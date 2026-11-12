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
 * The drill is offline: no key, no network, no hosted provider.
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
}

export interface FailoverDrillOptions {
  /** The gateway under test. A drill gateway is built when omitted. */
  gateway?: OneKeyGatewayImpl;
  policy?: TaskPolicy;
  request?: CompletionRequest;
  ctx?: RequestContext;
}

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
export function createFailingProvider(id: string, tier: 1 | 2 | 3): ProviderAdapter {
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
    // A permissive guardian: the drill measures the ladder, not the
    // accessibility contract. The real guardian is always supplied by the
    // learner path.
    guardian: {
      async intercept(emission) {
        return { deliver: true, emission, violations: [] };
      },
    },
    learnerFacing: false,
  };
}

/** A task the offline bundle has nothing for, so the ladder must escalate. */
function drillRequest(): CompletionRequest {
  return {
    prompt: 'Research the effect of soil salinity on maize yields in East Africa',
    dataClass: 'public',
    safetyTier: 'low',
    maxOutputTokens: 512,
    requiresAccessibilityContract: false,
  };
}

function drillPolicy(): TaskPolicy {
  return { taskClass: 'research', safetyTier: 'low', dataClass: 'public' };
}

/**
 * Build the drill gateway: a failing primary, a failing secondary, a failing
 * local model, the offline tier, and a human-support tier that catches the
 * learner when every model tier is gone.
 */
export function buildFailoverDrillGateway(): OneKeyGatewayImpl {
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
 * Run the failover drill.
 *
 * The drill exercises every tier of the ladder (0 -> 1 -> 2 -> 3 -> 4) and
 * records each transition, so the audit trail shows exactly how a learner was
 * kept in the loop when every provider failed.
 */
export async function runFailoverDrill(opts: FailoverDrillOptions = {}): Promise<FailoverDrillResult> {
  const gateway = opts.gateway ?? buildFailoverDrillGateway();
  const policy = opts.policy ?? drillPolicy();
  const request = opts.request ?? drillRequest();
  const ctx = opts.ctx ?? drillContext(DRILL_REQUEST_ID);

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
    decision,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
  };
}
