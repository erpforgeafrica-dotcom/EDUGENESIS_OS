/**
 * The 12 CI invariants of the Accessibility Runtime Contract (07 §5.3).
 *
 * Doc 2 §2.3 makes accessibility a runtime contract rather than a
 * post-processing layer, so each invariant is a machine-checkable predicate
 * over one emission plus the delivery context. A predicate returns the exact
 * offending path and a message that names it, so a failure is actionable
 * without reading the implementation.
 *
 * Severity (07 §5.3):
 *   - Blocker — fails the build AND blocks delivery.
 *   - High    — fails the build; a learner-facing emission is still withheld.
 * The validator therefore treats ANY violation as a failure; the severity
 * records how the failure must be escalated, not whether it may be ignored.
 */
import type {
  AccessibleAlternative,
  AccessibilityEmission,
  ArcInvariantId,
  ArcSeverity,
  CanonicalContent,
  EmissionMetadata,
  InteractionMode,
  LanguageInfo,
  Modality,
  ReadingLevel,
  SensoryProfile,
  SourceLineage,
} from '@edugenesis/contracts';

import { parseBcp47 } from './bcp47.js';
import { hashCanonicalContent } from './content-hash.js';
import type { ResolvedValidationContext } from './validator.js';

/** Where an invariant failed and why. */
export interface ArcInvariantFailure {
  /** The exact path of the offending field. */
  readonly path: string;
  readonly message: string;
}

/** One machine-checkable invariant of the runtime contract. */
export interface ArcInvariant {
  readonly id: ArcInvariantId;
  readonly severity: ArcSeverity;
  /** The rule as stated in 07 §5.3. */
  readonly rule: string;
  readonly check: (
    emission: AccessibilityEmission,
    ctx: ResolvedValidationContext,
  ) => ArcInvariantFailure | null;
}

/**
 * Modalities that present an interactive surface (07 §4.2). "Plain text /
 * chat" is the terminal fallback and carries no interaction surface of its
 * own; a text emission that does carry a motor-independent path is treated as
 * interactive all the same.
 */
const INTERACTIVE_MODALITIES: ReadonlySet<Modality> = new Set<Modality>([
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
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function alternativeOf(emission: AccessibilityEmission): AccessibleAlternative | undefined {
  const alternative = emission.accessible_alternative as AccessibleAlternative | undefined | null;
  return alternative === null ? undefined : alternative;
}

function canonicalOf(emission: AccessibilityEmission): CanonicalContent | undefined {
  const canonical = emission.canonical_content as CanonicalContent | undefined | null;
  return canonical === null ? undefined : canonical;
}

function metadataOf(emission: AccessibilityEmission): EmissionMetadata | undefined {
  const metadata = emission.metadata as EmissionMetadata | undefined | null;
  return metadata === null ? undefined : metadata;
}

/**
 * The invariant set. Order is the order of 07 §5.3 and is preserved in the
 * `passed` list of a validation result.
 */
export const ARC_INVARIANTS: readonly ArcInvariant[] = [
  {
    id: 'ARC-I1',
    severity: 'Blocker',
    rule: 'accessible_alternative exists and equivalence_verified is true for every learner-facing emission',
    check: (emission) => {
      const alternative = alternativeOf(emission);
      if (alternative === undefined || typeof alternative !== 'object') {
        return {
          path: 'accessible_alternative',
          message:
            'accessible_alternative is missing; a learner-facing emission must carry an accessible equivalent before delivery (07 §5.3 ARC-I1).',
        };
      }
      if (emission.equivalence_verified !== true) {
        return {
          path: 'equivalence_verified',
          message: `equivalence_verified is ${String(emission.equivalence_verified)}; the accessible equivalent must be verified against the 07 §4.2 equivalence matrix (07 §5.3 ARC-I1).`,
        };
      }
      return null;
    },
  },
  {
    id: 'ARC-I2',
    severity: 'Blocker',
    rule: 'risk_tier is one of 0, 1, 2, 3, 4',
    check: (emission) => {
      const tier = emission.risk_tier as number;
      if (typeof tier !== 'number' || !Number.isInteger(tier) || tier < 0 || tier > 4) {
        return {
          path: 'risk_tier',
          message: `risk_tier "${String(emission.risk_tier)}" is not one of 0, 1, 2, 3, 4 (Doc 6 §3.1; 07 §5.3 ARC-I2).`,
        };
      }
      return null;
    },
  },
  {
    id: 'ARC-I3',
    severity: 'Blocker',
    rule: 'source_lineage is non-empty when risk_tier is 2 or above',
    check: (emission) => {
      const tier = emission.risk_tier as number;
      const lineage = emission.source_lineage as SourceLineage[] | undefined;
      if (
        typeof tier === 'number' &&
        tier >= 2 &&
        (!Array.isArray(lineage) || lineage.length === 0)
      ) {
        return {
          path: 'source_lineage',
          message: `source_lineage is empty at risk_tier ${tier}; tier 2 and above must cite licence and retrieval date for every source (07 §5.3 ARC-I3; Doc 6 §9.4).`,
        };
      }
      return null;
    },
  },
  {
    id: 'ARC-I4',
    severity: 'High',
    rule: 'uncertainty_note is present when confidence_score is below the routing policy threshold',
    check: (emission, ctx) => {
      const confidence = emission.confidence_score as number | undefined;
      if (typeof confidence !== 'number' || confidence >= ctx.confidenceThreshold) {
        return null;
      }
      const note = emission.uncertainty_note;
      if (note === undefined || note === null || (typeof note === 'string' && note.trim().length === 0)) {
        return {
          path: 'uncertainty_note',
          message: `uncertainty_note is absent while confidence_score ${confidence} is below the routing policy threshold ${ctx.confidenceThreshold} (07 §5.3 ARC-I4; Doc 6 §9.2).`,
        };
      }
      return null;
    },
  },
  {
    id: 'ARC-I5',
    severity: 'Blocker',
    rule: 'language.primary is a valid BCP-47 tag and reading_level is present',
    check: (emission) => {
      const language = emission.language as LanguageInfo | undefined | null;
      const primary = language?.primary;
      if (!isNonEmptyString(primary)) {
        return {
          path: 'language.primary',
          message:
            'language.primary is missing; a BCP-47 language tag is required on every emission (07 §5.3 ARC-I5).',
        };
      }
      const parsed = parseBcp47(primary);
      if (!parsed.ok) {
        return {
          path: 'language.primary',
          message: `language.primary "${primary}" is not a valid BCP-47 tag: ${parsed.error} (07 §5.3 ARC-I5).`,
        };
      }
      const reading = emission.reading_level as ReadingLevel | undefined | null;
      if (reading === undefined || reading === null) {
        return {
          path: 'reading_level',
          message:
            'reading_level is missing; the reading level drives Easy Read and simplified-language variants (07 §5.1 element 7; 07 §5.3 ARC-I5).',
        };
      }
      if (!isNonEmptyString(reading.band)) {
        return {
          path: 'reading_level.band',
          message:
            'reading_level.band is missing; the reading level drives Easy Read and simplified-language variants (07 §5.1 element 7; 07 §5.3 ARC-I5).',
        };
      }
      return null;
    },
  },
  {
    id: 'ARC-I6',
    severity: 'High',
    rule: 'sensory_profile names the sensory variants the emitter actually produced',
    check: (emission) => {
      const alternative = alternativeOf(emission);
      if (alternative === undefined) {
        // ARC-I1 already blocks an emission without an alternative; there is
        // nothing to compare the sensory profile against.
        return null;
      }
      const profile = emission.sensory_profile as SensoryProfile | undefined | null;
      if (profile === undefined || profile === null) {
        return {
          path: 'sensory_profile',
          message:
            'sensory_profile is missing; the emission must declare which sensory variants it produces (07 §5.1 element 8; 07 §5.3 ARC-I6).',
        };
      }

      const textPath =
        isNonEmptyString(alternative.text) ||
        (alternative.interactiveAlternative !== undefined &&
          isNonEmptyString(alternative.interactiveAlternative.description));
      const visualPath =
        alternative.visual !== undefined && isNonEmptyString(alternative.visual.description);
      const audioPath =
        alternative.audio !== undefined && isNonEmptyString(alternative.audio.transcript);
      const motorPath =
        alternative.interactiveAlternative !== undefined &&
        Array.isArray(alternative.interactiveAlternative.steps) &&
        alternative.interactiveAlternative.steps.length > 0;

      if (profile.hasNonVisual === true && !textPath) {
        return {
          path: 'sensory_profile.hasNonVisual',
          message:
            'sensory_profile.hasNonVisual claims a non-visual variant but the alternative has no text path (07 §5.3 ARC-I6).',
        };
      }
      if (profile.hasNonAudio === true && !textPath && !visualPath) {
        return {
          path: 'sensory_profile.hasNonAudio',
          message:
            'sensory_profile.hasNonAudio claims a non-audio variant but the alternative has neither a text nor a visual path (07 §5.3 ARC-I6).',
        };
      }
      if (profile.hasNonMotor === true && !motorPath) {
        return {
          path: 'sensory_profile.hasNonMotor',
          message:
            'sensory_profile.hasNonMotor claims a motor-independent variant but the alternative has no motor-independent path (07 §5.3 ARC-I6).',
        };
      }
      if (profile.captioned === true && !audioPath) {
        return {
          path: 'sensory_profile.captioned',
          message:
            'sensory_profile.captioned claims captions but the alternative carries no audio track (07 §5.3 ARC-I6; AC-10).',
        };
      }
      if (
        profile.transcribed === true &&
        !(alternative.audio !== undefined && isNonEmptyString(alternative.audio.transcript))
      ) {
        return {
          path: 'sensory_profile.transcribed',
          message:
            'sensory_profile.transcribed claims a transcript but the alternative carries no audio transcript (07 §5.3 ARC-I6).',
        };
      }
      return null;
    },
  },
  {
    id: 'ARC-I7',
    severity: 'Blocker',
    rule: 'interaction_mode.input includes keyboard for all interactive surfaces',
    check: (emission) => {
      const modality = canonicalOf(emission)?.modality;
      const alternative = alternativeOf(emission);
      const interactiveSurface =
        (modality !== undefined && INTERACTIVE_MODALITIES.has(modality)) ||
        (alternative?.interactiveAlternative !== undefined);
      if (!interactiveSurface) {
        return null;
      }
      const mode = emission.interaction_mode as InteractionMode | undefined | null;
      const inputs = mode?.input;
      if (!Array.isArray(inputs) || inputs.length === 0) {
        return {
          path: 'interaction_mode.input',
          message:
            'interaction_mode.input is missing; every interactive surface must declare its input methods (07 §5.3 ARC-I7; AC-01).',
        };
      }
      if (!inputs.includes('keyboard')) {
        return {
          path: 'interaction_mode.input',
          message: `interaction_mode.input [${inputs.join(', ')}] does not include "keyboard"; an interactive surface must be operable by keyboard alone (07 §5.3 ARC-I7; AC-01).`,
        };
      }
      return null;
    },
  },
  {
    id: 'ARC-I8',
    severity: 'Blocker',
    rule: 'withheld emissions are never delivered to any learner',
    check: (emission) => {
      if (emission.withheld === true) {
        return {
          path: 'withheld',
          message:
            'withheld is true; a withheld emission must never be delivered to a learner (07 §5.3 ARC-I8; 07 §4.3.6).',
        };
      }
      return null;
    },
  },
  {
    id: 'ARC-I9',
    severity: 'High',
    rule: 'metadata.content_hash matches the canonical content bytes',
    check: (emission) => {
      const metadata = metadataOf(emission);
      const recorded = metadata?.content_hash;
      if (!isNonEmptyString(recorded)) {
        return {
          path: 'metadata.content_hash',
          message:
            'metadata.content_hash is missing; the canonical content cannot be checked for tampering or drift (07 §5.3 ARC-I9).',
        };
      }
      const canonical = canonicalOf(emission);
      if (canonical === undefined) {
        return {
          path: 'canonical_content',
          message:
            'canonical_content is missing; metadata.content_hash cannot be verified against it (07 §5.3 ARC-I9).',
        };
      }
      let expected: string;
      try {
        expected = hashCanonicalContent(canonical);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          path: 'canonical_content',
          message: `canonical_content cannot be canonicalised, so metadata.content_hash cannot be verified: ${detail} (07 §5.3 ARC-I9).`,
        };
      }
      if (recorded.trim().toLowerCase() !== expected.toLowerCase()) {
        return {
          path: 'metadata.content_hash',
          message: `metadata.content_hash "${recorded}" does not match the canonical content digest "${expected}"; the content has been tampered with or has drifted (07 §5.3 ARC-I9).`,
        };
      }
      return null;
    },
  },
  {
    id: 'ARC-I10',
    severity: 'High',
    rule: 'total media_bytes_total respects the active delivery-mode budget',
    check: (emission, ctx) => {
      const metadata = metadataOf(emission);
      const canonical = canonicalOf(emission);
      const metadataBytes =
        typeof metadata?.media_bytes_total === 'number' ? metadata.media_bytes_total : undefined;
      const canonicalBytes =
        typeof canonical?.media_bytes_total === 'number' ? canonical.media_bytes_total : undefined;

      // The emitter may report the figure in either place; the budget must
      // hold for the larger of the two, because that is what a delivery client
      // would actually fetch.
      const candidates: number[] = [];
      if (metadataBytes !== undefined) {
        candidates.push(metadataBytes);
      }
      if (canonicalBytes !== undefined) {
        candidates.push(canonicalBytes);
      }
      if (candidates.length === 0) {
        return null;
      }
      const total = Math.max(...candidates);
      if (total > ctx.mediaBudgetBytes) {
        const path =
          metadataBytes !== undefined && metadataBytes >= (canonicalBytes ?? 0)
            ? 'metadata.media_bytes_total'
            : 'canonical_content.media_bytes_total';
        return {
          path,
          message: `${path} is ${total} bytes, which exceeds the active delivery-mode budget of ${ctx.mediaBudgetBytes} bytes (07 §5.3 ARC-I10; 07 §9.1).`,
        };
      }
      return null;
    },
  },
  {
    id: 'ARC-I11',
    severity: 'Blocker',
    rule: 'validation.gate is approved wherever a learner accessibility profile is present',
    check: (emission, ctx) => {
      if (!ctx.hasAccessibilityProfile) {
        return null;
      }
      const gate = emission.validation?.gate;
      if (gate !== 'approved') {
        return {
          path: 'validation.gate',
          message: `validation.gate is "${String(gate)}" but a learner accessibility profile is present; no emission may reach such a learner without an approved gate (07 §5.3 ARC-I11; Doc 6 §7.3).`,
        };
      }
      return null;
    },
  },
  {
    id: 'ARC-I12',
    severity: 'Blocker',
    rule: 'special_category_flag is set wherever an emission is derived from an accessibility profile',
    check: (emission, ctx) => {
      if (!ctx.hasAccessibilityProfile) {
        return null;
      }
      if (emission.special_category_flag !== true) {
        return {
          path: 'special_category_flag',
          message:
            'special_category_flag is not set although the emission is derived from a learner accessibility profile (07 §5.3 ARC-I12; Doc 15 §18.4).',
        };
      }
      return null;
    },
  },
];

/** The invariant set keyed by id, for callers that need a single rule. */
export const ARC_INVARIANT_BY_ID: Readonly<Record<ArcInvariantId, ArcInvariant>> =
  Object.fromEntries(ARC_INVARIANTS.map((invariant) => [invariant.id, invariant])) as Record<
    ArcInvariantId,
    ArcInvariant
  >;
