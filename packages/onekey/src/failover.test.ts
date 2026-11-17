import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AllTiersExhaustedError } from '@edugenesis/contracts';
import { DEFERRED_RESPONSE_TEXT, runFailoverDrill, runFailoverScenario } from './failover.js';
import { TIER_ZERO_FALLBACK_NOTICE, TIER_ZERO_FALLBACK_UNRELATED_NOTICE, createTierZeroProvider } from './providers/tier-zero.js';
import { createPolicy, createRequest } from './testing/support.js';

test('tier 0: a fallback with no topical overlap does not claim the lesson covers the topic', async () => {
  const provider = createTierZeroProvider();

  const result = await provider.serveFallback(
    createPolicy(),
    createRequest({ prompt: 'Explain the water cycle' }),
  );

  assert.ok(result !== null, 'the learner must still receive a lesson — the promise is that a learner is never denied');
  assert.ok(
    !result.text.startsWith(TIER_ZERO_FALLBACK_NOTICE),
    'a lesson that shares no word with the task must not claim to cover the topic',
  );
  assert.ok(
    result.text.startsWith(TIER_ZERO_FALLBACK_UNRELATED_NOTICE),
    'the honest notice must be used when there is no topical match',
  );
});

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

test('failover drill: no-human-support — with no human tier the trail records a failure, not a deferral', async () => {
  // F3-20. The audit trail is the evidence the sponsor reads. It may only say
  // "deferred to human support" when a human tier EXISTS AND TOOK the work.
  const drill = await runFailoverScenario({ scenario: 'no-human-support' });

  assert.equal(drill.exhausted, true, 'with nothing to serve the request, the ladder is exhausted');
  const last = drill.transitions[drill.transitions.length - 1];
  assert.equal(last?.outcome, 'failed', 'no human took the work, so nothing was deferred');
  assert.doesNotMatch(
    last?.reason ?? '',
    /deferred to human support/i,
    'the trail must not claim a human was asked when no human tier exists',
  );
});

test('failover drill: the Tier 0 lesson states that core learning continues and that sponsors are notified', async () => {
  // F3-17. Doc 16 §6.6 step 6: the learner-facing message must state that
  // core learning continues and that sponsors are being notified — never that
  // credits ran out or that a provider failed. The old notice said neither,
  // and it framed the lesson as material pulled from an "offline library",
  // which is the degraded framing the spec forbids.
  const drill = await runFailoverScenario({ scenario: 'offline-rescue' });
  const text = drill.result?.text ?? '';

  assert.match(
    text,
    /core learning continues/i,
    '§6.6 step 6 requires the message to say that core learning continues',
  );
  assert.match(
    text,
    /sponsors?[^.]*notified/i,
    '§6.6 step 6 also requires the sponsor-notification clause',
  );
  assert.doesNotMatch(
    text,
    /provider|quota|credit|outage|\b401\b|\b403\b/i,
    'the learner must never see operations vocabulary',
  );
  assert.doesNotMatch(
    text,
    /offline|library|may not answer|apolog|sorry|unfortunately/i,
    'the message must not apologise for itself or frame the lesson as degraded material',
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
