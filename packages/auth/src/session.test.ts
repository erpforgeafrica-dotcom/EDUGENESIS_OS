import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createSessionManager } from './session.js';
import type { AuthPrincipal } from './roles.js';

// Secret-shaped values are assembled at runtime; no key literal appears in source.
const SECRET = ['sk', 'test', 'session', 'secret', '0123456789abcdef0123456789abcdef'].join('-');
const OTHER_SECRET = ['sk', 'test', 'other', 'secret', 'fedcba9876543210fedcba9876543210'].join('-');

const PRINCIPAL: AuthPrincipal = { id: 'learner-1', roles: ['learner'] };

function signToken(payload: unknown, secret: string): string {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return `${bytes.toString('base64url')}.${createHmac('sha256', secret).update(bytes).digest('base64url')}`;
}

test('issue returns token, csrf and expiry; verify round-trips the full payload', () => {
  const manager = createSessionManager({ secret: SECRET, ttlSec: 60, now: () => new Date(1_700_000_000_000) });
  const issued = manager.issue(PRINCIPAL);
  assert.equal(issued.expiresAt, 1_700_000_000 + 60);
  assert.ok(issued.token.split('.').length === 2, 'token has payload.signature shape');

  const verified = manager.verify(issued.token);
  if (verified === null) assert.fail('expected a verified session');
  assert.equal(verified.v, 1);
  assert.equal(verified.sub, 'learner-1');
  assert.deepEqual(verified.roles, ['learner']);
  assert.equal(verified.iat, 1_700_000_000);
  assert.equal(verified.exp, issued.expiresAt);
});

test('csrf is minted with sufficient length and is stable across verifications', () => {
  const manager = createSessionManager({ secret: SECRET });
  const issued = manager.issue(PRINCIPAL);
  assert.ok(issued.csrf.length >= 16, 'csrf is at least 16 characters');
  const verified = manager.verify(issued.token);
  if (verified === null) assert.fail('expected a verified session');
  assert.equal(verified.csrf, issued.csrf);
  assert.equal(manager.verify(issued.token)?.csrf, issued.csrf);
  const other = manager.issue(PRINCIPAL);
  assert.notEqual(other.csrf, issued.csrf, 'each session gets a fresh csrf');
});

test('verify rejects a tampered token (payload or signature)', () => {
  const manager = createSessionManager({ secret: SECRET });
  const token = manager.issue(PRINCIPAL).token;
  const parts = token.split('.');
  const payload = parts[0] ?? '';
  const signature = parts[1] ?? '';
  const flipped = (value: string): string => (value.slice(0, 1) === 'A' ? 'B' : 'A') + value.slice(1);

  assert.equal(manager.verify(`${flipped(payload)}.${signature}`), null);
  const badSignature = signature.slice(0, -1) + flipped(signature.slice(-1));
  assert.equal(manager.verify(`${payload}.${badSignature}`), null);
});

test('verify rejects an expired session using an injected clock', () => {
  let clockMs = 1_700_000_000_000;
  const manager = createSessionManager({ secret: SECRET, ttlSec: 60, now: () => new Date(clockMs) });
  const token = manager.issue(PRINCIPAL).token;
  assert.notEqual(manager.verify(token), null, 'valid before expiry');
  clockMs += 61_000;
  assert.equal(manager.verify(token), null, 'rejected at/after exp');
});

test('verify rejects a token signed with a different secret', () => {
  const issuer = createSessionManager({ secret: SECRET });
  const other = createSessionManager({ secret: OTHER_SECRET });
  const token = issuer.issue(PRINCIPAL).token;
  assert.equal(other.verify(token), null);
});

test('verify rejects malformed tokens, wrong versions and missing fields', () => {
  const manager = createSessionManager({ secret: SECRET });
  assert.equal(manager.verify('not-a-token'), null);
  assert.equal(manager.verify('only.one.thing'), null);
  assert.equal(manager.verify('%%%.@@@'), null);

  const sample = manager.issue(PRINCIPAL).token;
  const decoded = JSON.parse(Buffer.from(sample.split('.')[0] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.equal(manager.verify(signToken({ ...decoded, v: 2 }, SECRET)), null);
  const missingCsrf = { ...decoded };
  delete missingCsrf['csrf'];
  assert.equal(manager.verify(signToken(missingCsrf, SECRET)), null);
});
