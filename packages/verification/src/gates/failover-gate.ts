/**
 * Gate: the five-tier failover drill really exercises all five tiers AND ends
 * with Tier 0 serving the learner.
 *
 * The promise made to the Anchor Sponsor is that a provider failure never
 * stops a learner learning: tier 0 (cached curriculum) is the floor, tiers
 * 1–3 are model providers, tier 4 is human support.
 *
 * WHY the gate asserts the ORDER and the SERVING tier, not just the presence
 * of five numbers: a drill can mention all five tiers and still never serve a
 * learner from Tier 0 — that is exactly the defect round 1 found. Presence is
 * not behaviour. The gate therefore requires the §6.6 ladder to end with
 * `0:served`, `servedBy.tier === 0`, and a learner-facing text that names no
 * provider, quota, credit or outage.
 */
import type { Gate, GateContext, GateResult } from '../types.js';
import { asFunction, describeExports, findExports, isRecord, loadWorkspacePackage } from './loading.js';

const GATE_ID = 'failover-drill';
const PACKAGE_NAME = '@edugenesis/onekey';
const PACKAGE_DIR = 'packages/onekey';

/** Every tier that must appear in the drill evidence. */
export const REQUIRED_TIERS: readonly number[] = [0, 1, 2, 3, 4];

/** Terms a learner must never see in a fallback answer (Doc 16 §6.6). */
export const OPERATIONS_TERMS = /provider|quota|credit|outage|\b401\b|\b403\b/i;

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

/** One rung of the ladder, as the drill reported it. */
export interface DrillTransition {
  tier: number;
  outcome: string;
}

/**
 * Read the ordered transition list from a drill result.
 *
 * Only the explicit `transitions` array is trusted here. `collectTiers` walks
 * the whole object for the coverage check, but ORDER can only be read from a
 * list that is ordered by construction.
 */
export function extractTransitions(result: unknown): DrillTransition[] {
  if (!isRecord(result)) return [];
  const raw = result['transitions'];
  if (!Array.isArray(raw)) return [];
  const transitions: DrillTransition[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const tier = item['tier'];
    const outcome = item['outcome'];
    if (typeof tier !== 'number' || !Number.isInteger(tier)) continue;
    transitions.push({ tier, outcome: typeof outcome === 'string' ? outcome : '(unnamed)' });
  }
  return transitions;
}

/** The verdict of assessing one drill result. */
export interface DrillAssessment {
  ok: boolean;
  detail: string;
  evidence: string[];
}

/** What a single scenario must end with. */
export interface DrillExpectation {
  /** The tier that must serve, or `none` for the exhaustion control. */
  servingTier: number | 'none';
}

/**
 * Assess ONE scenario against its expected ending.
 *
 * Pure and exported so the negative case can be proven in a unit test: a
 * result that ends with Tier 4 serving when every model failed MUST be
 * refused. A gate that cannot fail its own negative fixture is decoration.
 */
export function assessScenario(result: unknown, expectation: DrillExpectation): DrillAssessment {
  const transitions = extractTransitions(result);
  const evidence = [
    `transitions: ${transitions.map((t) => `${String(t.tier)}:${t.outcome}`).join(' -> ') || '(none)'}`,
  ];

  if (transitions.length === 0) {
    return {
      ok: false,
      detail: 'the failover drill reported no ordered transitions',
      evidence,
    };
  }

  const last = transitions[transitions.length - 1];
  if (!last) {
    return { ok: false, detail: 'the failover drill reported no final transition', evidence };
  }

  if (expectation.servingTier === 'none') {
    if (isRecord(result) && result['exhausted'] !== true) {
      return {
        ok: false,
        detail: 'the exhaustion control did not report an exhausted ladder',
        evidence,
      };
    }
    if (last.outcome !== 'deferred') {
      return {
        ok: false,
        detail: `the exhaustion control ended with "${last.outcome}", not a deferral`,
        evidence,
      };
    }
    return { ok: true, detail: 'the ladder exhausted and deferred honestly', evidence };
  }

  if (last.tier !== expectation.servingTier || last.outcome !== 'served') {
    return {
      ok: false,
      detail: `the ladder ended ${String(last.tier)}:${last.outcome}, expected ${String(expectation.servingTier)}:served`,
      evidence,
    };
  }

  const servedBy = isRecord(result) ? result['servedBy'] : undefined;
  const servedTier = isRecord(servedBy) ? servedBy['tier'] : undefined;
  if (servedTier !== expectation.servingTier) {
    return {
      ok: false,
      detail: `the drill reported Tier ${String(servedTier ?? 'none')} as the serving tier, not Tier ${String(expectation.servingTier)}`,
      evidence,
    };
  }

  if (isRecord(result) && result['exhausted'] === true) {
    return {
      ok: false,
      detail: 'the drill reported an exhausted ladder while claiming a tier served',
      evidence,
    };
  }

  const delivered = isRecord(result) && isRecord(result['result']) ? result['result']['text'] : undefined;
  if (typeof delivered === 'string' && OPERATIONS_TERMS.test(delivered)) {
    return {
      ok: false,
      detail: 'the learner-facing fallback text names a provider, quota, credit or outage',
      evidence: [...evidence, 'delivered text contains an operations term'],
    };
  }

  return {
    ok: true,
    detail: `the ladder ended with Tier ${String(expectation.servingTier)} serving a neutral learner-facing lesson`,
    evidence,
  };
}

/** The three documented scenarios and what each must prove. */
const SCENARIO_EXPECTATIONS: ReadonlyArray<{
  name: 'offline-rescue' | 'human-deferral' | 'exhausted';
  servingTier: number | 'none';
}> = [
  { name: 'offline-rescue', servingTier: 0 },
  { name: 'human-deferral', servingTier: 4 },
  { name: 'exhausted', servingTier: 'none' },
];

/**
 * Assess the documented drill report: all three scenarios, all five tiers, and
 * the §6.6 rescue ending with Tier 0 serving.
 *
 * The union check is the point. A report can contain five tier numbers and
 * still never have served a learner from Tier 0; the per-scenario expectations
 * make that impossible to hide.
 */
export function assessReport(report: unknown): DrillAssessment {
  if (!isRecord(report)) {
    return { ok: false, detail: 'the drill report is not an object', evidence: [] };
  }
  const scenarios = report['scenarios'];
  if (!isRecord(scenarios)) {
    return {
      ok: false,
      detail: 'the drill report does not carry its three scenarios',
      evidence: [],
    };
  }

  const evidence: string[] = [];
  const failures: string[] = [];
  const reached = new Set<number>();

  for (const expectation of SCENARIO_EXPECTATIONS) {
    const outcome = assessScenario(scenarios[expectation.name], {
      servingTier: expectation.servingTier,
    });
    evidence.push(`${expectation.name}: ${outcome.evidence[0] ?? '(no transitions)'}`);
    if (!outcome.ok) {
      failures.push(`${expectation.name}: ${outcome.detail}`);
      continue;
    }
    const transitions = extractTransitions(scenarios[expectation.name]);
    for (const transition of transitions) {
      reached.add(transition.tier);
    }
  }

  const missing = REQUIRED_TIERS.filter((tier) => !reached.has(tier));
  if (missing.length > 0) {
    failures.push(`the drill never reached tier(s) ${missing.join(', ')}`);
  }

  const claimed = report['tiersExercised'];
  const claimedTiers = Array.isArray(claimed)
    ? claimed.filter((tier): tier is number => typeof tier === 'number')
    : [];
  const computed = [...reached].sort((a, b) => a - b);
  if (claimedTiers.join(',') !== computed.join(',')) {
    failures.push(
      `the report claims tiers [${claimedTiers.join(',')}] but the transitions reached [${computed.join(',')}]`,
    );
  }

  if (failures.length > 0) {
    return { ok: false, detail: failures.join('; '), evidence };
  }

  return {
    ok: true,
    detail: 'all three scenarios hold, all five tiers were reached, and Tier 0 rescued the learner',
    evidence,
  };
}

/**
 * Assess a drill result: the documented report when it carries scenarios,
 * otherwise a single scenario expected to end with Tier 0 serving.
 */
export function assessDrill(result: unknown): DrillAssessment {
  if (isRecord(result) && isRecord(result['scenarios'])) {
    return assessReport(result);
  }
  return assessScenario(result, { servingTier: 0 });
}

/** Find the drill entry point in the package exports. */
export function findDrill(exports: Record<string, unknown>): { name: string; run: () => unknown } | undefined {
  // The documented drill has one canonical name. Prefer it explicitly: the
  // module also exports a single-scenario runner, and picking that one would
  // report "Tier 4 never reached" against a healthy package.
  const canonical = asFunction(exports['runFailoverDrill']);
  if (canonical) {
    return { name: 'runFailoverDrill', run: () => canonical() };
  }
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
  title: 'The failover ladder exercises all five tiers and ends with Tier 0 serving',
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
    const assessment = assessDrill(resolved);
    const evidence = [`drill ${drill.name} via ${pkg.source}`, ...assessment.evidence];

    if (!assessment.ok) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: assessment.detail,
        evidence,
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: assessment.detail,
      evidence,
    };
  },
};
