/**
 * Gate: the accessibility runtime contract is actually enforced.
 *
 * The claim under test is "an emission blocked by ARC-I1 cannot reach a
 * learner". This gate builds a deliberately broken emission (no accessible
 * alternative) and asserts the validator rejects it, then builds a complete
 * emission and asserts the validator accepts it.
 */
import type { AccessibilityEmission, CanonicalContent } from '@edugenesis/contracts';
import type { Gate, GateContext, GateResult } from '../types.js';
import { brokenEmission, tamperedEmission, validEmission } from './emission-fixtures.js';
import { asFunction, describeExports, findExports, isRecord, loadWorkspacePackage } from './loading.js';

const GATE_ID = 'accessibility-contract';
const PACKAGE_NAME = '@edugenesis/accessibility';
const PACKAGE_DIR = 'packages/accessibility';

/** A validator surface resolved from the package exports. */
interface ValidatorLike {
  readonly label: string;
  validate(emission: AccessibilityEmission): unknown;
}

/** Narrow an unknown value to something with a `validate` method. */
function asValidator(candidate: unknown, label: string): ValidatorLike | undefined {
  if (!isRecord(candidate)) return undefined;
  const validate = candidate['validate'];
  if (typeof validate !== 'function') return undefined;
  const call = validate as (emission: AccessibilityEmission, ctx?: unknown) => unknown;
  return {
    label,
    validate: (emission: AccessibilityEmission): unknown => call.call(candidate, emission),
  };
}

/**
 * Resolve the validator by capability rather than by a hard-coded name, so
 * that the gate keeps working whatever the accessibility unit names it.
 */
export function resolveValidator(exports: Record<string, unknown>): ValidatorLike | undefined {
  const direct = asValidator(exports['validate'], 'validate');
  if (direct) return direct;

  const factories = findExports(
    exports,
    (name) => /^(create|make|build|new)/i.test(name) && /(validator|guardian|arc)/i.test(name),
  );
  for (const { name, value } of factories) {
    const fn = asFunction(value);
    if (!fn) continue;
    try {
      const produced = fn();
      const validator = asValidator(produced, name);
      if (validator) return validator;
    } catch {
      // not a zero-argument factory — try the next candidate
    }
  }

  const candidates = findExports(exports, (name) => /(validator|guardian)/i.test(name));
  for (const { name, value } of candidates) {
    const asObject = asValidator(value, name);
    if (asObject) return asObject;
    const fn = asFunction(value);
    if (!fn) continue;
    try {
      const produced = fn();
      const validator = asValidator(produced, name);
      if (validator) return validator;
    } catch {
      // not a zero-argument factory — try the next candidate
    }
  }
  return undefined;
}

/** The shape this gate needs from a validator result. */
interface ArcLike {
  ok: boolean;
  violations: Array<{ id: string; severity: string; message: string }>;
}

/** Narrow an unknown value to an ARC validation result. */
export function asArcResult(value: unknown): ArcLike | undefined {
  if (!isRecord(value)) return undefined;
  const ok = value['ok'];
  const raw = value['violations'];
  if (typeof ok !== 'boolean' || !Array.isArray(raw)) return undefined;
  const violations: Array<{ id: string; severity: string; message: string }> = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = typeof item['id'] === 'string' ? item['id'] : 'unknown';
    const severity = typeof item['severity'] === 'string' ? item['severity'] : 'unknown';
    const message = typeof item['message'] === 'string' ? item['message'] : '';
    violations.push({ id, severity, message });
  }
  return { ok, violations };
}

/**
 * Resolve the package's canonical content hasher.
 *
 * WHY the gate borrows it: ARC-I9 compares the recorded digest against the
 * canonical CONTENT OBJECT, so a fixture hashed any other way fails for the
 * wrong reason. Using the emitter's own canonicaliser is what a real emitter
 * does; the algorithm itself is proven independently by the accessibility
 * package's own hash tests.
 */
export function resolveContentHasher(
  exports: Record<string, unknown>,
): ((canonical: CanonicalContent) => string) | undefined {
  const fn = asFunction(exports['hashCanonicalContent']);
  if (!fn) return undefined;
  const call = fn as (canonical: CanonicalContent) => unknown;
  return (canonical: CanonicalContent): string => {
    const digest = call(canonical);
    return typeof digest === 'string' ? digest : '';
  };
}

export const contractGate: Gate = {
  id: GATE_ID,
  title: 'Accessibility validator blocks a broken emission and accepts a valid one',
  severity: 'blocker',
  async run(ctx: GateContext): Promise<GateResult> {
    const pkg = await loadWorkspacePackage(ctx.root, PACKAGE_NAME, PACKAGE_DIR);
    if (!pkg) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: 'package not built',
        evidence: [`${PACKAGE_NAME} has no resolvable build in this tree`],
      };
    }

    const validator = resolveValidator(pkg.exports);
    if (!validator) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: 'no validator surface found in the accessibility package',
        evidence: [
          `resolved via ${pkg.source}`,
          `exports: ${describeExports(pkg.exports) || '(none)'}`,
        ],
      };
    }

    const evidence: string[] = [`resolved via ${pkg.source}: ${validator.label}`];

    const hashCanonical = resolveContentHasher(pkg.exports);
    evidence.push(
      hashCanonical
        ? 'content hash: resolved hashCanonicalContent from the package'
        : 'content hash: package exposes no hashCanonicalContent; using the gate fallback (raw body digest)',
    );

    const brokenResult = asArcResult(validator.validate(brokenEmission()));
    if (!brokenResult) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'validator did not return an ARC validation result for the broken emission',
        evidence,
      };
    }
    evidence.push(
      `broken emission (no accessible alternative) -> ok=${String(brokenResult.ok)}, violations=${brokenResult.violations
        .map((v) => `${v.id}(${v.severity})`)
        .join(',') || 'none'}`,
    );

    const validResult = asArcResult(
      validator.validate(hashCanonical ? validEmission(hashCanonical) : validEmission()),
    );
    if (!validResult) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'validator did not return an ARC validation result for the valid emission',
        evidence,
      };
    }
    evidence.push(
      `valid emission -> ok=${String(validResult.ok)}, violations=${validResult.violations
        .map((v) => `${v.id}(${v.severity})`)
        .join(',') || 'none'}`,
    );

    const tamperedResult = asArcResult(
      validator.validate(hashCanonical ? tamperedEmission() : tamperedEmission()),
    );
    if (!tamperedResult) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'validator did not return an ARC validation result for the tampered emission',
        evidence,
      };
    }
    evidence.push(
      `tampered content hash -> ok=${String(tamperedResult.ok)}, violations=${tamperedResult.violations
        .map((v) => `${v.id}(${v.severity})`)
        .join(',') || 'none'}`,
    );

    const brokenBlocked = brokenResult.ok === false && brokenResult.violations.length > 0;
    const validAccepted = validResult.ok === true;
    const tamperCaught = tamperedResult.ok === false && tamperedResult.violations.some((v) => v.id === 'ARC-I9');

    if (!brokenBlocked) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'a broken emission was NOT blocked by the accessibility validator',
        evidence,
      };
    }
    if (!validAccepted) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'a complete emission was rejected by the accessibility validator',
        evidence,
      };
    }
    if (!tamperCaught) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'a tampered content hash was NOT caught by ARC-I9',
        evidence,
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: 'broken emission blocked, complete emission accepted, tampered hash caught',
      evidence,
    };
  },
};
