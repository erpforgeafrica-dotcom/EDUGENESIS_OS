/**
 * A Tier 2 fallback adapter (Doc 09 §12.7: at least one Tier 1 and one Tier 2
 * adapter). This one is deterministic and offline so the secondary rung of the
 * ladder is provable with no network and no key, like the Tier 1 local echo.
 *
 * WHY it lives under registry/: concrete vendor adapters stay in providers/
 * (a change of provider is a registry change); this is a secondary fallback
 * used to prove the ladder, not a vendor integration.
 * It implements the frozen ProviderAdapter contract unchanged.
 */
import { BudgetExceededError } from '@edugenesis/contracts';
import type {
  CompletionRequest,
  CompletionResult,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderHealth,
  RequestContext,
} from '@edugenesis/contracts';

export interface TierTwoAdapterOptions {
  id?: string;
  modelId?: string;
}

export const DEFAULT_TIER_TWO_ID = 'tier-two-local';

export function createTierTwoAdapter(opts: TierTwoAdapterOptions = {}): ProviderAdapter {
  const id = opts.id ?? DEFAULT_TIER_TWO_ID;
  const modelId = opts.modelId ?? `${id}-v1`;
  const maxDataClass = 'learner_scoped' as const;
  const clearedSafetyTiers = ['low', 'medium', 'high'] as const;

  return {
    id,
    modelId,
    tier: 2,
    maxDataClass,
    capabilities(): ProviderCapabilities {
      return {
        modalities: ['text'],
        supportsContextCaching: false,
        maxContextTokens: 16_000,
        maxDataClass,
        clearedSafetyTiers: [...clearedSafetyTiers],
      };
    },
    async complete(req: CompletionRequest, ctx: RequestContext): Promise<CompletionResult> {
      if (ctx.budget.remaining() <= 0) {
        throw new BudgetExceededError(ctx.budget.poolId, 1, ctx.budget.remaining());
      }
      // Deterministic answer; clamp to the declared output ceiling so the
      // conformance ceiling rule observes a real clamp, never a vacuous throw.
      const ceiling = Math.min(Math.max(1, req.maxOutputTokens), 16);
      const text = `Tier 2 fallback answer for: ${req.prompt}`.slice(0, ceiling * 4);
      return {
        text,
        providerId: id,
        modelId,
        usage: { inputTokens: 8, outputTokens: ceiling },
        latencyMs: 1,
        sourceLineage: [],
      };
    },
    async health(): Promise<ProviderHealth> {
      return { ok: true, consecutiveFailures: 0 };
    },
    async dispose(): Promise<void> {
      /* holds no resources */
    },
  };
}
