import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AllTiersExhaustedError, ProviderUnavailableError } from '@edugenesis/contracts';
import { createOneKeyGateway } from './gateway.js';
import { runFailoverDrill } from './failover.js';
import { createTierZeroProvider } from './providers/tier-zero.js';
import { createMockAdapter } from './testing/support.js';

test('failover drill: all five tiers are exercised and the transitions are recorded in order', async () => {
  const drill = await runFailoverDrill();

  assert.deepEqual(
    drill.transitions.map((t) => t.tier),
    [0, 1, 2, 3, 4],
    'the drill must exercise every tier of the ladder',
  );
  assert.deepEqual(
    drill.transitions.map((t) => t.outcome),
    ['no-offline-content', 'failed', 'failed', 'failed', 'served'],
  );
  assert.deepEqual(
    drill.transitions.map((t) => t.order),
    [1, 2, 3, 4, 5],
    'the transitions must be recorded in order',
  );
  assert.equal(drill.servedBy?.tier, 4, 'tier 4 (human support / deferred) must be the last resort');
  assert.ok(drill.result, 'the drill must return the delivered result');
  assert.ok(drill.result.text.length > 0, 'the learner must still get something');
  assert.equal(drill.exhausted, false);
});

test('failover drill: the routing decision under test spans the whole ladder', async () => {
  const drill = await runFailoverDrill();
  assert.deepEqual(
    drill.decision.fallbackChain.map((c) => c.tier),
    [0, 1, 2, 3, 4],
  );
});

test('failover drill: without a human-support tier the drill ends in a typed AllTiersExhaustedError', async () => {
  const gateway = createOneKeyGateway({ tierZero: createTierZeroProvider() });
  gateway.register(
    createMockAdapter({ id: 'p1', tier: 1, failWith: new ProviderUnavailableError('p1', 'boom') }).adapter,
  );
  gateway.register(
    createMockAdapter({ id: 'p2', tier: 2, failWith: new ProviderUnavailableError('p2', 'boom') }).adapter,
  );

  const drill = await runFailoverDrill({ gateway });

  assert.equal(drill.exhausted, true);
  assert.ok(drill.error instanceof AllTiersExhaustedError, 'the failure must be typed');
  assert.deepEqual(
    drill.error.attempts.map((a) => a.tier),
    [0, 1, 2, 4],
  );
});
