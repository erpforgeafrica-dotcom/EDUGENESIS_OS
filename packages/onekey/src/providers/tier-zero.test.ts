import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTierZeroProvider } from './tier-zero.js';
import { createPolicy, createRequest } from '../testing/support.js';

test('tier zero: serves cached curriculum deterministically', async () => {
  const tz = createTierZeroProvider();
  const policy = createPolicy({ taskClass: 'explain' });
  const req = createRequest({ prompt: 'Explain curriculum:algebra/linear-eq' });
  const first = await tz.serve(policy, req);
  const second = await tz.serve(policy, req);
  assert.ok(first, 'expected a cached curriculum answer');
  assert.equal(first.text, second?.text);
  assert.ok(first.text.length > 0);
  assert.ok(first.sourceLineage.length > 0, 'a cached answer must carry source lineage');
  assert.ok(first.sourceLineage[0]?.licence, 'source lineage must carry a licence');
});

test('tier zero: returns null when it has nothing for the task', async () => {
  const tz = createTierZeroProvider();
  const result = await tz.serve(
    createPolicy({ taskClass: 'research' }),
    createRequest({ prompt: 'Research quantum cryptography' }),
  );
  assert.equal(result, null, 'the gateway must be able to escalate when tier 0 has nothing');
});

test('tier zero: returns null for a curriculum id it does not hold', async () => {
  const tz = createTierZeroProvider();
  const result = await tz.serve(
    createPolicy({ taskClass: 'explain' }),
    createRequest({ prompt: 'Explain curriculum:unknown/atom' }),
  );
  assert.equal(result, null);
});

test('tier zero: lists the offline bundle ids available', () => {
  const tz = createTierZeroProvider();
  const bundles = tz.bundles();
  assert.ok(bundles.length > 0, 'expected at least one offline bundle id');
  assert.equal(new Set(bundles).size, bundles.length, 'bundle ids must be unique');
});
