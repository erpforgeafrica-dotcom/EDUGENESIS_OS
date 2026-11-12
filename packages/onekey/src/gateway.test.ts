import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AllTiersExhaustedError,
  BudgetExceededError,
  ContractViolation,
  ProviderUnavailableError,
} from '@edugenesis/contracts';
import { createBudgetLedger } from './budget.js';
import { createOneKeyGateway } from './gateway.js';
import { createLocalEchoProvider } from './providers/local-echo.js';
import { createTierZeroProvider } from './providers/tier-zero.js';
import { createBlockingGuardian, createContext, createMockAdapter, createPolicy, createRequest } from './testing/support.js';
import type { OneKeyGatewayImpl } from './gateway.js';

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

test('gateway: with every paid tier failing, tier 0 serves the request and the learner still gets an answer', async () => {
  const g = gateway();
  const t1 = createMockAdapter({ id: 'p1', tier: 1, failWith: new ProviderUnavailableError('p1', 'boom') });
  const t2 = createMockAdapter({ id: 'p2', tier: 2, failWith: new ProviderUnavailableError('p2', 'boom') });
  const t3 = createMockAdapter({ id: 'p3', tier: 3, failWith: new ProviderUnavailableError('p3', 'boom') });
  g.register(t1.adapter);
  g.register(t2.adapter);
  g.register(t3.adapter);

  const result = await g.complete(
    createPolicy(),
    createRequest({ prompt: OFFLINE_PROMPT }),
    createContext(),
  );

  assert.ok(result.text.length > 0, 'the learner must still get an answer');
  assert.equal(result.meta.tier, 0);
  assert.equal(result.meta.servedOffline, true);
  assert.equal(result.meta.providerId, 'tier-zero');
});

test('gateway: with every paid tier failing and nothing cached, the failure is typed, never silent', async () => {
  const g = gateway();
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

test('gateway: with the budget at zero, complete() still returns a tier 0 answer', async () => {
  const g = gateway();
  const paid = createMockAdapter({ id: 'p1', tier: 1 });
  g.register(paid.adapter);
  const budget = createBudgetLedger('pool-test', 100, 'token');
  budget.consume(100);

  const result = await g.complete(
    createPolicy(),
    createRequest({ prompt: OFFLINE_PROMPT }),
    createContext({ budget }),
  );

  assert.ok(result.text.length > 0, 'core learning must never be denied on credit exhaustion');
  assert.equal(result.meta.tier, 0);
  assert.equal(result.meta.servedOffline, true);
  assert.equal(paid.calls(), 0, 'a provider with no budget must not be called');
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
