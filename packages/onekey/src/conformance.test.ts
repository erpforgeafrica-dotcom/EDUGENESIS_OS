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
import { CONFORMANCE_RULES, runAdapterConformance } from './conformance.js';
import { createLocalEchoProvider } from './providers/local-echo.js';

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
