/**
 * The Multimodal Equivalence Rule — RED-phase specification.
 *
 * 07 §4.1: "Every modality emitted by the AI Main Tutor or the Multimodal
 * Delivery Engine SHALL have a tested accessible equivalent in every dimension
 * a learner might need: visual, auditory, and motor. If a modality has no
 * acceptable equivalent in a required dimension for a given learner profile,
 * the modality SHALL be restricted or withheld for that profile."
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Modality } from '@edugenesis/contracts';

import {
  EQUIVALENCE_MATRIX,
  NON_MODALITY_EQUIVALENCE_ROWS,
  checkEquivalence,
  equivalenceFor,
  equivalenceReport,
} from './equivalence.js';
import { buildEmission } from './fixtures.js';

const ALL_MODALITIES: readonly Modality[] = [
  'text',
  'whiteboard',
  'video',
  '3d',
  'diagram',
  'quiz',
  'song_story',
  'game',
  'simulation',
  'code',
  'exam',
];

describe('the Multimodal Equivalence Rule', () => {
  test('covers every modality in the contract', () => {
    assert.equal(Object.keys(EQUIVALENCE_MATRIX).length, ALL_MODALITIES.length);
    for (const modality of ALL_MODALITIES) {
      const rule = equivalenceFor(modality);
      assert.equal(rule.modality, modality);
      assert.ok(rule.canonicalForm.length > 0, `${modality} needs a canonical form`);
      assert.ok(rule.withholdCondition.length > 0, `${modality} needs a withhold condition`);
      assert.ok(rule.baseline.length > 0, `${modality} needs a baseline reference`);
    }
  });

  test('encodes the rows of the 07 §4.2 matrix that carry no Modality value', () => {
    // "Project guidance / brief" and "Live human session (OHE)" are matrix rows
    // with no counterpart in the frozen Modality union; they are still carried
    // so the matrix is not silently truncated.
    assert.equal(NON_MODALITY_EQUIVALENCE_ROWS.length, 2);
    for (const row of NON_MODALITY_EQUIVALENCE_ROWS) {
      assert.ok(row.withholdCondition.length > 0);
      assert.ok(row.baseline.length > 0);
    }
  });

  test('reports no missing dimension for a complete alternative', () => {
    const emission = buildEmission();
    assert.deepEqual(checkEquivalence(emission), []);
    const report = equivalenceReport(emission);
    assert.equal(report.ok, true);
    assert.equal(report.modality, 'text');
  });

  test('reports a missing dimension for an incomplete alternative', () => {
    const emission = buildEmission({
      canonical_content: { modality: 'video' },
      accessible_alternative: {
        audio: undefined,
        visual: undefined,
        interactiveAlternative: undefined,
        covers: ['visual'],
      },
    });
    const missing = checkEquivalence(emission);
    assert.ok(missing.length > 0, 'an incomplete alternative must be reported');
    assert.ok(
      missing.includes('audio path'),
      `expected the missing audio path to be reported, got ${JSON.stringify(missing)}`,
    );
    const report = equivalenceReport(emission);
    assert.equal(report.ok, false);
    assert.ok(report.missing.length === missing.length);
  });

  test('requires a motor-independent path for interactive modalities', () => {
    const emission = buildEmission({
      canonical_content: { modality: 'quiz' },
      accessible_alternative: { interactiveAlternative: undefined },
    });
    const missing = checkEquivalence(emission);
    assert.ok(
      missing.includes('motor-independent path'),
      `expected the motor-independent path to be reported, got ${JSON.stringify(missing)}`,
    );
  });

  test('never withholds the text modality', () => {
    // 07 §4.2: plain text is the terminal fallback modality.
    const rule = equivalenceFor('text');
    assert.match(rule.withholdCondition, /never withheld/i);
  });

  test('names the withhold condition of every modality', () => {
    for (const modality of ALL_MODALITIES) {
      const rule = equivalenceFor(modality);
      assert.ok(
        /withhold|never withheld|always available/i.test(rule.withholdCondition),
        `${modality} must state a withhold condition`,
      );
    }
  });
});
