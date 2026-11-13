import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_TIER_ROLE } from '@edugenesis/contracts';
import { createBudgetLedger } from './budget.js';
import { createCircuitBreaker } from './circuit-breaker.js';
import { createKillSwitch } from './kill-switch.js';
import { createPolicyEngine, TIER_FOUR_PROVIDER_ID, TIER_ZERO_PROVIDER_ID } from './policy.js';
import { createProviderRegistry } from './registry.js';
import { createContext, createMockAdapter, createPolicy, createRequest } from './testing/support.js';
import type { ProviderRegistry } from './registry.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import type { KillSwitch } from './kill-switch.js';

interface Harness {
  registry: ProviderRegistry;
  breaker: CircuitBreaker;
  killSwitch: KillSwitch;
  engine: ReturnType<typeof createPolicyEngine>;
}

function harness(): Harness {
  const registry = createProviderRegistry();
  const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 30_000, now: () => 1_000 });
  const killSwitch = createKillSwitch();
  const engine = createPolicyEngine({ registry, breaker, killSwitch, policyVersion: 'policy-test-1' });
  return { registry, breaker, killSwitch, engine };
}

test('routing: a provider with too low a maxDataClass is never selected', async () => {
  const h = harness();
  h.registry.register(createMockAdapter({ id: 'public-only', maxDataClass: 'public' }).adapter);
  h.registry.register(createMockAdapter({ id: 'can-take-sensitive', maxDataClass: 'secret' }).adapter);

  const decision = await h.engine.route(
    createPolicy({ dataClass: 'sensitive' }),
    createRequest({ dataClass: 'sensitive' }),
    createContext(),
  );

  assert.equal(decision.providerId, 'can-take-sensitive');
  assert.equal(
    decision.fallbackChain.some((c) => c.providerId === 'public-only'),
    false,
    'a provider whose maxDataClass is too low must never appear in the fallback chain',
  );
  assert.match(decision.reason, /data class/i);
});

test('routing: a provider not cleared for the safety tier is never selected', async () => {
  const h = harness();
  h.registry.register(createMockAdapter({ id: 'low-only', clearedSafetyTiers: ['low'] }).adapter);
  h.registry.register(
    createMockAdapter({ id: 'high-cleared', clearedSafetyTiers: ['low', 'medium', 'high'] }).adapter,
  );

  const decision = await h.engine.route(
    createPolicy({ safetyTier: 'high' }),
    createRequest({ safetyTier: 'high' }),
    createContext(),
  );

  assert.equal(decision.providerId, 'high-cleared');
  assert.equal(decision.fallbackChain.some((c) => c.providerId === 'low-only'), false);
  assert.match(decision.reason, /safety tier/i);
});

test('routing: a provider with an open circuit is skipped', async () => {
  const h = harness();
  h.registry.register(createMockAdapter({ id: 'tripped' }).adapter);
  h.registry.register(createMockAdapter({ id: 'healthy' }).adapter);
  h.breaker.recordFailure('tripped');
  h.breaker.recordFailure('tripped');

  const decision = await h.engine.route(createPolicy(), createRequest(), createContext());

  assert.equal(decision.providerId, 'healthy');
  assert.equal(decision.fallbackChain.some((c) => c.providerId === 'tripped'), false);
  assert.match(decision.reason, /circuit/i);
});

test('routing: a killed provider is skipped', async () => {
  const h = harness();
  h.registry.register(createMockAdapter({ id: 'killed' }).adapter);
  h.registry.register(createMockAdapter({ id: 'healthy' }).adapter);
  h.killSwitch.killSwitch('killed', 'safety incident INC-7');

  const decision = await h.engine.route(createPolicy(), createRequest(), createContext());

  assert.equal(decision.providerId, 'healthy');
  assert.equal(decision.fallbackChain.some((c) => c.providerId === 'killed'), false);
  assert.match(decision.reason, /killed/i);
});

test('routing: the decision records a reason and a fallback chain', async () => {
  const h = harness();
  h.registry.register(createMockAdapter({ id: 'tier-2-provider', tier: 2, modelId: 'm2' }).adapter);
  h.registry.register(createMockAdapter({ id: 'tier-1-provider', tier: 1, modelId: 'm1' }).adapter);

  const decision = await h.engine.route(createPolicy(), createRequest(), createContext());

  assert.equal(decision.providerId, 'tier-1-provider');
  assert.equal(decision.modelId, 'm1');
  assert.equal(decision.tier, 1);
  assert.equal(decision.budgetPoolId, 'pool-test');
  assert.equal(decision.servedOffline, false);
  assert.ok(decision.reason.length > 20, 'the reason must be a human-readable trace');
  assert.match(decision.reason, /tier-1-provider/);
  assert.match(decision.reason, /tier 1/);

  // The ladder spans tier 0 -> tier 4 so the failover drill can assert it.
  assert.deepEqual(
    decision.fallbackChain.map((c) => c.tier),
    [0, 1, 2, 4],
  );
  assert.equal(decision.fallbackChain[0]?.providerId, TIER_ZERO_PROVIDER_ID);
  assert.equal(decision.fallbackChain[3]?.providerId, TIER_FOUR_PROVIDER_ID);
});

test('routing: the lowest tier wins, then modality coverage, then locale coverage', async () => {
  const h = harness();
  h.registry.register(createMockAdapter({ id: 'tier-2-text', tier: 2, modalities: ['text'] }).adapter);
  h.registry.register(createMockAdapter({ id: 'tier-1-text', tier: 1, modalities: ['text'] }).adapter);
  h.registry.register(createMockAdapter({ id: 'tier-1-vision', tier: 1, modalities: ['vision'] }).adapter);

  const decision = await h.engine.route(
    createPolicy({ preferredModality: 'vision' }),
    createRequest(),
    createContext(),
  );

  assert.equal(decision.providerId, 'tier-1-vision', 'same tier, so modality coverage must decide');
});

test('routing: locale coverage breaks a tie between same-tier providers', async () => {
  const h = harness();
  h.registry.register(createMockAdapter({ id: 'english-only', tier: 1 }).adapter, { locales: ['en'] });
  h.registry.register(createMockAdapter({ id: 'swahili', tier: 1 }).adapter, { locales: ['sw', 'en'] });

  const decision = await h.engine.route(
    createPolicy({ locale: 'sw' }),
    createRequest({ locale: 'sw' }),
    createContext(),
  );

  assert.equal(decision.providerId, 'swahili');
});

test('routing: a provider with no remaining budget is ineligible for paid tiers', async () => {
  const h = harness();
  h.registry.register(createMockAdapter({ id: 'paid-provider' }).adapter);
  const exhausted = createBudgetLedger('pool-test', 10, 'token');
  exhausted.consume(10);

  const decision = await h.engine.route(createPolicy(), createRequest(), createContext({ budget: exhausted }));

  assert.equal(decision.tier, 0);
  assert.equal(decision.providerId, TIER_ZERO_PROVIDER_ID);
  assert.equal(decision.servedOffline, true);
  assert.match(decision.reason, /budget/i);
});

test('routing: a sponsor-preferred provider is never preferred over a policy-eligible one', async () => {
  const h = harness();
  h.registry.register(createMockAdapter({ id: 'plain-provider', tier: 1 }).adapter);
  h.registry.register(createMockAdapter({ id: 'sponsor-provider', tier: 1 }).adapter, {
    sponsorPreferred: true,
  });

  const decision = await h.engine.route(createPolicy(), createRequest(), createContext());

  assert.equal(decision.providerId, 'plain-provider', 'sponsor preference must not influence routing');
  assert.match(decision.reason, /sponsor/i);
});

test('routing: a provider disabled in the registry is not a candidate', async () => {
  const h = harness();
  h.registry.register(createMockAdapter({ id: 'disabled-provider' }).adapter);
  h.registry.register(createMockAdapter({ id: 'active-provider' }).adapter);
  h.registry.setStatus('disabled-provider', 'disabled');

  const decision = await h.engine.route(createPolicy(), createRequest(), createContext());

  assert.equal(decision.providerId, 'active-provider');
  assert.match(decision.reason, /disabled/i);
});

test('routing: the contract names a role for every tier, and tier 0 needs no provider', () => {
  // The five tiers are the promise made to the learner and to the sponsor.
  // The contract publishes what each one is FOR, so the ladder can be read
  // without reading the implementation.
  assert.deepEqual(
    Object.keys(FALLBACK_TIER_ROLE).sort(),
    ['0', '1', '2', '3', '4'],
    'every tier in the ladder must have a published role',
  );

  const tierZero = FALLBACK_TIER_ROLE[0];
  assert.match(
    tierZero,
    /no model provider required/i,
    'tier 0 is the offline floor — it must not be describable as needing a provider',
  );
  assert.match(FALLBACK_TIER_ROLE[4], /human/i, 'the last rung must be a person, not a model');
});
