/**
 * PII guard tests.
 *
 * These are the tests that stand between the platform and the one thing that
 * would destroy it: a learner's name in a ledger that is published, permanent
 * and global (Doc 2 §2.5; Doc 16 §3.5).
 *
 * Each case is written as an ATTACK, not as a feature: an innocuous key with a
 * personal value, a nested object, an array element, a camelCase spelling, a
 * shouting spelling.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FORBIDDEN_LEDGER_FIELDS } from '@edugenesis/contracts';

import {
  assertNoPersonalData,
  findForbiddenFieldPaths,
  findPersonalDataValues,
  isForbiddenFieldName,
  normalizeFieldName,
  EXTENDED_FORBIDDEN_LEDGER_FIELDS,
  VALUE_DETECTION_RULES,
} from './pii-guard.js';

test('the frozen contract list is honoured', () => {
  assert.equal(isForbiddenFieldName('learner_id'), true);
  assert.equal(isForbiddenFieldName('learner_name'), true);
  assert.equal(isForbiddenFieldName('email'), true);
  assert.equal(isForbiddenFieldName('national_id'), true);
});

test('normalisation collapses every spelling of the same field name', () => {
  assert.equal(normalizeFieldName('learner_id'), 'learnerid');
  assert.equal(normalizeFieldName('learnerId'), 'learnerid');
  assert.equal(normalizeFieldName('LEARNER_ID'), 'learnerid');
  assert.equal(normalizeFieldName('learner.id'), 'learnerid');
  assert.equal(normalizeFieldName('Learner Id'), 'learnerid');
  for (const spelling of ['learner_id', 'learnerId', 'LEARNER_ID', 'learner.id']) {
    assert.equal(isForbiddenFieldName(spelling), true, `${spelling} must be refused`);
  }
});

test('a forbidden field name is refused whatever its casing', () => {
  const result = assertNoPersonalData({ learner_name: 'Synthetic Learner' });
  assert.equal(result.ok, false);
  // F5-07 adds value scanning: a forbidden field name AND a name-shaped value
  // are both violations now. Both must be named, not merely counted.
  assert.equal(result.violations.length, 2);
  assert.match(result.violations.join(' '), /learner_name/);
  assert.match(result.violations[0] ?? '', /forbidden field name/);
  assert.match(result.violations[1] ?? '', /possible personal name in value/);
});

test('a forbidden field name nested in an object is refused', () => {
  const result = assertNoPersonalData({ meta: { learnerId: 'x' } });
  assert.equal(result.ok, false);
  assert.match(result.violations.join(' '), /meta\.learnerId/);
});

test('a forbidden field name inside an array is refused', () => {
  const result = assertNoPersonalData({ items: [{ ok: 1 }, { LEARNER_ID: 'x' }] });
  assert.equal(result.ok, false);
  assert.match(result.violations.join(' '), /items\[1\]\.LEARNER_ID/);
});

test('a shouting forbidden field name is refused', () => {
  const result = assertNoPersonalData({ LEARNER_ID: 'x' });
  assert.equal(result.ok, false);
});

test('an email-shaped value is caught even under an innocuous key', () => {
  const result = assertNoPersonalData({ contact: 'ada@example.org' });
  assert.equal(result.ok, false);
  assert.match(result.violations.join(' '), /email/);
});

test('a long digit string (phone / national id) is caught under an innocuous key', () => {
  const result = assertNoPersonalData({ reference: '0712345678' });
  assert.equal(result.ok, false);
  assert.match(result.violations.join(' '), /digit/);
});

test('a separated phone number is caught', () => {
  const result = assertNoPersonalData({ reference: '+000 000 0000' });
  assert.equal(result.ok, false);
});

test('a payload with only allowed fields passes', () => {
  const result = assertNoPersonalData({
    amount_cents: 1_750_000,
    currency: 'USD',
    cohort: 'Kisumu-G7-A',
    region: 'Kisumu',
    learningArea: 'algebra',
    sponsor_ref: 'SP-001',
    devices_delivered: 12,
  });
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});

test('hashes, timestamps and compact dates are not mistaken for personal data', () => {
  const result = assertNoPersonalData({
    entry_hash: 'a'.repeat(64),
    merkle_root: '0123456789abcdef'.repeat(4),
    at: '2026-01-15T10:00:00.000Z',
    compact: '20261112',
    cohort: 'Cohort 20261112',
  });
  assert.deepEqual(result.violations, []);
});

test('an organisational name is not a forbidden field', () => {
  const result = assertNoPersonalData({ sponsor_name: 'Anchor Foundation', category: 'devices' });
  assert.equal(result.ok, true);
});

test('the guard reports the exact paths it found', () => {
  assert.deepEqual(findForbiddenFieldPaths({ a: { b: [{ learner_name: 'x' }] } }), [
    'a.b[0].learner_name',
  ]);
  assert.equal(findPersonalDataValues({ a: 'learner@example.org' }).length, 1);
});

/**
 * HOMOGLYPH AND UNICODE-FORM TESTS (round-4 audit, finding F4-01).
 *
 * The guard's promise is that a forbidden field cannot reach the public ledger.
 * A field name is attacker-chosen text, so the comparison has to survive the
 * spellings a text editor does not distinguish: compatibility forms, and
 * letters borrowed from another alphabet.
 */
test('a full-width spelling of a forbidden field is caught, not collapsed away', () => {
  // NFKC folds the full-width forms; without it the letters are stripped and
  // `ｌｅａｒｎｅｒ＿ｉｄ` becomes the meaningless token `id`.
  assert.equal(normalizeFieldName('\uFF4C\uFF45\uFF41\uFF52\uFF4E\uFF45\uFF52\uFF3F\uFF49\uFF44'), 'learnerid');
  assert.equal(isForbiddenFieldName('\uFF4C\uFF45\uFF41\uFF52\uFF4E\uFF45\uFF52\uFF3F\uFF49\uFF44'), true);
});

test('a Cyrillic look-alike spelling of a forbidden field is caught', () => {
  // `lеаrnerid` written with U+0435 and U+0430: visually identical to the
  // Latin spelling, and previously normalised to `lrnrid`.
  const homoglyph = `l\u0435\u0430rner\u0456d`;
  assert.equal(normalizeFieldName(homoglyph), 'learnerid');
  assert.equal(isForbiddenFieldName(homoglyph), true);
});

test('a Greek look-alike spelling of a forbidden field is caught', () => {
  const homoglyph = `\u03B1ddress`; // GREEK SMALL LETTER ALPHA
  assert.equal(normalizeFieldName(homoglyph), 'address');
  assert.equal(isForbiddenFieldName(homoglyph), true);
});

test('folding is an extension: ordinary ASCII normalisation is unchanged', () => {
  assert.equal(normalizeFieldName('learner_id'), 'learnerid');
  assert.equal(normalizeFieldName('learnerId'), 'learnerid');
  assert.equal(normalizeFieldName('LEARNER_ID'), 'learnerid');
  assert.equal(normalizeFieldName('learner.id'), 'learnerid');
  assert.equal(normalizeFieldName('learner id'), 'learnerid');
  assert.equal(isForbiddenFieldName('total_spend_cents'), false);
});

test('VALUE: a personal name in free text under an innocuous key is refused', () => {
  // F5-07: a field name is not a guarantee. A prose value under a key like
  // `note` can carry a learner's full name; pattern-only value scanning used
  // to let that through because no email/digit shape was present.
  const result = assertNoPersonalData({ note: 'Learner Amina Ochieng missed the session.' });
  assert.equal(result.ok, false);
  assert.match(result.violations.join(' '), /personal name/i);
});

test('VALUE: an obfuscated email is refused', () => {
  // Writing the at-sign and the dot as words used to slip past V1 entirely.
  const result = assertNoPersonalData({ contact: 'ada [at] example [dot] org' });
  assert.equal(result.ok, false);
  assert.match(result.violations.join(' '), /email/i);
});

test('VALUE: a zero-width-obfuscated phone number is refused', () => {
  // Zero-width characters between the digits broke the contiguous digit run
  // that V2/V3 used to match, hiding a phone number in plain sight.
  const result = assertNoPersonalData({ reference: '07\u200B12\u200B34\u200B56\u200B78' });
  assert.equal(result.ok, false);
  assert.match(result.violations.join(' '), /digit|phone/i);
});

test('VALUE: an organisational name is not mistaken for a personal name', () => {
  // Explicit false-positive handling: the name rule is an extension, never a
  // narrowing. Known organisational values and keys stay legal.
  const result = assertNoPersonalData({ sponsor_name: 'Anchor Foundation', category: 'devices' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('the detection rules are published so an auditor can read them', () => {
  assert.ok(VALUE_DETECTION_RULES.length >= 3);
  assert.match(VALUE_DETECTION_RULES.join(' '), /email-address/);
  assert.match(VALUE_DETECTION_RULES.join(' '), /long-digit-string/);
});

test('the value rules include the name and obfuscation detectors an auditor relies on', () => {
  assert.ok(VALUE_DETECTION_RULES.length >= 6);
  assert.match(VALUE_DETECTION_RULES.join(' '), /personal name/i);
  assert.match(VALUE_DETECTION_RULES.join(' '), /obfuscat/i);
});

test('every forbidden field in the frozen contract is enforced by this guard', () => {
  // The contract lists the fields that may never reach the public ledger. The
  // guard extends that list with more it discovered. The extension must be an
  // extension, never a narrowing: a field the contract forbids but the guard
  // permits would be a hole in the published ledger.
  const missing = FORBIDDEN_LEDGER_FIELDS.filter((field) => !isForbiddenFieldName(field));

  assert.deepEqual(missing, [], 'the guard permits a field the frozen contract forbids');
  assert.ok(
    EXTENDED_FORBIDDEN_LEDGER_FIELDS.length > FORBIDDEN_LEDGER_FIELDS.length,
    'the guard is supposed to extend the contract list, not replace it',
  );
});
