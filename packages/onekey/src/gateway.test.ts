import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AllTiersExhaustedError,
  BudgetExceededError,
  ContractViolation,
  ProviderUnavailableError,
} from '@edugenesis/contracts';
import { createAccessibilityGuardian, createAccessibilityValidator } from '@edugenesis/accessibility';
import { createBudgetLedger } from './budget.js';
import { createOneKeyGateway } from './gateway.js';
import { createLocalEchoProvider } from './providers/local-echo.js';
import { createTierZeroProvider } from './providers/tier-zero.js';
import { createBlockingGuardian, createContext, createMockAdapter, createPolicy, createRequest, createSource } from './testing/support.js';
import { createKillSwitch } from './kill-switch.js';
import { ProviderCredentialRevokedError, ProviderRateLimitedError } from './provider-errors.js';
import type { OneKeyGatewayImpl } from './gateway.js';

/** The real interception point a learner's request runs. */
function realGuardian() {
  return createAccessibilityGuardian(createAccessibilityValidator());
}

/** A request the offline curriculum bundle CAN answer. */
const OFFLINE_PROMPT = 'Explain curriculum:algebra/linear-eq';
/** A request the offline bundle has nothing for — the paid ladder must run. */
const LIVE_PROMPT = 'Explain photosynthesis in simple terms';

function gateway(opts: { tierZero?: boolean } = {}): OneKeyGatewayImpl {
  return createOneKeyGateway({
    tierZero: opts.tierZero === false ? undefined : createTierZeroProvider(),
    policyVersion: 'policy-test-1',
  });
}

test('gateway: it routes to the eligible provider and records the metadata', async () => {
  const g = gateway();
  const provider = createMockAdapter({ id: 'p1', modelId: 'm1', tier: 1 });
  g.register(provider.adapter);

  const result = await g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), createContext());

  assert.equal(result.providerId, 'p1');
  assert.equal(result.modelId, 'm1');
  assert.ok(result.text.length > 0);
  assert.equal(result.meta.tier, 1);
  assert.equal(result.meta.policyVersion, 'policy-test-1');
  assert.equal(result.meta.servedOffline, false);
  assert.equal(result.meta.budgetPoolId, 'pool-test');
  assert.ok(result.meta.policyReason.length > 0, 'the policy trace must be recorded on the result');
  assert.equal(provider.calls(), 1);
});

test('gateway: on provider failure it walks the fallback chain down the tiers', async () => {
  const g = gateway();
  const primary = createMockAdapter({ id: 'p1', tier: 1, failWith: new ProviderUnavailableError('p1', 'boom') });
  const secondary = createMockAdapter({ id: 'p2', tier: 2, modelId: 'm2' });
  g.register(primary.adapter);
  g.register(secondary.adapter);

  const result = await g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), createContext());

  assert.equal(result.providerId, 'p2', 'the next tier down must serve the request');
  const attempts = g.attemptsFor('req-test');
  const outcomes = attempts.map((a) => `${a.tier}:${a.outcome}`);
  assert.deepEqual(outcomes, ['0:no-offline-content', '1:failed', '2:served']);
});

test('gateway: a provider that answers with no text is a failure, not a lesson', async () => {
  const g = gateway();
  const empty = createMockAdapter({ id: 'p1', tier: 1, text: '' });
  const healthy = createMockAdapter({ id: 'p2', tier: 2, modelId: 'm2' });
  g.register(empty.adapter);
  g.register(healthy.adapter);

  const result = await g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), createContext());

  assert.equal(result.providerId, 'p2', 'an empty answer must never be delivered to the learner');
  assert.ok(result.text.length > 0, 'the learner must receive real content');
  assert.deepEqual(
    g.attemptsFor('req-test').map((a) => `${a.tier}:${a.outcome}`),
    ['0:no-offline-content', '1:failed', '2:served'],
    'the empty answer must be recorded as a FAILED attempt, never as a served one',
  );
});

test('gateway: a provider that reports no usage never throws an untyped error out of complete()', async () => {
  const g = gateway();
  const noUsage = createMockAdapter({ id: 'p1', tier: 1, usage: { inputTokens: 0, outputTokens: 0 } });
  const healthy = createMockAdapter({ id: 'p2', tier: 2, modelId: 'm2' });
  g.register(noUsage.adapter);
  g.register(healthy.adapter);

  // Before the fix the budget ledger refused a zero-unit charge with a plain
  // Error, which escaped complete() and bypassed the whole fallback ladder.
  const result = await g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), createContext());

  assert.equal(result.providerId, 'p2', 'the request must fall through to the next tier');
  assert.ok(result.text.length > 0, 'the learner must receive real content');
  assert.deepEqual(
    g.attemptsFor('req-test').map((a) => `${a.tier}:${a.outcome}`),
    ['0:no-offline-content', '1:failed', '2:served'],
    'the uncostable answer must be recorded as a FAILED attempt',
  );
});

test('gateway: with every paid tier failing, tier 0 serves the learner — after the models were really tried', async () => {
  const g = gateway();
  const t1 = createMockAdapter({ id: 'p1', tier: 1, failWith: new ProviderUnavailableError('p1', 'boom') });
  const t2 = createMockAdapter({ id: 'p2', tier: 2, failWith: new ProviderUnavailableError('p2', 'boom') });
  const t3 = createMockAdapter({ id: 'p3', tier: 3, failWith: new ProviderUnavailableError('p3', 'boom') });
  g.register(t1.adapter);
  g.register(t2.adapter);
  g.register(t3.adapter);

  // LIVE_PROMPT carries no `curriculum:` reference, so Tier 0 misses first and
  // the paid ladder genuinely runs. learnerFacing + the REAL guardian prove the
  // learner-facing path rather than bypassing it.
  const result = await g.complete(
    createPolicy(),
    createRequest({ prompt: LIVE_PROMPT }),
    createContext({ learnerFacing: true, guardian: realGuardian() }),
  );

  assert.equal(t1.calls(), 1, 'the primary must actually be called');
  assert.equal(t2.calls(), 1, 'the secondary must actually be called');
  assert.equal(t3.calls(), 1, 'the local tier must actually be called');
  assert.ok(result.text.length > 0, 'the learner must still get an answer');
  assert.equal(result.meta.tier, 0);
  assert.equal(result.meta.servedOffline, true);
  assert.equal(result.meta.providerId, 'tier-zero');
  assert.deepEqual(
    g.attemptsFor('req-test').map((a) => `${a.tier}:${a.outcome}`),
    ['0:no-offline-content', '1:failed', '2:failed', '3:failed', '0:served'],
    'Tier 0 must be missed first and serve last, in that order',
  );
});

test('gateway: with every paid tier failing and no offline tier, the failure is typed, never silent', async () => {
  const g = gateway({ tierZero: false });
  g.register(createMockAdapter({ id: 'p1', tier: 1, failWith: new ProviderUnavailableError('p1', 'boom') }).adapter);
  g.register(createMockAdapter({ id: 'p2', tier: 2, failWith: new ProviderUnavailableError('p2', 'boom') }).adapter);
  g.register(createMockAdapter({ id: 'p3', tier: 3, failWith: new ProviderUnavailableError('p3', 'boom') }).adapter);

  await assert.rejects(
    () => g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), createContext()),
    (err: unknown) => {
      assert.ok(err instanceof AllTiersExhaustedError, 'expected AllTiersExhaustedError');
      const tiers = err.attempts.map((a) => a.tier);
      assert.deepEqual(tiers, [0, 1, 2, 3, 4], 'the whole ladder must be recorded');
      return true;
    },
  );
});

test('gateway: a kill reason that carries a credential is redacted everywhere it is recorded', async () => {
  const ks = createKillSwitch();
  // A synthetic, non-functional key shape. It is long enough for the
  // redaction rule to match and short enough that the secrets scan does not
  // treat the fixture as a real credential.
  const secret = 'sk-LIVESECRET-do-not-use-000000';
  ks.killSwitch('p1', `the provider key ${secret} was rotated during the incident`);
  const g = createOneKeyGateway({ killSwitch: ks, policyVersion: 'policy-test-1' });
  g.register(createMockAdapter({ id: 'p1', tier: 1 }).adapter);
  g.register(createMockAdapter({ id: 'p2', tier: 2, modelId: 'm2' }).adapter);

  const result = await g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), createContext());

  assert.ok(result.text.length > 0, 'the learner must still be served');
  const trail = JSON.stringify(g.attemptsFor('req-test'));
  assert.ok(!trail.includes(secret), 'the attempt trail must not carry the credential from the kill reason');
  const delivered = JSON.stringify(result);
  assert.ok(!delivered.includes(secret), 'the delivered result must not carry the credential from the kill reason');
  assert.ok(
    JSON.stringify(result.meta).includes('redacted') || !JSON.stringify(result.meta).includes('LIVESECRET'),
    'the recorded policy trace must not contain the raw key fragment',
  );
});

test('gateway: a request that under-declares its data class cannot reach a provider cleared for less', async () => {
  const g = gateway();
  // The provider is cleared for `public` only.
  const provider = createMockAdapter({ id: 'p1', tier: 1, maxDataClass: 'public' });
  g.register(provider.adapter);

  const result = await g.complete(
    // The SERVER-SIDE policy classifies this task as learner_scoped; the
    // request claims public. A caller is never trusted to under-declare.
    createPolicy({ dataClass: 'learner_scoped' }),
    createRequest({ prompt: LIVE_PROMPT, dataClass: 'public' }),
    createContext(),
  );

  assert.equal(provider.calls(), 0, 'a provider cleared only for public must not be called for a learner_scoped task');
  assert.ok(result.text.length > 0, 'the learner must still be served');
  assert.equal(result.meta.servedOffline, true, 'the deterministic offline tier must answer');
  assert.ok(
    result.meta.policyReason.includes('learner_scoped'),
    `the policy trace must record the effective data class, not the request's own claim: ${result.meta.policyReason}`,
  );
});

test('gateway: with the budget at zero, the real learner path still returns a tier 0 lesson', async () => {
  const g = gateway();
  const paid = createMockAdapter({ id: 'p1', tier: 1 });
  g.register(paid.adapter);
  const budget = createBudgetLedger('pool-test', 100, 'token');
  budget.consume(100);

  const result = await g.complete(
    createPolicy(),
    // No `curriculum:` reference: the exact Tier 0 floor misses, so this
    // exercises the last-resort rung a credit-exhausted learner depends on.
    createRequest({ prompt: LIVE_PROMPT }),
    createContext({ budget, learnerFacing: true, guardian: realGuardian() }),
  );

  assert.ok(result.text.length > 0, 'core learning must never be denied on credit exhaustion');
  assert.equal(result.meta.tier, 0);
  assert.equal(result.meta.servedOffline, true);
  assert.ok(
    result.sourceLineage.some((source) => source.sourceId === 'science/photosynthesis'),
    'the served lesson must be the topically relevant entry, not an arbitrary one',
  );
  assert.equal(paid.calls(), 0, 'a provider with no budget must not be called');
});

test('gateway: a real learner-facing emission passes the real validator and is delivered', async () => {
  const g = gateway();
  const text = 'Photosynthesis turns light energy into chemical energy inside the leaf.';
  g.register(createMockAdapter({ id: 'p1', tier: 1, text }).adapter);

  const result = await g.complete(
    createPolicy(),
    createRequest({ prompt: LIVE_PROMPT }),
    createContext({ learnerFacing: true, guardian: realGuardian() }),
  );

  assert.equal(result.text, text, 'the real validator must not block a valid emission');
  assert.equal(result.meta.tier, 1);
});

test('gateway: a rejecting equivalence verifier withholds the emission instead of claiming equivalence', async () => {
  const g = createOneKeyGateway({
    tierZero: createTierZeroProvider(),
    policyVersion: 'policy-test-1',
    equivalenceVerifier: () => ({ ok: false, missing: ['text path'] }),
  });
  g.register(createMockAdapter({ id: 'p1', tier: 1 }).adapter);

  await assert.rejects(
    () =>
      g.complete(
        createPolicy(),
        createRequest({ prompt: LIVE_PROMPT }),
        createContext({ learnerFacing: true, guardian: realGuardian() }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof ContractViolation, 'expected a typed ContractViolation');
      assert.ok(
        err.violations.some((violation) => violation.id === 'ARC-I1'),
        'ARC-I1 must name the failed equivalence claim',
      );
      return true;
    },
  );
});

test('gateway: a killed provider is never called again', async () => {
  const g = gateway();
  const killed = createMockAdapter({ id: 'p1', tier: 1 });
  const healthy = createMockAdapter({ id: 'p2', tier: 2 });
  g.register(killed.adapter);
  g.register(healthy.adapter);
  g.killSwitch('p1', 'safety incident INC-9');

  const result = await g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), createContext());

  assert.equal(killed.calls(), 0, 'a killed provider must never be called');
  assert.equal(result.providerId, 'p2');
  assert.equal(g.circuitState('p1'), 'closed');
});

test('gateway: a learner-facing result is run through the guardian and the delivered text is returned', async () => {
  const g = gateway();
  g.register(createMockAdapter({ id: 'p1', tier: 1 }).adapter);
  const ctx = createContext({
    learnerFacing: true,
    guardian: {
      async intercept(emission) {
        return {
          deliver: true,
          violations: [],
          emission: {
            ...emission,
            accessible_alternative: { ...emission.accessible_alternative, text: 'DELIVERED BY GUARDIAN' },
          },
        };
      },
    },
  });

  const result = await g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), ctx);

  assert.equal(result.text, 'DELIVERED BY GUARDIAN', 'the returned text must be the post-guardian emission');
});

test('gateway: a blocked emission is never delivered', async () => {
  const g = gateway();
  g.register(createMockAdapter({ id: 'p1', tier: 1 }).adapter);
  const ctx = createContext({ learnerFacing: true, guardian: createBlockingGuardian() });

  await assert.rejects(
    () => g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), ctx),
    (err: unknown) => {
      assert.ok(err instanceof ContractViolation, 'expected a typed ContractViolation');
      assert.ok(err.violations.length > 0);
      return true;
    },
  );
});

test('gateway: it charges the budget for a paid provider and records the entry', async () => {
  const g = gateway();
  g.register(createMockAdapter({ id: 'p1', tier: 1 }).adapter);
  const budget = createBudgetLedger('pool-test', 10_000, 'token');
  const ctx = createContext({ budget });

  await g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), ctx);

  assert.ok(budget.consumedUnits > 0, 'a paid completion must be charged');
  const snapshot = budget.snapshot();
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0]?.providerId, 'p1');
  assert.equal(snapshot.entries[0]?.requestId, 'req-test');
});

test('gateway: an offline tier 0 answer costs nothing', async () => {
  const g = gateway();
  const budget = createBudgetLedger('pool-test', 10_000, 'token');
  const ctx = createContext({ budget });

  await g.complete(createPolicy(), createRequest({ prompt: OFFLINE_PROMPT }), ctx);

  assert.equal(budget.consumedUnits, 0, 'offline cached curriculum must not consume credit');
});

test('gateway: the routing decision exposes the full five-tier ladder', async () => {
  const g = gateway();
  g.register(createMockAdapter({ id: 'p1', tier: 1 }).adapter);
  g.register(createMockAdapter({ id: 'p2', tier: 2 }).adapter);
  g.register(createMockAdapter({ id: 'p3', tier: 3 }).adapter);

  const decision = await g.route(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), createContext());

  assert.deepEqual(
    decision.fallbackChain.map((c) => c.tier),
    [0, 1, 2, 3, 4],
  );
});

test('gateway: a provider that refuses on budget falls through to the next tier', async () => {
  const g = gateway();
  const budget = createBudgetLedger('pool-test', 10_000, 'token');
  const refusing = createMockAdapter({
    id: 'p1',
    tier: 1,
    // The provider is healthy; the pool cannot pay for this call.
    failWith: new BudgetExceededError('pool-test', 500, 0),
  });
  const next = createMockAdapter({ id: 'p2', tier: 2 });
  g.register(refusing.adapter);
  g.register(next.adapter);

  const result = await g.complete(
    createPolicy(),
    createRequest({ prompt: LIVE_PROMPT }),
    createContext({ budget }),
  );

  assert.equal(result.providerId, 'p2', 'a budget refusal must not abort the request');
  const outcomes = g.attemptsFor('req-test').map((a) => `${a.tier}:${a.outcome}`);
  assert.deepEqual(outcomes, ['0:no-offline-content', '1:skipped', '2:served']);
  assert.equal(g.circuitState('p1'), 'closed', 'a budget refusal must not trip the provider circuit');
});

test('gateway: a 429 leaves the circuit closed — a rate limit is not a health failure', async () => {
  // F3-13. A throttle arrives exactly when the provider is busiest and most
  // needed. Before the fix every non-budget failure called
  // breaker.recordFailure(), so three throttles opened the circuit and the
  // provider was removed from routing under load.
  const g = gateway();
  const throttled = createMockAdapter({
    id: 'p1',
    tier: 1,
    failWith: new ProviderRateLimitedError('p1', 'the provider is rate limited (HTTP 429)'),
  });
  const next = createMockAdapter({ id: 'p2', tier: 2 });
  g.register(throttled.adapter);
  g.register(next.adapter);

  const result = await g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), createContext());

  assert.equal(result.providerId, 'p2', 'a throttled provider must fall through to the next tier');
  assert.equal(g.circuitState('p1'), 'closed', 'a 429 must not open the health circuit');
  assert.deepEqual(
    g.attemptsFor('req-test').map((a) => `${a.tier}:${a.outcome}`),
    ['0:no-offline-content', '1:skipped', '2:served'],
    'a throttled provider is a skipped rung, not a failed one',
  );
});

test('gateway: a revoked credential is a governance failure, never a health failure', async () => {
  // F3-14. The provider is not sick — the credential is dead. The failure is a
  // governance event (rotate the key, review the incident), it must not be
  // counted towards the health circuit, and the provider must not be retried.
  const g = gateway();
  const revoked = createMockAdapter({
    id: 'p1',
    tier: 1,
    failWith: new ProviderCredentialRevokedError('p1', 'the provider rejected the credential (HTTP 401)'),
  });
  const next = createMockAdapter({ id: 'p2', tier: 2 });
  g.register(revoked.adapter);
  g.register(next.adapter);

  const result = await g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), createContext());

  assert.equal(result.providerId, 'p2', 'the request must fall through to the next tier');
  assert.equal(g.circuitState('p1'), 'closed', 'a rejected credential is not a provider outage');
  assert.deepEqual(
    g.attemptsFor('req-test').map((a) => `${a.tier}:${a.outcome}`),
    ['0:no-offline-content', '1:governance-failed', '2:served'],
    'the attempt must be recorded as a governance failure, not a generic provider failure',
  );
  assert.equal(revoked.calls(), 1, 'a provider whose credential was revoked must not be retried');
});

test('gateway: no handler means no deferral claim', async () => {
  // F3-20. After every tier fails, the gateway used to record tier 4 as
  // "deferred to human support" whether or not a human tier existed. The
  // trail is the audit evidence for the sponsor: it must describe what
  // actually happened, and no human was ever asked here.
  const g = createOneKeyGateway({ policyVersion: 'policy-test-1' });
  g.register(
    createMockAdapter({ id: 'p1', tier: 1, failWith: new ProviderUnavailableError('p1', 'boom') }).adapter,
  );

  await assert.rejects(
    () => g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), createContext()),
    (err: unknown) => {
      assert.ok(err instanceof AllTiersExhaustedError, 'the failure must stay typed');
      const tierFour = err.attempts.find((attempt) => attempt.tier === 4);
      assert.ok(tierFour, 'the tier 4 rung must still be recorded');
      assert.doesNotMatch(
        tierFour.reason,
        /deferred to human support/i,
        'no human was asked, so the trail must not claim one was',
      );
      return true;
    },
  );

  const tierFour = g.attemptsFor('req-test').find((attempt) => attempt.tier === 4);
  assert.ok(tierFour, 'the tier 4 rung must be recorded on the trail');
  assert.equal(
    tierFour.outcome,
    'failed',
    'with no handler there is no deferral — the request failed, and the trail must say so',
  );
});

test('gateway: a tier 4 handler that declines the work records a failure, not a deferral', async () => {
  const g = createOneKeyGateway({
    policyVersion: 'policy-test-1',
    tierFour: {
      async serve() {
        return null;
      },
    },
  });
  g.register(
    createMockAdapter({ id: 'p1', tier: 1, failWith: new ProviderUnavailableError('p1', 'boom') }).adapter,
  );

  await assert.rejects(
    () => g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), createContext()),
    (err: unknown) => err instanceof AllTiersExhaustedError,
  );

  const tierFour = g.attemptsFor('req-test').find((attempt) => attempt.tier === 4);
  assert.equal(
    tierFour?.outcome,
    'failed',
    'a human tier that did not take the work did not defer it',
  );
});

test('gateway: a tier 4 handler that accepts the work records the deferral', async () => {
  const g = createOneKeyGateway({
    policyVersion: 'policy-test-1',
    tierFour: {
      async serve() {
        return null;
      },
      async accept() {
        return true;
      },
    },
  });
  g.register(
    createMockAdapter({ id: 'p1', tier: 1, failWith: new ProviderUnavailableError('p1', 'boom') }).adapter,
  );

  await assert.rejects(
    () => g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), createContext()),
    (err: unknown) => err instanceof AllTiersExhaustedError,
  );

  const tierFour = g.attemptsFor('req-test').find((attempt) => attempt.tier === 4);
  assert.equal(
    tierFour?.outcome,
    'deferred',
    'a human took the work, so the deferral is true and may be recorded',
  );
});

test('gateway: the onAttempt hook receives every rung of the ladder as it happens', async () => {
  // The hook exists so a deployment can stream the audit trail live. A hook
  // nobody sets is an API surface that looks live and is not, so the wiring
  // is proven here: the hook fires per attempt, in order, with the outcome
  // the ladder recorded.
  const seen: { tier: number; providerId: string; outcome: string }[] = [];
  const g = createOneKeyGateway({
    tierZero: createTierZeroProvider(),
    onAttempt: (attempt) => {
      seen.push({ tier: attempt.tier, providerId: attempt.providerId, outcome: attempt.outcome });
    },
  });
  g.register(
    createMockAdapter({ id: 'p1', tier: 1, failWith: new ProviderUnavailableError('p1', 'boom') }).adapter,
  );
  g.register(createMockAdapter({ id: 'p2', tier: 2 }).adapter);

  await g.complete(createPolicy(), createRequest({ prompt: LIVE_PROMPT }), createContext());

  assert.deepEqual(
    seen.map((a) => `${a.tier}:${a.outcome}`),
    ['0:no-offline-content', '1:failed', '2:served'],
    'the hook must see every attempt, in order, as it happens',
  );
  assert.equal(seen[1]?.providerId, 'p1');
});

test('gateway: the provenance a provider reports reaches the caller unchanged', async () => {
  // Where an answer came from is part of the answer. The gateway must not
  // drop, rename or summarise a provider's source lineage on its way out.
  const lineage = [
    createSource({
      sourceId: 'oer-solar-001',
      locator: 'https://example.org/open-solar-guide',
      licence: 'CC-BY-4.0',
    }),
  ];
  const g = gateway();
  g.register(createMockAdapter({ id: 'p1', tier: 1, sourceLineage: lineage }).adapter);

  const result = await g.complete(
    createPolicy(),
    createRequest({ prompt: LIVE_PROMPT }),
    createContext({ learnerFacing: true, guardian: realGuardian() }),
  );

  assert.deepEqual(result.sourceLineage, lineage, 'the source lineage must survive the routing');
  assert.equal(result.sourceLineage[0]?.licence, 'CC-BY-4.0');
});
