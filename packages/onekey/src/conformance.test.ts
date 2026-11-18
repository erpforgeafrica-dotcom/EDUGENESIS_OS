import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetExceededError } from '@edugenesis/contracts';
import type {
  CompletionRequest,
  CompletionResult,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderHealth,
  RequestContext,
} from '@edugenesis/contracts';
import {
  CONFORMANCE_RULES,
  ConformanceRefusalError,
  runAdapterConformance,
  runRegisteredAdapterConformance,
} from './conformance.js';
import { createProviderRegistry } from './registry.js';
import { createLocalEchoProvider } from './providers/local-echo.js';
import { createMockAdapter } from './testing/support.js';

/**
 * A compliant mock adapter. The conformance suite must be runnable against a
 * mock, so the suite can be proven without a provider, a key or a network.
 */
function compliantMock(): ProviderAdapter {
  return {
    id: 'mock-ok',
    modelId: 'mock-ok-v1',
    tier: 1,
    maxDataClass: 'public',
    capabilities(): ProviderCapabilities {
      return {
        modalities: ['text'],
        supportsContextCaching: false,
        maxContextTokens: 4_000,
        maxDataClass: 'public',
        clearedSafetyTiers: ['low', 'medium'],
      };
    },
    async complete(req: CompletionRequest, ctx: RequestContext): Promise<CompletionResult> {
      if (ctx.budget.remaining() <= 0) {
        throw new BudgetExceededError(ctx.budget.poolId, 1, ctx.budget.remaining());
      }
      return {
        text: 'mock completion',
        providerId: 'mock-ok',
        modelId: 'mock-ok-v1',
        usage: { inputTokens: 4, outputTokens: Math.min(req.maxOutputTokens, 12) },
        latencyMs: 3,
        sourceLineage: [],
      };
    },
    async health(): Promise<ProviderHealth> {
      return { ok: true, consecutiveFailures: 0 };
    },
    async dispose() {
      /* nothing to release */
    },
  };
}

/**
 * A deliberately non-compliant adapter.
 *
 * WHY runtime corruption instead of casts: the fixture must present values the
 * contract forbids (a modality list that is empty, a health object with the
 * wrong types, a data class that does not exist). The object is built type-safe
 * and then corrupted in place, so the test file needs no type-laundering cast.
 */
function nonCompliantMock(): ProviderAdapter {
  const capabilities: ProviderCapabilities = {
    modalities: ['text'],
    supportsContextCaching: false,
    maxContextTokens: 4_000,
    maxDataClass: 'public',
    clearedSafetyTiers: ['low'],
  };
  Object.assign(capabilities, {
    modalities: [],
    maxContextTokens: 0,
    clearedSafetyTiers: ['extreme'],
  });

  const health: ProviderHealth = { ok: true, consecutiveFailures: 0 };
  Object.assign(health, { ok: 'yes', consecutiveFailures: 'many' });

  const adapter: ProviderAdapter = {
    id: 'mock-bad',
    modelId: 'mock-bad-v1',
    tier: 1,
    maxDataClass: 'public',
    capabilities(): ProviderCapabilities {
      return capabilities;
    },
    async complete(_req: CompletionRequest, _ctx: RequestContext): Promise<CompletionResult> {
      // Never refuses on budget, and ignores the output ceiling.
      return {
        text: '',
        providerId: 'mock-bad',
        modelId: 'mock-bad-v1',
        usage: { inputTokens: 0, outputTokens: 9_999 },
        latencyMs: 0,
        sourceLineage: [],
      };
    },
    async health(): Promise<ProviderHealth> {
      return health;
    },
    async dispose() {
      throw new Error('dispose failed');
    },
  };

  // Corrupt the declared data class: it must not name a real class, and it
  // must disagree with the capabilities snapshot.
  Object.assign(adapter, { maxDataClass: 'ultra_secret' });
  return adapter;
}

test('conformance: a compliant mock adapter passes every rule', async () => {
  const results = await runAdapterConformance(compliantMock());
  const failed = results.filter((r) => !r.passed);
  assert.deepEqual(
    failed.map((r) => `${r.ruleId}: ${r.detail}`),
    [],
    'a compliant adapter must pass every rule',
  );
  assert.equal(results.length, CONFORMANCE_RULES.length);
});

test('conformance: a non-compliant adapter fails exactly one rule per rule', async () => {
  const results = await runAdapterConformance(nonCompliantMock());
  const failed = results.filter((r) => !r.passed);
  assert.equal(failed.length, CONFORMANCE_RULES.length, 'every rule must be reported as a failure');
  const failedIds = failed.map((r) => r.ruleId);
  assert.equal(new Set(failedIds).size, failedIds.length, 'each rule may fail only once');
  for (const rule of CONFORMANCE_RULES) {
    assert.ok(failedIds.includes(rule.id), `rule ${rule.id} should have failed`);
  }
});

test('conformance: the local echo adapter passes the suite', async () => {
  const results = await runAdapterConformance(createLocalEchoProvider());
  const failed = results.filter((r) => !r.passed);
  assert.deepEqual(failed.map((r) => `${r.ruleId}: ${r.detail}`), []);
});

test('conformance: every rule carries a description and a detail', async () => {
  const results = await runAdapterConformance(compliantMock());
  for (const result of results) {
    assert.ok(result.ruleId.length > 0);
    assert.ok(result.description.length > 0);
    assert.ok(result.detail.length > 0);
  }
});

// F3-09: the suite is the "allowed near a learner" gate. It must refuse to
// run when there is no real adapter to measure — neither a non-adapter value
// nor a provider id that is not registered.
test('conformance: refuses to run without a real registered adapter', async () => {
  const registry = createProviderRegistry();
  await assert.rejects(
    () => runRegisteredAdapterConformance(registry, 'not-registered'),
    (err: unknown) => err instanceof ConformanceRefusalError,
    'an unregistered provider id must be refused',
  );
  await assert.rejects(
    () => runAdapterConformance(undefined as unknown as ProviderAdapter),
    (err: unknown) => err instanceof ConformanceRefusalError,
    'a value that is not an adapter must be refused',
  );
});

// F3-09: the counterpart — a REAL adapter, obtained from the registry the
// gateway routes through, passes every rule.
test('conformance: the registered adapter passes the suite', async () => {
  const registry = createProviderRegistry();
  registry.register(createLocalEchoProvider());
  const results = await runRegisteredAdapterConformance(registry, 'local-echo');
  assert.deepEqual(
    results.filter((r) => !r.passed).map((r) => `${r.ruleId}: ${r.detail}`),
    [],
    'the registered adapter must satisfy every conformance rule',
  );
  assert.equal(results.length, CONFORMANCE_RULES.length);
});

// F3-27: `refuseOverBudget` is no longer an unused knob — this is its real
// caller, and the assertion proves the option actually drives the refusal rule.
test('conformance: the mock adapter refuseOverBudget option is exercised', async () => {
  const { adapter, calls } = createMockAdapter({
    id: 'budget-refusing',
    refuseOverBudget: true,
    usage: { inputTokens: 4, outputTokens: 2 },
  });
  const results = await runAdapterConformance(adapter);
  assert.equal(
    results.find((r) => r.ruleId === 'over-budget-refused')?.passed,
    true,
    'the over-budget option must make the adapter refuse on an empty pool',
  );
  assert.ok(calls() >= 2, 'the option must be reached through real complete() calls');
});
