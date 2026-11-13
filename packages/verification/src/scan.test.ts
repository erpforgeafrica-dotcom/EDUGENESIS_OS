/**
 * Unit tests for the static scanners.
 *
 * NOTE ON FIXTURES: every "dangerous" string in this file is assembled from
 * fragments at runtime. The scanners must not flag this file itself, and the
 * final self-check test proves it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPiiViolations, findHexViolations, findAbsolutePathViolations } from './scan.js';
import {
  defaultProjectRoot,
  collectSourceFiles,
  isScannableExtension,
  listDocumentationFiles,
  readSourceFiles,
} from './paths.js';
import type { SourceFile } from './types.js';

/** Join fragments so no sensitive literal is ever contiguous in this source. */
const j = (...parts: string[]): string => parts.join('');

/** Build a hex colour literal without a contiguous hash in the source. */
const hex = (digits: string): string => j('#', digits);

/** Build a functional colour literal without a contiguous call in the source. */
const fnColour = (name: string, args: string): string => j(name, '(', args, ')');

function file(relPath: string, lines: string[]): SourceFile {
  return { relPath, absPath: relPath, content: lines.join('\n') };
}

test('pii scanner flags a non-synthetic email address', () => {
  const email = j('learner', '@', 'mail', '.net');
  const violations = findPiiViolations([file('packages/x/src/a.ts', [`const owner = '${email}';`])]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'pii-email');
  assert.equal(violations[0]?.file, 'packages/x/src/a.ts');
  assert.equal(violations[0]?.line, 1);
});

test('pii scanner allows the reserved example domain', () => {
  const email = j('learner', '@', 'example', '.org');
  const violations = findPiiViolations([file('packages/x/src/a.ts', [`const owner = '${email}';`])]);
  assert.deepEqual(violations, []);
});

test('pii scanner allows the documented test- and +000 markers', () => {
  const email = j('test', '-', 'learner', '@', 'example', '.org');
  const phone = j('+000', '700', '123', '456');
  const violations = findPiiViolations([
    file('packages/x/src/a.ts', [`const a = '${email}';`, `const b = '${phone}';`]),
  ]);
  assert.deepEqual(violations, []);
});

test('pii scanner flags a phone-number-shaped digit string', () => {
  const phone = j('+254', '712', '345', '678');
  const violations = findPiiViolations([file('packages/x/src/a.ts', [`const phone = '${phone}';`])]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'pii-phone');
});

test('pii scanner ignores plain numbers, ip addresses and timestamps', () => {
  const violations = findPiiViolations([
    file('packages/x/src/a.ts', [
      'const ratio = 0.123456789;',
      'const host = "192.168.100.200";',
      'const at = "2026-11-12T09:30:00.000Z";',
      'const epoch = 1762838400000;',
    ]),
  ]);
  assert.deepEqual(violations, []);
});

test('pii scanner flags a personal name in a personal-data field', () => {
  const field = j('learner', '_', 'name');
  const value = j('Ada', ' Lovelace');
  const violations = findPiiViolations([file('packages/x/src/a.ts', [`const r = { ${field}: '${value}' };`])]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'pii-name');
});

test('pii scanner ignores a synthetic identifier in a personal-data field', () => {
  const field = j('learner', '_', 'name');
  const value = j('learner-', '0001');
  const violations = findPiiViolations([file('packages/x/src/a.ts', [`const r = { ${field}: '${value}' };`])]);
  assert.deepEqual(violations, []);
});

test('pii violations never carry the offending value', () => {
  const email = j('secret', '@', 'mail', '.net');
  const violations = findPiiViolations([file('packages/x/src/a.ts', [`const owner = '${email}';`])]);
  const rendered = JSON.stringify(violations);
  assert.equal(rendered.includes('secret'), false);
  assert.equal(rendered.includes('mail.net'), false);
});

test('hex scanner flags raw hex colour literals', () => {
  const violations = findHexViolations([
    file('packages/x/src/a.ts', [`const c = '${hex('ff0000')}';`]),
    file('packages/x/src/b.ts', [`const c = '${hex('abc')}';`]),
  ]);
  assert.equal(violations.length, 2);
  assert.ok(violations.every((v) => v.rule === 'hex-literal'));
});

test('hex scanner ignores a long hex run such as a digest', () => {
  const digest = 'a'.repeat(64);
  const violations = findHexViolations([file('packages/x/src/a.ts', [`const h = '${digest}';`])]);
  assert.deepEqual(violations, []);
});

test('hex scanner flags rgba and hsla literals', () => {
  const violations = findHexViolations([
    file('packages/x/src/a.ts', [`const c = '${fnColour('rgba', '0,0,0,0.5')}';`]),
    file('packages/x/src/b.ts', [`const c = '${fnColour('hsla', '0,0%,0%,0.5')}';`]),
  ]);
  assert.equal(violations.length, 2);
  assert.ok(violations.every((v) => v.rule === 'functional-colour-literal'));
});

test('path scanner flags a windows drive letter path', () => {
  // Deliberately without a user-profile segment, so exactly one rule fires.
  const p = j('C', ':', '\\', 'Projects', '\\', 'eg');
  const violations = findAbsolutePathViolations([file('packages/x/src/a.ts', [`const p = '${p}';`])]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'abs-drive-letter');
});

test('path scanner flags a unc path', () => {
  const p = j('\\\\', 'server', '\\', 'share');
  const violations = findAbsolutePathViolations([file('packages/x/src/a.ts', [`const p = '${p}';`])]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'abs-unc');
});

test('path scanner flags a literal user profile segment', () => {
  const p = j('\\', 'Users', '\\', 'someone', '\\', 'project');
  const violations = findAbsolutePathViolations([file('packages/x/src/a.ts', [`const p = '${p}';`])]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'abs-user-profile');
});

test('path scanner ignores relative paths and url schemes', () => {
  const violations = findAbsolutePathViolations([
    file('packages/x/src/a.ts', ["const a = './packages/x/src';", "const b = '../..';", "const c = 'https://example.org/x';"]),
  ]);
  assert.deepEqual(violations, []);
});

test('path scanner does not mistake an escape sequence for a drive letter', () => {
  // Regression: before the boundary lookbehind, the last letter of an English
  // word was read as a drive letter. `settings:\n` is a label plus a newline
  // escape, not an absolute path, and every throw-statement in the tree was a
  // false portability finding.
  const violations = findAbsolutePathViolations([
    file('packages/x/src/a.ts', [
      'throw new Error(`invalid settings:\\n  ${detail}`);',
      'process.stderr.write(`the schema did not validate:\\n`);',
      'const message = `copy failed:\\n${report}`;',
    ]),
  ]);
  assert.deepEqual(violations, []);
});

test('path scanner still flags a lowercase drive letter in a string literal', () => {
  const p = j('d', ':', '\\', 'data');
  const violations = findAbsolutePathViolations([file('packages/x/src/a.ts', [`const p = '${p}';`])]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'abs-drive-letter');
});

/* -------------------------------------------------------------------------- */
/* Widened detectors (round-4 finding F6-04)                                   */
/* -------------------------------------------------------------------------- */

test('path scanner flags a drive letter written with a forward slash', () => {
  // The audited hole: the class was backslash-only, so this walked through.
  const p = j('C', ':', '/', 'Projects', '/', 'eg');
  const violations = findAbsolutePathViolations([file('packages/x/src/a.ts', [`const p = '${p}';`])]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'abs-drive-letter');
});

test('path scanner flags a forward-slash user profile segment', () => {
  const p = j('/', 'Users', '/', 'someone', '/', 'project');
  const violations = findAbsolutePathViolations([file('packages/x/src/a.ts', [`const p = '${p}';`])]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'abs-user-profile');
});

test('path scanner flags a POSIX home-directory segment', () => {
  const p = j('/', 'home', '/', 'someone', '/', 'project');
  const violations = findAbsolutePathViolations([file('packages/x/src/a.ts', [`const p = '${p}';`])]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'abs-home-profile');
});

test('path scanner flags a forward-slash UNC share', () => {
  const p = j('/', '/', 'server', '/', 'share');
  const violations = findAbsolutePathViolations([file('packages/x/src/a.ts', [`const p = '${p}';`])]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'abs-unc-posix');
});

test('path scanner ignores a protocol-relative URL but not a share-looking host', () => {
  // A protocol-relative URL points at a dotted domain, and flagging it would
  // make every doc link a finding; the same shape over a dot-free host is a
  // share and must still be caught.
  const url = j('/', '/', 'example.org', '/', 'x');
  const share = j('/', '/', 'server', '/', 'share');
  const violations = findAbsolutePathViolations([
    file('packages/x/src/a.ts', [`const u = '${url}';`, `const s = '${share}';`]),
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'abs-unc-posix');
});

test('path scanner ignores an escaped newline and the device namespace', () => {
  // `\\n\` is prose about an escape sequence and `\\.\` is the Windows device
  // namespace — neither carries a real host name of two or more characters.
  const escaped = j('\\', '\\', 'n', '\\');
  const device = j('\\', '\\', '.', '\\');
  const violations = findAbsolutePathViolations([
    file('packages/x/src/a.ts', [`const a = '${escaped}';`, `const b = '${device}';`]),
  ]);
  assert.deepEqual(violations, []);
});

test('the doc extension list now includes markdown and csv', () => {
  // The audit found `.md`/`.csv` named nowhere, so a documented machine path
  // was invisible. The set itself is asserted through the exported predicate.
  assert.equal(isScannableExtension('docs/setup.md'), true);
  assert.equal(isScannableExtension('data/roster.CSV'), true);
  assert.equal(isScannableExtension('docs/setup.txt'), false);
});

test('the documentation scope reads the root docs and the docs folder', () => {
  const root = defaultProjectRoot();
  const docs = listDocumentationFiles(root);
  assert.ok(docs.some((p) => p.startsWith('docs/') && p.endsWith('.md')));
  assert.ok(docs.every((p) => isScannableExtension(p)));
  // The scanned scope never comes back empty for this project.
  assert.ok(readSourceFiles(root, docs).length >= docs.length - 1);
});

test('the scanners find nothing wrong with their own source tree', () => {
  const root = defaultProjectRoot();
  // Only this package: the harness must police its own hygiene. The whole
  // tree is policed by the PII / hex / path gates, not by this unit test.
  const files = collectSourceFiles(root, ['packages/verification/src']);
  assert.ok(files.length > 0, 'expected to find the harness source itself');
  assert.deepEqual(findPiiViolations(files), []);
  assert.deepEqual(findHexViolations(files), []);
  assert.deepEqual(findAbsolutePathViolations(files), []);
});
