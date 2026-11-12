import { BudgetExceededError, ProviderUnavailableError } from '@edugenesis/contracts';
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
import { redactSecret } from '../redact.js';

/**
 * The Alibaba Cloud Model Studio (Qwen) provider adapter.
 *
 * WIRE FORMAT — VERIFICATION STATUS: implemented against the DOCUMENTED
 * OpenAI-compatible "compatible-mode" shape of Alibaba Cloud Model Studio
 * (`POST {baseUrl}/chat/completions`, bearer auth, `messages`/`max_tokens`
 * request, `choices[].message.content` / `usage.prompt_tokens` response).
 * It could NOT be verified against the live endpoint from this environment:
 * there is no credential available and no network probe was made. The request
 * and response mapping below therefore follows the published OpenAI-compatible
 * contract and asserts nothing that a proprietary Qwen-only protocol would
 * require. If Model Studio deviates for a given model, the fix is confined to
 * this file — the registry, the policy engine and the gateway are unaffected.
 *
 * CREDENTIAL HANDLING: the key is supplied by the caller (normally from
 * EduGenesisSettings.providers.apiKeys), is held only in this closure, is
 * never logged, never written to disk, and is dropped by dispose().
 */

/** The minimum HTTP surface the adapter needs. */
export interface FetchRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: FetchRequestInit) => Promise<FetchResponseLike>;

/** Alibaba Cloud Model Studio, international endpoint, OpenAI-compatible mode. */
export const QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
/**
 * The mainland (Beijing) endpoint is
 * `https://dashscope.aliyuncs.com/compatible-mode/v1`. It is not the default
 * because the international endpoint is the one the sponsor's region maps to;
 * pass `baseUrl` to switch.
 */
export const QWEN_MAINLAND_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

export const QWEN_DEFAULT_MODEL = 'qwen-plus';
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface QwenAdapterOptions {
  /**
   * The API key. Supplied by the caller from settings; never hardcoded here,
   * never logged, never persisted by this package.
   */
  apiKey?: string;
  /** OpenAI-compatible base URL. Defaults to the international endpoint. */
  baseUrl?: string;
  /** Model id, e.g. `qwen-plus`, `qwen-turbo`, `qwen-max`. */
  modelId?: string;
  /** Fallback tier this provider belongs to. */
  tier?: 1 | 2 | 3;
  /** The highest data class this provider may receive. */
  maxDataClass?: DataClass;
  /** Safety tiers this provider is cleared for. */
  clearedSafetyTiers?: SafetyTier[];
  /** Injectable HTTP client, so the adapter can be exercised without a network. */
  fetchImpl?: FetchLike;
  /** Upper bound on the request timeout, in ms. */
  timeoutMs?: number;
}

/** The OpenAI-compatible chat-completions request body. */
interface QwenChatRequestBody {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  max_tokens: number;
  temperature: number;
  stream: false;
}

/** The OpenAI-compatible chat-completions response body. */
interface QwenChatResponseBody {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function isQwenChatResponse(value: unknown): value is QwenChatResponseBody {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { choices?: unknown; usage?: unknown };
  if (candidate.choices !== undefined && !Array.isArray(candidate.choices)) {
    return false;
  }
  return true;
}

/** The default HTTP client, wrapping the platform fetch. */
const platformFetch: FetchLike = async (url, init) => {
  const response = await globalThis.fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: { get: (name: string) => response.headers.get(name) },
    json: async () => await response.json(),
  };
};

export function createQwenAdapter(opts: QwenAdapterOptions = {}): ProviderAdapter {
  const id = 'qwen';
  const modelId = opts.modelId ?? QWEN_DEFAULT_MODEL;
  const baseUrl = (opts.baseUrl ?? QWEN_BASE_URL).replace(/\/+$/, '');
  const maxDataClass = opts.maxDataClass ?? 'learner_scoped';
  const clearedSafetyTiers = opts.clearedSafetyTiers ?? ['low', 'medium'];
  const fetchImpl = opts.fetchImpl ?? platformFetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Held in a mutable binding so dispose() can release it (Doc 2 exit
  // procedure: a provider must be able to drop its credential).
  let apiKey: string | undefined = opts.apiKey;

  const capabilities: ProviderCapabilities = {
    modalities: ['text'],
    supportsContextCaching: false,
    maxContextTokens: 32_768,
    maxDataClass,
    clearedSafetyTiers: [...clearedSafetyTiers],
  };

  return {
    id,
    modelId,
    tier: opts.tier ?? 1,
    maxDataClass,
    capabilities(): ProviderCapabilities {
      return { ...capabilities, clearedSafetyTiers: [...clearedSafetyTiers] };
    },

    async complete(req: CompletionRequest, ctx: RequestContext): Promise<CompletionResult> {
      if (!apiKey) {
        // A typed refusal. The adapter never runs without a credential and
        // never surfaces a raw credential error to the caller.
        throw new ProviderUnavailableError(
          id,
          'no API key is configured for this provider; the adapter refuses to run',
        );
      }

      // ---- Deadline: the call must never outlive the request ---------------
      const remaining = ctx.deadlineAt - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        throw new ProviderUnavailableError(id, 'the request deadline had already passed');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(remaining, timeoutMs));
      const onOuterAbort = (): void => controller.abort();
      if (ctx.signal) {
        if (ctx.signal.aborted) {
          clearTimeout(timer);
          throw new ProviderUnavailableError(id, 'the request was aborted before it started');
        }
        ctx.signal.addEventListener('abort', onOuterAbort, { once: true });
      }

      try {
        // ---- Request mapping (OpenAI-compatible chat completions) -----------
        const messages: QwenChatRequestBody['messages'] = [];
        if (req.system) {
          messages.push({ role: 'system', content: req.system });
        }
        for (const grounded of req.context ?? []) {
          messages.push({
            role: 'user',
            content: `[${grounded.source.locator}] ${grounded.text}`,
          });
        }
        messages.push({ role: 'user', content: req.prompt });

        const body: QwenChatRequestBody = {
          model: modelId,
          messages,
          max_tokens: Math.min(req.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
          temperature: 0.7,
          stream: false,
        };

        const init: FetchRequestInit = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        };

        let response: FetchResponseLike;
        try {
          response = await fetchImpl(`${baseUrl}/chat/completions`, init);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (controller.signal.aborted) {
            throw new ProviderUnavailableError(
              id,
              `the request timed out after ${Math.min(remaining, timeoutMs)}ms`,
            );
          }
          throw new ProviderUnavailableError(id, `the provider could not be reached: ${redactSecret(message)}`);
        }

        // ---- Error mapping --------------------------------------------------
        if (!response.ok) {
          const detail = await readErrorDetail(response);
          if (response.status === 401 || response.status === 403) {
            throw new ProviderUnavailableError(
              id,
              `the provider rejected the credential (HTTP ${response.status}): ${detail}`,
            );
          }
          if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            const hint = retryAfter ? `retry after ${retryAfter}s` : 'no retry-after header was returned';
            throw new ProviderUnavailableError(
              id,
              `the provider is rate limited (HTTP 429): ${detail}; ${hint}`,
            );
          }
          throw new ProviderUnavailableError(id, `the provider returned HTTP ${response.status}: ${detail}`);
        }

        // ---- Response mapping ----------------------------------------------
        const payload: unknown = await response.json();
        if (!isQwenChatResponse(payload)) {
          throw new ProviderUnavailableError(id, 'the provider returned an unreadable response body');
        }
        const content = payload.choices?.[0]?.message?.content ?? '';
        const usage = {
          inputTokens: payload.usage?.prompt_tokens ?? 0,
          outputTokens: payload.usage?.completion_tokens ?? 0,
        };

        // ---- Budget: never spend what the pool cannot pay for --------------
        const required = requiredUnits(ctx.budget, usage.inputTokens, usage.outputTokens);
        if (ctx.budget.remaining() < required) {
          throw new BudgetExceededError(ctx.budget.poolId, required, ctx.budget.remaining());
        }

        return {
          text: content,
          providerId: id,
          modelId: payload.model ?? modelId,
          usage,
          latencyMs: 0,
          sourceLineage: [],
        };
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onOuterAbort);
      }
    },

    async health() {
      if (!apiKey) {
        return { ok: false, consecutiveFailures: 0, detail: 'no API key is configured' };
      }
      // No network probe: health must not spend credit or leak the key.
      return { ok: true, consecutiveFailures: 0 };
    },

    async dispose() {
      // Drop the credential reference (Doc 2 exit procedure).
      apiKey = undefined;
    },
  };
}

/** Read an error detail from a failed response, without leaking the key. */
async function readErrorDetail(response: FetchResponseLike): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload === 'object' && payload !== null) {
      const error = (payload as { error?: unknown }).error;
      if (typeof error === 'object' && error !== null) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string') {
          return redactSecret(message);
        }
      }
    }
  } catch {
    // A body that is not JSON is not a problem; fall through.
  }
  return response.statusText || 'no detail was returned';
}
