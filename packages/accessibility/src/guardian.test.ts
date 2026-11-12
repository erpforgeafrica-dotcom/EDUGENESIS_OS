/**
 * The Accessibility Guardian — RED-phase specification.
 *
 * Doc 6 §7.3: the guardian is the interception point every learner-facing
 * emission passes through. Doc 2 §2.3 makes the accessibility contract a
 * runtime contract, so a violation must stop delivery — not annotate it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createAccessibilityGuardian } from './guardian.js';
import { createAccessibilityValidator } from './validator.js';
import { buildEmission } from './fixtures.js';

function guardian() {
  return createAccessibilityGuardian(createAccessibilityValidator());
}

describe('the accessibility guardian', () => {
  test('delivers a valid emission unchanged', async () => {
    const emission = buildEmission();
    const result = await guardian().intercept(emission);

    assert.equal(result.deliver, true);
    assert.equal(result.emission, emission);
    assert.deepEqual(result.violations, []);
    assert.notEqual(emission.withheld, true);
  });

  test('refuses to deliver a blocked emission and marks it withheld', async () => {
    const emission = buildEmission({ accessible_alternative: undefined, equivalence_verified: false });
    const result = await guardian().intercept(emission);

    assert.equal(result.deliver, false);
    assert.equal(result.emission?.withheld, true);
    assert.equal(emission.withheld, true, 'the emission itself must be marked withheld');
    assert.ok(result.violations.length > 0);
    assert.equal(result.violations[0]?.id, 'ARC-I1');
  });

  test('never delivers an emission that is already withheld', async () => {
    const emission = buildEmission({ withheld: true });
    const result = await guardian().intercept(emission);

    assert.equal(result.deliver, false);
    assert.equal(result.violations[0]?.id, 'ARC-I8');
    assert.equal(result.emission?.withheld, true);
  });

  test('never mutates the canonical content', async () => {
    const emission = buildEmission({ risk_tier: 7 });
    const before = structuredClone(emission.canonical_content);
    const result = await guardian().intercept(emission);

    assert.equal(result.deliver, false);
    assert.deepEqual(emission.canonical_content, before);
    assert.deepEqual(result.emission?.canonical_content, before);
  });

  test('blocks an emission whose gate is not approved for a profiled learner', async () => {
    const emission = buildEmission({
      special_category_flag: true,
      validation: { gate: 'pending' },
    });
    const result = await guardian().intercept(emission, { hasAccessibilityProfile: true });

    assert.equal(result.deliver, false);
    assert.equal(result.violations[0]?.id, 'ARC-I11');
    assert.equal(result.emission?.withheld, true);
  });

  test('blocks a High severity violation for a learner-facing emission', async () => {
    // 07 §5.3: a High severity invariant fails the build; a learner-facing
    // emission that fails it must still be withheld rather than degraded.
    const emission = buildEmission({ metadata: { content_hash: `sha256:${'0'.repeat(64)}` } });
    const result = await guardian().intercept(emission);

    assert.equal(result.deliver, false);
    assert.equal(result.violations[0]?.id, 'ARC-I9');
    assert.equal(result.violations[0]?.severity, 'High');
  });

  test('delivers a profiled learner an emission that passes every invariant', async () => {
    const emission = buildEmission({
      special_category_flag: true,
      validation: { gate: 'approved' },
    });
    const result = await guardian().intercept(emission, { hasAccessibilityProfile: true });

    assert.equal(result.deliver, true);
    assert.deepEqual(result.violations, []);
  });
});
