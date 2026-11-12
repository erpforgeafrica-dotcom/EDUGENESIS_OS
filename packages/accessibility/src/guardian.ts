/**
 * The Accessibility Guardian (Doc 6 §7.3).
 *
 * The guardian is the interception point every learner-facing emission passes
 * through. It applies the accessibility runtime contract (Doc 2 §2.3) at the
 * service boundary: if the emission fails any invariant, it is withheld and
 * `deliver` is false. There is no degraded path — 07 §4.3.6 is explicit that
 * the correct behaviour when no equivalent exists is withholding, not
 * "restricted or degraded but presented as equivalent".
 */
import type {
  AccessibilityEmission,
  AccessibilityGuardian,
  AccessibilityValidator,
  ArcViolation,
  ValidationContext,
} from '@edugenesis/contracts';

/**
 * Creates the interception point.
 *
 * On a blocked emission the guardian marks `withheld: true` on the emission
 * itself rather than on a copy: the emission may be held by more than one
 * component, and a copy would leave the other holder free to deliver it. The
 * canonical content is never touched — it is the learner-facing payload and
 * its bytes are the ARC-I9 tamper reference.
 */
export function createAccessibilityGuardian(validator: AccessibilityValidator): AccessibilityGuardian {
  return {
    intercept: async (
      emission: AccessibilityEmission,
      ctx?: ValidationContext,
    ): Promise<{
      deliver: boolean;
      emission?: AccessibilityEmission;
      violations: ArcViolation[];
    }> => {
      const result = validator.validate(emission, ctx);

      if (result.ok && emission.withheld !== true) {
        return { deliver: true, emission, violations: [] };
      }

      emission.withheld = true;
      return { deliver: false, emission, violations: result.violations };
    },
  };
}
