/**
 * The Multimodal Equivalence Rule (07 §4).
 *
 * 07 §4.1: "Every modality emitted by the AI Main Tutor or the Multimodal
 * Delivery Engine SHALL have a tested accessible equivalent in every dimension
 * a learner might need: visual, auditory, and motor. If a modality has no
 * acceptable equivalent in a required dimension for a given learner profile,
 * the modality SHALL be restricted or withheld for that profile — and, where
 * the modality is the only route to a learning objective, withheld globally
 * until remediated."
 *
 * §4.2 states the rule as a matrix. Each row becomes one entry of
 * EQUIVALENCE_MATRIX, keyed by the contract's `Modality`. The matrix columns
 * are encoded as:
 *   - "Non-visual equivalent"  → the TEXT path (a structured description a
 *     learner who cannot see can read: action log, transcript, alt text).
 *   - "Non-audio equivalent"   → an AUDIO path (narration, audio description,
 *     read-aloud) and, for audio-first rows, a VISUAL path.
 *   - "Non-motor equivalent"   → the motor-independent interaction path
 *     (`interactiveAlternative`), which must be keyboard operable.
 * `requiredCovers` mirrors the same three dimensions as the `covers` array of
 * the accessible alternative, so the declaration and the evidence are checked
 * separately: a declared dimension with no path behind it is a broken promise.
 */
import type { AccessibleAlternative, AccessibilityEmission, CanonicalContent, Modality } from '@edugenesis/contracts';

/** The dimensions of the accessible alternative's `covers` array. */
export type EquivalenceDimension = 'visual' | 'auditory' | 'motor';

/** The alternative paths that can evidence a dimension. */
export type AccessiblePathKind = 'text' | 'audio' | 'visual' | 'interactiveAlternative';

/** One row of the 07 §4.2 equivalence matrix. */
export interface ModalityEquivalence {
  readonly modality: Modality;
  /** Matrix column "Canonical form". */
  readonly canonicalForm: string;
  /** The alternative paths this modality must produce. */
  readonly requiredPaths: readonly AccessiblePathKind[];
  /** The dimensions the alternative must declare in `covers`. */
  readonly requiredCovers: readonly EquivalenceDimension[];
  /** Matrix column "Withhold condition". */
  readonly withholdCondition: string;
  /** Matrix column "Baseline reference". */
  readonly baseline: readonly string[];
}

/** A matrix row that the frozen `Modality` union does not name. */
export interface NonModalityEquivalence {
  readonly label: string;
  readonly canonicalForm: string;
  readonly requiredPaths: readonly AccessiblePathKind[];
  readonly requiredCovers: readonly EquivalenceDimension[];
  readonly withholdCondition: string;
  readonly baseline: readonly string[];
}

const TEXT_PATH_LABEL = 'text path';
const AUDIO_PATH_LABEL = 'audio path';
const VISUAL_PATH_LABEL = 'visual path';
const MOTOR_PATH_LABEL = 'motor-independent path';

const PATH_LABEL: Readonly<Record<AccessiblePathKind, string>> = {
  text: TEXT_PATH_LABEL,
  audio: AUDIO_PATH_LABEL,
  visual: VISUAL_PATH_LABEL,
  interactiveAlternative: MOTOR_PATH_LABEL,
};

const COVER_LABEL: Readonly<Record<EquivalenceDimension, string>> = {
  visual: 'visual cover',
  auditory: 'auditory cover',
  motor: 'motor cover',
};

/**
 * The 07 §4.2 matrix, keyed by modality. Row order follows the document.
 */
export const EQUIVALENCE_MATRIX: Readonly<Record<Modality, ModalityEquivalence>> = {
  text: {
    modality: 'text',
    canonicalForm: 'Conversational text',
    requiredPaths: ['text'],
    requiredCovers: [],
    withholdCondition:
      'Never withheld — plain text is the terminal fallback modality and is always available.',
    baseline: ['Doc 2 §10.2', 'Doc 15 §7'],
  },
  whiteboard: {
    modality: 'whiteboard',
    canonicalForm: 'Sequential hand-drawn step build',
    requiredPaths: ['text', 'visual', 'audio', 'interactiveAlternative'],
    requiredCovers: ['visual', 'auditory', 'motor'],
    withholdCondition: 'Withhold if no serialized action log exists.',
    baseline: ['Doc 15 §7.1', 'Doc 2 §10.2'],
  },
  video: {
    modality: 'video',
    canonicalForm: 'Narrated moving image',
    requiredPaths: ['text', 'audio', 'interactiveAlternative'],
    requiredCovers: ['auditory', 'motor'],
    withholdCondition: 'Withhold if captions AND transcript are absent.',
    baseline: ['Doc 15 §7.1', 'Doc 16 §3.4'],
  },
  '3d': {
    modality: '3d',
    canonicalForm: 'Interactive spatial model',
    requiredPaths: ['text', 'visual', 'audio', 'interactiveAlternative'],
    requiredCovers: ['visual', 'auditory', 'motor'],
    withholdCondition:
      'Withhold the 3D mode (not the objective) if no state log/2D/audio fallback exists.',
    baseline: ['Doc 15 §7.1', 'Doc 2 §6.2, §12.1', 'Doc 6 §7.4'],
  },
  diagram: {
    modality: 'diagram',
    canonicalForm: 'Static labelled diagram',
    requiredPaths: ['text', 'audio', 'interactiveAlternative'],
    requiredCovers: ['auditory', 'motor'],
    withholdCondition: 'Withhold if the diagram carries information not present in the alt text.',
    baseline: ['Doc 2 §10.2, §11.5', 'Doc 15 §14.1'],
  },
  quiz: {
    modality: 'quiz',
    canonicalForm: 'Interactive question set',
    requiredPaths: ['text', 'audio', 'interactiveAlternative'],
    requiredCovers: ['auditory', 'motor'],
    withholdCondition: 'Withhold if no non-timed alternative path exists.',
    baseline: ['Doc 15 §7.1', 'Doc 6 §7.1', 'Doc 3 §12.3'],
  },
  song_story: {
    modality: 'song_story',
    canonicalForm: 'Original audio narrative',
    requiredPaths: ['text', 'interactiveAlternative'],
    requiredCovers: ['motor'],
    withholdCondition: 'Withhold if lyrics/text and an easy-read summary are absent.',
    baseline: ['Doc 15 §7.1', 'Doc 6 §7.5'],
  },
  game: {
    modality: 'game',
    canonicalForm: 'Interactive challenge environment',
    requiredPaths: ['text', 'audio', 'interactiveAlternative'],
    requiredCovers: ['auditory', 'motor'],
    withholdCondition:
      'Withhold if the game is the only route to the objective and lacks keyboard/timing control.',
    baseline: ['Doc 15 §7.1', 'Doc 2 §10.2', 'Doc 6 §7.3'],
  },
  simulation: {
    modality: 'simulation',
    canonicalForm: 'Interactive challenge environment',
    requiredPaths: ['text', 'audio', 'interactiveAlternative'],
    requiredCovers: ['auditory', 'motor'],
    withholdCondition:
      'Withhold if the simulation is the only route to the objective and lacks keyboard/timing control.',
    baseline: ['Doc 15 §7.1', 'Doc 2 §10.2', 'Doc 6 §7.3'],
  },
  code: {
    modality: 'code',
    canonicalForm: 'Source code with execution',
    requiredPaths: ['text', 'audio', 'interactiveAlternative'],
    requiredCovers: ['auditory', 'motor'],
    withholdCondition:
      'Withhold the code block (never the objective) if no explanation accompanies it.',
    baseline: ['Doc 15 §7.1', 'Doc 2 §6.2, §10.2, §11.4'],
  },
  exam: {
    modality: 'exam',
    canonicalForm: 'Practice questions and mock exam',
    requiredPaths: ['text', 'interactiveAlternative'],
    requiredCovers: ['motor'],
    withholdCondition: 'Withhold the mock if accommodations are not honoured.',
    baseline: ['Doc 15 §7.1', 'Doc 3 §12.3'],
  },
};

/**
 * The two 07 §4.2 matrix rows that the frozen `Modality` union does not name:
 * "Project guidance / brief" and "Live human session (OHE)". They are carried
 * explicitly so the matrix is not silently truncated; they become reachable
 * when a modality is added to the contract.
 */
export const NON_MODALITY_EQUIVALENCE_ROWS: readonly NonModalityEquivalence[] = [
  {
    label: 'Project guidance / brief',
    canonicalForm: 'Written project brief',
    requiredPaths: ['text', 'audio', 'interactiveAlternative'],
    requiredCovers: ['auditory', 'motor'],
    withholdCondition: 'Withhold if the brief cannot be consumed without a visual layout.',
    baseline: ['Doc 2 §10.1, §11.5', 'Doc 15 §6.2'],
  },
  {
    label: 'Live human session (OHE)',
    canonicalForm: 'Scheduled live interaction',
    requiredPaths: ['text', 'audio', 'interactiveAlternative'],
    requiredCovers: ['auditory', 'motor'],
    withholdCondition:
      'Postpone, redesign, or replace with AI-accessible enrichment if accessibility cannot be assured.',
    baseline: ['Doc 15 §7.1, §14.2'],
  },
];

/** The equivalence rule that applies to a modality. */
export function equivalenceFor(modality: Modality): ModalityEquivalence {
  return EQUIVALENCE_MATRIX[modality];
}

/** The detailed outcome of an equivalence check. */
export interface EquivalenceReport {
  readonly ok: boolean;
  readonly modality: Modality;
  readonly rule: ModalityEquivalence | null;
  /** The missing dimensions, named. */
  readonly missing: readonly string[];
  readonly missingPaths: readonly AccessiblePathKind[];
  readonly missingCovers: readonly EquivalenceDimension[];
}

function hasPath(alternative: AccessibleAlternative | undefined, path: AccessiblePathKind): boolean {
  if (alternative === undefined || typeof alternative !== 'object') {
    return false;
  }
  switch (path) {
    case 'text':
      return typeof alternative.text === 'string' && alternative.text.trim().length > 0;
    case 'audio':
      return (
        alternative.audio !== undefined &&
        typeof alternative.audio.transcript === 'string' &&
        alternative.audio.transcript.trim().length > 0
      );
    case 'visual':
      return (
        alternative.visual !== undefined &&
        typeof alternative.visual.description === 'string' &&
        alternative.visual.description.trim().length > 0
      );
    case 'interactiveAlternative':
      return (
        alternative.interactiveAlternative !== undefined &&
        Array.isArray(alternative.interactiveAlternative.steps) &&
        alternative.interactiveAlternative.steps.length > 0
      );
    default:
      return false;
  }
}

function modalityOf(emission: AccessibilityEmission): Modality {
  const canonical = emission.canonical_content as CanonicalContent | undefined;
  const modality = canonical?.modality;
  return modality ?? 'text';
}

/**
 * Checks an emission against the matrix row for its modality and reports the
 * dimensions that are missing.
 */
export function equivalenceReport(emission: AccessibilityEmission): EquivalenceReport {
  const modality = modalityOf(emission);
  const rule = EQUIVALENCE_MATRIX[modality];
  if (rule === undefined) {
    return {
      ok: false,
      modality,
      rule: null,
      missing: [`unknown modality "${String(modality)}"`],
      missingPaths: [],
      missingCovers: [],
    };
  }

  const alternative = emission.accessible_alternative as AccessibleAlternative | undefined;
  const missingPaths: AccessiblePathKind[] = [];
  const missingCovers: EquivalenceDimension[] = [];

  for (const path of rule.requiredPaths) {
    if (!hasPath(alternative, path)) {
      missingPaths.push(path);
    }
  }

  const covers = Array.isArray(alternative?.covers) ? alternative.covers : [];
  for (const cover of rule.requiredCovers) {
    if (!covers.includes(cover)) {
      missingCovers.push(cover);
    }
  }

  const missing = [
    ...missingPaths.map((path) => PATH_LABEL[path]),
    ...missingCovers.map((cover) => COVER_LABEL[cover]),
  ];

  return {
    ok: missing.length === 0,
    modality,
    rule,
    missing,
    missingPaths,
    missingCovers,
  };
}

/**
 * The missing dimensions for an emission — empty when the alternative covers
 * everything the modality owes a learner.
 */
export function checkEquivalence(emission: AccessibilityEmission): string[] {
  return [...equivalenceReport(emission).missing];
}
