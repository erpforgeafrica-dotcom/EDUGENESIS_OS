/**
 * The accessibility validator — RED-phase specification.
 *
 * Doc 2 §2.3: "Accessibility is not a post-processing layer. It is a runtime
 * contract." This suite proves the contract is enforced before delivery.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_MEDIA_BUDGET_BYTES,
  createAccessibilityValidator,
  resolveValidationContext,
} from './validator.js';
import { buildEmission } from './fixtures.js';
import { hashCanonicalContent } from './content-hash.js';

describe('the accessibility validator', () => {
  test('a valid emission passes with zero violations', () => {
    const validator = createAccessibilityValidator();
    const result = validator.validate(buildEmission());

    assert.equal(result.violations.length, 0, JSON.stringify(result.violations, null, 2));
    assert.equal(result.ok, true);
    assert.equal(result.passed.length, 12);
    assert.deepEqual(result.passed, [
      'ARC-I1',
      'ARC-I2',
      'ARC-I3',
      'ARC-I4',
      'ARC-I5',
      'ARC-I6',
      'ARC-I7',
      'ARC-I8',
      'ARC-I9',
      'ARC-I10',
      'ARC-I11',
      'ARC-I12',
    ]);
  });

  test('resolves the documented context defaults', () => {
    const resolved = resolveValidationContext();
    assert.equal(resolved.mediaBudgetBytes, 5_242_880);
    assert.equal(resolved.mediaBudgetBytes, DEFAULT_MEDIA_BUDGET_BYTES);
    assert.equal(resolved.confidenceThreshold, 0.7);
    assert.equal(resolved.confidenceThreshold, DEFAULT_CONFIDENCE_THRESHOLD);
    assert.equal(resolved.hasAccessibilityProfile, false);
    assert.equal(resolved.safetyTier, 'low');
    assert.equal(resolved.locale, undefined);
  });

  test('honours an explicit context override', () => {
    const resolved = resolveValidationContext({
      locale: 'en-KE',
      mediaBudgetBytes: 1024,
      hasAccessibilityProfile: true,
      confidenceThreshold: 0.9,
      safetyTier: 'critical',
    });
    assert.equal(resolved.locale, 'en-KE');
    assert.equal(resolved.mediaBudgetBytes, 1024);
    assert.equal(resolved.hasAccessibilityProfile, true);
    assert.equal(resolved.confidenceThreshold, 0.9);
    assert.equal(resolved.safetyTier, 'critical');
  });

  test('validates a batch and keeps the results in order', () => {
    const validator = createAccessibilityValidator();
    const broken = buildEmission({ withheld: true });
    const results = validator.validateMany([buildEmission(), broken, buildEmission()]);
    assert.equal(results.length, 3);
    assert.equal(results[0]?.ok, true);
    assert.equal(results[1]?.ok, false);
    assert.equal(results[1]?.violations[0]?.id, 'ARC-I8');
    assert.equal(results[2]?.ok, true);
  });

  test('ARC-I9 detects a tampered content hash', () => {
    const validator = createAccessibilityValidator();
    const emission = buildEmission({
      metadata: { content_hash: `sha256:${'a'.repeat(64)}` },
    });
    const result = validator.validate(emission);
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    const violation = result.violations[0];
    assert.ok(violation !== undefined);
    assert.equal(violation.id, 'ARC-I9');
    assert.equal(violation.path, 'metadata.content_hash');
  });

  test('ARC-I9 detects content drift that was not rehashed', () => {
    const validator = createAccessibilityValidator();
    const emission = buildEmission();
    // The body changes but the recorded hash is left as it was: the content
    // drifted away from the hash the emitter published.
    const drifted = {
      ...emission,
      canonical_content: { ...emission.canonical_content, body: 'A different body entirely.' },
    };
    const result = validator.validate(drifted);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]?.id, 'ARC-I9');
    assert.notEqual(
      hashCanonicalContent(drifted.canonical_content),
      emission.metadata.content_hash,
    );
  });

  test('ARC-I9 accepts the hash of the canonical content', () => {
    const validator = createAccessibilityValidator();
    const emission = buildEmission();
    assert.equal(emission.metadata.content_hash, hashCanonicalContent(emission.canonical_content));
    assert.equal(validator.validate(emission).ok, true);
  });

  test('ARC-I10 rejects an emission that exceeds the media budget', () => {
    const validator = createAccessibilityValidator();
    const emission = buildEmission({ metadata: { media_bytes_total: 6_000_000 } });
    const result = validator.validate(emission);
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    const violation = result.violations[0];
    assert.ok(violation !== undefined);
    assert.equal(violation.id, 'ARC-I10');
    assert.equal(violation.severity, 'High');
  });

  test('ARC-I10 accepts an emission under the media budget', () => {
    const validator = createAccessibilityValidator();
    const under = buildEmission({ metadata: { media_bytes_total: 1_000 } });
    const result = validator.validate(under);
    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
  });

  test('ARC-I10 respects a delivery mode with a smaller budget', () => {
    const validator = createAccessibilityValidator();
    const emission = buildEmission({ metadata: { media_bytes_total: 41_200 } });
    assert.equal(validator.validate(emission, { mediaBudgetBytes: 40_000 }).ok, false);
    assert.equal(validator.validate(emission, { mediaBudgetBytes: 41_200 }).ok, true);
  });

  test('ARC-I11 blocks an emission when a profile is present and the gate is not approved', () => {
    const validator = createAccessibilityValidator();
    const emission = buildEmission({
      special_category_flag: true,
      validation: { gate: 'pending' },
    });
    const result = validator.validate(emission, { hasAccessibilityProfile: true });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    const violation = result.violations[0];
    assert.ok(violation !== undefined);
    assert.equal(violation.id, 'ARC-I11');
    assert.equal(violation.severity, 'Blocker');
    assert.equal(violation.path, 'validation.gate');
  });

  test('ARC-I11 allows an approved emission when a profile is present', () => {
    const validator = createAccessibilityValidator();
    const emission = buildEmission({
      special_category_flag: true,
      validation: { gate: 'approved' },
    });
    const result = validator.validate(emission, { hasAccessibilityProfile: true });
    assert.equal(result.ok, true);
  });

  test('ARC-I11 does not require a gate when no profile is present', () => {
    const validator = createAccessibilityValidator();
    const result = validator.validate(buildEmission({ validation: { gate: 'pending' } }));
    assert.equal(result.ok, true);
  });

  test('ARC-I12 requires the special category flag when a profile is present', () => {
    const validator = createAccessibilityValidator();
    const emission = buildEmission({
      special_category_flag: false,
      validation: { gate: 'approved' },
    });
    const result = validator.validate(emission, { hasAccessibilityProfile: true });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]?.id, 'ARC-I12');
  });

  test('ARC-I12 does not require the flag when no profile is present', () => {
    const validator = createAccessibilityValidator();
    const result = validator.validate(buildEmission({ special_category_flag: false }));
    assert.equal(result.ok, true);
  });

  test('ARC-I4 follows the configured confidence threshold', () => {
    const validator = createAccessibilityValidator();
    const emission = buildEmission({ confidence_score: 0.8, uncertainty_note: null });
    assert.equal(validator.validate(emission, { confidenceThreshold: 0.9 }).ok, false);
    assert.equal(validator.validate(emission, { confidenceThreshold: 0.7 }).ok, true);
  });
});
