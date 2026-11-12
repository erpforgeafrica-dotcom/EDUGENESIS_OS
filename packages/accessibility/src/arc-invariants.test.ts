/**
 * The 12 CI invariants (07 §5.3) — RED-phase specification.
 *
 * One deliberately broken fixture per invariant. Each fixture must produce
 * EXACTLY ONE violation, for that invariant, with the severity the controlled
 * disability plan assigns, and with a message naming the offending path. The
 * "exactly one" requirement is what keeps a violation attributable: if one
 * broken emission tripped two invariants, the table could not prove that each
 * invariant is independently enforced.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type {
  AccessibilityEmission,
  ArcInvariantId,
  ArcSeverity,
  ValidationContext,
} from '@edugenesis/contracts';

import { ARC_INVARIANTS } from './arc-invariants.js';
import { createAccessibilityValidator } from './validator.js';
import { buildEmission } from './fixtures.js';

interface InvariantFixture {
  readonly id: ArcInvariantId;
  readonly severity: ArcSeverity;
  readonly path: string;
  readonly emission: AccessibilityEmission;
  readonly ctx?: ValidationContext;
}

const FIXTURES: readonly InvariantFixture[] = [
  {
    id: 'ARC-I1',
    severity: 'Blocker',
    path: 'accessible_alternative',
    emission: buildEmission({ accessible_alternative: undefined, equivalence_verified: false }),
  },
  {
    id: 'ARC-I2',
    severity: 'Blocker',
    path: 'risk_tier',
    emission: buildEmission({ risk_tier: 7 }),
  },
  {
    id: 'ARC-I3',
    severity: 'Blocker',
    path: 'source_lineage',
    emission: buildEmission({ risk_tier: 2, source_lineage: [] }),
  },
  {
    id: 'ARC-I4',
    severity: 'High',
    path: 'uncertainty_note',
    emission: buildEmission({ confidence_score: 0.42, uncertainty_note: null }),
  },
  {
    id: 'ARC-I5',
    severity: 'Blocker',
    path: 'language.primary',
    emission: buildEmission({ language: { primary: 'not a tag' } }),
  },
  {
    id: 'ARC-I6',
    severity: 'High',
    path: 'sensory_profile.hasNonMotor',
    emission: buildEmission({ accessible_alternative: { interactiveAlternative: undefined } }),
  },
  {
    id: 'ARC-I7',
    severity: 'Blocker',
    path: 'interaction_mode.input',
    emission: buildEmission({
      canonical_content: { modality: 'quiz' },
      interaction_mode: { input: ['pointer'], output: ['visual'] },
    }),
  },
  {
    id: 'ARC-I8',
    severity: 'Blocker',
    path: 'withheld',
    emission: buildEmission({ withheld: true }),
  },
  {
    id: 'ARC-I9',
    severity: 'High',
    path: 'metadata.content_hash',
    emission: buildEmission({ metadata: { content_hash: `sha256:${'0'.repeat(64)}` } }),
  },
  {
    id: 'ARC-I10',
    severity: 'High',
    path: 'metadata.media_bytes_total',
    emission: buildEmission({ metadata: { media_bytes_total: 6_000_000 } }),
  },
  {
    id: 'ARC-I11',
    severity: 'Blocker',
    path: 'validation.gate',
    ctx: { hasAccessibilityProfile: true },
    emission: buildEmission({
      special_category_flag: true,
      validation: { gate: 'pending' },
    }),
  },
  {
    id: 'ARC-I12',
    severity: 'Blocker',
    path: 'special_category_flag',
    ctx: { hasAccessibilityProfile: true },
    emission: buildEmission({
      special_category_flag: false,
      validation: { gate: 'approved' },
    }),
  },
];

describe('the ARC invariant registry', () => {
  test('declares the 12 invariants of 07 §5.3 with their severities', () => {
    const expected: ReadonlyArray<readonly [ArcInvariantId, ArcSeverity]> = [
      ['ARC-I1', 'Blocker'],
      ['ARC-I2', 'Blocker'],
      ['ARC-I3', 'Blocker'],
      ['ARC-I4', 'High'],
      ['ARC-I5', 'Blocker'],
      ['ARC-I6', 'High'],
      ['ARC-I7', 'Blocker'],
      ['ARC-I8', 'Blocker'],
      ['ARC-I9', 'High'],
      ['ARC-I10', 'High'],
      ['ARC-I11', 'Blocker'],
      ['ARC-I12', 'Blocker'],
    ];
    assert.equal(ARC_INVARIANTS.length, expected.length);
    ARC_INVARIANTS.forEach((invariant, index) => {
      const row = expected[index];
      assert.ok(row !== undefined);
      assert.equal(invariant.id, row[0]);
      assert.equal(invariant.severity, row[1]);
      assert.ok(invariant.rule.length > 0, `${invariant.id} must state its rule`);
      assert.equal(typeof invariant.check, 'function');
    });
  });
});

describe('one broken fixture per invariant', () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.id} is violated by its own broken fixture`, () => {
      const validator = createAccessibilityValidator();
      const result = validator.validate(fixture.emission, fixture.ctx);

      assert.equal(
        result.violations.length,
        1,
        `expected exactly one violation, got ${JSON.stringify(result.violations, null, 2)}`,
      );
      const violation = result.violations[0];
      assert.ok(violation !== undefined);
      assert.equal(violation.id, fixture.id);
      assert.equal(violation.severity, fixture.severity);
      assert.equal(violation.path, fixture.path);
      assert.ok(
        violation.message.includes(fixture.path),
        `message "${violation.message}" must name the offending path "${fixture.path}"`,
      );
      assert.equal(result.ok, false);
      assert.ok(!result.passed.includes(fixture.id), 'a violated invariant must not be reported as passed');
    });
  }

  test('every invariant in the registry is covered by a fixture', () => {
    const covered = new Set(FIXTURES.map((fixture) => fixture.id));
    for (const invariant of ARC_INVARIANTS) {
      assert.ok(covered.has(invariant.id), `${invariant.id} has no broken fixture`);
    }
  });

  test('a Blocker violation fails the emission', () => {
    const validator = createAccessibilityValidator();
    const blocker = FIXTURES.find((fixture) => fixture.severity === 'Blocker');
    assert.ok(blocker !== undefined);
    const result = validator.validate(blocker.emission, blocker.ctx);
    assert.equal(result.ok, false);
  });

  test('a High severity violation also fails the emission', () => {
    // 07 §5.3: a Blocker "fails the build and blocks delivery"; a High
    // severity "fails the build" — so neither severity may pass validation.
    const validator = createAccessibilityValidator();
    const high = FIXTURES.find((fixture) => fixture.severity === 'High');
    assert.ok(high !== undefined);
    const result = validator.validate(high.emission, high.ctx);
    assert.equal(result.ok, false);
  });

  test('ARC-I1 also fires when the alternative exists but is not verified', () => {
    const validator = createAccessibilityValidator();
    const result = validator.validate(buildEmission({ equivalence_verified: false }));
    assert.equal(result.violations.length, 1);
    const violation = result.violations[0];
    assert.ok(violation !== undefined);
    assert.equal(violation.id, 'ARC-I1');
    assert.equal(violation.path, 'equivalence_verified');
  });
});
