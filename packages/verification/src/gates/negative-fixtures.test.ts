/**
 * Negative fixtures for the gates.
 *
 * WHY these exist: a gate that only ever sees a passing tree is decoration.
 * Each test below builds the smallest tree that SHOULD fail and asserts the
 * gate refuses it. The provider-host cases are the ones round 1 found: a
 * comment was excluded by weakening the gate's scope, and a provider import
 * outside the boundary was invisible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripComments } from '../scan.js';
import { assessDrill, assessReport } from './failover-gate.js';
import { noProviderLeakGate } from './no-provider-leak-gate.js';

/** Create a throwaway project root with one file at `relPath`. */
function treeWith(relPath: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'edugenesis-gate-'));
  const abs = join(root, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return root;
}

function removeTree(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // A leaked temp directory is not a test failure; the OS cleans it up.
  }
}

test('stripComments: removes block and line comments, preserves code, strings and line count', () => {
  const source = [
    '/** A doc comment that cites the sponsor. */',
    "const host = 'api.example.invalid';",
    'const url = "https://example.invalid"; // trailing note',
    'const re = /a\\/\\/b/;',
    '/* multi',
    '   line */',
    'const done = true;',
  ].join('\n');

  const stripped = stripComments(source);
  const lines = stripped.split('\n');

  assert.equal(lines.length, source.split('\n').length, 'line numbers must stay true');
  assert.ok(!stripped.includes('doc comment'), 'a block comment must be removed');
  assert.ok(!stripped.includes('trailing note'), 'a line comment must be removed');
  assert.ok(stripped.includes('api.example.invalid'), 'a string literal must be preserved');
  assert.ok(stripped.includes('/a\\/\\/b/'), 'a regex literal must survive');
  assert.ok(stripped.includes('const done = true;'), 'code after a block comment must survive');
});

test('provider gate: a provider host in executable contract code FAILS', async () => {
  // The needle is assembled from fragments so this fixture does not itself
  // contain a literal the gate scans for — the gate needs no exclusion list.
  const host = ['dash', 'scope'].join('');
  const root = treeWith(
    'packages/contracts/src/index.ts',
    `export const endpoint = 'https://${host}.aliyuncs.com/v1';\n`,
  );
  try {
    const result = await noProviderLeakGate.run({ root });
    assert.equal(result.passed, false, 'a provider host in contracts must fail the gate');
    assert.equal(result.severity, 'blocker');
    assert.ok(
      result.evidence.some((line) => line.includes('packages/contracts/src/index.ts:1')),
      'the finding must name the file and line',
    );
  } finally {
    removeTree(root);
  }
});

test('provider gate: the same host inside a doc comment PASSES', async () => {
  const root = treeWith(
    'packages/contracts/src/index.ts',
    '/** The sponsor document names the provider host. */\nexport const ok = true;\n',
  );
  try {
    const result = await noProviderLeakGate.run({ root });
    assert.equal(result.passed, true, 'a citation in a comment is not a dependency');
  } finally {
    removeTree(root);
  }
});

test('provider gate: an import of a provider implementation outside onekey FAILS', async () => {
  const folder = ['pro', 'viders'].join('');
  const provider = ['q', 'wen'].join('');
  const root = treeWith(
    'packages/ledger/src/index.ts',
    `import { thing } from '../${folder}/${provider}.js';\nexport const x = thing;\n`,
  );
  try {
    const result = await noProviderLeakGate.run({ root });
    assert.equal(result.passed, false, 'a learner-path provider import must fail the gate');
    assert.ok(result.evidence.some((line) => line.includes('imports a provider implementation')));
  } finally {
    removeTree(root);
  }
});

test('failover assessor: all five tiers named but Tier 4 serving FAILS', () => {
  const assessment = assessDrill({
    transitions: [
      { tier: 0, outcome: 'no-offline-content' },
      { tier: 1, outcome: 'failed' },
      { tier: 2, outcome: 'failed' },
      { tier: 3, outcome: 'failed' },
      { tier: 4, outcome: 'served' },
    ],
    servedBy: { tier: 4, providerId: 'human-support' },
    exhausted: false,
    result: { text: 'Your request is queued.' },
  });
  assert.equal(assessment.ok, false, 'Tier 0 must serve when every model fails');
  assert.match(assessment.detail, /expected 0:served/);
});

test('failover assessor: an operations term in the learner text FAILS', () => {
  const assessment = assessDrill({
    transitions: [
      { tier: 0, outcome: 'no-offline-content' },
      { tier: 1, outcome: 'failed' },
      { tier: 2, outcome: 'failed' },
      { tier: 3, outcome: 'failed' },
      { tier: 0, outcome: 'served' },
    ],
    servedBy: { tier: 0, providerId: 'tier-zero' },
    exhausted: false,
    result: { text: 'The provider quota is exhausted, so here is a cached lesson.' },
  });
  assert.equal(assessment.ok, false, 'a learner must never be shown an operations term');
});

test('failover assessor: the §6.6 ladder ending 0:served PASSES', () => {
  const assessment = assessDrill({
    transitions: [
      { tier: 0, outcome: 'no-offline-content' },
      { tier: 1, outcome: 'failed' },
      { tier: 2, outcome: 'failed' },
      { tier: 3, outcome: 'failed' },
      { tier: 0, outcome: 'served' },
    ],
    servedBy: { tier: 0, providerId: 'tier-zero' },
    exhausted: false,
    result: { text: 'Here is a lesson from your offline library that covers this topic.' },
  });
  assert.equal(assessment.ok, true, assessment.detail);
});

test('failover assessor: a report whose rescue scenario defers to Tier 4 FAILS', () => {
  const deferral = {
    transitions: [
      { tier: 0, outcome: 'no-offline-content' },
      { tier: 1, outcome: 'failed' },
      { tier: 2, outcome: 'failed' },
      { tier: 3, outcome: 'failed' },
      { tier: 4, outcome: 'served' },
    ],
    servedBy: { tier: 4, providerId: 'human-support' },
    exhausted: false,
    result: { text: 'Your request is queued.' },
  };
  const assessment = assessReport({
    scenarios: {
      'offline-rescue': deferral,
      'human-deferral': deferral,
      exhausted: {
        transitions: [
          { tier: 0, outcome: 'skipped' },
          { tier: 1, outcome: 'failed' },
          { tier: 2, outcome: 'failed' },
          { tier: 3, outcome: 'failed' },
          { tier: 4, outcome: 'deferred' },
        ],
        exhausted: true,
      },
    },
    tiersExercised: [0, 1, 2, 3, 4],
  });
  assert.equal(assessment.ok, false, 'the rescue scenario must end with Tier 0 serving');
  assert.match(assessment.detail, /offline-rescue/);
});

test('failover assessor: a report that claims an unreached tier FAILS', () => {
  const rescue = {
    transitions: [
      { tier: 0, outcome: 'no-offline-content' },
      { tier: 1, outcome: 'failed' },
      { tier: 2, outcome: 'failed' },
      { tier: 3, outcome: 'failed' },
      { tier: 0, outcome: 'served' },
    ],
    servedBy: { tier: 0, providerId: 'tier-zero' },
    exhausted: false,
    result: { text: 'A neutral offline lesson.' },
  };
  const assessment = assessReport({
    scenarios: { 'offline-rescue': rescue, 'human-deferral': rescue, exhausted: rescue },
    tiersExercised: [0, 1, 2, 3, 4],
  });
  assert.equal(assessment.ok, false, 'the report must not claim a tier its transitions never reached');
});
