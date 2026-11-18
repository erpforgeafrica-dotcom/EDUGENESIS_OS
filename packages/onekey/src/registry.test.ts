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
 * they are exempt. `src/failover.ts` and `src/provider-wiring.ts` are exempt
 * because both are COMPOSITION ROOTS: failover.ts builds the drill's own
 * scenario, and provider-wiring.ts is the ONE place that maps a settings
 * provider id to a concrete adapter factory (ADR-0001).
 *
 * F3-34: `src/index.ts` is NO LONGER exempt. The public surface must itself be
 * provider-agnostic, so it is scanned like every other module; the concrete
 * Alibaba adapter is no longer re-exported from it.
 */
function isProductionLearnerPath(relativePath: string): boolean {
  const normalised = relativePath.replace(/\\/g, '/');
  if (normalised.startsWith('providers/')) {
    return false;
  }
  if (normalised === 'failover.ts' || normalised === 'provider-wiring.ts') {
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
    // Only an IMPORT binds a provider implementation into a learner-path
    // module. `export ... from` in the public surface is the package API, not
    // a learner-path import (F3-34); that surface is checked separately for
    // concrete vendor adapters by the public-surface test below.
    const providerImport = /^\s*import\s[^;]*?from\s*['"][^'"]*providers\/[^'"]+['"]/gm;
    if (providerImport.test(source)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], `learner-path modules must not import provider implementations: ${offenders.join(', ')}`);
});

// F3-34: the root public surface is scanned by BOTH guards above and must not
// re-export the concrete Alibaba adapter. Concrete adapters stay behind their
// own modules; the root stays provider-agnostic.
test('registry: the public surface does not re-export the concrete Qwen adapter', () => {
  const source = readFileSync(join(srcDir(), 'index.ts'), 'utf8');
  // A TYPE-only re-export is not a vendor dependency: FetchLike is the CLI's
  // injection seam and must stay available after the concrete adapter is
  // removed from the value surface. Only value re-exports are forbidden here.
  const valueSurface = source
    .split('\n')
    .filter((line) => !/^\s*export\s+type\s/.test(line))
    .join('\n');
  assert.doesNotMatch(
    valueSurface,
    /from\s*['"][^'"]*qwen-adapter/,
    'a concrete vendor adapter must not be part of the root public API',
  );
  assert.match(source, /export\s+type\s*\{\s*FetchLike\s*\}/, 'the type-only injection seam survives');
  assert.equal(
    isProductionLearnerPath('index.ts'),
    true,
    'the guard must scan index.ts — it is no longer an exemption',
  );
  // The guard still fires on a real learner-path import of a provider module.
  const providerImport = /^\s*import\s[^;]*?from\s*['"][^'"]*providers\/[^'"]+['"]/gm;
  assert.equal(providerImport.test("import { x } from './providers/qwen-adapter.js';"), true);
});
