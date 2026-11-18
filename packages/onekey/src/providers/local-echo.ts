import { createHash } from 'node:crypto';
import { BudgetExceededError } from '@edugenesis/contracts';
import type {
  CompletionRequest,
  CompletionResult,
  DataClass,
  ProviderAdapter,
  ProviderCapabilities,
  RequestContext,
  SafetyTier,
} from '@edugenesis/contracts';
import { requiredUnits } from '../budget.js';

/**
 * The local echo provider — a deterministic, offline ProviderAdapter (tier 1).
 *
 * WHY it exists: the whole system has to be provable with NO network and NO
 * API key. This adapter answers deterministically so the gateway, the policy
 * engine and the failover drill can be exercised end to end offline, and so a
 * sponsor can see the ladder working before any key is configured.
 *
 * DETERMINISM: the completion is a pure function of the request. No clock, no
 * randomness, no locale-dependent formatting — the same request yields
 * byte-identical output on every machine, every run.
 */

export interface LocalEchoOptions {
  id?: string;
  modelId?: string;
  tier?: 1 | 2 | 3;
  maxDataClass?: DataClass;
  modalities?: ProviderCapabilities['modalities'];
  clearedSafetyTiers?: SafetyTier[];
  maxContextTokens?: number;
}

const DEFAULT_ID = 'local-echo';
const DEFAULT_MODEL = 'local-echo-v1';

/** Rough token estimate. Deterministic and dependency-free. */
function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/** Clamp text so it fits inside a token ceiling. */
function clampToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return '';
  }
  const maxChars = maxTokens * 4;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

export function createLocalEchoProvider(opts: LocalEchoOptions = {}): ProviderAdapter {
  const id = opts.id ?? DEFAULT_ID;
  const modelId = opts.modelId ?? DEFAULT_MODEL;
  const maxDataClass = opts.maxDataClass ?? 'public';
  const modalities = opts.modalities ?? ['text'];
  const clearedSafetyTiers = opts.clearedSafetyTiers ?? ['low', 'medium'];
  const maxContextTokens = opts.maxContextTokens ?? 8_192;

  return {
    id,
    modelId,
    tier: opts.tier ?? 1,
    maxDataClass,
    capabilities(): ProviderCapabilities {
      return {
        modalities: [...modalities],
        supportsContextCaching: false,
        maxContextTokens,
        maxDataClass,
        clearedSafetyTiers: [...clearedSafetyTiers],
      };
    },
    async complete(req: CompletionRequest, ctx: RequestContext): Promise<CompletionResult> {
      const digest = createHash('sha256').update(req.prompt).digest('hex').slice(0, 16);
      const head = req.prompt.split('\n')[0] ?? '';
      const raw = `[${id}] deterministic offline completion ${digest} :: ${head}`;
      const text = clampToTokens(raw, req.maxOutputTokens);
      // Charge for everything that actually reaches the model: the prompt,
      // the system instruction and every grounded context passage (F3-35).
      // Counting only the prompt under-charges the ledger on the offline tier.
      const inputText =
        req.prompt +
        (req.system ?? '') +
        (req.context ?? []).map((item) => item.text).join('');
      const usage = { inputTokens: estimateTokens(inputText), outputTokens: estimateTokens(text) };

      // The adapter refuses to spend what the pool cannot pay for, so an
      // over-budget request is rejected BEFORE the provider is called.
      const required = requiredUnits(ctx.budget, usage.inputTokens, usage.outputTokens);
      if (ctx.budget.remaining() < required) {
        throw new BudgetExceededError(ctx.budget.poolId, required, ctx.budget.remaining());
      }

      return {
        text,
        providerId: id,
        modelId,
        usage,
        // Deterministic: a fixed 0 keeps the whole result byte-identical.
        latencyMs: 0,
        sourceLineage: [],
      };
    },
    async health() {
      return { ok: true, consecutiveFailures: 0 };
    },
    async dispose() {
      // Holds no credential and no socket: nothing to release.
    },
  };
}
