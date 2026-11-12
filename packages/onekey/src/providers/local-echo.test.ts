import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetExceededError } from '@edugenesis/contracts';
import { createLocalEchoProvider } from './local-echo.js';
import { createBudgetLedger } from '../budget.js';
import { createContext, createRequest } from '../testing/support.js';

test('local echo: the same request yields byte-identical output', async () => {
  const adapter = createLocalEchoProvider();
  const req = createRequest({ prompt: 'Explain fractions' });
  const a = await adapter.complete(req, createContext());
  const b = await adapter.complete(req, createContext());
  assert.equal(a.text, b.text);
  assert.deepEqual(a.usage, b.usage);
  assert.equal(a.modelId, b.modelId);
  assert.equal(a.providerId, adapter.id);
});

test('local echo: different prompts yield different output', async () => {
  const adapter = createLocalEchoProvider();
  const a = await adapter.complete(createRequest({ prompt: 'Explain fractions' }), createContext());
  const b = await adapter.complete(createRequest({ prompt: 'Explain photosynthesis' }), createContext());
  assert.notEqual(a.text, b.text);
});

test('local echo: it refuses an over-budget request', async () => {
  const adapter = createLocalEchoProvider();
  const budget = createBudgetLedger('pool-empty', 10, 'token');
  budget.consume(10);
  await assert.rejects(
    () => adapter.complete(createRequest(), createContext({ budget })),
    BudgetExceededError,
  );
});

test('local echo: it clamps the output to the requested maxOutputTokens', async () => {
  const adapter = createLocalEchoProvider();
  const result = await adapter.complete(createRequest({ maxOutputTokens: 4 }), createContext());
  assert.ok(result.usage.outputTokens <= 4, `expected <= 4 output tokens, got ${result.usage.outputTokens}`);
  assert.ok(result.text.length > 0, 'a clamped response must still carry text');
});

test('local echo: it reports coherent capabilities and health', async () => {
  const adapter = createLocalEchoProvider();
  const caps = adapter.capabilities();
  assert.ok(caps.modalities.length > 0);
  assert.ok(caps.maxContextTokens > 0);
  assert.equal(caps.maxDataClass, adapter.maxDataClass);
  assert.ok(caps.clearedSafetyTiers.length > 0);
  const health = await adapter.health();
  assert.equal(typeof health.ok, 'boolean');
  assert.equal(typeof health.consecutiveFailures, 'number');
  await adapter.dispose();
});
