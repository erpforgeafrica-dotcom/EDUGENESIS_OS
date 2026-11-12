import { createHash } from 'node:crypto';
import { AllTiersExhaustedError, BudgetExceededError, ContractViolation } from '@edugenesis/contracts';
import type {
  AccessibilityEmission,
  ArcViolation,
  CompletionRequest,
  CompletionResult,
  FallbackTier,
  OneKeyGateway,
  ProviderAdapter,
  RequestContext,
  RoutingDecision,
  TaskPolicy,
  TierZeroProvider,
} from '@edugenesis/contracts';
import { requiredUnits } from './budget.js';
import { createCircuitBreaker } from './circuit-breaker.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { createKillSwitch } from './kill-switch.js';
import type { KillSwitch } from './kill-switch.js';
import { createPolicyEngine, TIER_FOUR_PROVIDER_ID, TIER_ZERO_PROVIDER_ID } from './policy.js';
import type { PolicyEngine } from './policy.js';
import { createProviderRegistry } from './registry.js';
import type { ProviderRegistry, RegisterMeta } from './registry.js';
import { redactSecret } from './redact.js';

/**
 * The OneKey gateway (Doc 2 §7; Doc 16 §6.4).
 *
 * This is the component that makes the sponsor promise real: EduGenesis can
 * select, route, suspend and replace any provider, and a learner is never
 * charged, blocked or interrupted while that happens.
 *
 * The ladder, in order:
 *   Tier 0 — deterministic cached curriculum, no provider required
 *   Tier 1 — primary approved hosted model
 *   Tier 2 — secondary approved hosted model
 *   Tier 3 — local or open model
 *   Tier 4 — human support or deferred response
 */

/** One rung of the ladder, recorded for the audit trail. */
export interface GatewayAttempt {
  tier: FallbackTier;
  providerId: string;
  outcome: 'served' | 'failed' | 'skipped' | 'deferred' | 'no-offline-content';
  reason: string;
  at: string;
}

/** The provenance recorded on every delivered result. */
export interface GatewayMeta {
  requestId: string;
  policyVersion: string;
  tier: FallbackTier;
  providerId: string;
  modelId: string;
  servedOffline: boolean;
  budgetPoolId: string;
  /** The human-readable policy trace behind the choice. */
  policyReason: string;
  attempts: GatewayAttempt[];
}

export interface GatewayCompletionResult extends CompletionResult {
  meta: GatewayMeta;
}

/**
 * The gateway, with the extra surface the audit trail and the failover drill
 * need. It satisfies the frozen OneKeyGateway contract.
 */
export interface OneKeyGatewayImpl extends OneKeyGateway {
  complete(
    policy: TaskPolicy,
    req: CompletionRequest,
    ctx: RequestContext,
  ): Promise<GatewayCompletionResult>;
  /** Register a provider. The optional metadata carries locale coverage and status. */
  register(adapter: ProviderAdapter, meta?: RegisterMeta): void;
  /** The attempts recorded for one request, in order. */
  attemptsFor(requestId: string): GatewayAttempt[];
  /** The policy engine behind the gateway. */
  policyEngine: PolicyEngine;
}

/**
 * The tier 4 rung: human support or a deferred response.
 *
 * WHY it is a hook and not built in: queueing a request for a human mentor is
 * an operational decision that belongs to the deployment, not to the gateway.
 * With no handler configured, tier 4 records the deferral and the gateway
 * raises AllTiersExhaustedError with the full trail.
 */
export interface TierFourHandler {
  serve(
    policy: TaskPolicy,
    req: CompletionRequest,
    ctx: RequestContext,
  ): Promise<CompletionResult | null>;
}

export interface GatewayOptions {
  registry?: ProviderRegistry;
  breaker?: CircuitBreaker;
  killSwitch?: KillSwitch;
  /** The deterministic offline tier. Omit to run without tier 0. */
  tierZero?: TierZeroProvider;
  /** Optional human-support / deferred-response tier. */
  tierFour?: TierFourHandler;
  policyEngine?: PolicyEngine;
  /** Recorded on every result, for audit. */
  policyVersion?: string;
  /** Injectable clock, so timestamps are deterministic under test. */
  now?: () => number;
  /** Called for every attempt, for live audit streaming. */
  onAttempt?: (attempt: GatewayAttempt) => void;
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // A provider error can quote a request header; never let a credential land
  // in the audit trail.
  return redactSecret(message);
}

export function createOneKeyGateway(opts: GatewayOptions = {}): OneKeyGatewayImpl {
  const registry = opts.registry ?? createProviderRegistry();
  const breaker = opts.breaker ?? createCircuitBreaker();
  const killSwitch = opts.killSwitch ?? createKillSwitch();
  const tierZero = opts.tierZero;
  const tierFour = opts.tierFour;
  const policyVersion = opts.policyVersion ?? 'policy-v1';
  const now = opts.now ?? ((): number => Date.now());
  const policyEngine =
    opts.policyEngine ?? createPolicyEngine({ registry, breaker, killSwitch, policyVersion });
  const attemptsByRequest = new Map<string, GatewayAttempt[]>();

  const gateway: OneKeyGatewayImpl = {
    policyEngine,

    async route(
      policy: TaskPolicy,
      req: CompletionRequest,
      ctx: RequestContext,
    ): Promise<RoutingDecision> {
      return policyEngine.route(policy, req, ctx);
    },

    async complete(
      policy: TaskPolicy,
      req: CompletionRequest,
      ctx: RequestContext,
    ): Promise<GatewayCompletionResult> {
      const decision = await policyEngine.route(policy, req, ctx);
      const attempts: GatewayAttempt[] = [];
      attemptsByRequest.set(ctx.requestId, attempts);

      const record = (
        tier: FallbackTier,
        providerId: string,
        outcome: GatewayAttempt['outcome'],
        reason: string,
      ): void => {
        const attempt: GatewayAttempt = {
          tier,
          providerId,
          outcome,
          reason: redactSecret(reason),
          at: new Date(now()).toISOString(),
        };
        attempts.push(attempt);
        opts.onAttempt?.(attempt);
      };

      // ---- Tier 0 first: the deterministic offline floor --------------------
      // WHY first: the offline bundle needs no provider, no credit and no
      // network, so a learner is never denied because a hosted model is down,
      // suspended or unaffordable. `serve()` returns null when the bundle has
      // nothing for this task, which is the signal to escalate.
      if (tierZero) {
        const offline = await tierZero.serve(policy, req);
        if (offline) {
          record(0, TIER_ZERO_PROVIDER_ID, 'served', 'the deterministic offline tier answered the request');
          return await deliver({
            result: offline,
            policy,
            req,
            ctx,
            decision,
            attempts,
            tier: 0,
            servedOffline: true,
            policyVersion,
            now,
          });
        }
        record(0, TIER_ZERO_PROVIDER_ID, 'no-offline-content', 'the offline bundle has no cached answer for this task');
      } else {
        record(0, TIER_ZERO_PROVIDER_ID, 'skipped', 'no offline tier is configured');
      }

      // ---- The paid ladder: walk the fallback chain down the tiers ---------
      let paidAttempted = false;
      for (const candidate of decision.fallbackChain) {
        if (candidate.tier < 1 || candidate.tier > 3) {
          continue;
        }
        const entry = registry.get(candidate.providerId);
        if (!entry) {
          record(candidate.tier, candidate.providerId, 'skipped', 'the provider is no longer in the registry');
          continue;
        }
        if (killSwitch.isKilled(candidate.providerId)) {
          record(
            candidate.tier,
            candidate.providerId,
            'skipped',
            `the provider was killed: ${killSwitch.reasonFor(candidate.providerId) ?? 'no reason recorded'}`,
          );
          continue;
        }
        if (breaker.state(candidate.providerId) === 'open') {
          record(candidate.tier, candidate.providerId, 'skipped', 'the circuit is open');
          continue;
        }
        if (ctx.budget.remaining() <= 0) {
          record(
            candidate.tier,
            candidate.providerId,
            'skipped',
            `budget pool '${ctx.budget.poolId}' has no remaining units`,
          );
          continue;
        }

        let result: CompletionResult;
        try {
          paidAttempted = true;
          result = await entry.adapter.complete(req, ctx);
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            // A budget refusal is NOT a health failure: the provider is fine,
            // the pool is empty. It must not trip the circuit, and the request
            // falls through to the next tier.
            record(
              candidate.tier,
              candidate.providerId,
              'skipped',
              `the provider refused: ${describeError(err)}`,
            );
            continue;
          }
          breaker.recordFailure(candidate.providerId, describeError(err));
          record(candidate.tier, candidate.providerId, 'failed', `the provider failed: ${describeError(err)}`);
          continue;
        }

        // Charge the ledger. A charge that cannot be made is a failure, not a
        // silent overspend: the request falls through to the next tier.
        const units = requiredUnits(ctx.budget, result.usage.inputTokens, result.usage.outputTokens);
        try {
          ctx.budget.consume(units, {
            providerId: result.providerId,
            modelId: result.modelId,
            requestId: ctx.requestId,
          });
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            record(
              candidate.tier,
              candidate.providerId,
              'failed',
              `the budget was exhausted before the answer could be charged (${units} units needed, ${ctx.budget.remaining()} left)`,
            );
            continue;
          }
          throw err;
        }

        breaker.recordSuccess(candidate.providerId);
        record(candidate.tier, candidate.providerId, 'served', 'the provider served the request');
        return await deliver({
          result,
          policy,
          req,
          ctx,
          decision,
          attempts,
          tier: candidate.tier,
          servedOffline: false,
          policyVersion,
          now,
        });
      }

      // ---- Tier 4: human support or deferred response ----------------------
      // WHY tier 4 is only consulted after a real provider outage: when no
      // provider was eligible (no budget, data class, safety tier), a human
      // response is not a learning answer, so the request fails with a typed
      // error instead of pretending the learner was served.
      if (tierFour && paidAttempted) {
        const deferred = await tierFour.serve(policy, req, ctx);
        if (deferred) {
          record(4, TIER_FOUR_PROVIDER_ID, 'served', 'the request was deferred to human support');
          return await deliver({
            result: deferred,
            policy,
            req,
            ctx,
            decision,
            attempts,
            tier: 4,
            servedOffline: false,
            policyVersion,
            now,
          });
        }
      }
      record(4, TIER_FOUR_PROVIDER_ID, 'deferred', 'every model tier failed; the request is deferred to human support');
      throw new AllTiersExhaustedError(
        attempts.map((attempt) => ({
          tier: attempt.tier,
          providerId: attempt.providerId,
          reason: attempt.reason,
        })),
      );
    },

    register(adapter: ProviderAdapter, meta?: RegisterMeta): void {
      registry.register(adapter, meta);
    },

    unregister(providerId: string): void {
      registry.unregister(providerId);
    },

    listProviders(): ProviderAdapter[] {
      return registry.listProviders();
    },

    killSwitch(providerId: string, reason: string): void {
      killSwitch.killSwitch(providerId, reason);
    },

    circuitState(providerId: string): 'closed' | 'open' | 'half_open' {
      return breaker.state(providerId);
    },

    resetCircuit(providerId: string): void {
      breaker.reset(providerId);
    },

    attemptsFor(requestId: string): GatewayAttempt[] {
      return [...(attemptsByRequest.get(requestId) ?? [])];
    },
  };

  return gateway;
}

interface DeliverInput {
  result: CompletionResult;
  policy: TaskPolicy;
  req: CompletionRequest;
  ctx: RequestContext;
  decision: RoutingDecision;
  attempts: GatewayAttempt[];
  tier: FallbackTier;
  servedOffline: boolean;
  policyVersion: string;
  now: () => number;
}

/**
 * Run the result through the accessibility guardian and return the DELIVERED
 * text (Doc 6 §7.3).
 *
 * WHY the guardian is mandatory for learner-facing output: no learner-facing
 * emission bypasses it. If the guardian blocks the emission, a typed failure
 * is thrown — a blocked emission is NEVER delivered.
 */
async function deliver(input: DeliverInput): Promise<GatewayCompletionResult> {
  const { result, policy, req, ctx, decision, attempts, tier, servedOffline, policyVersion, now: clock } =
    input;
  let text = result.text;

  if (ctx.learnerFacing) {
    const emission = buildEmission(result, policy, req, clock);
    const verdict = await ctx.guardian.intercept(emission, {
      locale: req.locale,
      safetyTier: req.safetyTier,
    });
    const violations: ArcViolation[] = verdict.violations?.length
      ? verdict.violations
      : [
          {
            id: 'ARC-I8',
            severity: 'Blocker',
            message: 'the accessibility guardian blocked the emission',
            path: 'canonical_content.body',
          },
        ];

    if (!verdict.deliver) {
      throw new ContractViolation(violations);
    }
    const delivered = verdict.emission ?? emission;
    if (delivered.withheld === true) {
      // ARC-I8: a withheld emission must never be delivered.
      throw new ContractViolation(violations);
    }
    text = delivered.accessible_alternative.text ?? delivered.canonical_content.body;
  }

  const meta: GatewayMeta = {
    requestId: ctx.requestId,
    policyVersion,
    tier,
    providerId: result.providerId,
    modelId: result.modelId,
    servedOffline,
    budgetPoolId: ctx.budget.poolId,
    policyReason: decision.reason,
    attempts: [...attempts],
  };

  return { ...result, text, meta };
}

/**
 * Build the nine-element emission for a provider result (Doc 2 §2.3).
 *
 * The gateway is the boundary between a raw provider completion and a
 * learner-facing emission, so this is where the contract shape is created.
 */
function buildEmission(
  result: CompletionResult,
  policy: TaskPolicy,
  req: CompletionRequest,
  now: () => number,
): AccessibilityEmission {
  const contentHash = createHash('sha256').update(result.text, 'utf8').digest('hex');
  return {
    canonical_content: {
      contentId: `${result.providerId}:${result.modelId}:${contentHash.slice(0, 16)}`,
      body: result.text,
      modality: 'text',
    },
    accessible_alternative: {
      text: result.text,
      covers: ['visual'],
      method: 'auto',
    },
    metadata: {
      contractVersion: 'nine-element/1.0',
      emittingService: 'onekey-gateway',
      emittingModel: result.modelId,
      emittedAt: new Date(now()).toISOString(),
      content_hash: contentHash,
      taskClass: policy.taskClass,
    },
    source_lineage: result.sourceLineage,
    risk_tier: 1,
    language: { primary: req.locale ?? 'en' },
    reading_level: { band: 'unspecified' },
    sensory_profile: {
      hasNonVisual: true,
      hasNonAudio: true,
      hasNonMotor: true,
      reducedMotionSafe: true,
    },
    interaction_mode: {
      input: ['keyboard', 'pointer', 'touch'],
      output: ['visual', 'text'],
    },
    // ARC-I1: set true only when an accessible equivalent has been verified.
    equivalence_verified: false,
    confidence_score: result.confidence,
  };
}
