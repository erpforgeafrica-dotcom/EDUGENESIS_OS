/**
 * @edugenesis/accessibility — the accessibility runtime contract engine.
 *
 * Doc 2 §2.3: "Accessibility is not a post-processing layer. It is a runtime
 * contract." This package is the enforcement point for that contract:
 *
 *   - `arc-invariants.ts` — the 12 CI invariants of 07 §5.3 as
 *     machine-checkable predicates, each naming the exact offending path.
 *   - `validator.ts`      — evaluates the invariant set against one emission.
 *   - `guardian.ts`       — the interception point (Doc 6 §7.3) that refuses
 *     to deliver a non-compliant emission.
 *   - `equivalence.ts`    — the Multimodal Equivalence Rule of 07 §4.
 *   - `bcp47.ts`          — syntactic BCP-47 validation (ARC-I5).
 *   - `content-hash.ts`   — the canonical content digest used by ARC-I9.
 *
 * This package MUST NOT import a provider SDK: provider access lives behind
 * packages/onekey (Doc 2 §7, ADR-0001).
 */
export {
  ARC_INVARIANTS,
  ARC_INVARIANT_BY_ID,
} from './arc-invariants.js';
export type { ArcInvariant, ArcInvariantFailure } from './arc-invariants.js';

export {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_MEDIA_BUDGET_BYTES,
  blockerViolations,
  createAccessibilityValidator,
  resolveValidationContext,
} from './validator.js';
export type { ResolvedValidationContext } from './validator.js';

export { createAccessibilityGuardian } from './guardian.js';

export {
  EQUIVALENCE_MATRIX,
  NON_MODALITY_EQUIVALENCE_ROWS,
  checkEquivalence,
  equivalenceFor,
  equivalenceReport,
} from './equivalence.js';
export type {
  AccessiblePathKind,
  EquivalenceDimension,
  EquivalenceReport,
  ModalityEquivalence,
  NonModalityEquivalence,
} from './equivalence.js';

export { canonicalizeBcp47, isValidBcp47, parseBcp47 } from './bcp47.js';
export type { Bcp47Extension, Bcp47ParseResult, Bcp47Tag } from './bcp47.js';

export { canonicaliseContent, hashCanonicalContent } from './content-hash.js';
