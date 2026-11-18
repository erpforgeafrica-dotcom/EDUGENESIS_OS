import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  equivalenceReport,
  hashCanonicalContent,
} from '@edugenesis/accessibility';
import { AllTiersExhaustedError, BudgetExceededError, ContractViolation } from '@edugenesis/contracts';
import type {
  AccessibilityEmission,
  ArcViolation,
  CanonicalContent,
  CompletionRequest,
  CompletionResult,
  FallbackTier,
  OneKeyGateway,
  ProviderAdapter,
  RequestContext,
  RiskTier,
  RoutingDecision,
  SafetyTier,
  TaskPolicy,
  TierZeroProvider,
} from '@edugenesis/contracts';
import { requiredUnits } from './budget.js';
import { createCircuitBreaker } from './circuit-breaker.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { createKillSwitch } from './kill-switch.js';
import type { KillClassification, KillSwitch } from './kill-switch.js';
import { createPolicyEngine, TIER_FOUR_PROVIDER_ID, TIER_ZERO_PROVIDER_ID } from './policy.js';
import type { PolicyEngine } from './policy.js';
import { isCredentialRevoked, isRateLimited } from './provider-errors.js';
import { hasTierZeroFallback } from './tier-zero-fallback.js';
import { createProviderRegistry } from './registry.js';
import type { ProviderRegistry, RegisterMeta, ModelRegistryEntry } from './registry.js';
import { EgressRejectedError, projectRequestForEgress } from './egress.js';
import { describeRedacted, redactSecret } from './redact.js';

/**
 * The OneKey gateway (Doc 2 §7; Doc 16 §6.4).
 *
 * This is the component that makes the sponsor promise real: EduGenesis can
 * select, route, suspend and replace any provider, and a learner is never
 * charged, blocked or interrupted while that happens.
 *
 * The ladder is SIX rungs, not five (Doc 16 §6.6): Tier 0 is visited TWICE.
 *   1. Tier 0 — deterministic cached curriculum, no provider required
 *   2. Tier 1 — primary approved hosted model
 *   3. Tier 2 — secondary approved hosted model
 *   4. Tier 3 — local or open model
 *   5. Tier 0 — the §6.6 step-5 last resort, once every model has failed
 *   6. Tier 4 — human support or deferred response
 *
 * The second Tier 0 visit is the 2 -> 3 -> 0 -> 4 sequence of §6.6 step 5: a
 * deterministic lesson still beats a deferral, so a learner is never denied
 * core learning. The six-rung shape is asserted in gateway.test.ts.
 */

/** One rung of the ladder, recorded for the audit trail. */
export interface GatewayAttempt {
  tier: FallbackTier;
  providerId: string;
  /**
   * What happened on this rung.
   *
   * `governance-failed` is a failure of the CREDENTIAL, not of the provider:
   * the provider rejected it, so it is dead and must never be used again. It
   * is kept apart from `failed` because a governance failure is an incident
   * for a human, while a `failed` rung is a provider the ladder may retry
   * elsewhere (audit findings F3-13, F3-14).
   */
  outcome: 'served' | 'failed' | 'skipped' | 'deferred' | 'no-offline-content' | 'governance-failed';
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
  /**
   * The nine-element compliance emission that was actually delivered (ARC-I1..I9).
   * F3-18: the gateway used to compute this and then discard it, making the
   * compliance contract unauditable. Present on learner-facing completions;
   * absent when no emission was built (`learnerFacing: false`).
   */
  emission?: AccessibilityEmission;
}

/**
 * The typed LEARNER-FACING failure (audit findings F3-07 and F3-15).
 *
 * It extends the audit-grade AllTiersExhaustedError so existing catchers keep
 * working, but overrides `message` with neutral, operations-free text: no HTTP
 * status, provider id, credential vocabulary or credit wording may reach a
 * learner. The raw attempt chain stays on `.attempts` (the audit trail only).
 */
export class LearningUnavailableError extends AllTiersExhaustedError {
  constructor(attempts: Array<{ tier: FallbackTier; providerId?: string; reason: string }>) {
    super(attempts);
    this.name = 'LearningUnavailableError';
    this.message =
      'Learning is temporarily unavailable. Your teacher has been notified and core learning continues.';
  }
}

/** Doc 6 §3.1 mapping from a request safety tier to its emission risk tier. */
const SAFETY_TIER_TO_RISK_TIER: Record<SafetyTier, RiskTier> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

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
 * With no handler configured, tier 4 records the failure and the gateway
 * raises AllTiersExhaustedError with the full trail.
 *
 * WHY `accept` is separate from `serve`: "a human took the question" and "a
 * human answered now" are DIFFERENT facts. Only the first may be recorded as
 * a deferral (Doc 16 §6.6; audit finding F3-20), and only the second is
 * something the learner can be given. Before this split, a handler that
 * could not answer produced the same trail as one that had taken the work,
 * so the audit trail could not tell a real deferral from a refusal.
 */
export interface TierFourHandler {
  /**
   * Answer the request now.
   *
   * Return the result to serve the learner, or `null` when this tier has no
   * answer right now.
   */
  serve(
    policy: TaskPolicy,
    req: CompletionRequest,
    ctx: RequestContext,
  ): Promise<CompletionResult | null>;
  /**
   * Accept the work for a later answer.
   *
   * Return `true` when a human took the request; the gateway then records
   * the deferral honestly. Return `false` (or omit this method) when the work
   * was NOT taken — the request failed, and the trail says so.
   *
   * WHY optional: a deployment whose human tier always answers now implements
   * nothing extra, and omitting the method means "this tier never defers".
   */
  accept?(
    policy: TaskPolicy,
    req: CompletionRequest,
    ctx: RequestContext,
  ): Promise<boolean>;
}

/**
 * The equivalence check the gateway runs before it may claim
 * `equivalence_verified`.
 *
 * WHY injectable: the gateway is the producer of the emission, so it must not
 * be the only judge of its own accessibility claim. The default is the
 * 07 §4 Multimodal Equivalence Rule; a deployment (or a test) can supply a
 * stricter verifier, and a rejecting verifier must withhold the emission
 * rather than let a false `true` reach a learner.
 */
export interface EquivalenceVerdict {
  readonly ok: boolean;
  /** The missing dimensions, named, for the audit trail. */
  readonly missing: readonly string[];
}

export type EquivalenceVerifier = (emission: AccessibilityEmission) => EquivalenceVerdict;

export interface GatewayOptions {
  registry?: ProviderRegistry;
  breaker?: CircuitBreaker;
  killSwitch?: KillSwitch;
  /** The deterministic offline tier. Omit to run without tier 0. */
  tierZero?: TierZeroProvider;
  /** Optional human-support / deferred-response tier. */
  tierFour?: TierFourHandler;
  policyEngine?: PolicyEngine;
  /** The equivalence verifier behind `equivalence_verified`. Defaults to 07 §4. */
  equivalenceVerifier?: EquivalenceVerifier;
  /** Recorded on every result, for audit. */
  policyVersion?: string;
  /** Injectable clock, so timestamps are deterministic under test. */
  now?: () => number;
  /** Called for every attempt, for live audit streaming. */
  onAttempt?: (attempt: GatewayAttempt) => void;
  /** Max per-request attempt trails retained (F3-25). Default 1000. */
  maxAttemptTrails?: number;
  /** How long an attempt trail is retained in ms (F3-25). Default 300_000. */
  attemptTrailTtlMs?: number;
}

function describeError(err: unknown): string {
  // A provider error can be a string, an Error, or an arbitrary object/array
  // (F3-26). Every shape goes through the redactor before it can land in the
  // audit trail; the familiar Error path keeps its message-only shape.
  if (err instanceof Error) {
    return redactSecret(err.message);
  }
  return describeRedacted(err);
}

export function createOneKeyGateway(opts: GatewayOptions = {}): OneKeyGatewayImpl {
  // F3-36: the gateway MUST own the policy engine so the breaker and kill
  // switch used at decision time are the same instances used at execution
  // time. An injected engine was built with its own breaker/kill switch (the
  // PolicyEngine contract does not expose them), so accepting it would create
  // two independent, silently diverging safety states. Refuse that shape.
  if (opts.policyEngine) {
    throw new Error(
      'GatewayOptions.policyEngine is not supported: the gateway owns its policy engine so the breaker and kill switch are shared. Build a gateway and use gateway.policyEngine instead.',
    );
  }
  const registry = opts.registry ?? createProviderRegistry();
  const breaker = opts.breaker ?? createCircuitBreaker();
  const killSwitch = opts.killSwitch ?? createKillSwitch();
  const tierZero = opts.tierZero;
  const tierZeroFallback = hasTierZeroFallback(opts.tierZero) ? opts.tierZero : undefined;
  const tierFour = opts.tierFour;
  const policyVersion = opts.policyVersion ?? 'policy-v1';
  const now = opts.now ?? ((): number => Date.now());
  const verifyEquivalence: EquivalenceVerifier =
    opts.equivalenceVerifier ??
    ((emission): EquivalenceVerdict => {
      const report = equivalenceReport(emission);
      return { ok: report.ok, missing: report.missing };
    });
  // One engine, built from the gateway's own safety primitives.
  const policyEngine = createPolicyEngine({ registry, breaker, killSwitch, policyVersion });
  const maxAttemptTrails = opts.maxAttemptTrails ?? 1_000;
  const attemptTrailTtlMs = opts.attemptTrailTtlMs ?? 300_000;
  interface AttemptTrail {
    attempts: GatewayAttempt[];
    at: number;
  }
  const attemptsByRequest = new Map<string, AttemptTrail>();

  /** F3-25: bound the trail map by size and TTL; oldest first. */
  const storeTrail = (requestId: string, attempts: GatewayAttempt[]): void => {
    const cutoff = now() - attemptTrailTtlMs;
    for (const [id, trail] of attemptsByRequest) {
      if (trail.at < cutoff) {
        attemptsByRequest.delete(id);
      }
    }
    // A re-used request id is a fresh trail; delete first so it becomes newest.
    attemptsByRequest.delete(requestId);
    attemptsByRequest.set(requestId, { attempts, at: now() });
    while (attemptsByRequest.size > maxAttemptTrails) {
      const oldest = attemptsByRequest.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      attemptsByRequest.delete(oldest);
    }
  };

  /**
   * F8-07: the ONLY path from a routed request to a registered adapter.
   *
   * Project once here and hand the adapter only the egress-safe shape. Before
   * this seam the raw request — including `context` with the full SourceLineage
   * (licence, retrieval time, tier, source id) — was passed straight through,
   * so every adapter except Qwen was an unguarded egress path. Centralising the
   * call makes skipping the projection a single place to audit rather than one
   * missed call site per adapter. The projection is idempotent, so an adapter
   * that still projects internally (Qwen) is not broken by projecting first.
   */
  const callAdapter = async (
    entry: ModelRegistryEntry,
    rawReq: CompletionRequest,
    requestCtx: RequestContext,
  ): Promise<CompletionResult> => {
    const projected = projectRequestForEgress(rawReq, {
      maxDataClass: entry.adapter.maxDataClass,
    });
    return entry.adapter.complete(projected as unknown as CompletionRequest, requestCtx);
  };

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
      storeTrail(ctx.requestId, attempts);

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
            verify: verifyEquivalence,
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
            `the provider was killed: ${redactSecret(killSwitch.reasonFor(candidate.providerId) ?? 'no reason recorded')}`,
          );
          continue;
        }
        // F3-28: claiming the single half-open probe replaces the old read of
        // state(). A closed circuit is admitted; an open/cooling circuit or a
        // half-open circuit whose probe is already in flight is skipped.
        if (!breaker.tryAcquireProbe(candidate.providerId)) {
          record(
            candidate.tier,
            candidate.providerId,
            'skipped',
            'the circuit is open or a half-open probe is already in flight',
          );
          continue;
        }
        if (ctx.budget.remaining() <= 0) {
          breaker.releaseProbe(candidate.providerId);
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
          result = await callAdapter(entry, req, ctx);
        } catch (err) {
          if (err instanceof EgressRejectedError) {
            // F8-07: the egress boundary refused this request for this provider
            // (an unsafe locator, an unknown field or a class above its ceiling).
            // Never fall back to sending the raw request: record the refusal and
            // walk to the next tier, exactly like any other provider failure.
            breaker.releaseProbe(candidate.providerId);
            record(
              candidate.tier,
              candidate.providerId,
              'failed',
              `the egress boundary refused the request: ${err.reason}`,
            );
            continue;
          }
          if (err instanceof BudgetExceededError) {
            // A budget refusal is NOT a health failure: the provider is fine,
            // the pool is empty. It must not trip the circuit, and the request
            // falls through to the next tier.
            breaker.releaseProbe(candidate.providerId);
            record(
              candidate.tier,
              candidate.providerId,
              'skipped',
              `the provider refused: ${describeError(err)}`,
            );
            continue;
          }
          if (isCredentialRevoked(err)) {
            // A 401/403 is a CREDENTIAL failure, not an outage (audit finding
            // F3-14). The provider is not sick: its credential is dead. The
            // rung is skipped for this request — the credential is never
            // retried — and the health circuit is NOT tripped, because
            // counting a governance failure as an outage would take a healthy
            // provider out of routing for a reason the circuit cannot fix.
            // The attempt is recorded as a GOVERNANCE failure so the incident
            // is visible in the audit trail.
            breaker.releaseProbe(candidate.providerId);
            record(
              candidate.tier,
              candidate.providerId,
              'governance-failed',
              `the provider credential was revoked: ${describeError(err)}`,
            );
            continue;
          }
          if (isRateLimited(err)) {
            // A 429 is a rate limit on a HEALTHY provider (audit finding
            // F3-13). The provider is busy, not sick: it must not open the
            // health circuit, and the request falls through to the next tier.
            breaker.releaseProbe(candidate.providerId);
            record(
              candidate.tier,
              candidate.providerId,
              'skipped',
              `the provider is rate limited: ${describeError(err)}`,
            );
            continue;
          }
          breaker.recordFailure(candidate.providerId, describeError(err));
          record(candidate.tier, candidate.providerId, 'failed', `the provider failed: ${describeError(err)}`);
          continue;
        }

        // An answer with no text in it is a FAILED provider, not a lesson.
        // Delivering it would hand the learner a blank screen and record the
        // attempt as "served" — a failure wearing a success.
        if (typeof result.text !== 'string' || result.text.trim().length === 0) {
          breaker.recordFailure(candidate.providerId, 'the provider returned an empty answer');
          record(candidate.tier, candidate.providerId, 'failed', 'the provider returned an empty answer');
          continue;
        }

        // Charge the ledger. A charge that cannot be made is a failure, not a
        // silent overspend: the request falls through to the next tier.
        const units = requiredUnits(ctx.budget, result.usage.inputTokens, result.usage.outputTokens);
        if (units <= 0) {
          // The provider reported no measurable usage, so the request cannot be
          // costed. The budget refuses a zero-unit charge by design — a charge
          // must be a positive number of units — and letting that refusal
          // escape would throw an untyped error out of `complete()` and bypass
          // the whole fallback ladder. It is a provider failure: record it and
          // walk to the next tier.
          breaker.recordFailure(candidate.providerId, 'the provider reported no usage');
          record(candidate.tier, candidate.providerId, 'failed', 'the provider reported no usage');
          continue;
        }
        try {
          ctx.budget.consume(units, {
            providerId: result.providerId,
            modelId: result.modelId,
            requestId: ctx.requestId,
          });
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            breaker.releaseProbe(candidate.providerId);
            record(
              candidate.tier,
              candidate.providerId,
              'failed',
              `the budget was exhausted before the answer could be charged (${units} units needed, ${ctx.budget.remaining()} left)`,
            );
            continue;
          }
          // Any other refusal from the ledger is still "the charge could not
          // be made". It must never escape `complete()`: an untyped error
          // thrown here would bypass the fallback ladder and reach the
          // learner as a raw failure.
          breaker.releaseProbe(candidate.providerId);
          record(
            candidate.tier,
            candidate.providerId,
            'failed',
            `the answer could not be charged: ${describeError(err)}`,
          );
          continue;
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
          verify: verifyEquivalence,
        });
      }

      // ---- Tier 0 last resort: a cached lesson when every model failed ------
      // WHY after the paid ladder: the exact curriculum match was already tried
      // first. This second Tier 0 visit is the §6.6 ladder's 2 -> 3 -> 0 step:
      // once every hosted model has failed, a deterministic lesson still beats
      // a deferral, and a learner is never denied core learning (Doc 16 §6.4).
      if (tierZeroFallback) {
        const lastResort = await tierZeroFallback.serveFallback(policy, req);
        if (lastResort) {
          record(
            0,
            TIER_ZERO_PROVIDER_ID,
            'served',
            'every model tier failed; the deterministic offline tier served a cached lesson',
          );
          return await deliver({
            result: lastResort,
            policy,
            req,
            ctx,
            decision,
            attempts,
            tier: 0,
            servedOffline: true,
            policyVersion,
            now,
            verify: verifyEquivalence,
          });
        }
        record(
          0,
          TIER_ZERO_PROVIDER_ID,
          'no-offline-content',
          'every model tier failed and the offline bundle has no lesson for this task',
        );
      }

      // ---- Tier 4: human support or deferred response ----------------------
      // WHY tier 4 is only consulted after a real provider outage: when no
      // provider was eligible (no budget, data class, safety tier), a human
      // response is not a learning answer, so the request fails with a typed
      // error instead of pretending the learner was served.
      //
      // WHY three outcomes and not one: the trail is the audit evidence for
      // the sponsor, and only a human tier that ACTUALLY TOOK the work may be
      // recorded as a deferral (Doc 16 §6.6; audit finding F3-20). A request
      // nobody took was denied, and the trail has to say exactly that.
      if (!tierFour) {
        record(
          4,
          TIER_FOUR_PROVIDER_ID,
          'failed',
          'no human-support tier is configured; the request could not be served',
        );
      } else if (!paidAttempted) {
        record(
          4,
          TIER_FOUR_PROVIDER_ID,
          'failed',
          'no model tier was attempted; there was nothing for human support to take',
        );
      } else {
        const answer = await tierFour.serve(policy, req, ctx);
        if (answer) {
          record(4, TIER_FOUR_PROVIDER_ID, 'served', 'the request was deferred to human support');
          return await deliver({
            result: answer,
            policy,
            req,
            ctx,
            decision,
            attempts,
            tier: 4,
            servedOffline: false,
            policyVersion,
            now,
            verify: verifyEquivalence,
          });
        }
        // No answer now: did a human take the work? Only then is a deferral
        // true. `accept` is optional, and an absent method means "this tier
        // never defers".
        const accepted = tierFour.accept ? await tierFour.accept(policy, req, ctx) : false;
        if (accepted) {
          record(
            4,
            TIER_FOUR_PROVIDER_ID,
            'deferred',
            'the human-support tier accepted the request; the answer will follow',
          );
        } else {
          record(
            4,
            TIER_FOUR_PROVIDER_ID,
            'failed',
            'the human-support tier could not accept the request',
          );
        }
      }
      // F3-07/F3-15: the audit-grade attempt chain is preserved, but the
      // learner-facing message is neutral — no HTTP status, provider id,
      // credential vocabulary or credit wording.
      throw new LearningUnavailableError(
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

    killSwitch(
      providerId: string,
      reason: string,
      actor?: string,
      classification?: KillClassification,
    ): void {
      killSwitch.killSwitch(providerId, reason, actor, classification);
    },

    circuitState(providerId: string): 'closed' | 'open' | 'half_open' {
      return breaker.state(providerId);
    },

    resetCircuit(providerId: string): void {
      breaker.reset(providerId);
    },

    attemptsFor(requestId: string): GatewayAttempt[] {
      return [...(attemptsByRequest.get(requestId)?.attempts ?? [])];
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
  verify: EquivalenceVerifier;
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
  const {
    result,
    policy,
    req,
    ctx,
    decision,
    attempts,
    tier,
    servedOffline,
    policyVersion,
    now: clock,
    verify,
  } = input;
  let text = result.text;
  // F3-18: the emission is a compliance artifact, not a local temporary. Hoist
  // it so the DELIVERED emission (post-guardian) can be attached to the result.
  let emission: AccessibilityEmission | undefined;

  if (ctx.learnerFacing) {
    const built = buildEmission(result, policy, req, clock, verify);
    emission = built;
    const verdict = await ctx.guardian.intercept(built, {
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

  return { ...result, text, meta, ...(emission ? { emission } : {}) };
}

/**
 * Build the nine-element emission for a provider result (Doc 2 §2.3).
 *
 * The gateway is the boundary between a raw provider completion and a
 * learner-facing emission, so this is where the contract shape is created.
 *
 * THREE THINGS ARE COMPUTED, NEVER HARDCODED:
 *   - `metadata.content_hash` is the ARC-I9 digest of the canonical content,
 *     produced by the same function the invariant recomputes.
 *   - `equivalence_verified` is the verdict of the injected verifier. The
 *     gateway does not assert its own accessibility claim.
 *   - `uncertainty_note` is present whenever the provider reports confidence
 *     below the routing threshold (ARC-I4).
 */
function buildEmission(
  result: CompletionResult,
  policy: TaskPolicy,
  req: CompletionRequest,
  now: () => number,
  verify: EquivalenceVerifier,
): AccessibilityEmission {
  // The content id needs a stable seed, but it must not be part of a circular
  // hash. Hash a placeholder id first, then hash the final canonical content.
  const seed = hashCanonicalContent({ contentId: '', body: result.text, modality: 'text' });
  const canonical: CanonicalContent = {
    contentId: `${result.providerId}:${result.modelId}:${seed.slice('sha256:'.length, 'sha256:'.length + 16)}`,
    body: result.text,
    modality: 'text',
  };
  const contentHash = hashCanonicalContent(canonical);
  const confidence = result.confidence;

  const emission: AccessibilityEmission = {
    canonical_content: canonical,
    accessible_alternative: {
      text: result.text,
      covers: ['visual'],
      method: 'auto',
      // ARC-I6: a motor-independent route through the lesson. Text needs no
      // pointer, drag, timed or voice input, and the steps make that explicit
      // rather than merely claimed.
      interactiveAlternative: {
        description:
          'Read the lesson in order using the keyboard alone; no pointer, drag, timed or voice input is required.',
        steps: [
          'Tab to the lesson region and press Enter to open it.',
          'Read each paragraph in order; the text is the complete lesson.',
          'Use the notes or transcript panel to review at your own pace.',
        ],
      },
    },
    metadata: {
      contractVersion: 'nine-element/1.0',
      emittingService: 'onekey-gateway',
      emittingModel: result.modelId,
      emittedAt: new Date(now()).toISOString(),
      content_hash: contentHash,
      taskClass: policy.taskClass,
    },
    source_lineage: result.sourceLineage ?? [],
    // F3-21: derive the AI risk tier from the request's safety tier (Doc 6
    // §3.1) rather than hardcoding 1. `low` maps to 1, preserving the previous
    // behaviour for the default request; higher safety tiers map higher.
    risk_tier: SAFETY_TIER_TO_RISK_TIER[req.safetyTier] ?? 1,
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
    // ARC-I1: replaced immediately below with the verifier's verdict.
    equivalence_verified: false,
    confidence_score: confidence,
    uncertainty_note:
      typeof confidence === 'number' && confidence < DEFAULT_CONFIDENCE_THRESHOLD
        ? 'This answer is a best effort from the available material and has not been fully checked. Verify it with your teacher or the cited sources.'
        : null,
  };

  emission.equivalence_verified = verify(emission).ok;
  return emission;
}
