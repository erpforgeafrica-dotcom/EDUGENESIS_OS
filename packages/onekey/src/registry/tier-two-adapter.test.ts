import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFORMANCE_RULES, runAdapterConformance } from '../conformance.js';
import { createBudgetLedger } from '../budget.js';
import { createContext, createRequest } from '../testing/support.js';
import { createTierTwoAdapter, DEFAULT_TIER_TWO_ID } from './tier-two-adapter.js';

// F1-09: a Tier 2 adapter exists against the frozen ProviderAdapter contract
// and passes the same conformance suite as the Tier 1 adapter.
test('tier 2: a secondary adapter exists and satisfies conformance', async () => {
  const adapter = createTierTwoAdapter();
  assert.equal(adapter.id, DEFAULT_TIER_TWO_ID);
  assert.equal(adapter.tier, 2, 'the secondary adapter must declare tier 2');

  const results = await runAdapterConformance(adapter);
  assert.equal(results.length, CONFORMANCE_RULES.length);
  assert.deepEqual(
    results.filter((r) => !r.passed).map((r) => `${r.ruleId}: ${r.detail}`),
    [],
    'the Tier 2 adapter must pass every rule',
  );

  // It does real work at decision time: a funded request returns non-empty
  // text clamped to the ceiling; an empty pool is refused.
  const funded = await adapter.complete(createRequest(), createContext());
  assert.ok(funded.text.length > 0);
  assert.ok(funded.usage.outputTokens <= createRequest().maxOutputTokens);

  const emptyBudget = createBudgetLedger('tier-two-empty', 1, 'token');
  emptyBudget.consume(1);
  await assert.rejects(
    () => adapter.complete(createRequest(), createContext({ budget: emptyBudget })),
    /budget/i,
  );
});
