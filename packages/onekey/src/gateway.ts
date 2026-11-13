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
import { hasTierZeroFallback } from './tier-zero-fallback.js';
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
            verify: verifyEquivalence,
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

  if (ctx.learnerFacing) {
    const emission = buildEmission(result, policy, req, clock, verify);
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
