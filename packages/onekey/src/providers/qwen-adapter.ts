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
import { EgressRejectedError, projectEgressPayload, projectGroundedContext } from '../egress.js';
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
  /**
   * Hosts the credential may be sent to. Defaults to the two Qwen hosts.
   * A self-hosted or proxied provider must be named here explicitly.
   */
  allowedHosts?: readonly string[];
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

/**
 * Validate the provider base URL before a credential is ever attached to it.
 *
 * WHY: the adapter sends an `Authorization: Bearer <key>` header to whatever
 * host this names. Without a check, a misconfigured or tampered base URL
 * would carry a live credential to a plaintext endpoint, a link-local
 * metadata service, or a local file — and the credential would go with it.
 *
 * THE RULE: HTTPS, except on loopback (a locally hosted mock). No
 * credentials in the URL. AND the host must be on the allowlist: a valid
 * HTTPS certificate proves the server is who it says it is, not that it is
 * the provider the credential belongs to. A cloud metadata endpoint is
 * HTTPS-reachable, so scheme validation alone never bounded this.
 */
export interface BaseUrlPolicy {
  /** Hosts a credential may be sent to. Loopback is always permitted. */
  readonly allowedHosts?: readonly string[];
}

/** The hosts the Qwen credential belongs to. */
const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  'dashscope-intl.aliyuncs.com',
  'dashscope.aliyuncs.com',
];

/**
 * Hosts that are never a model provider, whatever the allowlist says.
 * These answer with instance credentials, so a request to one is a breach,
 * not a misconfiguration.
 */
const METADATA_HOSTS: ReadonlySet<string> = new Set([
  '169.254.169.254',
  '100.100.100.200',
  'metadata.google.internal',
  'metadata',
  'fd00:ec2::254',
]);

export function assertSafeBaseUrl(baseUrl: string, policy: BaseUrlPolicy = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`the provider base URL is not a valid URL: ${baseUrl}`);
  }
  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (protocol !== 'https:' && !(protocol === 'http:' && loopback)) {
    throw new Error(
      `the provider base URL must be https, or http on loopback; "${protocol}" is not permitted`,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('the provider base URL must not carry credentials');
  }
  if (METADATA_HOSTS.has(host)) {
    throw new Error(`the provider base URL names a metadata endpoint: "${host}"`);
  }
  if (!loopback) {
    const allowed = policy.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
    if (!allowed.includes(host)) {
      throw new Error(
        `the provider host "${host}" is not in the allowlist (${allowed.join(', ')})`,
      );
    }
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function createQwenAdapter(opts: QwenAdapterOptions = {}): ProviderAdapter {
  const id = 'qwen';
  const modelId = opts.modelId ?? QWEN_DEFAULT_MODEL;
  const baseUrl = assertSafeBaseUrl(opts.baseUrl ?? QWEN_BASE_URL, {
    ...(opts.allowedHosts ? { allowedHosts: opts.allowedHosts } : {}),
  });
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
        // ---- The egress boundary: decide what may leave the process ---------
        // WHY HERE: this adapter is the only place a request becomes bytes on
        // the wire, so it is the only place the boundary can be enforced. The
        // projection is deny-by-default: a field added to the request contract
        // is refused here until someone allows it and writes a test for it.
        let projected: Record<string, unknown>;
        let grounded: readonly { readonly locator: string; readonly text: string }[];
        try {
          projected = projectEgressPayload({ ...req, context: undefined }, { maxDataClass });
          grounded = projectGroundedContext(req.context ?? []);
        } catch (err) {
          if (err instanceof EgressRejectedError) {
            throw new ProviderUnavailableError(
              id,
              `the egress boundary refused the request: ${err.reason}`,
            );
          }
          throw err;
        }

        // ---- Budget: refuse BEFORE the call, not after the bill -------------
        // WHY: the check that follows the response only proves the pool was
        // empty AFTER the provider had already been paid. The pool must be
        // tested against the WORST case the request can cost, before the
        // request leaves the process. A refusal here is not a denial to the
        // learner: the gateway treats a budget refusal as a fall-through to
        // the next tier, and Tier 0 still answers.
        const cappedMaxOutput = Math.min(req.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
        const promptChars =
          String(projected['prompt'] ?? '').length +
          String(projected['system'] ?? '').length +
          grounded.reduce((sum, item) => sum + item.text.length, 0);
        const estimatedInputTokens = Math.ceil(promptChars / 4);
        const upperBound = requiredUnits(ctx.budget, estimatedInputTokens, cappedMaxOutput);
        if (ctx.budget.remaining() < upperBound) {
          throw new BudgetExceededError(ctx.budget.poolId, upperBound, ctx.budget.remaining());
        }

        // ---- Request mapping (OpenAI-compatible chat completions) -----------
        const messages: QwenChatRequestBody['messages'] = [];
        if (projected['system'] !== undefined) {
          messages.push({ role: 'system', content: String(projected['system']) });
        }
        for (const item of grounded) {
          messages.push({
            role: 'user',
            content: `[${item.locator}] ${item.text}`,
          });
        }
        messages.push({ role: 'user', content: String(projected['prompt']) });

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
