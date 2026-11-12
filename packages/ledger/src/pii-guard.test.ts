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

import {
  assertNoPersonalData,
  findForbiddenFieldPaths,
  findPersonalDataValues,
  isForbiddenFieldName,
  normalizeFieldName,
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
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0] ?? '', /learner_name/);
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

test('the detection rules are published so an auditor can read them', () => {
  assert.ok(VALUE_DETECTION_RULES.length >= 3);
  assert.match(VALUE_DETECTION_RULES.join(' '), /email-address/);
  assert.match(VALUE_DETECTION_RULES.join(' '), /long-digit-string/);
});
