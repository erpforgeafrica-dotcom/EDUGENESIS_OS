/**
 * The public surface of @edugenesis/accessibility — RED-phase specification.
 *
 * The package entry point is the only thing other packages may import, so the
 * surface is asserted explicitly rather than left to drift.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as accessibility from './index.js';

describe('the package entry point', () => {
  test('exports the validator, the guardian and the context resolver', () => {
    assert.equal(typeof accessibility.createAccessibilityValidator, 'function');
    assert.equal(typeof accessibility.createAccessibilityGuardian, 'function');
    assert.equal(typeof accessibility.resolveValidationContext, 'function');
    assert.equal(typeof accessibility.blockerViolations, 'function');
  });

  test('exports the invariant set', () => {
    assert.equal(Array.isArray(accessibility.ARC_INVARIANTS), true);
    assert.equal(accessibility.ARC_INVARIANTS.length, 12);
    assert.equal(typeof accessibility.ARC_INVARIANT_BY_ID, 'object');
    assert.equal(accessibility.ARC_INVARIANT_BY_ID['ARC-I1']?.severity, 'Blocker');
  });

  test('exports the hashing helpers', () => {
    assert.equal(typeof accessibility.hashCanonicalContent, 'function');
    assert.equal(typeof accessibility.canonicaliseContent, 'function');
  });

  test('exports the BCP-47 helpers', () => {
    assert.equal(typeof accessibility.parseBcp47, 'function');
    assert.equal(typeof accessibility.isValidBcp47, 'function');
    assert.equal(typeof accessibility.canonicalizeBcp47, 'function');
  });

  test('exports the equivalence engine', () => {
    assert.equal(typeof accessibility.EQUIVALENCE_MATRIX, 'object');
    assert.equal(Array.isArray(accessibility.NON_MODALITY_EQUIVALENCE_ROWS), true);
    assert.equal(typeof accessibility.equivalenceFor, 'function');
    assert.equal(typeof accessibility.checkEquivalence, 'function');
    assert.equal(typeof accessibility.equivalenceReport, 'function');
  });

  test('exports the documented defaults', () => {
    assert.equal(accessibility.DEFAULT_MEDIA_BUDGET_BYTES, 5_242_880);
    assert.equal(accessibility.DEFAULT_CONFIDENCE_THRESHOLD, 0.7);
  });
});
