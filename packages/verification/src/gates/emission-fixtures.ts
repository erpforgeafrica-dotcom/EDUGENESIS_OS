/**
 * Fixture emissions for the accessibility contract gate.
 *
 * These are built here rather than imported so the gate can construct a
 * deliberately contract-VIOLATING emission even though the TypeScript type
 * marks the missing field as required. The single cast below is the point of
 * the test, not an accident.
 */
import { createHash } from 'node:crypto';
import type { AccessibilityEmission, CanonicalContent } from '@edugenesis/contracts';

const BODY = 'A rectangle has four sides. Two of them are long and two are short.';

/** SHA-256 of a string — the fallback when the package exposes no canonicaliser. */
export function contentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * The canonical content object the emission carries.
 *
 * WHY it is a separate function: ARC-I9 hashes the canonical CONTENT OBJECT,
 * not the bare body string. The gate must build its fixture with the same
 * canonicaliser the emitting service would use, otherwise it is testing its own
 * guess at the algorithm instead of the contract.
 */
export function canonicalContent(): CanonicalContent {
  return {
    contentId: 'eg-fixture-0001',
    body: BODY,
    modality: 'text',
    media_bytes_total: BODY.length,
  };
}

/** A complete, contract-conformant emission. */
export function validEmission(
  hashCanonical: (canonical: CanonicalContent) => string = (canonical) => contentHash(canonical.body),
): AccessibilityEmission {
  const canonical = canonicalContent();
  return {
    canonical_content: canonical,
    accessible_alternative: {
      text: BODY,
      audio: {
        transcript: BODY,
        description: 'Read aloud: a rectangle has four sides, two long and two short.',
        durationSec: 12,
      },
      visual: {
        description: 'A simple line drawing of a rectangle with each of the four sides labelled.',
      },
      interactiveAlternative: {
        description: 'Count the sides of the rectangle.',
        steps: ['Point at the first side.', 'Count to four.', 'Say "four sides".'],
      },
      covers: ['visual', 'auditory', 'motor'],
      method: 'auto',
    },
    metadata: {
      contractVersion: '1.0',
      emittingService: 'verification-harness',
      emittedAt: '2026-01-01T00:00:00.000Z',
      content_hash: hashCanonical(canonical),
      taskClass: 'explain',
      media_bytes_total: BODY.length,
    },
    source_lineage: [
      {
        sourceId: 'eg-src-0001',
        locator: 'curriculum/math/shapes#rectangle',
        licence: 'CC-BY-4.0',
        retrievedAt: '2026-01-01T00:00:00.000Z',
        tier: 1,
      },
    ],
    risk_tier: 0,
    language: { primary: 'en', support: ['en'], plainLanguageVariant: false },
    reading_level: { band: 'B1', targetWordsPerSentence: 12, simplified: false },
    sensory_profile: {
      hasNonVisual: true,
      hasNonAudio: true,
      hasNonMotor: true,
      reducedMotionSafe: true,
      captioned: true,
      transcribed: true,
    },
    interaction_mode: {
      input: ['keyboard', 'pointer', 'voice', 'switch', 'touch'],
      output: ['visual', 'audio', 'text'],
    },
    equivalence_verified: true,
    withheld: false,
    uncertainty_note: null,
    confidence_score: 0.95,
    special_category_flag: false,
    validation: { gate: 'approved' },
  };
}

/**
 * A deliberately broken emission: the accessible alternative is missing, so
 * the validator MUST block it (ARC-I1).
 */
export function brokenEmission(): AccessibilityEmission {
  const partial: Partial<AccessibilityEmission> = { ...validEmission() };
  delete partial.accessible_alternative;
  return partial as AccessibilityEmission;
}

/**
 * A complete emission whose recorded content hash does not match its canonical
 * content. ARC-I9 exists to catch exactly this: a payload that was altered
 * after its digest was taken (tampering, or silent drift between an emitter and
 * its cache). The gate asserts the validator notices.
 */
export function tamperedEmission(): AccessibilityEmission {
  const emission = validEmission();
  emission.metadata = { ...emission.metadata, content_hash: '0'.repeat(64) };
  return emission;
}
