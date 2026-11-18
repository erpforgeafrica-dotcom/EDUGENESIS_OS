import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthStore } from './auth-store.js';

test('register returns the principal, stores roles, and rejects duplicates', () => {
  const store = createAuthStore();
  try {
    const principal = store.register({ id: 'u1', password: 'pw', roles: ['learner'] });
    assert.deepEqual(principal, { id: 'u1', roles: ['learner'] });
    assert.deepEqual(store.rolesOf('u1'), ['learner']);
    assert.equal(store.rolesOf('missing'), undefined);
    assert.throws(() => store.register({ id: 'u1', password: 'pw2', roles: ['sponsor'] }));
  } finally {
    store.close();
  }
});

test('authenticate succeeds with the right password and fails for wrong/unknown ids', () => {
  const store = createAuthStore();
  try {
    store.register({ id: 'u2', password: 'correct', roles: ['guardian'] });
    const ok = store.authenticate('u2', 'correct');
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.principal.id, 'u2');
      assert.deepEqual(ok.principal.roles, ['guardian']);
    }

    const bad = store.authenticate('u2', 'wrong');
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.locked, false);

    const unknown = store.authenticate('ghost', 'pw');
    assert.equal(unknown.ok, false);
  } finally {
    store.close();
  }
});

test('lockout engages after the threshold and resets after lockoutMs with an injected clock', () => {
  let clockMs = 1_700_000_000_000;
  const store = createAuthStore({
    now: () => new Date(clockMs),
    lockoutThreshold: 2,
    lockoutMs: 5_000,
  });
  try {
    store.register({ id: 'u3', password: 'right', roles: ['learner'] });

    const first = store.authenticate('u3', 'bad');
    assert.equal(first.ok, false);
    if (!first.ok) assert.equal(first.locked, false);
    assert.equal(store.isLocked('u3'), false);

    const second = store.authenticate('u3', 'bad');
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.locked, true);
    assert.equal(store.isLocked('u3'), true);

    // A correct password is refused while locked: lockout is checked first.
    const whileLocked = store.authenticate('u3', 'right');
    assert.equal(whileLocked.ok, false);
    if (!whileLocked.ok) assert.equal(whileLocked.locked, true);

    clockMs += 6_000;
    assert.equal(store.isLocked('u3'), false);
    const afterExpiry = store.authenticate('u3', 'right');
    assert.equal(afterExpiry.ok, true);
  } finally {
    store.close();
  }
});

test('audit events persist with increasing seq, honour at, and ordered retrieval', () => {
  const store = createAuthStore({ now: () => new Date(1_700_000_000_000) });
  try {
    store.register({ id: 'u4', password: 'pw', roles: ['learner'] });
    store.auditEvent({ actor: 'alice', action: 'login', target: 'u4', outcome: 'ok' });
    store.auditEvent({
      actor: 'alice',
      action: 'grant',
      target: 'u4',
      outcome: 'ok',
      at: '2026-01-01T00:00:00.000Z',
    });
    store.grantRole('u4', 'sponsor');
    assert.deepEqual(store.rolesOf('u4'), ['learner', 'sponsor']);

    const trail = store.auditTrail();
    assert.ok(trail.length >= 3);
    for (let i = 1; i < trail.length; i += 1) {
      assert.ok((trail[i]?.seq ?? 0) > (trail[i - 1]?.seq ?? 0), 'seq strictly increases');
    }
    assert.equal(trail[0]?.action, 'login');
    assert.equal(trail[1]?.action, 'grant');
    assert.equal(trail[1]?.at, '2026-01-01T00:00:00.000Z');
    assert.equal(trail[trail.length - 1]?.action, 'grantRole');
    assert.equal(trail[trail.length - 1]?.target, 'u4');
  } finally {
    store.close();
  }
});

test('dataDir creates the directory and persists principals and audit across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eg-auth-'));
  try {
    const first = createAuthStore({ dataDir: dir });
    assert.equal(existsSync(join(dir, 'auth.sqlite')), true);
    first.register({ id: 'p', password: 'pw', roles: ['auditor'] });
    first.auditEvent({ actor: 'x', action: 'a', outcome: 'ok' });
    first.close();

    const second = createAuthStore({ dataDir: dir });
    assert.deepEqual(second.rolesOf('p'), ['auditor']);
    assert.equal(second.authenticate('p', 'pw').ok, true);
    assert.equal(second.auditTrail().length, 1);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
