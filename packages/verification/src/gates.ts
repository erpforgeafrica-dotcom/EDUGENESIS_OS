/**
 * The gate registry.
 *
 * Every claim this build makes has a machine-checkable gate here. A gate
 * that cannot run (because a sibling package has not been built yet) reports
 * a WARNING and `passed: false` — never a false pass, never a blocker.
 */
import type { Gate, GateContext, GateResult, GateSummary } from './types.js';
import { defaultProjectRoot } from './paths.js';
import { contractGate } from './gates/contract-gate.js';
import { failoverGate } from './gates/failover-gate.js';
import { ledgerGate } from './gates/ledger-gate.js';
import { consentGate } from './gates/consent-gate.js';
import { piiGate } from './gates/pii-gate.js';
import { noProviderLeakGate } from './gates/no-provider-leak-gate.js';
import { pathPortabilityGate } from './gates/path-portability-gate.js';
import { hexTokenGate } from './gates/hex-token-gate.js';
import { contractsBaselineGate } from './gates/contracts-baseline-gate.js';
import { exitCriteriaGate } from './gates/exit-criteria-gate.js';
import { pwaLightDefaultGate } from './gates/pwa-light-default-gate.js';
import { adrGovernanceGate } from './gates/adr-governance-gate.js';

/**
 * Every gate, in the order the report prints them.
 * Behavioural gates first (they prove the product works), then the static
 * governance gates (they prove the tree stays honest), then the phase
 * register, which re-runs the gates it cites as evidence.
 */
export const GATE_REGISTRY: readonly Gate[] = [
  contractGate,
  failoverGate,
  ledgerGate,
  consentGate,
  piiGate,
  noProviderLeakGate,
  pathPortabilityGate,
  hexTokenGate,
  contractsBaselineGate,
  exitCriteriaGate,
  pwaLightDefaultGate,
  adrGovernanceGate,
];

/**
 * Run every gate. A gate that throws is converted into a FAILED gate of its
 * own severity — an exception is never silently swallowed into a pass.
 */
export async function runAllGates(
  gates: readonly Gate[] = GATE_REGISTRY,
  ctx: GateContext = { root: defaultProjectRoot() },
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of gates) {
    try {
      const result = await gate.run(ctx);
      results.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: gate.id,
        passed: false,
        severity: gate.severity,
        detail: `gate threw: ${message}`,
        evidence: [`${gate.id} raised an unhandled error`],
      });
    }
  }
  return results;
}

/**
 * Summarise a gate run. One failed BLOCKER fails the whole run; failed
 * warnings are reported but do not block (they mean "could not verify").
 */
export function summarise(results: readonly GateResult[]): GateSummary {
  const blockerFailures: Array<{ id: string; detail: string }> = [];
  const warningFailures: Array<{ id: string; detail: string }> = [];
  let passedCount = 0;

  for (const result of results) {
    if (result.passed) {
      passedCount += 1;
      continue;
    }
    if (result.severity === 'blocker') blockerFailures.push({ id: result.id, detail: result.detail });
    else warningFailures.push({ id: result.id, detail: result.detail });
  }

  return {
    passed: blockerFailures.length === 0,
    total: results.length,
    passedCount,
    failedCount: results.length - passedCount,
    blockerFailures,
    warningFailures,
  };
}
