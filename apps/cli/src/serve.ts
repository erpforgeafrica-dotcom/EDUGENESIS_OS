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
import { flagString, parseArgs } from './args.js';
import { displayPath, isMainModule, LOCAL_SETTINGS_PATH, PROJECT_ROOT, PUBLIC_DIR, TOKENS_PATH } from './paths.js';
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
};

/** Static files the UI may request. Nothing else is reachable. */
const STATIC_ROUTES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.css': 'app.css',
  '/app.js': 'app.js',
};

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function sendText(response: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

/** Only loopback callers may talk to the settings API. */
function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.');
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

/** Start the local server. Resolves when the server stops. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const loaded = loadSettings();
  const host = flagString(args, 'host') ?? loaded.settings.server.host;
  const port = Number(flagString(args, 'port') ?? String(loaded.settings.server.port));
  const writeTarget = LOCAL_SETTINGS_PATH;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (!isLoopback(request.socket.remoteAddress)) {
      sendJson(response, 403, { ok: false, error: 'Only loopback clients may reach the local settings server.' });
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
        version: readRootVersion(),
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
        settingsFile,
        settingsSchemaVersion: schemaVersion,
        time: new Date().toISOString(),
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
      if (method === 'POST' || method === 'PUT') {
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
  process.stdout.write(`EduGenesis OS — local server listening on http://${host}:${actualPort}\n`);
  process.stdout.write(`Settings UI: http://${host}:${actualPort}/\n`);
  process.stdout.write(`Settings written to: ${displayPath(writeTarget)}\n`);
  process.stdout.write('Press Ctrl+C to stop.\n');

  await new Promise<void>((resolvePromise) => {
    const stop = (): void => {
      process.stdout.write('\nStopping the local server.\n');
      server.close(() => resolvePromise());
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
