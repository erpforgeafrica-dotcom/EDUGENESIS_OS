/**
 * Gate: consent withdrawal blocks sharing but NEVER blocks core learning.
 *
 * This is the Phase 1 exit criterion and the single most important
 * behavioural gate in the build. A learner who withdraws consent must stop
 * being shared and must keep being able to learn.
 */
import type { Gate, GateContext, GateResult } from '../types.js';
import { asFunction, describeExports, findExports, isRecord, loadWorkspacePackage } from './loading.js';

const GATE_ID = 'consent-withdrawal';
const PACKAGE_NAME = '@edugenesis/identity';
const PACKAGE_DIR = 'packages/identity';

/** The consent surface this gate needs. */
interface ConsentLike {
  readonly label: string;
  grant(grant: unknown): unknown;
  withdraw(learnerId: string, scope: string): unknown;
  mayShare(learnerId: string, scope: string): boolean;
  mayLearn(learnerId: string): boolean;
}

/** Narrow an unknown value to a consent service. */
function asConsent(candidate: unknown, label: string): ConsentLike | undefined {
  if (!isRecord(candidate)) return undefined;
  const grant = candidate['grant'];
  const withdraw = candidate['withdraw'];
  const mayShare = candidate['mayShare'];
  const mayLearn = candidate['mayLearn'];
  if (
    typeof grant !== 'function' ||
    typeof withdraw !== 'function' ||
    typeof mayShare !== 'function' ||
    typeof mayLearn !== 'function'
  ) {
    return undefined;
  }
  const grantFn = grant as (g: unknown) => unknown;
  const withdrawFn = withdraw as (id: string, scope: string) => unknown;
  const mayShareFn = mayShare as (id: string, scope: string) => boolean;
  const mayLearnFn = mayLearn as (id: string) => boolean;
  return {
    label,
    grant: (g) => grantFn.call(candidate, g),
    withdraw: (id, scope) => withdrawFn.call(candidate, id, scope),
    mayShare: (id, scope) => mayShareFn.call(candidate, id, scope),
    mayLearn: (id) => mayLearnFn.call(candidate, id),
  };
}

/** Resolve the consent service by capability. */
export function resolveConsent(exports: Record<string, unknown>): ConsentLike | undefined {
  const candidates = findExports(exports, (name) => /consent/i.test(name));
  for (const { name, value } of candidates) {
    const asObject = asConsent(value, name);
    if (asObject) return asObject;
    const fn = asFunction(value);
    if (!fn) continue;
    try {
      const produced = fn();
      const consent = asConsent(produced, name);
      if (consent) return consent;
    } catch {
      // not a zero-argument factory
    }
    try {
      const constructed: unknown = Reflect.construct(fn, []);
      const consent = asConsent(constructed, name);
      if (consent) return consent;
    } catch {
      // not constructible
    }
  }
  return undefined;
}

export const consentGate: Gate = {
  id: GATE_ID,
  title: 'Consent withdrawal blocks sharing but never blocks core learning',
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

    const consent = resolveConsent(pkg.exports);
    if (!consent) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: 'no consent service found in the identity package',
        evidence: [
          `resolved via ${pkg.source}`,
          `exports: ${describeExports(pkg.exports) || '(none)'}`,
        ],
      };
    }

    const evidence: string[] = [`resolved via ${pkg.source}: ${consent.label}`];

    const learnerId = 'eg-verification-learner';
    const sharedScope = 'sponsor_aggregate_reporting';
    const otherScope = 'analytics_aggregate';
    const at = '2026-01-01T00:00:00.000Z';

    try {
      consent.grant({ learnerId, scope: sharedScope, granted: true, at });
      consent.grant({ learnerId, scope: otherScope, granted: true, at });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the consent service refused a valid grant',
        evidence: [...evidence, `grant threw: ${message}`],
      };
    }

    const shareBefore = consent.mayShare(learnerId, sharedScope);
    evidence.push(`before withdrawal: mayShare(${sharedScope})=${String(shareBefore)}`);

    try {
      consent.withdraw(learnerId, sharedScope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the consent service refused a withdrawal',
        evidence: [...evidence, `withdraw threw: ${message}`],
      };
    }

    const shareAfter = consent.mayShare(learnerId, sharedScope);
    const mayLearn = consent.mayLearn(learnerId);
    const otherScopeAfter = consent.mayShare(learnerId, otherScope);

    evidence.push(`after withdrawal: mayShare(${sharedScope})=${String(shareAfter)}`);
    evidence.push(`after withdrawal: mayLearn=${String(mayLearn)}`);
    evidence.push(`after withdrawal: mayShare(${otherScope})=${String(otherScopeAfter)}`);

    if (shareAfter !== false) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'consent withdrawal did NOT block the sharing surface',
        evidence,
      };
    }
    if (mayLearn !== true) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'consent withdrawal BLOCKED core learning — the Phase 1 exit criterion is broken',
        evidence,
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: 'sharing blocked by withdrawal, core learning still permitted',
      evidence,
    };
  },
};
