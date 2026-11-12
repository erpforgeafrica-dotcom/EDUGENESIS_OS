import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createProviderRegistry } from './registry.js';
import { createMockAdapter, srcDir } from './testing/support.js';

test('registry: register, list and unregister providers', () => {
  const reg = createProviderRegistry();
  const a = createMockAdapter({ id: 'p-a' }).adapter;
  const b = createMockAdapter({ id: 'p-b' }).adapter;
  reg.register(a);
  reg.register(b);
  assert.deepEqual(reg.listProviders().map((p) => p.id), ['p-a', 'p-b']);
  reg.unregister('p-a');
  assert.deepEqual(reg.listProviders().map((p) => p.id), ['p-b']);
  assert.equal(reg.get('p-a'), undefined);
});

test('registry: registering the same provider id twice replaces the entry', () => {
  const reg = createProviderRegistry();
  reg.register(createMockAdapter({ id: 'p-a', modelId: 'm1' }).adapter);
  reg.register(createMockAdapter({ id: 'p-a', modelId: 'm2' }).adapter);
  assert.equal(reg.listProviders().length, 1);
  assert.equal(reg.get('p-a')?.modelId, 'm2');
});

test('registry: the model registry entry carries provider id, model id, tier, capabilities and status', () => {
  const reg = createProviderRegistry();
  const { adapter } = createMockAdapter({
    id: 'qwen-test',
    modelId: 'qwen-plus',
    tier: 2,
    maxDataClass: 'learner_scoped',
  });
  reg.register(adapter, { locales: ['en', 'en-KE'] });
  const entry = reg.get('qwen-test');
  assert.ok(entry, 'expected a registry entry');
  assert.equal(entry.providerId, 'qwen-test');
  assert.equal(entry.modelId, 'qwen-plus');
  assert.equal(entry.tier, 2);
  assert.equal(entry.capabilities.maxDataClass, 'learner_scoped');
  assert.deepEqual(entry.capabilities.clearedSafetyTiers, ['low', 'medium']);
  assert.equal(entry.status, 'active');
  assert.deepEqual(entry.locales, ['en', 'en-KE']);
});

test('registry: a provider can be disabled and re-enabled by status', () => {
  const reg = createProviderRegistry();
  reg.register(createMockAdapter({ id: 'p-a' }).adapter);
  reg.setStatus('p-a', 'disabled');
  assert.equal(reg.get('p-a')?.status, 'disabled');
  reg.setStatus('p-a', 'active');
  assert.equal(reg.get('p-a')?.status, 'active');
});

/**
 * Files that are not production learner-path code.
 *
 * WHY the exemption: the rule exists to stop the runtime path from reaching
 * into a provider SDK. Test files and the shared test doubles legitimately
 * name concrete providers — that is how the offline behaviour is proven — so
 * they are exempt. `src/index.ts` and `src/failover.ts` are exempt because
 * both are COMPOSITION ROOTS: index.ts is the package's public surface, and
 * failover.ts builds the drill's own scenario. The rule's intent — the
 * gateway and the policy engine never reach into a provider — still holds.
 */
function isProductionLearnerPath(relativePath: string): boolean {
  const normalised = relativePath.replace(/\\/g, '/');
  if (normalised.startsWith('providers/')) {
    return false;
  }
  if (normalised === 'index.ts' || normalised === 'failover.ts') {
    return false;
  }
  if (normalised.startsWith('testing/') || normalised.endsWith('.test.ts')) {
    return false;
  }
  return true;
}

test('registry: no learner-path module imports a provider SDK', () => {
  // Doc 2 ADR-0001: "A provider change is a registry change — no learner-path
  // code may import a provider SDK." This is the mechanical guard for that rule.
  const sdkPattern = /(dashscope|alibabacloud|@qwen|tongyi|openai|zhipu|moonshot|@anthropic-ai|google-genai|cohere)/i;
  const root = srcDir();
  const files = readdirSync(root, { recursive: true })
    .map((f) => join(root, String(f)))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  assert.ok(files.length > 0, 'expected source files to scan');

  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(root, file);
    if (!isProductionLearnerPath(rel)) {
      continue;
    }
    const source = readFileSync(file, 'utf8');
    const specifiers = [
      ...source.matchAll(/^\s*import\s[^\n]*?from\s*['"]([^'"]+)['"]/gm),
      ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1] ?? '');
    for (const spec of specifiers) {
      if (sdkPattern.test(spec)) {
        offenders.push(`${rel} imports "${spec}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `provider SDK imports leaked into the package: ${offenders.join(', ')}`);
});

test('registry: only the composition root may reference provider implementations', () => {
  // The gateway and the policy engine must reach providers through the
  // registry, never by importing a concrete provider module.
  const root = srcDir();
  const files = readdirSync(root, { recursive: true })
    .map((f) => join(root, String(f)))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(root, file);
    if (!isProductionLearnerPath(rel)) {
      continue;
    }
    const source = readFileSync(file, 'utf8');
    if (/from\s*['"][^'"]*providers\//.test(source)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], `learner-path modules must not import provider implementations: ${offenders.join(', ')}`);
});
