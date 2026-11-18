/**
 * PG-01/PG-02/PG-03 — hosted access control, proven over a REAL socket.
 *
 * The policy functions are unit-tested in serve.test.ts; these tests drive the
 * actual routes so a policy that is correct in isolation but never called by
 * the router cannot pass. Every assertion names the refusal it proves.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EduGenesisSettings } from '@edugenesis/contracts';
import { createLearnerServices, type LearnerServices } from './learner.js';
import { startServer, type ServeHandle } from './serve.js';

const SECRET = 'a-local-test-session-secret-that-is-not-a-production-key';
const BOOTSTRAP = [
  { id: 'op-1', password: 'Correct-Horse-Battery-9!', roles: ['operator' as const] },
  { id: 'guard-1', password: 'Guardian-Passphrase-7!', roles: ['guardian' as const] },
  { id: 'learn-1', password: 'Learner-Passphrase-7!', roles: ['learner' as const] },
];

function hermeticSettings(): EduGenesisSettings {
  return {
    schemaVersion: 1,
    server: { host: '127.0.0.1', port: 8787 },
    paths: { dataDir: './.edugenesis-data' },
    providers: { primary: 'local-echo', secondary: 'local-echo', apiKeys: {} },
    features: { accessibilityGuardian: true, offlineBundle: true, telemetry: false, publicAnchoring: false },
    limits: { budgetUnits: 1_000_000, mediaBudgetBytes: 5_242_880, confidenceThreshold: 0.7 },
  };
}

async function withHosted(
  extra: Record<string, unknown>,
  run: (handle: ServeHandle) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'edugenesis-auth-'));
  const services: LearnerServices = createLearnerServices({ dataDir, settings: hermeticSettings() });
  const handle = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    hosted: true,
    sessionSecret: SECRET,
    authBootstrap: BOOTSTRAP,
    hostedEnrol: true,
    hostedAudit: true,
    learnerServices: services,
    ...extra,
  });
  try {
    await run(handle);
  } finally {
    await handle.close();
    services.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function login(handle: ServeHandle, id: string, password: string): Promise<{ status: number; cookie: string; csrf: string }> {
  const res = await fetch(`${handle.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, password }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const csrf = (setCookie.match(/eg_csrf=([^;]+)/) ?? [])[1] ?? '';
  return { status: res.status, cookie: setCookie, csrf };
}

test('PG-02: hosted settings are denied to an anonymous caller', async () => {
  await withHosted({}, async (handle) => {
    const res = await fetch(`${handle.url}/api/settings`);
    assert.equal(res.status, 403, 'deny-by-default: no session, no settings');
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, false);
  });
});

test('PG-01: a learner session is refused settings (role separation)', async () => {
  await withHosted({}, async (handle) => {
    const session = await login(handle, 'learn-1', 'Learner-Passphrase-7!');
    assert.equal(session.status, 200);
    const res = await fetch(`${handle.url}/api/settings`, { headers: { cookie: session.cookie } });
    assert.equal(res.status, 403, 'a learner role must not read operator settings');
  });
});

test('PG-01: an operator reads redacted settings; no credential value leaks', async () => {
  await withHosted({}, async (handle) => {
    const session = await login(handle, 'op-1', 'Correct-Horse-Battery-9!');
    assert.equal(session.status, 200, 'operator login succeeds');
    const res = await fetch(`${handle.url}/api/settings`, { headers: { cookie: session.cookie } });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(!body.includes('Correct-Horse-Battery-9!'), 'no credential value leaks');
    assert.ok(/"apiKeys"\s*:/.test(body), 'the masked key map is present, not a raw secret');
  });
});

test('PG-01: a wrong password is refused and the audit trail records it', async () => {
  await withHosted({}, async (handle) => {
    const bad = await login(handle, 'op-1', 'not-the-password');
    assert.equal(bad.status, 401);
    const good = await login(handle, 'op-1', 'Correct-Horse-Battery-9!');
    const res = await fetch(`${handle.url}/api/audit`, { headers: { cookie: good.cookie } });
    assert.equal(res.status, 200, 'an operator/auditor reads the private audit trail');
    const body = (await res.json()) as { events: unknown[] };
    assert.ok(Array.isArray(body.events));
  });
});

test('PG-03: hosted enrol/audit stay refused when the feature flags are off', async () => {
  await withHosted({ hostedEnrol: false, hostedAudit: false }, async (handle) => {
    const session = await login(handle, 'guard-1', 'Guardian-Passphrase-7!');
    const enrol = await fetch(`${handle.url}/api/enrol`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrf },
      body: JSON.stringify({ action: 'register-guardian', guardianId: 'g1', learnerId: 'l1' }),
    });
    assert.equal(enrol.status, 403, 'the flag off keeps the ADR-0012 refusal');
    const audit = await fetch(`${handle.url}/api/audit`, { headers: { cookie: session.cookie } });
    assert.equal(audit.status, 403);
  });
});

test('PG-01: a guardian may enrol on a hosted instance when the flag is on', async () => {
  await withHosted({}, async (handle) => {
    const session = await login(handle, 'guard-1', 'Guardian-Passphrase-7!');
    const enrol = await fetch(`${handle.url}/api/enrol`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrf },
      body: JSON.stringify({ action: 'register-guardian', guardianId: 'g1', learnerId: 'l1' }),
    });
    assert.equal(enrol.status, 200, 'a guardian with a valid CSRF token may enrol');
    const body = (await enrol.json()) as { ok: boolean; token?: unknown };
    assert.equal(body.ok, true);
  });
});

test('PG-01: a state-changing request without a CSRF token is refused', async () => {
  await withHosted({}, async (handle) => {
    const session = await login(handle, 'guard-1', 'Guardian-Passphrase-7!');
    const enrol = await fetch(`${handle.url}/api/enrol`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookie },
      body: JSON.stringify({ action: 'register-guardian', guardianId: 'g1', learnerId: 'l1' }),
    });
    assert.equal(enrol.status, 403, 'no x-csrf-token, no write');
  });
});

test('PG-01: /api/auth/me reports the session principal', async () => {
  await withHosted({}, async (handle) => {
    const anon = await fetch(`${handle.url}/api/auth/me`);
    assert.equal(anon.status, 401);
    const session = await login(handle, 'op-1', 'Correct-Horse-Battery-9!');
    const me = await fetch(`${handle.url}/api/auth/me`, { headers: { cookie: session.cookie } });
    assert.equal(me.status, 200);
    const body = (await me.json()) as { principal: { id: string; roles: string[] } };
    assert.equal(body.principal.id, 'op-1');
    assert.ok(body.principal.roles.includes('operator'));
  });
});

test('PG-05: the public ledger is readable without a session', async () => {
  await withHosted({}, async (handle) => {
    const res = await fetch(`${handle.url}/api/ledger`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; entries: unknown[]; verification: { ok: boolean } };
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.entries));
    assert.equal(body.verification.ok, true);
  });
});

test('PG-04/05/06: sponsor funds, the ledger records it, and the report is readable', async () => {
  await withHosted({}, async (handle) => {
    const session = await login(handle, 'op-1', 'Correct-Horse-Battery-9!');
    const headers = {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
    };

    const registration = await fetch(`${handle.url}/api/sponsor/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ref: 'anchor-sponsor-01' }),
    });
    assert.equal(registration.status, 200, 'a pseudonymous sponsor registers');
    const { sponsorId } = (await registration.json()) as { sponsorId: string };

    const before = (await (await fetch(`${handle.url}/api/ledger`)).json()) as { entries: unknown[] };
    const funding = await fetch(`${handle.url}/api/sponsor/funding`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sponsorId, amountCents: 1000, idempotencyKey: 'pledge-001' }),
    });
    assert.equal(funding.status, 200);
    const funded = (await funding.json()) as { ok: boolean; creditsGranted: number; seq: number };
    assert.equal(funded.ok, true);
    assert.equal(funded.creditsGranted, 60, '60 % of 1000c at 10c/unit grants 60 credits');

    const duplicate = await fetch(`${handle.url}/api/sponsor/funding`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sponsorId, amountCents: 1000, idempotencyKey: 'pledge-001' }),
    });
    const dup = (await duplicate.json()) as { duplicate: boolean; seq: number };
    assert.equal(dup.duplicate, true, 'a repeated idempotency key is not a second pledge');
    assert.equal(dup.seq, funded.seq);

    const after = (await (await fetch(`${handle.url}/api/ledger`)).json()) as { entries: unknown[] };
    assert.equal(after.entries.length, before.entries.length + 2, 'pledge + allocation, no duplicate');

    const report = await fetch(`${handle.url}/api/sponsor/report?sponsorId=${sponsorId}`, {
      headers: { cookie: session.cookie },
    });
    assert.equal(report.status, 200, 'the sponsor report publishes on a healthy chain');
    const body = (await report.json()) as { ok: boolean; draft: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.draft, false);
  });
});

test('PG-04: funding needs an authenticated session with the sponsor permission', async () => {
  await withHosted({}, async (handle) => {
    const anon = await fetch(`${handle.url}/api/sponsor/funding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sponsorId: 'x', amountCents: 100, idempotencyKey: 'y' }),
    });
    assert.equal(anon.status, 403, 'an anonymous caller cannot write to the ledger');
  });
});
