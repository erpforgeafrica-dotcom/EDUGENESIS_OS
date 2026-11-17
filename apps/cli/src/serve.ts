/**
 * `eg serve` — the local server and the Settings UI.
 *
 * Binds to 127.0.0.1 by default. The Settings UI is plain HTML + CSS + JS:
 * no build step, no framework. It uses the Aurora design tokens that ship
 * inside this project (`assets/edugenesis-tokens.css`).
 *
 * An API key is write-only over HTTP: the read endpoint returns only whether a
 * key exists and how long it is, never the value.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { ProviderAdapter } from '@edugenesis/contracts';
import { flagBoolean, flagString, parseArgs } from './args.js';
import { createLearnerServices, type LearnerServices } from './learner.js';
import {
  DATA_DIR,
  displayPath,
  ensureDataDir,
  isMainModule,
  localOverridePath,
  PROJECT_ROOT,
  PUBLIC_DIR,
  TOKENS_PATH,
} from './paths.js';
import {
  deepMerge,
  describeApiKeys,
  getByPath,
  isPlainObject,
  loadSettings,
  maskSettingsForDisplay,
  setByPath,
  writeSettingsFile,
  type SettingsFile,
} from './settings-store.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/** Static files the UI may request. Nothing else is reachable. */
const STATIC_ROUTES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  // The learner screen (owner decision D-1): a learner asks a question and
  // receives a lesson.
  '/learn': 'learn.html',
  '/learn.html': 'learn.html',
  '/app.css': 'app.css',
  '/app.js': 'app.js',
  '/learn.js': 'learn.js',
  // The service-worker bootstrap is a file, not an inline script, so the
  // Content-Security-Policy can refuse inline scripts outright.
  '/register-sw.js': 'register-sw.js',
  // The service worker must be served from the origin root: its scope is its
  // own directory, so `/sw.js` can control `/` but `/assets/sw.js` could not.
  '/sw.js': 'sw.js',
  '/manifest.webmanifest': 'manifest.webmanifest',
  '/icon.svg': 'icon.svg',
};

/**
 * Headers every response carries.
 *
 * WHY a CSP with no inline allowance: both shipped pages load scripts from
 * files only (the Settings page's service-worker bootstrap lives in
 * `/register-sw.js`), so `script-src 'self'` costs nothing and closes the
 * injected-script class outright. `frame-ancestors 'none'` plus
 * `X-Frame-Options: DENY` stop another site framing the learner page.
 *
 * WHY `style-src 'self'`: no shipped HTML carries a `style` attribute, and the
 * only script that touches styling assigns through the CSSOM, which the CSP
 * does not govern. If a future page needs an inline style, this line must be
 * changed deliberately — not silently relaxed.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join('; '),
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function sendText(response: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

/** Only loopback callers may talk to the settings API. */
export function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.');
}

/**
 * The identity a throttle bucket is keyed by.
 *
 * WHY this is not simply the socket address: a hosted instance sits behind the
 * platform proxy, so `request.socket.remoteAddress` is the PROXY for every
 * learner. Keying on it would turn a per-caller throttle into ONE bucket shared
 * by the whole internet — the eleventh learner in a minute would be refused
 * because ten strangers asked a question first. That is a denial of service
 * wearing the costume of a defence.
 *
 * WHY the forwarded header is trusted only when hosted: on a directly exposed
 * instance the header is caller-controlled, and honouring it would let one
 * caller mint unlimited buckets. Local and self-hosted instances key on the
 * socket address, exactly as before.
 *
 * The first hop is the originating client; later hops are the proxies that
 * appended to the header. The shape check keeps the key space bounded, so even
 * a hostile header cannot grow the bucket map without limit.
 */
export function clientIdentity(
  remoteAddress: string | undefined,
  forwardedFor: string | undefined,
  hosted: boolean,
): string {
  const fallback = remoteAddress ?? 'unknown';
  if (!hosted) return fallback;
  const first = (forwardedFor ?? '').split(',')[0]?.trim() ?? '';
  return /^[0-9a-fA-F:.]{3,45}$/.test(first) ? first : fallback;
}

/**
 * The token bucket that guards the public question route.
 *
 * WHY this exists: `/api/learn` is the one surface that can cause real work
 * (a model call whenever a tier-1 provider is configured) and anyone who can
 * reach the instance can call it. A twelve-request burst was answered with
 * twelve 200s and no throttle. That is a budget hazard for the programme and a
 * trivial denial-of-service against a free instance.
 *
 * WHY it is in-process and keyed by address: the product is single-tenant and
 * dependency-free by design. A shared store would be the right answer for a
 * fleet; pretending this is a fleet would be worse than an honest local
 * limiter. Loopback is exempt by default, so a learner running the project on
 * their own machine is never throttled by their own software.
 */
export interface RateLimitOptions {
  /** How many requests may arrive at once. */
  readonly burst?: number;
  /** How many requests are restored per minute, per caller. */
  readonly perMinute?: number;
  /** Exempt loopback callers (default true — local use is never throttled). */
  readonly exemptLoopback?: boolean;
}

export const DEFAULT_RATE_LIMIT: Required<RateLimitOptions> = {
  burst: 10,
  perMinute: 30,
  exemptLoopback: true,
};

/** Build a limiter. Pure in time, so a test can drive it without sleeping. */
export function createRateLimiter(
  options: RateLimitOptions = {},
): (key: string, now?: number) => { allowed: boolean; retryAfterSec: number } {
  const capacity = options.burst ?? DEFAULT_RATE_LIMIT.burst;
  const perMinute = options.perMinute ?? DEFAULT_RATE_LIMIT.perMinute;
  const tokensPerMs = perMinute / 60_000;
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();

  return function take(key: string, now: number = Date.now()) {
    // A cheap bound: under address churn the map must not grow without limit.
    if (buckets.size > 10_000) buckets.clear();

    const previous = buckets.get(key);
    const tokens = Math.min(
      capacity,
      (previous?.tokens ?? capacity) + Math.max(0, now - (previous?.updatedAt ?? now)) * tokensPerMs,
    );

    if (tokens < 1) {
      buckets.set(key, { tokens, updatedAt: now });
      const waitMs = tokensPerMs > 0 ? (1 - tokens) / tokensPerMs : 60_000;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
    }

    buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return { allowed: true, retryAfterSec: 0 };
  };
}

/**
 * Decide whether a request may reach the settings surface.
 *
 * Two modes, and the difference is deliberate:
 *
 *   local   — only a loopback peer. This is the default, and it is why a
 *             laptop's settings page is unreachable from the network.
 *   hosted  — any peer, because the request arrives through the platform's
 *             proxy and is never loopback. Writes are refused separately, so a
 *             hosted instance is a read-only demonstration, never a remote
 *             settings editor.
 *
 * Pure and exported so the policy is unit-tested without opening a socket.
 */
export function authorizePeer(
  remoteAddress: string | undefined,
  hosted: boolean,
): { allowed: boolean; reason?: string } {
  if (hosted) return { allowed: true };
  if (isLoopback(remoteAddress)) return { allowed: true };
  return { allowed: false, reason: 'Only loopback clients may reach the local settings server.' };
}

/** True when a hosted instance must refuse the write. */
export function isHostedWriteRefused(
  hosted: boolean,
  method: string,
  pathname: string,
): boolean {
  return hosted && (method === 'POST' || method === 'PUT') && pathname.startsWith('/api/');
}

/**
 * Decide whether a request may read the DURABLE AUDIT TRAIL.
 *
 * WHY THIS IS STRICTER THAN THE SETTINGS SURFACE
 *   The settings endpoint is a configuration surface. The audit trail is
 *   EVIDENCE about a named learner and a named guardian — who consented, when,
 *   and on what authority. It is private-only evidence (Module-Perfection Law
 *   §12.4): a public visitor must never see it, and a hosted instance — which
 *   is on the open internet — must never serve it at all, not even to a
 *   loopback peer, because a hosted instance's "loopback" is the platform
 *   proxy's own loopback.
 *
 * Pure and exported so the policy is unit-tested without opening a socket.
 */
export function authorizeAuditAccess(
  hosted: boolean,
  remoteAddress: string | undefined,
): { allowed: boolean; reason?: string } {
  if (hosted) {
    return {
      allowed: false,
      reason: 'The audit trail is private evidence and is never exposed on a hosted instance.',
    };
  }
  if (isLoopback(remoteAddress)) return { allowed: true };
  return {
    allowed: false,
    reason: 'The audit trail is private evidence: only a loopback client may read it.',
  };
}

/** The request facts a settings-write decision is made from. */
export interface SettingsWriteRequest {
  readonly hosted: boolean;
  readonly remoteAddress: string | undefined;
  readonly method: string;
  readonly pathname: string;
  /** The `Content-Type` header, verbatim. */
  readonly contentType: string | undefined;
  /** The `Origin` header, verbatim. Absent for a non-browser client. */
  readonly origin: string | undefined;
  /** The `Sec-Fetch-Site` header, when the browser sends one. */
  readonly secFetchSite: string | undefined;
}

/** True when a URL host is this machine. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '127.0.0.1' ||
    host.startsWith('127.')
  );
}

/**
 * Decide whether a settings write may proceed.
 *
 * WHY A SECOND GATE: loopback-only admission says which PEER may connect. It
 * says nothing about which PAGE caused the request. A page at any origin can
 * POST `text/plain` to `http://127.0.0.1:<port>/api/settings` as a CORS
 * "simple request" — no preflight — and the write lands even though the page
 * cannot read the reply. The settings carry provider base URLs and API keys, so
 * that write can point a credential at an attacker's host.
 *
 * THREE CONDITIONS, ALL REQUIRED:
 *  1. the peer is loopback;
 *  2. the body declares `application/json`, which no cross-origin page can do
 *     without a preflight this server never grants;
 *  3. when the browser says where the request came from, that origin is
 *     loopback too — and `Sec-Fetch-Site: cross-site` refuses outright.
 *
 * A non-browser client (curl, a test) sends no `Origin` and is admitted: CSRF
 * is a browser behaviour, and the content-type condition has already excluded
 * the form-encoded shapes a browser can send without a preflight.
 */
export function authorizeSettingsWrite(
  request: SettingsWriteRequest,
): { allowed: boolean; reason?: string } {
  const isWrite = request.method === 'POST' || request.method === 'PUT';
  if (!isWrite || !request.pathname.startsWith('/api/')) return { allowed: true };
  if (request.hosted) {
    return { allowed: false, reason: 'Settings are read-only on the hosted demonstration.' };
  }
  if (!isLoopback(request.remoteAddress)) {
    return { allowed: false, reason: 'Only loopback clients may write settings.' };
  }
  const mediaType = (request.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json') {
    return {
      allowed: false,
      reason: 'A settings write must declare Content-Type: application/json.',
    };
  }
  if ((request.secFetchSite ?? '').toLowerCase() === 'cross-site') {
    return { allowed: false, reason: 'A cross-site page may not write settings.' };
  }
  if (request.origin !== undefined) {
    let origin: URL;
    try {
      origin = new URL(request.origin);
    } catch {
      return { allowed: false, reason: `The request origin "${request.origin}" is not a URL.` };
    }
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
      return { allowed: false, reason: `The request origin "${request.origin}" is not a web origin.` };
    }
    if (!isLoopbackHost(origin.hostname)) {
      return { allowed: false, reason: `The origin "${request.origin}" is not this machine.` };
    }
  }
  return { allowed: true };
}

/** Header lookup that treats an empty value as absent. */
function headerValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value.length === 0 ? undefined : value;
}

function readRootVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return typeof raw.version === 'string' ? raw.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The settings payload exposed over HTTP. Secrets are described, never returned. */
function publicSettings(settings: SettingsFile): Record<string, unknown> {
  const masked = maskSettingsForDisplay(settings);
  setByPath(masked, 'providers.apiKeys', describeApiKeys(settings));
  return masked;
}

/** Apply an incoming partial settings payload onto the current settings. */
function applyPatch(current: SettingsFile, patch: unknown): { ok: true; settings: SettingsFile } | { ok: false; error: string } {
  if (!isPlainObject(patch)) return { ok: false, error: 'The request body must be a JSON object.' };
  const next = JSON.parse(JSON.stringify(current)) as SettingsFile;

  for (const [section, value] of Object.entries(patch)) {
    if (section === 'providers' && isPlainObject(value)) {
      const incomingKeys = isPlainObject(value['apiKeys']) ? (value['apiKeys'] as Record<string, unknown>) : undefined;
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'apiKeys') continue;
        setByPath(next, `providers.${key}`, entry);
      }
      if (incomingKeys) {
        const existing = getByPath(next, 'providers.apiKeys');
        const merged: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
        for (const [name, secret] of Object.entries(incomingKeys)) {
          if (secret === null) {
            delete merged[name];
            continue;
          }
          if (typeof secret === 'string') {
            if (secret.length > 0) merged[name] = secret;
            continue;
          }
          return { ok: false, error: `providers.apiKeys.${name} must be a string or null.` };
        }
        setByPath(next, 'providers.apiKeys', merged);
      }
      continue;
    }
    // A nested object is MERGED, not replaced, so a partial patch never drops
    // the fields it does not mention.
    const existing = getByPath(next, section);
    if (isPlainObject(existing) && isPlainObject(value)) {
      setByPath(next, section, deepMerge(existing, value));
      continue;
    }
    if (!setByPath(next, section, value)) {
      return { ok: false, error: `Could not apply "${section}".` };
    }
  }
  return { ok: true, settings: next };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 512 * 1024) throw new Error('The request body is too large.');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

/** Options for `startServer`. */
export interface ServeOptions {
  readonly host?: string;
  readonly port?: number;
  readonly hosted?: boolean;
  /** Where the durable stores live. Created if absent. */
  readonly dataDir?: string;
  /** Provider adapters to register on the learner gateway. */
  readonly adapters?: readonly ProviderAdapter[];
  /** A ready-made learner surface. Supplied by tests; built here otherwise. */
  readonly learnerServices?: LearnerServices;
  /** Token bucket for the public question route. */
  readonly rateLimit?: RateLimitOptions;
}

/** A running server. */
export interface ServeHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** Stop the server and release the durable stores. */
  close(): Promise<void>;
}

/**
 * Start the server.
 *
 * WHY IT IS SEPARATE FROM `main`: a route that can only be reached by running
 * the CLI cannot be tested. `startServer` is the whole server minus the
 * process wiring, so a test can drive the REAL routes over a REAL socket on
 * an ephemeral port — the only way to prove that a learner question really
 * reaches the gateway and really comes back through the guardian.
 */
export async function startServer(options: ServeOptions = {}): Promise<ServeHandle> {
  const hosted = options.hosted ?? false;
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const dataDir = ensureDataDir(options.dataDir ?? DATA_DIR);
  const ownsLearner = options.learnerServices === undefined;
  const learner =
    options.learnerServices ??
    createLearnerServices({ dataDir, adapters: options.adapters ?? [] });
  const rateLimit = options.rateLimit ?? {};
  const takeQuestionToken = createRateLimiter(rateLimit);
  const loaded = loadSettings();
  // Hosted mode exists for the Render deployment. It widens WHO may connect
  // (the platform proxy is never loopback) and narrows WHAT may be written
  // (settings become read-only). It is opt-in, so a laptop is never exposed by
  // accident.
  // The only file this process may write. Named through the accessor rather
  // than the constant so the rule has one definition (see paths.ts).
  const writeTarget = localOverridePath();

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    const access = authorizePeer(request.socket.remoteAddress, hosted);
    if (!access.allowed) {
      sendJson(response, 403, {
        ok: false,
        error: access.reason ?? 'This peer may not reach the settings server.',
      });
      return;
    }

    // ---- health --------------------------------------------------------
    if (pathname === '/api/health') {
      if (method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'Use GET.' });
        return;
      }
      let settingsFile = displayPath(writeTarget);
      let schemaVersion = loaded.settings.schemaVersion;
      try {
        const current = loadSettings();
        settingsFile = displayPath(current.activePath);
        schemaVersion = current.settings.schemaVersion;
      } catch {
        // keep the startup values
      }
      sendJson(response, 200, {
        ok: true,
        status: 'ok',
        service: 'edugenesis-os',
        hosted,
        version: readRootVersion(),
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
        settingsFile,
        settingsSchemaVersion: schemaVersion,
        time: new Date().toISOString(),
      });
      return;
    }

    // ---- the learner question (D-1) -------------------------------------
    if (pathname === '/api/learn') {
      if (method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'Use POST.' });
        return;
      }
      // The throttle comes BEFORE the body is read: a caller who is over the
      // limit must not be able to make the server buffer a megabyte first.
      const remoteAddress = request.socket.remoteAddress;
      const forwarded = request.headers['x-forwarded-for'];
      const forwardedFor = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const exempt =
        (rateLimit.exemptLoopback ?? DEFAULT_RATE_LIMIT.exemptLoopback) && isLoopback(remoteAddress);
      if (!exempt) {
        const verdict = takeQuestionToken(clientIdentity(remoteAddress, forwardedFor, hosted));
        if (!verdict.allowed) {
          response.setHeader('Retry-After', String(verdict.retryAfterSec));
          sendJson(response, 429, {
            ok: false,
            error: `Too many questions at once. Try again in ${verdict.retryAfterSec} seconds.`,
          });
          return;
        }
      }
      let body: unknown;
      try {
        body = await readBody(request);
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          error: `Could not read the request body: ${(error as Error).message}`,
        });
        return;
      }
      const prompt = isPlainObject(body) ? String(body['prompt'] ?? '') : '';
      if (prompt.trim().length === 0) {
        sendJson(response, 400, { ok: false, error: 'Ask a question to get a lesson.' });
        return;
      }
      try {
        const answer = await learner.answer(prompt.trim());
        if (answer.blocked) {
          // The guardian did not intercept the emission exactly once, so the
          // text must NOT ship. A lesson that skipped the guardian is not a
          // lesson this platform may deliver.
          sendJson(response, 502, {
            ok: false,
            error: 'That answer could not be prepared for delivery. Please try again.',
          });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          text: answer.text,
          tier: answer.tier,
          guarded: answer.guarded,
        });
      } catch {
        // The learner must never see an operations term: no provider name, no
        // quota, no credit, no outage (Doc 16 §6.6).
        sendJson(response, 502, {
          ok: false,
          error: 'A lesson is not available right now. Please try again shortly.',
        });
      }
      return;
    }

    // ---- enrolment (D-1) ------------------------------------------------
    if (pathname === '/api/enrol') {
      if (hosted) {
        // A DEMONSTRATION SURFACE TAKES NO REAL LEARNER DATA.
        //
        // WHY THIS IS REFUSED AND WHY `/api/learn` IS NOT: a hosted instance
        // is a public demonstration, its filesystem is ephemeral (the free tier
        // recycles the container), and ADR-0012 forbids real learner data in a
        // technical demonstration. Enrolment creates a guardian identity and a
        // learner record - that is real data about a person. A learner asking a
        // question is not: it is the product working, and it carries no
        // identifier. So the question is answered and the enrolment is refused.
        sendJson(response, 403, {
          ok: false,
          error:
            'This is a demonstration instance: it answers questions but cannot enrol a learner, ' +
            'so it never holds real learner data. Run the project locally to enrol.',
        });
        return;
      }
      if (method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'Use POST.' });
        return;
      }
      let body: unknown;
      try {
        body = await readBody(request);
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          error: `Could not read the request body: ${(error as Error).message}`,
        });
        return;
      }
      const payload = isPlainObject(body) ? body : {};
      const action = String(payload['action'] ?? '');
      try {
        if (action === 'register-guardian') {
          const guardianId = String(payload['guardianId'] ?? '');
          const learnerId = String(payload['learnerId'] ?? '');
          if (guardianId.length === 0 || learnerId.length === 0) {
            sendJson(response, 400, {
              ok: false,
              error: 'A guardian id and a learner id are required.',
            });
            return;
          }
          const guardian = learner.registerGuardian(guardianId);
          const issued = learner.issueConsentToken(guardianId, learnerId);
          // The secrets are shown ONCE, to the guardian who owns them. They are
          // never stored, never logged, and never returned by an enrolment.
          sendJson(response, 200, {
            ok: true,
            guardianId: guardian.guardianId,
            token: issued.token,
            secret: issued.secret,
          });
          return;
        }
        if (action === 'enrol') {
          const learnerId = String(payload['learnerId'] ?? '');
          const token = payload['token'];
          const secret = String(payload['secret'] ?? '');
          if (learnerId.length === 0 || token === undefined || secret.length === 0) {
            sendJson(response, 400, {
              ok: false,
              error: 'A learner id, a consent token and its secret are required.',
            });
            return;
          }
          const outcome = await learner.enrol(learnerId, token, secret);
          sendJson(response, 200, {
            ok: true,
            provisional: outcome.provisional,
            method: outcome.method,
            grantedScopes: outcome.grantedScopes,
          });
          return;
        }
        sendJson(response, 400, { ok: false, error: 'Unknown enrolment action.' });
      } catch (error) {
        const refusal = error instanceof Error ? error.message : String(error);
        sendJson(response, 400, { ok: false, error: refusal });
      }
      return;
    }

    // ---- the private audit trail (D-3) ----------------------------------
    if (pathname === '/api/audit') {
      const auditAccess = authorizeAuditAccess(hosted, request.socket.remoteAddress);
      if (!auditAccess.allowed) {
        sendJson(response, 403, {
          ok: false,
          error: auditAccess.reason ?? 'This request may not read the audit trail.',
        });
        return;
      }
      if (method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'Use GET.' });
        return;
      }
      const trail = learner.auditTrail();
      sendJson(response, 200, {
        ok: true,
        verification: trail.verification,
        events: trail.events,
      });
      return;
    }

    // ---- settings ------------------------------------------------------
    if (pathname === '/api/settings') {
      if (method === 'GET') {
        try {
          const current = loadSettings();
          sendJson(response, 200, { ok: true, settings: publicSettings(current.settings), file: displayPath(current.activePath) });
        } catch (error) {
          sendJson(response, 500, { ok: false, error: (error as Error).message });
        }
        return;
      }
      if (isHostedWriteRefused(hosted, method, pathname)) {
        sendJson(response, 403, {
          ok: false,
          error: 'Settings are read-only on the hosted demonstration. Run the project locally to change them.',
        });
        return;
      }
      if (method === 'POST' || method === 'PUT') {
        // The peer gate above says WHO connected. This says which PAGE caused
        // the write: without it, any site the learner visits can POST here.
        const writeAccess = authorizeSettingsWrite({
          hosted,
          remoteAddress: request.socket.remoteAddress,
          method,
          pathname,
          contentType: headerValue(request, 'content-type'),
          origin: headerValue(request, 'origin'),
          secFetchSite: headerValue(request, 'sec-fetch-site'),
        });
        if (!writeAccess.allowed) {
          sendJson(response, 403, {
            ok: false,
            error: writeAccess.reason ?? 'This request may not write settings.',
          });
          return;
        }
        let body: unknown;
        try {
          body = await readBody(request);
        } catch (error) {
          sendJson(response, 400, { ok: false, error: `Could not read the request body: ${(error as Error).message}` });
          return;
        }
        const patch = isPlainObject(body) && isPlainObject(body['settings']) ? body['settings'] : body;
        let current: SettingsFile;
        try {
          current = loadSettings().settings;
        } catch (error) {
          sendJson(response, 500, { ok: false, error: (error as Error).message });
          return;
        }
        const applied = applyPatch(current, patch);
        if (!applied.ok) {
          sendJson(response, 400, { ok: false, error: applied.error });
          return;
        }
        try {
          writeSettingsFile(writeTarget, applied.settings);
        } catch (error) {
          sendJson(response, 400, { ok: false, error: (error as Error).message });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          saved: true,
          file: displayPath(writeTarget),
          settings: publicSettings(applied.settings),
          notice: 'Host and port changes take effect the next time the server starts.',
        });
        return;
      }
      sendJson(response, 405, { ok: false, error: 'Use GET or POST.' });
      return;
    }

    // ---- static --------------------------------------------------------
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(response, 405, { ok: false, error: 'Use GET.' });
      return;
    }

    if (pathname === '/assets/edugenesis-tokens.css') {
      if (!existsSync(TOKENS_PATH)) {
        sendText(response, 404, 'Token stylesheet not found.');
        return;
      }
      sendText(response, 200, readFileSync(TOKENS_PATH, 'utf8'), CONTENT_TYPES['.css'] ?? 'text/css');
      return;
    }

    const staticName = STATIC_ROUTES[pathname];
    if (staticName) {
      const file = resolve(join(PUBLIC_DIR, staticName));
      if (!file.startsWith(resolve(PUBLIC_DIR)) || !existsSync(file)) {
        sendText(response, 404, 'Not found.');
        return;
      }
      const contentType = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
      sendText(response, 200, readFileSync(file, 'utf8'), contentType);
      return;
    }

    sendText(response, 404, 'Not found.');
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      sendJson(response, 500, { ok: false, error: (error as Error).message });
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => {
      server.removeListener('error', rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    async close(): Promise<void> {
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
      if (ownsLearner) learner.close();
    },
  };
}

/**
 * `eg serve` — the CLI entry point.
 *
 * WHY IT IS SEPARATE FROM `startServer`: the CLI owns the process (flags,
 * environment, signals, the message the operator reads); `startServer` owns
 * the routes. A test drives `startServer`; a human runs `main`.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const loaded = loadSettings();
  // Hosted mode exists for the Render deployment. It widens WHO may connect
  // (the platform proxy is never loopback) and narrows WHAT may be written
  // (settings become read-only). It is opt-in, so a laptop is never exposed by
  // accident.
  const hosted = flagBoolean(args, 'hosted') || process.env['EDUGENESIS_HOSTED'] === '1';
  const envPort = process.env['PORT'];
  const host = flagString(args, 'host') ?? (hosted ? '0.0.0.0' : loaded.settings.server.host);
  const port = Number(
    flagString(args, 'port') ?? (hosted && envPort ? envPort : String(loaded.settings.server.port)),
  );

  const server = await startServer({ host, port, hosted });
  process.stdout.write(`EduGenesis OS — local server listening on ${server.url}\n`);
  process.stdout.write(`Settings UI: ${server.url}/\n`);
  process.stdout.write(`Learner screen: ${server.url}/learn\n`);
  process.stdout.write(`Settings written to: ${displayPath(localOverridePath())}\n`);
  process.stdout.write('Press Ctrl+C to stop.\n');

  await new Promise<void>((resolvePromise) => {
    const stop = (): void => {
      process.stdout.write('\nStopping the local server.\n');
      void server.close().then(() => resolvePromise());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`eg serve failed: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
