/**
 * Test fixtures for the accessibility runtime contract.
 *
 * The base emission is a fully-typed, fully-valid ARC-1.0 emission modelled on
 * the reference emission in 07 §5.2. The broken fixtures are derived from it
 * so that each ARC invariant can be violated in exactly one way — which is
 * what makes a table-driven invariant test meaningful.
 *
 * Overrides are applied loosely on purpose: the ARC invariants are a RUNTIME
 * gate, so the fixtures must be able to express wire shapes that the static
 * contract types forbid (an out-of-range risk tier, a missing alternative).
 */
import type {
  AccessibleAlternative,
  AccessibilityEmission,
  CanonicalContent,
  EmissionMetadata,
  InteractionMode,
  LanguageInfo,
  ReadingLevel,
  SensoryProfile,
  SourceLineage,
} from '@edugenesis/contracts';

import { hashCanonicalContent } from './content-hash.js';

export const BASE_CANONICAL_CONTENT: CanonicalContent = {
  contentId: 'ct-0001',
  body: 'Current leaves the battery, passes through the first bulb, then the second, and returns to the battery.',
  modality: 'text',
  media_bytes_total: 41_200,
  payload: { unit: 'ampere', steps: ['leave', 'pass', 'return'] },
};

export const BASE_ACCESSIBLE_ALTERNATIVE: AccessibleAlternative = {
  text: 'Current goes round the circuit. It starts at the battery. It lights bulb one. Then bulb two. Then back to the battery.',
  audio: {
    transcript: 'Current leaves the battery, passes through the first bulb, then the second, and returns to the battery.',
    description: 'A single-line circuit with two bulbs and a battery.',
  },
  visual: {
    description: 'A battery on the left, wired in a line to two bulbs.',
  },
  interactiveAlternative: {
    description: 'Step through the circuit one node at a time.',
    steps: ['Select the battery', 'Select bulb one', 'Select bulb two'],
  },
  covers: ['visual', 'auditory', 'motor'],
  method: 'expert',
};

export const BASE_SOURCE_LINEAGE: readonly SourceLineage[] = [
  {
    sourceId: 'oer-solar-001',
    locator: 'https://example.org/open-solar-guide',
    licence: 'CC-BY-4.0',
    retrievedAt: '2026-11-11T00:00:00.000Z',
    tier: 1,
  },
];

/** A valid ARC-1.0 emission: it passes every invariant with no violations. */
export const BASE_EMISSION: AccessibilityEmission = {
  canonical_content: BASE_CANONICAL_CONTENT,
  accessible_alternative: BASE_ACCESSIBLE_ALTERNATIVE,
  metadata: {
    contractVersion: 'ARC-1.0',
    emittingService: 'accessibility-service',
    emittingAgent: 'tutor_agent',
    emittingModel: 'local-echo',
    emittedAt: '2026-11-12T09:14:02.000Z',
    content_hash: hashCanonicalContent(BASE_CANONICAL_CONTENT),
    taskClass: 'explain',
    media_bytes_total: 41_200,
  },
  source_lineage: [...BASE_SOURCE_LINEAGE],
  risk_tier: 1,
  language: { primary: 'en', support: ['sw'], plainLanguageVariant: true } as LanguageInfo,
  reading_level: { band: 'grade_5', targetWordsPerSentence: 12, simplified: true } as ReadingLevel,
  sensory_profile: {
    hasNonVisual: true,
    hasNonAudio: true,
    hasNonMotor: true,
    reducedMotionSafe: true,
    captioned: true,
    transcribed: true,
  } as SensoryProfile,
  interaction_mode: { input: ['keyboard', 'voice'], output: ['visual', 'text'] } as InteractionMode,
  equivalence_verified: true,
  confidence_score: 0.88,
  uncertainty_note: null,
  special_category_flag: false,
  withheld: false,
};

/** Loose overrides — the wire shape of an emission may violate the static types. */
export type EmissionOverrides = Record<string, unknown>;

/**
 * Materialises an emission from its wire form. `JSON.parse` returns `any` in
 * the standard library, so the result is bound to `unknown` before the single
 * narrowing assertion — the fixtures model data arriving over the wire, which
 * is precisely what the runtime contract exists to police.
 */
function asWireEmission(raw: unknown): AccessibilityEmission {
  const text: string = JSON.stringify(raw);
  const parsed: unknown = JSON.parse(text);
  return parsed as AccessibilityEmission;
}

/**
 * Builds an emission from the valid base plus overrides.
 *
 * The content hash is re-derived from the final canonical content unless the
 * caller supplied one explicitly — which is how the ARC-I9 tamper fixture is
 * built. The accessible alternative is merged one level deep so that a
 * fixture can remove ONE path (the motor-independent path, say) while leaving
 * the rest of the alternative intact; passing `undefined` for the whole
 * alternative removes it entirely.
 */
export function buildEmission(overrides: EmissionOverrides = {}): AccessibilityEmission {
  const canonical = {
    ...BASE_CANONICAL_CONTENT,
    ...((overrides['canonical_content'] as Partial<CanonicalContent> | undefined) ?? {}),
  };
  const metadataOverrides = (overrides['metadata'] as Partial<EmissionMetadata> | undefined) ?? {};
  const metadata: EmissionMetadata = {
    ...BASE_EMISSION.metadata,
    ...metadataOverrides,
    content_hash: metadataOverrides.content_hash ?? hashCanonicalContent(canonical),
  };

  const hasAlternativeOverride = Object.prototype.hasOwnProperty.call(
    overrides,
    'accessible_alternative',
  );
  const alternativeOverride = hasAlternativeOverride
    ? (overrides['accessible_alternative'] as Partial<AccessibleAlternative> | undefined)
    : undefined;
  const accessible_alternative: AccessibleAlternative | undefined = !hasAlternativeOverride
    ? BASE_EMISSION.accessible_alternative
    : alternativeOverride === undefined
      ? undefined
      : { ...BASE_EMISSION.accessible_alternative, ...alternativeOverride };

  const merged: Record<string, unknown> = {
    ...BASE_EMISSION,
    ...overrides,
    canonical_content: canonical,
    metadata,
    accessible_alternative,
  };
  return asWireEmission(merged);
}

/** A deep-ish copy of an emission, used to prove the guardian does not mutate content. */
export function snapshotEmission(emission: AccessibilityEmission): string {
  return JSON.stringify(emission);
}
