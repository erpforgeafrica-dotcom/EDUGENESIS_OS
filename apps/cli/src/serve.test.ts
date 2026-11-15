/**
 * The settings server's access policy.
 *
 * These tests exist because the policy is the only thing standing between a
 * learner's laptop and the open network. The server is loopback-only by
 * default; hosted mode exists solely for the Render deployment, where the
 * platform proxy is never a loopback peer.
 *
 * The policy is tested as a pure function rather than over a socket: a test
 * that binds 0.0.0.0 and connects from the same machine still arrives from
 * 127.0.0.1 and would prove nothing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProviderAdapter } from '@edugenesis/contracts';
import {
  authorizeAuditAccess,
  authorizePeer,
  authorizeSettingsWrite,
  isHostedWriteRefused,
  isLoopback,
  startServer,
  type ServeHandle,
  type ServeOptions,
} from './serve.js';

test('loopback detection accepts the IPv4, IPv6 and mapped loopback forms', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('127.0.0.9'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
});

test('loopback detection refuses a private network peer and an absent address', () => {
  assert.equal(isLoopback('10.0.0.5'), false);
  assert.equal(isLoopback('192.168.1.20'), false);
  assert.equal(isLoopback(undefined), false);
});

test('local mode refuses a non-loopback peer and says why', () => {
  const verdict = authorizePeer('10.0.0.5', false);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? '', /loopback/);
});

test('local mode admits a loopback peer', () => {
  assert.deepEqual(authorizePeer('127.0.0.1', false), { allowed: true });
});

test('hosted mode admits the platform proxy, which is never loopback', () => {
  assert.deepEqual(authorizePeer('10.0.0.5', true), { allowed: true });
});

test('hosted mode refuses every settings write, and local mode does not', () => {
  assert.equal(isHostedWriteRefused(true, 'POST', '/api/settings'), true);
  assert.equal(isHostedWriteRefused(true, 'PUT', '/api/settings'), true);
  assert.equal(isHostedWriteRefused(false, 'POST', '/api/settings'), false);
});

test('the hosted write refusal never blocks a read', () => {
  assert.equal(isHostedWriteRefused(true, 'GET', '/api/settings'), false);
  assert.equal(isHostedWriteRefused(true, 'GET', '/api/health'), false);
});

test('the hosted write refusal does not reach beyond the API surface', () => {
  assert.equal(isHostedWriteRefused(true, 'POST', '/app.js'), false);
});

/**
 * CSRF GATE TESTS (round-4 audit, finding F7-05).
 *
 * A loopback server is reachable by every page the learner has open. These
 * cases are the attack: a cross-origin POST that costs the attacker nothing
 * because it needs no preflight.
 */
const LOCAL = {
  hosted: false,
  remoteAddress: '127.0.0.1',
  method: 'POST',
  pathname: '/api/settings',
  contentType: 'application/json',
  origin: undefined,
  secFetchSite: undefined,
} as const;

test('csrf: a JSON write from a loopback peer is admitted', () => {
  assert.deepEqual(authorizeSettingsWrite({ ...LOCAL }), { allowed: true });
  assert.deepEqual(
    authorizeSettingsWrite({ ...LOCAL, contentType: 'application/json; charset=utf-8' }),
    { allowed: true },
  );
});

test('csrf: a text/plain write is refused, which is the attack shape', () => {
  // `text/plain` is a CORS simple request: the browser sends it with no
  // preflight, so this is exactly the request a hostile page can make.
  const verdict = authorizeSettingsWrite({ ...LOCAL, contentType: 'text/plain' });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? '', /application\/json/);
});

test('csrf: a form-encoded write is refused', () => {
  assert.equal(
    authorizeSettingsWrite({ ...LOCAL, contentType: 'application/x-www-form-urlencoded' }).allowed,
    false,
  );
  assert.equal(authorizeSettingsWrite({ ...LOCAL, contentType: undefined }).allowed, false);
});

test('csrf: a write carrying a foreign Origin is refused', () => {
  const verdict = authorizeSettingsWrite({ ...LOCAL, origin: 'https://attacker.example' });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? '', /not this machine/);
});

test('csrf: a cross-site fetch metadata hint is refused even with a loopback origin', () => {
  assert.equal(
    authorizeSettingsWrite({
      ...LOCAL,
      origin: 'http://127.0.0.1:4817',
      secFetchSite: 'cross-site',
    }).allowed,
    false,
  );
});

test('csrf: a loopback origin is admitted, including the localhost and IPv6 spellings', () => {
  for (const origin of ['http://127.0.0.1:4817', 'http://localhost:4817', 'http://[::1]:4817']) {
    assert.equal(authorizeSettingsWrite({ ...LOCAL, origin }).allowed, true, origin);
  }
});

test('csrf: a non-loopback peer is refused even with every header in order', () => {
  const verdict = authorizeSettingsWrite({ ...LOCAL, remoteAddress: '10.0.0.5' });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? '', /loopback/);
});

test('csrf: hosted mode refuses the write before any header is considered', () => {
  assert.equal(authorizeSettingsWrite({ ...LOCAL, hosted: true }).allowed, false);
});

test('csrf: reads and non-API paths are not gated', () => {
  assert.equal(authorizeSettingsWrite({ ...LOCAL, method: 'GET' }).allowed, true);
  assert.equal(authorizeSettingsWrite({ ...LOCAL, pathname: '/app.js' }).allowed, true);
});

test('csrf: an origin that is not a URL is refused rather than guessed at', () => {
  assert.equal(authorizeSettingsWrite({ ...LOCAL, origin: 'null' }).allowed, false);
});

/* -------------------------------------------------------------------------- */
/* The learner route, the enrolment route and the private audit route.        */
/* -------------------------------------------------------------------------- */

/**
 * A deterministic provider adapter.
 *
 * WHY A REAL ADAPTER: the route must drive the REAL gateway — a mocked
 * gateway would prove nothing about the guardian interception the route
 * claims. The adapter is the only thing faked: it stands in for the hosted
 * model provider so the test never touches a network.
 */
function echoAdapter(): ProviderAdapter {
  return {
    id: 'p1',
    modelId: 'p1-model',
    tier: 1,
    maxDataClass: 'public',
    capabilities: () => ({
      modalities: ['text'],
      supportsContextCaching: false,
      maxContextTokens: 8_000,
      maxDataClass: 'public',
      clearedSafetyTiers: ['low', 'medium'],
    }),
    async complete(req) {
      return {
        text: `a lesson for: ${req.prompt}`,
        providerId: 'p1',
        modelId: 'p1-model',
        usage: { inputTokens: 12, outputTokens: 24 },
        latencyMs: 1,
        sourceLineage: [],
      };
    },
    async health() {
      return { ok: true, consecutiveFailures: 0 };
    },
    async dispose() {
      /* nothing held */
    },
  };
}

/** Start a server on an ephemeral loopback port, and always stop it. */
async function withServer(
  options: Partial<ServeOptions>,
  run: (handle: ServeHandle) => Promise<void>,
): Promise<void> {
  const handle = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: mkdtempSync(join(tmpdir(), 'edugenesis-serve-')),
    ...options,
  });
  try {
    await run(handle);
  } finally {
    await handle.close();
  }
}

test('a blank question is refused with a plain message', async () => {
  await withServer({ adapters: [echoAdapter()] }, async (handle) => {
    const response = await fetch(`${handle.url}/api/learn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '   ' }),
    });
    assert.equal(response.status, 400);
    const payload = (await response.json()) as { ok: boolean; error: string };
    assert.equal(payload.ok, false);
    assert.ok(payload.error.length > 0);
  });
});

test('a learner question is answered by the real gateway, guarded exactly once', async () => {
  await withServer({ adapters: [echoAdapter()] }, async (handle) => {
    const response = await fetch(`${handle.url}/api/learn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Explain photosynthesis in simple terms' }),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      ok: boolean;
      text: string;
      tier: number;
      guarded: boolean;
    };
    assert.equal(payload.ok, true);
    assert.ok(payload.text.length > 0, 'the learner must receive a lesson');
    assert.equal(payload.guarded, true, 'the guardian must have intercepted the emission');
    assert.equal(typeof payload.tier, 'number');
  });
});

test('the audit route is refused on a hosted instance', async () => {
  await withServer({ hosted: true, adapters: [echoAdapter()] }, async (handle) => {
    const response = await fetch(`${handle.url}/api/audit`);
    assert.equal(response.status, 403);
    const payload = (await response.json()) as { ok: boolean };
    assert.equal(payload.ok, false);
  });
});

test('a hosted instance refuses enrolment - a demonstration surface takes no real learner data', async () => {
  await withServer({ hosted: true, adapters: [echoAdapter()] }, async (handle) => {
    const response = await fetch(`${handle.url}/api/enrol`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'register-guardian', guardianId: 'g1', learnerId: 'l1' }),
    });
    assert.equal(response.status, 403);
    const payload = (await response.json()) as { ok: boolean; error: string };
    assert.equal(payload.ok, false);
    assert.match(payload.error, /demonstration|learner data/i);
  });
});

test('a hosted instance still answers a learner question - that is the product', async () => {
  await withServer({ hosted: true, adapters: [echoAdapter()] }, async (handle) => {
    const response = await fetch(`${handle.url}/api/learn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Explain photosynthesis in simple terms' }),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { ok: boolean; guarded: boolean };
    assert.equal(payload.ok, true);
    assert.equal(payload.guarded, true);
  });
});

test('the audit route is refused for a peer that is not loopback', () => {
  const verdict = authorizeAuditAccess(false, '10.0.0.5');
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? '', /loopback|private/i);
});

test('the audit route is refused on a hosted instance, whatever the peer', () => {
  const verdict = authorizeAuditAccess(true, '127.0.0.1');
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? '', /private|hosted/i);
});

test('the audit route is admitted for a loopback peer on a local instance', () => {
  assert.equal(authorizeAuditAccess(false, '127.0.0.1').allowed, true);
});

test('the learner screen is served, with a live region and a labelled control', async () => {
  await withServer({ adapters: [echoAdapter()] }, async (handle) => {
    const response = await fetch(`${handle.url}/learn`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /role="status"/, 'the answer must be announced by a live region');
    assert.match(html, /<label[^>]*for=/, 'the question field must have a real label');
    assert.match(html, /aria-describedby/, 'the hint must be announced with its control');
  });
});

test('the enrolment route enrols a learner on a guardian consent token', async () => {
  await withServer({ adapters: [echoAdapter()] }, async (handle) => {
    // The guardian is registered through the identity surface the server exposes.
    const guardian = await fetch(`${handle.url}/api/enrol`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'register-guardian', guardianId: 'guardian-1', learnerId: 'learner-1' }),
    });
    assert.equal(guardian.status, 200);
    const issued = (await guardian.json()) as { ok: boolean; token: unknown; secret: string };

    const response = await fetch(`${handle.url}/api/enrol`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'enrol',
        learnerId: 'learner-1',
        token: issued.token,
        secret: issued.secret,
      }),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      ok: boolean;
      provisional: boolean;
      method: string;
      secret?: string;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.provisional, true);
    assert.equal(payload.method, 'guardian_consent_token');
    assert.equal(
      payload.secret,
      undefined,
      'an enrolment response must never carry a credential secret',
    );
  });
});
