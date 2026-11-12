/**
 * The accessibility validator.
 *
 * Doc 2 §2.3: "Accessibility is not a post-processing layer. It is a runtime
 * contract." This module is where that contract is evaluated: every learner-
 * facing emission is checked against the 12 CI invariants of 07 §5.3 before
 * it is allowed to reach a learner.
 *
 * `ok` means the emission passes the contract — no invariant was violated.
 * Per 07 §5.3 a Blocker "fails the build and blocks delivery" and a High
 * severity "fails the build"; a learner-facing emission is therefore withheld
 * on any violation, and the severity records how the failure is escalated
 * (incident, remediation owner) rather than whether it may be ignored.
 */
import type {
  AccessibilityEmission,
  AccessibilityValidator,
  ArcInvariantId,
  ArcValidationResult,
  ArcViolation,
  SafetyTier,
  ValidationContext,
} from '@edugenesis/contracts';

import { ARC_INVARIANTS } from './arc-invariants.js';

/**
 * The default per-emission media budget (5 MiB), matching
 * `DEFAULT_SETTINGS.limits.mediaBudgetBytes` in the contracts package and the
 * delivery-mode budgets of 07 §9.1.
 */
export const DEFAULT_MEDIA_BUDGET_BYTES = 5_242_880;

/**
 * The default confidence threshold: below it an uncertainty note is mandatory
 * (07 §5.3 ARC-I4, Doc 6 §9.2).
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/** The validation context with every default resolved. */
export interface ResolvedValidationContext {
  /** BCP-47 tag of the learner's locale, if known. */
  readonly locale: string | undefined;
  readonly mediaBudgetBytes: number;
  readonly hasAccessibilityProfile: boolean;
  readonly confidenceThreshold: number;
  readonly safetyTier: SafetyTier;
}

/**
 * Resolves the validation context, applying the documented defaults.
 *
 * `locale` and `safetyTier` are carried rather than tested: none of the 12
 * invariants of 07 §5.3 is conditioned on them, and inventing an extra rule
 * would make the invariant set lie about its own authority. They are exposed
 * here so a caller (the CLI, the guardian, an escalation policy) can apply
 * its own policy without changing the contract.
 */
export function resolveValidationContext(ctx?: ValidationContext): ResolvedValidationContext {
  return {
    locale: ctx?.locale,
    mediaBudgetBytes: ctx?.mediaBudgetBytes ?? DEFAULT_MEDIA_BUDGET_BYTES,
    hasAccessibilityProfile: ctx?.hasAccessibilityProfile ?? false,
    confidenceThreshold: ctx?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
    safetyTier: ctx?.safetyTier ?? 'low',
  };
}

/** The violations of a result that block delivery outright. */
export function blockerViolations(result: ArcValidationResult): ArcViolation[] {
  return result.violations.filter((violation) => violation.severity === 'Blocker');
}

/**
 * Creates the validator that enforces the accessibility runtime contract.
 */
export function createAccessibilityValidator(): AccessibilityValidator {
  const validate = (
    emission: AccessibilityEmission,
    ctx?: ValidationContext,
  ): ArcValidationResult => {
    const resolved = resolveValidationContext(ctx);
    const violations: ArcViolation[] = [];
    const passed: ArcInvariantId[] = [];

    for (const invariant of ARC_INVARIANTS) {
      const failure = invariant.check(emission, resolved);
      if (failure === null) {
        passed.push(invariant.id);
        continue;
      }
      violations.push({
        id: invariant.id,
        severity: invariant.severity,
        message: failure.message,
        path: failure.path,
      });
    }

    return { ok: violations.length === 0, violations, passed };
  };

  return {
    validate,
    validateMany: (emissions: AccessibilityEmission[], ctx?: ValidationContext): ArcValidationResult[] =>
      emissions.map((emission) => validate(emission, ctx)),
  };
}
