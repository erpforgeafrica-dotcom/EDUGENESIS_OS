import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate, renderReleaseRecord } from './release.mjs';

const green = { verifyExit: 0, reproExit: 0, ciLocalExit: 0, ciLocalPartial: false };

test('all three gates green allows the release', () => {
  assert.deepEqual(evaluateGate(green), { allowed: true, reason: 'verify, verify:repro and ci:local are green.' });
});
test('a failed verify refuses', () => {
  assert.equal(evaluateGate({ ...green, verifyExit: 1 }).allowed, false);
});
test('a failed repro refuses', () => {
  assert.equal(evaluateGate({ ...green, reproExit: 1 }).allowed, false);
});
test('a failed ci:local refuses', () => {
  assert.equal(evaluateGate({ ...green, ciLocalExit: 1 }).allowed, false);
});
test('a partial ci:local refuses even when all exits are zero', () => {
  assert.equal(evaluateGate({ ...green, ciLocalPartial: true }).allowed, false);
});
test('the release record is deterministic and names no secret', () => {
  const a = renderReleaseRecord({ commit: 'abc', deployId: 'dep-1', status: 'live', probe: 'pass' });
  const b = renderReleaseRecord({ commit: 'abc', deployId: 'dep-1', status: 'live', probe: 'pass' });
  assert.equal(a, b);
  assert.ok(!/rnd_|sk-|Bearer/.test(a));
  assert.ok(a.includes('"commit": "abc"'));
});
