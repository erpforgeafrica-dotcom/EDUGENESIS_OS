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
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripComments } from '../scan.js';
import { assessDrill, assessReport } from './failover-gate.js';
import { noProviderLeakGate } from './no-provider-leak-gate.js';
import { hexTokenGate } from './hex-token-gate.js';
import { contractsBaselineGate, parseAmendments } from './contracts-baseline-gate.js';
import { pwaLightDefaultGate } from './pwa-light-default-gate.js';
import { adrGovernanceGate } from './adr-governance-gate.js';
import { assessConsentTransition } from './consent-gate.js';
import { assessFocusVisibility } from './keyboard-focus-gate.js';
import { assessFormSemantics } from './form-semantics-gate.js';

/** Create a throwaway project root with one file at `relPath`. */
function treeWith(relPath: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'edugenesis-gate-'));
  const abs = join(root, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return root;
}

/**
 * Hex literals are assembled from fragments.
 *
 * WHY: this file is inside the scanned source tree, so a literal written out
 * here would be a finding — the scanner would be reporting its own test
 * fixture. The fragments are split so that no `#` is ever followed by three
 * or more hex characters in the source text.
 */
const COLOUR_SOURCE = ['#', '12', '3456'].join('');
const COLOUR_TOKEN = ['#', 'FA', 'F8F2'].join('');
const COLOUR_FOREIGN = ['#', 'AB', 'CDEF'].join('');

/**
 * A throwaway tree with a token stylesheet, so the design-token gate has the
 * definitions it measures against.
 */
function treeWithTokens(relPath: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'edugenesis-token-'));
  const tokenPath = join(root, 'assets', 'edugenesis-tokens.css');
  mkdirSync(join(tokenPath, '..'), { recursive: true });
  writeFileSync(
    tokenPath,
    `:root {\n  --eg-surface: ${COLOUR_TOKEN};\n  --eg-ink: ${COLOUR_SOURCE};\n}\n`,
    'utf8',
  );
  const abs = join(root, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return root;
}

/**
 * A throwaway tree that renders a PWA, so the theme gate has something real to
 * measure. The canvas colours are the fragment-built literals declared above,
 * so this file never contains a raw colour literal of its own.
 */
function treeWithPwa(opts: {
  dataTheme?: string | null;
  colorScheme: string;
  manifestColour: string;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'edugenesis-pwa-'));
  const tokenPath = join(root, 'assets', 'edugenesis-tokens.css');
  mkdirSync(join(tokenPath, '..'), { recursive: true });
  writeFileSync(
    tokenPath,
    `:root {\n  --eg-canvas: ${COLOUR_SOURCE};\n  --eg-canvas-light: ${COLOUR_TOKEN};\n}\n` +
      `[data-theme="light"] {\n  --eg-canvas: var(--eg-canvas-light);\n}\n`,
    'utf8',
  );
  const htmlPath = join(root, 'apps', 'cli', 'public', 'index.html');
  mkdirSync(join(htmlPath, '..'), { recursive: true });
  const themeAttr = opts.dataTheme ? ` data-theme="${opts.dataTheme}"` : '';
  writeFileSync(
    htmlPath,
    `<!doctype html>\n<html lang="en"${themeAttr}>\n<head>\n` +
      `<meta name="color-scheme" content="${opts.colorScheme}" />\n</head>\n<body></body>\n</html>\n`,
    'utf8',
  );
  const manifestPath = join(root, 'apps', 'cli', 'public', 'manifest.webmanifest');
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ theme_color: opts.manifestColour, background_color: opts.manifestColour }, null, 2)}\n`,
    'utf8',
  );
  return root;
}

test('theme gate: a PWA that renders the dark theme by default FAILS', async () => {
  const root = treeWithPwa({ dataTheme: null, colorScheme: 'light', manifestColour: COLOUR_TOKEN });
  try {
    const result = await pwaLightDefaultGate.run({ root });
    assert.equal(result.passed, false, 'a PWA that renders dark by default must fail the gate');
    assert.ok(
      result.evidence.some((line) => line.includes('renders the DARK canvas')),
      'the failure must name the defect',
    );
  } finally {
    removeTree(root);
  }
});

test('theme gate: a color-scheme that disagrees with the rendered theme FAILS', async () => {
  const root = treeWithPwa({ dataTheme: 'light', colorScheme: 'dark', manifestColour: COLOUR_TOKEN });
  try {
    const result = await pwaLightDefaultGate.run({ root });
    assert.equal(result.passed, false, 'a mismatched color-scheme must fail the gate');
    assert.ok(
      result.evidence.some((line) => line.includes('form controls')),
      'the failure must name the mismatched declaration',
    );
  } finally {
    removeTree(root);
  }
});

test('theme gate: a manifest colour that drifts from the rendered canvas FAILS', async () => {
  const root = treeWithPwa({ dataTheme: 'light', colorScheme: 'light', manifestColour: COLOUR_FOREIGN });
  try {
    const result = await pwaLightDefaultGate.run({ root });
    assert.equal(result.passed, false, 'a manifest colour that drifts from the canvas must fail the gate');
    assert.ok(
      result.evidence.some((line) => line.includes('manifest')),
      'the failure must name the manifest',
    );
  } finally {
    removeTree(root);
  }
});

test('theme gate: a consistent light PWA PASSES', async () => {
  const root = treeWithPwa({ dataTheme: 'light', colorScheme: 'light', manifestColour: COLOUR_TOKEN });
  try {
    const result = await pwaLightDefaultGate.run({ root });
    assert.equal(result.passed, true, result.detail);
  } finally {
    removeTree(root);
  }
});

/**
 * A throwaway tree with an ADR index, an ADR record and an appointment
 * register, so the ADR-governance gate has something real to compare.
 */
function treeWithAdrs(opts: { indexOwner: string; recordOwner: string; recordStatus: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'edugenesis-adr-'));
  const indexPath = join(root, 'docs', 'adr', 'README.md');
  mkdirSync(join(indexPath, '..'), { recursive: true });
  writeFileSync(
    indexPath,
    '| ADR | Title | Status | Owner | Record |\n|---|---|---|---|---|\n' +
      `| [ADR-0001](ADR-0001-example.md) | An example decision | Accepted | ${opts.indexOwner} | Proposal |\n`,
    'utf8',
  );
  const recordPath = join(root, 'docs', 'adr', 'ADR-0001-example.md');
  writeFileSync(
    recordPath,
    `# ADR-0001 — An example decision\n\n- **Status:** ${opts.recordStatus}\n- **Owner:** ${opts.recordOwner}\n`,
    'utf8',
  );
  const officersPath = join(root, 'docs', 'OFFICERS.md');
  mkdirSync(join(officersPath, '..'), { recursive: true });
  writeFileSync(
    officersPath,
    '| Role | Appointed person | Status |\n|---|---|---|\n' +
      '| Chief AI & Model Orchestrator | A Person | APPOINTED |\n' +
      '| Security Officer | not appointed | VACANT |\n',
    'utf8',
  );
  return root;
}

test('ADR gate: an index owner that contradicts the ADR record FAILS', async () => {
  const root = treeWithAdrs({
    indexOwner: 'Security Officer',
    recordOwner: 'Chief AI & Model Orchestrator',
    recordStatus: 'Accepted',
  });
  try {
    const result = await adrGovernanceGate.run({ root });
    assert.equal(result.passed, false, 'an index that contradicts the record must fail the gate');
    assert.ok(
      result.evidence.some((line) => line.includes('the index names owner')),
      'the failure must name the contradiction',
    );
  } finally {
    removeTree(root);
  }
});

test('ADR gate: an owner that is not a registered role FAILS', async () => {
  const root = treeWithAdrs({
    indexOwner: 'Chief Systems Architect',
    recordOwner: 'Chief Systems Architect',
    recordStatus: 'Accepted',
  });
  try {
    const result = await adrGovernanceGate.run({ root });
    assert.equal(result.passed, false, 'an unregistered owner role must fail the gate');
    assert.ok(
      result.evidence.some((line) => line.includes('not a role in the appointment register')),
      'the failure must name the unregistered role',
    );
  } finally {
    removeTree(root);
  }
});

test('ADR gate: a record whose status contradicts the index FAILS', async () => {
  const root = treeWithAdrs({
    indexOwner: 'Chief AI & Model Orchestrator',
    recordOwner: 'Chief AI & Model Orchestrator',
    recordStatus: 'Superseded by ADR-0002',
  });
  try {
    const result = await adrGovernanceGate.run({ root });
    assert.equal(result.passed, false, 'a status contradiction must fail the gate');
    assert.ok(
      result.evidence.some((line) => line.includes('the index says status')),
      'the failure must name the status contradiction',
    );
  } finally {
    removeTree(root);
  }
});

test('ADR gate: a consistent index, record and register PASSES', async () => {
  const root = treeWithAdrs({
    indexOwner: 'Chief AI & Model Orchestrator',
    recordOwner: 'Chief AI & Model Orchestrator',
    recordStatus: 'Accepted',
  });
  try {
    const result = await adrGovernanceGate.run({ root });
    assert.equal(result.passed, true, result.detail);
  } finally {
    removeTree(root);
  }
});
/** Run a git command in a throwaway repository. */
function gitIn(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout ?? '').trim();
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

test('design-token gate: a raw colour literal in a source file FAILS', async () => {
  const root = treeWithTokens(
    'packages/onekey/src/theme.ts',
    `export const accent = '${COLOUR_SOURCE}';\n`,
  );
  try {
    const result = await hexTokenGate.run({ root });
    assert.equal(result.passed, false, 'a raw hex literal in source must fail the gate');
    assert.equal(result.severity, 'blocker');
    assert.ok(
      result.evidence.some((line) => line.includes('packages/onekey/src/theme.ts:1')),
      'the finding must name the file and line',
    );
  } finally {
    removeTree(root);
  }
});

test('design-token gate: an asset may hold a colour the token stylesheet defines', async () => {
  // The manifest, the icon and the theme-color meta element cannot express a
  // CSS variable. They may carry a literal — but only a token colour.
  const root = treeWithTokens(
    'apps/cli/public/icon.svg',
    `<svg><rect fill="${COLOUR_TOKEN}"/></svg>\n`,
  );
  try {
    const result = await hexTokenGate.run({ root });
    assert.equal(result.passed, true, result.detail);
  } finally {
    removeTree(root);
  }
});

test('design-token gate: an asset colour that is NOT a token FAILS', async () => {
  const root = treeWithTokens(
    'apps/cli/public/icon.svg',
    `<svg><rect fill="${COLOUR_FOREIGN}"/></svg>\n`,
  );
  try {
    const result = await hexTokenGate.run({ root });
    assert.equal(result.passed, false, 'an asset colour that drifts from the tokens must fail');
    assert.ok(result.evidence.some((line) => line.includes('not a design token value')));
  } finally {
    removeTree(root);
  }
});

test('contracts-baseline gate: an amendment without a commit is rejected', () => {
  const raw = JSON.stringify({
    baseline: 'e7a5e3f',
    frozenPath: 'packages/contracts/src',
    amendments: [
      {
        path: 'packages/contracts/tsconfig.json',
        reason: 'A packaging change that changes no contract type at all.',
        adr: 'ADR-0016',
      },
    ],
  });
  assert.throws(
    () => parseAmendments(raw),
    /commit/i,
    'an enumeration without the commit that introduced it cannot be checked',
  );
});

test('contracts-baseline gate: a change to the frozen surface is a blocker, never an amendment', () => {
  const raw = JSON.stringify({
    baseline: 'e7a5e3f',
    frozenPath: 'packages/contracts/src',
    amendments: [
      {
        path: 'packages/contracts/src/index.ts',
        reason: 'Trying to allowlist a change to the frozen contract surface.',
        adr: 'ADR-0016',
        commit: 'e7a5e3f',
      },
    ],
  });
  assert.throws(() => parseAmendments(raw), /frozen surface/);
});

test('contracts-baseline gate: an unlisted change under packages/contracts FAILS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edugenesis-contracts-'));
  try {
    const contractPath = join(root, 'packages', 'contracts', 'src', 'index.ts');
    mkdirSync(join(contractPath, '..'), { recursive: true });
    writeFileSync(contractPath, 'export const baseline = 1;\n', 'utf8');
    gitIn(root, ['init', '-q', '-b', 'main']);
    gitIn(root, ['add', '-A']);
    gitIn(root, ['-c', 'user.name=Gate', '-c', 'user.email=gate@example.invalid', 'commit', '-q', '-m', 'baseline']);
    const baseline = gitIn(root, ['rev-parse', 'HEAD']);

    // A change OUTSIDE the frozen surface, never enumerated.
    const configPath = join(root, 'packages', 'contracts', 'tsconfig.json');
    writeFileSync(configPath, '{ "extends": "../../tsconfig.base.json" }\n', 'utf8');

    const registerPath = join(root, 'docs', 'contracts-baseline-amendments.json');
    mkdirSync(join(registerPath, '..'), { recursive: true });
    writeFileSync(
      registerPath,
      `${JSON.stringify(
        { baseline, frozenPath: 'packages/contracts/src', amendments: [] },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const result = await contractsBaselineGate.run({ root });
    assert.equal(result.passed, false, 'an unlisted contracts change must fail the gate');
    assert.match(result.detail, /not enumerated/);
    assert.ok(
      result.evidence.some((line) => line.includes('packages/contracts/tsconfig.json')),
      'the finding must name the unlisted file',
    );
  } finally {
    removeTree(root);
  }
});

test('consent gate: a false pre-state is a failure, not a vacuous pass', () => {
  const verdict = assessConsentTransition({ shareBefore: false, shareAfter: false, mayLearn: true });
  assert.equal(verdict.passed, false, 'a service that never shares cannot demonstrate withdrawal');
  assert.match(verdict.detail, /no transition was observed/);
});

test('consent gate: sharing that survives withdrawal fails', () => {
  const verdict = assessConsentTransition({ shareBefore: true, shareAfter: true, mayLearn: true });
  assert.equal(verdict.passed, false, 'withdrawal that does not stop sharing must fail');
  assert.match(verdict.detail, /did NOT block/);
});

test('consent gate: withdrawal that blocks learning fails', () => {
  const verdict = assessConsentTransition({ shareBefore: true, shareAfter: false, mayLearn: false });
  assert.equal(verdict.passed, false, 'the core-learning guarantee is part of the gate');
  assert.match(verdict.detail, /BLOCKED core learning/);
});

test('consent gate: a real transition passes', () => {
  const verdict = assessConsentTransition({ shareBefore: true, shareAfter: false, mayLearn: true });
  assert.equal(verdict.passed, true);
});

/* -------------------------------------------------------------------------- */
/* Batch E gate halves: keyboard-focus (F2-01 / E1) and form-semantics (E2).  */
/* -------------------------------------------------------------------------- */

/**
 * The smallest focus system that SHOULD pass.
 *
 * The colours are system keywords, never literals, so the design-token gate
 * has nothing to report about this fixture.
 */
const GOOD_FOCUS_CSS = `:root {
  --eg-focus-width: 2px;
  --eg-focus-offset: 2px;
  --eg-focus-ring: CanvasText;
  --eg-surface: Canvas;
  --eg-gold: ButtonFace;
  --eg-text-primary: CanvasText;
}
:focus-visible {
  outline: var(--eg-focus-width) solid var(--eg-focus-ring);
  outline-offset: var(--eg-focus-offset);
  box-shadow: 0 0 0 calc(var(--eg-focus-width) + var(--eg-focus-offset)) var(--eg-surface);
}
.btn--gold:focus-visible {
  outline-color: var(--eg-text-primary);
}
@media (forced-colors: active) {
  :focus-visible { outline: 3px solid Highlight; }
}
`;

test('focus gate: a stylesheet with no focus-visible rule fails', () => {
  const verdict = assessFocusVisibility(':root { --eg-surface: Canvas; }\na { color: CanvasText; }\n');
  assert.equal(verdict.passed, false, 'a page with no authored focus indicator must fail the gate');
  assert.ok(verdict.findings.some((line) => line.includes('no `:focus-visible` rule')));
});

test('focus gate: a rule that removes the outline fails', () => {
  const css = GOOD_FOCUS_CSS.replace('outline-offset: var(--eg-focus-offset);', 'outline-offset: var(--eg-focus-offset);\n  outline: none;');
  const verdict = assessFocusVisibility(css);
  assert.equal(verdict.passed, false, 'outline:none in the focus rule must fail, not pass silently');
  assert.ok(verdict.findings.some((line) => line.includes('hides the indicator')));
});

test('focus gate: a focus rule that suppresses the outline elsewhere fails', () => {
  const css = `${GOOD_FOCUS_CSS}\n.card:focus { outline: none; }\n`;
  const verdict = assessFocusVisibility(css);
  assert.equal(verdict.passed, false, 'any :focus rule that removes the indicator must fail');
  assert.ok(verdict.findings.some((line) => line.includes('suppresses the outline')));
});

test('focus gate: a missing forced-colors override fails', () => {
  const css = GOOD_FOCUS_CSS.replace(/@media \(forced-colors: active\) \{[\s\S]*?\}\n\}/, '');
  const verdict = assessFocusVisibility(css);
  assert.equal(verdict.passed, false, 'the ring disappears in forced-colors mode without an override');
  assert.ok(verdict.findings.some((line) => line.includes('forced-colors')));
});

test('focus gate: an undefined focus token fails', () => {
  const css = GOOD_FOCUS_CSS.replace('--eg-focus-ring: CanvasText;', '');
  const verdict = assessFocusVisibility(css);
  assert.equal(verdict.passed, false, 'a token the stylesheet never defines cannot ship a visible ring');
  assert.ok(verdict.findings.some((line) => line.includes('--eg-focus-ring')));
});

test('focus gate: the complete focus system passes', () => {
  const verdict = assessFocusVisibility(GOOD_FOCUS_CSS);
  assert.equal(verdict.passed, true, `unexpected findings: ${verdict.findings.join(' | ')}`);
});

/** The smallest settings page that SHOULD pass the form-semantics gate. */
const GOOD_FORM_HTML = `<!doctype html>
<html lang="en">
  <body>
    <main id="main">
      <form id="settings-form" novalidate>
        <div class="field">
          <label for="server-port">Port</label>
          <input id="server-port" name="server.port" type="number" aria-describedby="hint-server-port" />
          <p class="hint" id="hint-server-port">A port change takes effect the next time the server starts.</p>
        </div>
        <div class="switch">
          <input id="features-telemetry" type="checkbox" aria-describedby="hint-features-telemetry" />
          <label for="features-telemetry">Telemetry</label>
          <p class="hint" id="hint-features-telemetry">Off by default.</p>
        </div>
        <p class="eg-status" id="status" role="status" aria-live="polite"></p>
      </form>
    </main>
  </body>
</html>
`;

test('form-semantics gate: a hinted control that does not reference its hint fails', () => {
  const html = GOOD_FORM_HTML.replace(' aria-describedby="hint-server-port"', '');
  const verdict = assessFormSemantics(html);
  assert.equal(verdict.passed, false, 'a hint rendered next to a control must be announced with it');
  assert.ok(verdict.findings.some((line) => line.includes('hint-server-port')));
});

test('form-semantics gate: a dangling describedby reference fails', () => {
  const html = GOOD_FORM_HTML.replace('aria-describedby="hint-server-port"', 'aria-describedby="hint-missing"');
  const verdict = assessFormSemantics(html);
  assert.equal(verdict.passed, false, 'a reference to an id that does not exist must fail');
  assert.ok(verdict.findings.some((line) => line.includes('hint-missing')));
});

test('form-semantics gate: a duplicated id fails', () => {
  const html = GOOD_FORM_HTML.replace('id="status"', 'id="hint-server-port"');
  const verdict = assessFormSemantics(html);
  assert.equal(verdict.passed, false, 'a duplicated id makes every reference to it ambiguous');
  assert.ok(verdict.findings.some((line) => line.includes('appears 2 times')));
});

test('form-semantics gate: an unlabelled control fails', () => {
  const html = GOOD_FORM_HTML.replace('<label for="server-port">Port</label>', '');
  const verdict = assessFormSemantics(html);
  assert.equal(verdict.passed, false, 'a control with no accessible name must fail');
  assert.ok(verdict.findings.some((line) => line.includes('no accessible name')));
});

test('form-semantics gate: a page with no live region fails', () => {
  const html = GOOD_FORM_HTML.replace(' role="status" aria-live="polite"', '');
  const verdict = assessFormSemantics(html);
  assert.equal(verdict.passed, false, 'save and error feedback that is never announced is silent');
  assert.ok(verdict.findings.some((line) => line.includes('role="status"')));
});

test('form-semantics gate: the complete settings page passes', () => {
  const verdict = assessFormSemantics(GOOD_FORM_HTML);
  assert.equal(verdict.passed, true, `unexpected findings: ${verdict.findings.join(' | ')}`);
});
