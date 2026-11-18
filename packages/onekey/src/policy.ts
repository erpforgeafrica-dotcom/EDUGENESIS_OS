import type {
  CompletionRequest,
  DataClass,
  FallbackTier,
  ProviderCapabilities,
  RequestContext,
  RoutingDecision,
  SafetyTier,
  TaskPolicy,
} from '@edugenesis/contracts';
import type { CircuitBreaker } from './circuit-breaker.js';
import type { KillSwitch } from './kill-switch.js';
import type { ModelRegistryEntry, ProviderRegistry } from './registry.js';
import { redactSecret } from './redact.js';

/**
 * The routing policy engine (Doc 2 §7; Doc 16 §6.4).
 *
 * WHY a policy engine and not a provider preference: the sponsor's promise is
 * MODEL SOVEREIGNTY — EduGenesis can select, route, suspend and replace any
 * provider without a learner ever being charged, blocked or interrupted. A
 * decision that could be swayed by a sponsor would void that promise, so the
 * decision is derived only from hard safety rules plus capability fit. There
 * is no sponsor input anywhere in this file.
 */

/** Provider id used for the deterministic offline tier in routing decisions. */
export const TIER_ZERO_PROVIDER_ID = 'tier-zero';
/** Provider id used for the human-support / deferred-response tier. */
export const TIER_FOUR_PROVIDER_ID = 'human-support';
/**
 * Sentinel for an honest "nothing will serve this" decision (F3-19). It is NOT
 * a provider: it exists so a decision without an offline tier never promises a
 * Tier 0 delivery it cannot make.
 */
export const NO_PROVIDER_DECISION_ID = 'no-eligible-provider';

const DATA_CLASS_RANK: Record<DataClass, number> = {
  public: 0,
  learner_scoped: 1,
  sensitive: 2,
  secret: 3,
};

/** Ordering of data classes: a provider may receive a class it is cleared for. */
export function dataClassRank(dataClass: DataClass): number {
  return DATA_CLASS_RANK[dataClass];
}

/** Ordering of safety tiers: a higher tier is a more restricted task. */
const SAFETY_TIER_RANK: Record<SafetyTier, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Ordering of safety tiers, so the stricter of two declarations can be taken. */
export function safetyTierRank(tier: SafetyTier): number {
  return SAFETY_TIER_RANK[tier];
}

/**
 * The classification the routing ACTUALLY uses.
 *
 * WHY THE STRICTER OF THE TWO: the request declares its own data class and
 * safety tier, but a caller is never trusted to UNDER-declare them — a client
 * that claimed `public` would otherwise reach a provider cleared for more than
 * the server-side policy allows. The effective classification is therefore the
 * STRICTER of the request's claim and the policy's: a request may only ever
 * make the routing stricter, never looser. Before this, `policy.dataClass` and
 * `policy.safetyTier` were dead inputs — the routing read only the request's
 * own claim.
 */
export function effectiveClassification(
  policy: TaskPolicy,
  req: CompletionRequest,
): { dataClass: DataClass; safetyTier: SafetyTier } {
  return {
    dataClass:
      dataClassRank(req.dataClass) > dataClassRank(policy.dataClass) ? req.dataClass : policy.dataClass,
    safetyTier:
      safetyTierRank(req.safetyTier) > safetyTierRank(policy.safetyTier) ? req.safetyTier : policy.safetyTier,
  };
}

/**
 * Whether a provider covers a requested locale.
 *
 * A provider declaring `['*']` makes no locale claim and therefore covers
 * every locale; a provider declaring `['en']` covers `en` and `en-KE`.
 */
export function localeCovered(locales: string[], locale: string | undefined): boolean {
  if (locale === undefined || locale === '') {
    return true;
  }
  const wanted = locale.toLowerCase();
  const primary = (wanted.split('-')[0] ?? wanted).toLowerCase();
  return locales.some((candidate) => {
    const value = candidate.toLowerCase();
    return value === '*' || value === wanted || value === primary;
  });
}

/** Why a candidate was not considered. */
export interface PolicyRejection {
  providerId: string;
  tier: FallbackTier;
  /** Which hard rule rejected the provider. */
  rule: 'status' | 'data-class' | 'safety-tier' | 'locale' | 'circuit' | 'killed' | 'budget';
  detail: string;
}

/** The full audit trail behind a routing decision. */
export interface PolicyTrace {
  decision: RoutingDecision;
  /** Eligible providers, in the order they would be used. */
  eligible: ModelRegistryEntry[];
  /** Candidates that were considered and rejected, with the rule that rejected them. */
  rejections: PolicyRejection[];
}

export interface PolicyEngineOptions {
  registry: ProviderRegistry;
  breaker: CircuitBreaker;
  killSwitch: KillSwitch;
  /**
   * Whether the deployment has an offline Tier 0 the gateway can actually
   * serve (F3-19). Defaults to false: without this declaration the decision
   * must NOT promise an offline delivery. The gateway that owns Tier 0 opts in.
   */
  offlineAvailable?: boolean;
  /** Recorded on the decision and on the result, for audit. */
  policyVersion?: string;
}

export interface PolicyEngine {
  route(policy: TaskPolicy, req: CompletionRequest, ctx: RequestContext): Promise<RoutingDecision>;
  /** The decision plus the rejection trail behind it. */
  trace(policy: TaskPolicy, req: CompletionRequest, ctx: RequestContext): Promise<PolicyTrace>;
}

export function createPolicyEngine(opts: PolicyEngineOptions): PolicyEngine {
  const { registry, breaker, killSwitch } = opts;
  const policyVersion = opts.policyVersion ?? 'policy-v1';
  const offlineAvailable = opts.offlineAvailable ?? false;

  /**
   * The stricter of the adapter's CURRENT capability ceiling and its own
   * declaration. Capabilities are re-read from the adapter at decision time,
   * never taken from the registration snapshot (F3-32).
   */
  const effectiveMaxDataClass = (entry: ModelRegistryEntry, live: ProviderCapabilities): DataClass => {
    const declared = dataClassRank(live.maxDataClass);
    const adapterDeclared = dataClassRank(entry.adapter.maxDataClass);
    return declared <= adapterDeclared ? live.maxDataClass : entry.adapter.maxDataClass;
  };

  const trace = async (
    policy: TaskPolicy,
    req: CompletionRequest,
    ctx: RequestContext,
  ): Promise<PolicyTrace> => {
    const rejections: PolicyRejection[] = [];
    const eligible: ModelRegistryEntry[] = [];
    const budget = ctx.budget;
    const budgetExhausted = budget.remaining() <= 0;
    const locale = req.locale ?? policy.locale;
    const preferredModality = policy.preferredModality;

    // ---- The authority for classification is the POLICY, not the request ---
    const effective = effectiveClassification(policy, req);
    const effectiveDataClass = effective.dataClass;
    const effectiveSafetyTier = effective.safetyTier;

    for (const entry of registry.entries()) {
      const providerId = entry.providerId;
      const tier = entry.tier;
      // F3-32: re-read capabilities NOW. The snapshot on the registry entry is
      // for inspection; a clearance revoked mid-flight must take effect here.
      const live = entry.adapter.capabilities();

      // Rule 0 — a provider disabled in the registry is not a candidate.
      if (entry.status !== 'active') {
        rejections.push({
          providerId,
          tier,
          rule: 'status',
          detail: 'provider is disabled in the registry',
        });
        continue;
      }

      // Rule 1 — data class. Restricted data must never reach an unapproved
      // provider (Doc 2 §27). This is checked first because it is the
      // strongest constraint: no other consideration may override it.
      const providerMax = effectiveMaxDataClass(entry, live);
      if (dataClassRank(providerMax) < dataClassRank(effectiveDataClass)) {
        rejections.push({
          providerId,
          tier,
          rule: 'data-class',
          detail: `request data class '${effectiveDataClass}' exceeds provider max '${providerMax}'`,
        });
        continue;
      }

      // Rule 2 — safety tier clearance (Doc 6 §3.1), from LIVE capabilities.
      if (!live.clearedSafetyTiers.includes(effectiveSafetyTier)) {
        rejections.push({
          providerId,
          tier,
          rule: 'safety-tier',
          detail: `provider is not cleared for safety tier '${effectiveSafetyTier}'`,
        });
        continue;
      }

      // Rule 2.5 — locale is an eligibility rule WHERE DECLARED (F3-31).
      // A `*` locale declares no limit and always passes; a provider that
      // declares a language it does not serve is ineligible, not merely ranked
      // lower. Tier 0 declares no locale limit and is not hard-filtered here.
      if (!localeCovered(entry.locales, locale)) {
        rejections.push({
          providerId,
          tier,
          rule: 'locale',
          detail: `provider locales '${entry.locales.join(', ')}' do not cover requested locale '${locale ?? ''}'`,
        });
        continue;
      }

      // Rule 3 — an open circuit is never used for routing.
      const circuitState = breaker.state(providerId);
      if (circuitState === 'open') {
        rejections.push({
          providerId,
          tier,
          rule: 'circuit',
          detail: 'circuit is open (the provider tripped)',
        });
        continue;
      }

      // Rule 4 — a killed provider is excluded immediately (Doc 6 §5).
      if (killSwitch.isKilled(providerId)) {
        rejections.push({
          providerId,
          tier,
          rule: 'killed',
          detail: `provider was killed: ${redactSecret(killSwitch.reasonFor(providerId) ?? 'no reason recorded')}`,
        });
        continue;
      }

      // Rule 5 — no remaining budget means the paid tiers are not eligible.
      if (budgetExhausted) {
        rejections.push({
          providerId,
          tier,
          rule: 'budget',
          detail: `budget pool '${budget.poolId}' has no remaining units`,
        });
        continue;
      }

      eligible.push(entry);
    }

    // Selection: lowest tier first, then modality fit, then locale fit.
    // Registration order breaks any remaining tie, so the decision is stable.
    const ranked = eligible
      .map((entry, index) => ({
        entry,
        index,
        live: entry.adapter.capabilities(),
        modalityMatch: preferredModality
          ? entry.adapter.capabilities().modalities.includes(preferredModality)
          : false,
        localeMatch: localeCovered(entry.locales, locale),
      }))
      .sort(
        (a, b) =>
          a.entry.tier - b.entry.tier ||
          (a.modalityMatch === b.modalityMatch ? 0 : a.modalityMatch ? -1 : 1) ||
          (a.localeMatch === b.localeMatch ? 0 : a.localeMatch ? -1 : 1) ||
          a.index - b.index,
      );

    const selected = ranked[0];
    const fallbackChain: Array<{ providerId: string; tier: FallbackTier }> = [
      { providerId: TIER_ZERO_PROVIDER_ID, tier: 0 },
      ...ranked.map((candidate) => ({ providerId: candidate.entry.providerId, tier: candidate.entry.tier })),
      { providerId: TIER_FOUR_PROVIDER_ID, tier: 4 },
    ];

    const reason = buildReason({
      policyVersion,
      selected,
      eligibleCount: ranked.length,
      rejections,
      preferredModality,
      locale,
      req,
      effectiveDataClass: effectiveClassification(policy, req).dataClass,
      effectiveSafetyTier: effectiveClassification(policy, req).safetyTier,
      budgetRemaining: budget.remaining(),
      budgetCap: budget.hardCapUnits,
      circuitState: selected ? breaker.state(selected.entry.providerId) : 'closed',
      providerMax: selected ? effectiveMaxDataClass(selected.entry, selected.live) : undefined,
      offlineAvailable,
    });

    // F3-19: only promise a Tier 0 delivery when the deployment actually has
    // an offline tier. Otherwise report an honest "nothing will serve this"
    // decision — the fallbackChain still shows the ladder, but the primary
    // selection never claims a service the gateway cannot make.
    const decision: RoutingDecision = selected
      ? {
          providerId: selected.entry.providerId,
          modelId: selected.entry.modelId,
          tier: selected.entry.tier,
          reason,
          fallbackChain,
          budgetPoolId: budget.poolId,
          servedOffline: false,
        }
      : offlineAvailable
        ? {
            providerId: TIER_ZERO_PROVIDER_ID,
            modelId: 'offline-curriculum',
            tier: 0,
            reason,
            fallbackChain,
            budgetPoolId: budget.poolId,
            servedOffline: true,
          }
        : {
            providerId: NO_PROVIDER_DECISION_ID,
            modelId: 'none',
            tier: 4,
            reason,
            fallbackChain,
            budgetPoolId: budget.poolId,
            servedOffline: false,
          };

    return { decision, eligible: ranked.map((candidate) => candidate.entry), rejections };
  };

  return {
    async route(policy, req, ctx) {
      return (await trace(policy, req, ctx)).decision;
    },
    trace,
  };
}

interface ReasonInput {
  policyVersion: string;
  selected: { entry: ModelRegistryEntry; modalityMatch: boolean; localeMatch: boolean } | undefined;
  eligibleCount: number;
  rejections: PolicyRejection[];
  preferredModality: TaskPolicy['preferredModality'];
  locale: string | undefined;
  req: CompletionRequest;
  /** The classification the routing actually used: the stricter of the request's own claim and the server-side policy's. */
  effectiveDataClass: DataClass;
  effectiveSafetyTier: SafetyTier;
  budgetRemaining: number;
  budgetCap: number;
  circuitState: string;
  providerMax: DataClass | undefined;
  /** Whether the deployment has an offline Tier 0 (F3-19). */
  offlineAvailable: boolean;
}

/** Build the human-readable policy trace attached to a routing decision. */
function buildReason(input: ReasonInput): string {
  const parts: string[] = [`policy ${input.policyVersion}`];

  if (input.selected) {
    const { entry } = input.selected;
    parts.push(
      `selected provider '${entry.providerId}' (model '${entry.modelId}', tier ${entry.tier}) as the lowest eligible tier among ${input.eligibleCount} eligible provider(s)`,
    );
    if (input.preferredModality) {
      parts.push(
        `capabilities ${input.selected.modalityMatch ? 'cover' : 'do not cover'} the preferred modality '${input.preferredModality}'`,
      );
    }
    if (input.locale) {
      parts.push(
        `capabilities ${input.selected.localeMatch ? 'include' : 'do not include'} the requested locale '${input.locale}'`,
      );
    }
    parts.push(
      `hard rules passed: data class '${input.effectiveDataClass}' within provider max '${input.providerMax ?? 'unknown'}', safety tier '${input.effectiveSafetyTier}' cleared, circuit ${input.circuitState}, not killed, budget remaining ${input.budgetRemaining}/${input.budgetCap} units`,
    );
  } else if (input.offlineAvailable) {
    parts.push(
      'no provider was eligible for this request; the deterministic offline tier 0 is selected so the learner is never blocked',
    );
  } else {
    parts.push(
      'no provider was eligible for this request and no offline tier is available; this decision does not promise a delivery',
    );
  }

  if (input.rejections.length > 0) {
    parts.push(
      `considered and rejected: ${input.rejections
        .map((rejection) => `'${rejection.providerId}' (${rejection.rule}: ${rejection.detail})`)
        .join('; ')}`,
    );
  }

  // Stated explicitly, because it is the promise made to the anchor sponsor.
  parts.push('no sponsor preference was applied: sponsor preference is never a routing input');
  return parts.join('; ');
}
