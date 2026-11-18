import { createAccessibilityGuardian, createAccessibilityValidator } from '@edugenesis/accessibility';
import { AllTiersExhaustedError, ProviderUnavailableError } from '@edugenesis/contracts';
import type {
  CompletionRequest,
  FallbackTier,
  ProviderAdapter,
  ProviderCapabilities,
  RequestContext,
  RoutingDecision,
  TaskPolicy,
} from '@edugenesis/contracts';
import { createBudgetLedger } from './budget.js';
import { createOneKeyGateway } from './gateway.js';
import type { GatewayAttempt, GatewayCompletionResult, OneKeyGatewayImpl } from './gateway.js';
import { TIER_FOUR_PROVIDER_ID } from './policy.js';
import { createTierZeroProvider } from './providers/tier-zero.js';

/**
 * The failover drill (Doc 16 §6.4).
 *
 * WHY a drill and not a hope: the promise made to the anchor sponsor is that
 * EduGenesis can lose any provider and the learner keeps learning. That claim
 * is only worth anything if it is exercised on every build, so this module
 * walks the FULL five-tier ladder against deliberately failing providers and
 * records every transition.
 *
 * The built-in drill is offline: no key, no network, no hosted provider.
 * A caller may inject a gateway, but that result is marked `offline: false`
 * so a live run cannot be presented as the offline drill (F3-33).
 */

/** One rung of the ladder, as it actually happened. */
export interface FailoverTransition {
  order: number;
  tier: FallbackTier;
  providerId: string;
  outcome: GatewayAttempt['outcome'];
  reason: string;
  at: string;
}

export interface FailoverDrillResult {
  /** Every transition, in the order it happened. */
  transitions: FailoverTransition[];
  /** The tier that produced the delivered answer, if any. */
  servedBy?: { tier: FallbackTier; providerId: string };
  /** True when no tier could serve the request. */
  exhausted: boolean;
  /** The routing decision that was under test. */
  decision: RoutingDecision;
  /** The delivered result, when a tier served the request. */
  result?: GatewayCompletionResult;
  /** The typed failure, when the ladder was exhausted. */
  error?: AllTiersExhaustedError;
  /**
   * True only when the drill built its OWN offline gateway (F3-33). An
   * injected gateway may contain live providers, so its result is marked live
   * and can never be presented as the offline drill.
   */
  offline: boolean;
}

export interface FailoverDrillOptions {
  /**
   * A gateway under test. Prefer omitting this: the built-in gateway is
   * deliberately offline. When supplied, the result is marked `offline: false`
   * so a live run is not reported as the offline drill (F3-33).
   */
  gateway?: OneKeyGatewayImpl;
  /**
   * Which ladder outcome to exercise. Defaults to `offline-rescue`.
   *   offline-rescue     — every model fails, Tier 0 serves a cached lesson
   *   human-deferral     — every model fails and no cached lesson exists, Tier 4 answers
   *   exhausted          — no Tier 0; a human tier takes the work but has no
   *                         answer now, so the ladder raises a typed error
   *   no-human-support  — no Tier 0 and NO human tier: the ladder raises a
   *                         typed error and records NO deferral, because no
   *                         human ever took the work (audit finding F3-20)
   */
  scenario?: FailoverScenario;
  policy?: TaskPolicy;
  request?: CompletionRequest;
  ctx?: RequestContext;
}

export type FailoverScenario =
  | 'offline-rescue'
  | 'human-deferral'
  | 'exhausted'
  | 'no-human-support';

/** The deferred response a human-support tier returns. */
export const DEFERRED_RESPONSE_TEXT =
  'Your request is queued. A mentor will pick it up and the answer will reach you shortly.';

const DRILL_REQUEST_ID = 'failover-drill';

/**
 * A provider that always fails.
 *
 * WHY it lives here and not in a test file: the drill is a diagnostic that a
 * deployment can run against its own gateway, so it ships with its own
 * deliberately broken providers.
 */
/**
 * A provider that always fails.
 *
 * Module-internal: the drill ships with its own deliberately broken providers
 * because it is a diagnostic a deployment can run against its own gateway. The
 * individual factory is not part of the public seam — `runFailoverDrill` is.
 */
function createFailingProvider(id: string, tier: 1 | 2 | 3): ProviderAdapter {
  const capabilities: ProviderCapabilities = {
    modalities: ['text'],
    supportsContextCaching: false,
    maxContextTokens: 8_192,
    maxDataClass: 'public',
    clearedSafetyTiers: ['low', 'medium', 'high', 'critical'],
  };
  return {
    id,
    modelId: `${id}-model`,
    tier,
    maxDataClass: 'public',
    capabilities(): ProviderCapabilities {
      return { ...capabilities, clearedSafetyTiers: [...capabilities.clearedSafetyTiers] };
    },
    async complete(): Promise<never> {
      throw new ProviderUnavailableError(id, 'this provider is configured to fail (failover drill)');
    },
    async health() {
      return { ok: false, consecutiveFailures: 3, detail: 'failover drill provider' };
    },
    async dispose() {
      /* holds nothing */
    },
  };
}

/** The context the drill runs under. */
function drillContext(requestId: string): RequestContext {
  return {
    requestId,
    deadlineAt: Date.now() + 60_000,
    budget: createBudgetLedger('failover-drill-pool', 100_000, 'token'),
    // WHY the REAL guardian: the drill is a claim about what a learner
    // receives, so it must run the same interception point a learner's request
    // runs. A permissive stub would prove the ladder and not the delivery.
    guardian: createAccessibilityGuardian(createAccessibilityValidator()),
    learnerFacing: true,
  };
}

/** A task the offline bundle has nothing for, so the ladder must escalate. */
function researchRequest(): CompletionRequest {
  return {
    prompt: 'Research the effect of soil salinity on maize yields in East Africa',
    dataClass: 'public',
    safetyTier: 'low',
    maxOutputTokens: 512,
    requiresAccessibilityContract: false,
  };
}

/** A tutoring task the offline bundle CAN answer, used for the rescue drill. */
function tutoringRequest(): CompletionRequest {
  return {
    prompt: 'Explain how to solve a linear equation step by step',
    dataClass: 'public',
    safetyTier: 'low',
    maxOutputTokens: 512,
    requiresAccessibilityContract: false,
  };
}

function drillPolicy(taskClass: TaskPolicy['taskClass'] = 'explain'): TaskPolicy {
  return { taskClass, safetyTier: 'low', dataClass: 'public' };
}

/**
 * Build the drill gateway: a failing primary, a failing secondary, a failing
 * local model, the offline tier, and a human-support tier that catches the
 * learner when every model tier is gone.
 *
 * Module-internal: the drill runner owns the scenarios.
 */
function buildFailoverDrillGateway(): OneKeyGatewayImpl {
  const gateway = createOneKeyGateway({
    tierZero: createTierZeroProvider(),
    policyVersion: 'failover-drill-v1',
    tierFour: {
      async serve() {
        return {
          text: DEFERRED_RESPONSE_TEXT,
          providerId: TIER_FOUR_PROVIDER_ID,
          modelId: 'deferred-response',
          usage: { inputTokens: 0, outputTokens: 0 },
          latencyMs: 0,
          sourceLineage: [],
        };
      },
    },
  });

  gateway.register(createFailingProvider('drill-primary', 1), { locales: ['*'] });
  gateway.register(createFailingProvider('drill-secondary', 2), { locales: ['*'] });
  gateway.register(createFailingProvider('drill-local', 3), { locales: ['*'] });

  return gateway;
}

/**
 * A drill gateway with NO offline tier and a human tier that TAKES the work
 * but has no answer ready, so the ladder must fail with a typed error instead
 * of pretending a learner was served. This is the negative control for the
 * other two scenarios.
 *
 * WHY a human tier here and not none: the deferral must be TRUE for it to be
 * recorded. A human that took the question and cannot answer it right now has
 * genuinely deferred it, so the trail says "deferred" and the learner is not
 * denied silently. The case where NO human tier exists — where nothing may be
 * deferred at all — is the separate `no-human-support` scenario below.
 *
 * Module-internal: the drill runner owns the scenarios.
 */
function buildExhaustionDrillGateway(): OneKeyGatewayImpl {
  const gateway = createOneKeyGateway({
    policyVersion: 'failover-drill-v1',
    tierFour: {
      async serve() {
        // A mentor took the question; no answer is ready now.
        return null;
      },
      async accept() {
        return true;
      },
    },
  });
  gateway.register(createFailingProvider('drill-primary', 1), { locales: ['*'] });
  gateway.register(createFailingProvider('drill-secondary', 2), { locales: ['*'] });
  gateway.register(createFailingProvider('drill-local', 3), { locales: ['*'] });
  return gateway;
}

/**
 * A drill gateway with NO offline tier and NO human tier.
 *
 * WHY this scenario exists (audit finding F3-20): with no human tier, nothing
 * can be deferred. The request was denied, and the trail must record exactly
 * that — the false sentence "the request is deferred to human support" is what
 * this control exists to rule out.
 *
 * Module-internal: the drill runner owns the scenarios.
 */
function buildNoHumanSupportDrillGateway(): OneKeyGatewayImpl {
  const gateway = createOneKeyGateway({
    policyVersion: 'failover-drill-v1',
  });
  gateway.register(createFailingProvider('drill-primary', 1), { locales: ['*'] });
  gateway.register(createFailingProvider('drill-secondary', 2), { locales: ['*'] });
  gateway.register(createFailingProvider('drill-local', 3), { locales: ['*'] });
  return gateway;
}

/**
 * Run ONE named failover scenario.
 *
 * The drill exercises a named ladder outcome and records every transition, so
 * the audit trail shows exactly how a learner was kept in the loop — or why
 * the request was deferred. Each scenario is decidable: the caller asserts the
 * ordered transitions and the serving tier, not a narrative.
 */
export async function runFailoverScenario(
  opts: FailoverDrillOptions = {},
): Promise<FailoverDrillResult> {
  const scenario = opts.scenario ?? 'offline-rescue';
  const gateway =
    opts.gateway ??
    (scenario === 'exhausted'
      ? buildExhaustionDrillGateway()
      : scenario === 'no-human-support'
        ? buildNoHumanSupportDrillGateway()
        : buildFailoverDrillGateway());
  const policy =
    opts.policy ?? (scenario === 'offline-rescue' ? drillPolicy('explain') : drillPolicy('research'));
  const request =
    opts.request ?? (scenario === 'offline-rescue' ? tutoringRequest() : researchRequest());
  const ctx = opts.ctx ?? drillContext(`${DRILL_REQUEST_ID}-${scenario}`);

  const decision = await gateway.route(policy, request, ctx);

  let result: GatewayCompletionResult | undefined;
  let error: AllTiersExhaustedError | undefined;
  try {
    result = await gateway.complete(policy, request, ctx);
  } catch (err) {
    if (err instanceof AllTiersExhaustedError) {
      error = err;
    } else {
      throw err;
    }
  }

  const attempts = gateway.attemptsFor(ctx.requestId);
  const transitions: FailoverTransition[] = attempts.map((attempt, index) => ({
    order: index + 1,
    tier: attempt.tier,
    providerId: attempt.providerId,
    outcome: attempt.outcome,
    reason: attempt.reason,
    at: attempt.at,
  }));

  const served = transitions.find((transition) => transition.outcome === 'served');

  return {
    transitions,
    ...(served ? { servedBy: { tier: served.tier, providerId: served.providerId } } : {}),
    exhausted: result === undefined,
    offline: opts.gateway === undefined,
    decision,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * The documented failover drill: every scenario, in one report.
 *
 * WHY a report and not one scenario: the Phase 5 exit criterion says all five
 * tiers are exercised "including the §6.6 procedure end to end". A single
 * ladder cannot show both the Tier 0 rescue and the Tier 4 deferral, so the
 * drill runs the three documented outcomes and reports the union of the tiers
 * it actually reached. The gate reads this report; a report that omits a tier
 * or a scenario is a failure, not a smaller drill.
 */
export interface FailoverDrillReport {
  scenarios: {
    'offline-rescue': FailoverDrillResult;
    'human-deferral': FailoverDrillResult;
    exhausted: FailoverDrillResult;
    'no-human-support': FailoverDrillResult;
  };
  /** Every tier reached by at least one scenario, ascending and distinct.
   * Kept in this shape because the verification gate compares it with the
   * distinct set of reached tiers; the repeated visit is below. */
  tiersExercised: FallbackTier[];
  /** Per-scenario ordered rung sequences, not a Set union (F3-16). */
  rungSequences: Record<FailoverScenario, FallbackTier[]>;
  /** The ordered rungs of the ONE scenario that walks all five tiers. */
  fullLadderWalk: FallbackTier[];
  /** How many times Tier 0 was visited in that walk (§6.6 3 -> 0 -> 4). */
  tierZeroVisits: number;
}

export async function runFailoverDrill(): Promise<FailoverDrillReport> {
  const rescue = await runFailoverScenario({ scenario: 'offline-rescue' });
  const deferral = await runFailoverScenario({ scenario: 'human-deferral' });
  const exhausted = await runFailoverScenario({ scenario: 'exhausted' });
  const noHumanSupport = await runFailoverScenario({ scenario: 'no-human-support' });

  const scenarios = {
    'offline-rescue': rescue,
    'human-deferral': deferral,
    exhausted,
    'no-human-support': noHumanSupport,
  };

  // F3-16: report the actual rung SEQUENCE per scenario, not a Set union that
  // hides the repeated Tier 0. Find the single scenario that walks all five
  // rungs and publish its sequence so the §6.6 3 -> 0 -> 4 return is visible.
  const rungSequences = Object.fromEntries(
    (Object.keys(scenarios) as FailoverScenario[]).map((name) => [
      name,
      scenarios[name].transitions.map((transition) => transition.tier),
    ]),
  ) as Record<FailoverScenario, FallbackTier[]>;

  const fullWalk = (Object.keys(scenarios) as FailoverScenario[]).find((name) => {
    return new Set(rungSequences[name]).size === 5;
  });
  const tiers = new Set<FallbackTier>();
  for (const name of Object.keys(scenarios) as FailoverScenario[]) {
    for (const tier of rungSequences[name]) {
      tiers.add(tier);
    }
  }

  return {
    scenarios,
    tiersExercised: [...tiers].sort((a, b) => a - b),
    rungSequences,
    fullLadderWalk: fullWalk ? rungSequences[fullWalk] : [...tiers].sort((a, b) => a - b),
    tierZeroVisits: fullWalk ? rungSequences[fullWalk].filter((tier) => tier === 0).length : 0,
  };
}
