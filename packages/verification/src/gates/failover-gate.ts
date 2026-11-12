/**
 * Gate: the five-tier failover drill really exercises all five tiers.
 *
 * The promise made to the Anchor Sponsor is that a provider failure never
 * stops a learner learning: tier 0 (cached curriculum) is the floor, tiers
 * 1–3 are model providers, tier 4 is human support.
 */
import type { Gate, GateContext, GateResult } from '../types.js';
import { asFunction, describeExports, findExports, isRecord, loadWorkspacePackage } from './loading.js';

const GATE_ID = 'failover-drill';
const PACKAGE_NAME = '@edugenesis/onekey';
const PACKAGE_DIR = 'packages/onekey';

/** Every tier that must appear in the drill evidence. */
export const REQUIRED_TIERS: readonly number[] = [0, 1, 2, 3, 4];

/** Keys that commonly hold the drill's step list. */
const STEP_KEYS = ['transitions', 'steps', 'attempts', 'tiers', 'events', 'trace', 'failover'];

/** Extract every tier number mentioned anywhere in a drill result. */
export function collectTiers(result: unknown, depth = 0): number[] {
  const tiers: number[] = [];
  if (depth > 6) return tiers;
  if (Array.isArray(result)) {
    for (const item of result) tiers.push(...collectTiers(item, depth + 1));
    return tiers;
  }
  if (!isRecord(result)) return tiers;
  const tier = result['tier'];
  if (typeof tier === 'number' && Number.isInteger(tier) && tier >= 0 && tier <= 4) {
    tiers.push(tier);
  } else if (typeof tier === 'string') {
    const parsed = /^t?([0-4])$/i.exec(tier.trim());
    if (parsed?.[1] !== undefined) tiers.push(Number(parsed[1]));
  }
  for (const key of STEP_KEYS) {
    const nested = result[key];
    if (nested !== undefined) tiers.push(...collectTiers(nested, depth + 1));
  }
  return tiers;
}

/** Find the drill entry point in the package exports. */
export function findDrill(exports: Record<string, unknown>): { name: string; run: () => unknown } | undefined {
  const candidates = findExports(
    exports,
    (name) =>
      /(drill|failover|fallback)/i.test(name) &&
      !/type|interface|config/i.test(name) &&
      // A builder returns a configured gateway; it does not run the ladder.
      // Calling one here would report "tiers observed: none" against a healthy
      // package, which is a false blocker rather than a finding.
      !/^(build|create|make|new)/i.test(name),
  );
  for (const { name, value } of candidates) {
    if (isRecord(value)) {
      for (const method of ['run', 'drill', 'runDrill', 'execute']) {
        const fn = asFunction(value[method]);
        if (fn) return { name: `${name}.${method}`, run: () => fn.call(value) };
      }
      continue;
    }
    const fn = asFunction(value);
    if (fn) return { name, run: () => fn() };
  }
  return undefined;
}

export const failoverGate: Gate = {
  id: GATE_ID,
  title: 'All five fallback tiers are exercised by the failover drill',
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

    const drill = findDrill(pkg.exports);
    if (!drill) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: 'no failover drill surface found in the onekey package',
        evidence: [
          `resolved via ${pkg.source}`,
          `exports: ${describeExports(pkg.exports) || '(none)'}`,
          'expected an exported drill that reports one transition per fallback tier',
        ],
      };
    }

    let outcome: unknown;
    try {
      outcome = drill.run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the failover drill threw',
        evidence: [`drill ${drill.name} threw: ${message}`],
      };
    }

    const resolved = await Promise.resolve(outcome);
    const tiers = [...new Set(collectTiers(resolved))].sort((a, b) => a - b);
    const missing = REQUIRED_TIERS.filter((tier) => !tiers.includes(tier));

    const evidence: string[] = [
      `drill ${drill.name} via ${pkg.source}`,
      `tiers observed: ${tiers.length > 0 ? tiers.join(',') : 'none'}`,
    ];

    if (missing.length > 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: `the failover drill did not exercise tiers ${missing.join(', ')}`,
        evidence,
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: 'all five fallback tiers exercised',
      evidence,
    };
  },
};
