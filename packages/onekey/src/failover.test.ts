import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AllTiersExhaustedError } from '@edugenesis/contracts';
import { DEFERRED_RESPONSE_TEXT, runFailoverDrill, runFailoverScenario } from './failover.js';
import { TIER_ZERO_FALLBACK_NOTICE } from './providers/tier-zero.js';

test('failover drill: offline-rescue — every model fails and Tier 0 serves a learner', async () => {
  const drill = await runFailoverScenario({ scenario: 'offline-rescue' });

  assert.deepEqual(
    drill.transitions.map((t) => t.tier),
    [0, 1, 2, 3, 0],
    'the exact Tier 0 miss, the three model tiers, then the Tier 0 last resort',
  );
  assert.deepEqual(
    drill.transitions.map((t) => t.outcome),
    ['no-offline-content', 'failed', 'failed', 'failed', 'served'],
    'Tier 0 must be attempted first, missed, and then serve after the models fail',
  );
  assert.deepEqual(
    drill.transitions.map((t) => t.order),
    [1, 2, 3, 4, 5],
    'the transitions must be recorded in order',
  );
  assert.equal(
    drill.servedBy?.tier,
    0,
    'Tier 0 (no provider at all) must be the tier that rescues the learner',
  );
  assert.equal(drill.exhausted, false);
  assert.ok(drill.result, 'the drill must return the delivered result');
  assert.equal(drill.result.meta.servedOffline, true, 'the answer must be marked offline');
  assert.ok(
    drill.result.text.startsWith(TIER_ZERO_FALLBACK_NOTICE),
    'the learner must receive the neutral offline-library notice, not a provider error',
  );
  assert.ok(
    drill.result.text.includes('linear equation'),
    'the cached lesson must be the topically relevant one, not an arbitrary entry',
  );
  assert.ok(
    !/provider|quota|credit|outage|401|403/i.test(drill.result.text),
    'a provider outage is an operations event: the learner-facing text must stay neutral',
  );
});

test('failover drill: the routing decision under test spans the whole ladder', async () => {
  const drill = await runFailoverScenario({ scenario: 'offline-rescue' });
  assert.deepEqual(
    drill.decision.fallbackChain.map((c) => c.tier),
    [0, 1, 2, 3, 4],
  );
});

test('failover drill: human-deferral — no cached lesson exists, so Tier 4 defers', async () => {
  const drill = await runFailoverScenario({ scenario: 'human-deferral' });

  assert.deepEqual(
    drill.transitions.map((t) => t.tier),
    [0, 1, 2, 3, 0, 4],
    'both Tier 0 visits must miss before the request is deferred',
  );
  assert.deepEqual(
    drill.transitions.map((t) => t.outcome),
    ['no-offline-content', 'failed', 'failed', 'failed', 'no-offline-content', 'served'],
  );
  assert.equal(drill.servedBy?.tier, 4, 'Tier 4 is the last resort when nothing can teach');
  assert.equal(drill.result?.text, DEFERRED_RESPONSE_TEXT);
  assert.equal(drill.exhausted, false);
});

test('failover drill: exhausted — no Tier 0 and no Tier 4 raises a typed error', async () => {
  const drill = await runFailoverScenario({ scenario: 'exhausted' });

  assert.equal(drill.exhausted, true);
  assert.ok(drill.error instanceof AllTiersExhaustedError, 'the failure must be typed');
  assert.deepEqual(
    drill.transitions.map((t) => t.tier),
    [0, 1, 2, 3, 4],
    'the trail must name every rung that was tried',
  );
  assert.deepEqual(
    drill.transitions.map((t) => t.outcome),
    ['skipped', 'failed', 'failed', 'failed', 'deferred'],
    'with no offline tier the first rung is skipped, not silently omitted',
  );
  assert.deepEqual(
    drill.error.attempts.map((a) => a.tier),
    [0, 1, 2, 3, 4],
    'the typed error must carry the full ladder',
  );
});

test('failover drill: the documented report exercises all five tiers and the §6.6 rescue', async () => {
  const report = await runFailoverDrill();

  assert.deepEqual(
    report.tiersExercised,
    [0, 1, 2, 3, 4],
    'the documented drill must reach every tier across its scenarios',
  );
  assert.equal(
    report.scenarios['offline-rescue'].servedBy?.tier,
    0,
    'the §6.6 rescue scenario must be served by Tier 0',
  );
  assert.equal(
    report.scenarios['human-deferral'].servedBy?.tier,
    4,
    'with nothing cached, Tier 4 must defer rather than fail',
  );
  assert.equal(
    report.scenarios.exhausted.exhausted,
    true,
    'the negative control must report an exhausted ladder',
  );
});
