import { BudgetExceededError } from '@edugenesis/contracts';
import type {
  CompletionRequest,
  CompletionResult,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderHealth,
  RequestContext,
} from '@edugenesis/contracts';
import { createBudgetLedger } from './budget.js';

/**
 * The provider adapter conformance suite (Doc 2 §7; ADR-0001).
 *
 * WHY a suite and not a checklist: the whole point of model sovereignty is
 * that ANY provider can be dropped into the registry and be trusted. That
 * trust has to be mechanical, so every adapter — hosted or local — is run
 * through the same assertions before it is allowed near a learner.
 *
 * The suite runs entirely offline: it needs no key, no network and no real
 * provider, so it can be executed against a mock adapter in CI.
 */

export interface ConformanceRule {
  id: string;
  description: string;
}

export interface ConformanceResult {
  ruleId: string;
  description: string;
  passed: boolean;
  detail: string;
}

/** The rules every provider adapter must satisfy. */
export const CONFORMANCE_RULES: readonly ConformanceRule[] = [
  { id: 'capabilities-coherent', description: 'capabilities() describes a usable provider' },
  { id: 'max-data-class-declared', description: 'maxDataClass is declared and agrees with the capabilities snapshot' },
  { id: 'complete-returns-text-and-usage', description: 'complete() returns non-empty text and usage' },
  { id: 'health-returns-shape', description: 'health() returns { ok, consecutiveFailures }' },
  { id: 'dispose-callable', description: 'dispose() is callable and resolves' },
  { id: 'over-budget-refused', description: 'an over-budget request is refused with BudgetExceededError' },
  { id: 'max-output-tokens-respected', description: 'a request above maxOutputTokens is refused or clamped' },
];

const VALID_MODALITIES = ['text', 'vision', 'audio', 'embedding'];
const VALID_SAFETY_TIERS = ['low', 'medium', 'high', 'critical'];
const VALID_DATA_CLASSES = ['public', 'learner_scoped', 'sensitive', 'secret'];

export interface ConformanceOptions {
  /** Context for the behavioural probes. Defaults to an offline probe context. */
  ctx?: RequestContext;
  /** Request for the behavioural probes. */
  request?: CompletionRequest;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The probe context.
 *
 * WHY a permissive guardian lives in production code: the suite measures the
 * ADAPTER, not the accessibility contract. The guardian here never gates
 * anything and is never reachable from the learner path — the gateway always
 * supplies the real one.
 */
function probeContext(budget: RequestContext['budget']): RequestContext {
  return {
    requestId: 'conformance-probe',
    deadlineAt: Date.now() + 30_000,
    budget,
    guardian: {
      async intercept(emission) {
        return { deliver: true, emission, violations: [] };
      },
    },
    learnerFacing: false,
  };
}

function probeRequest(): CompletionRequest {
  return {
    prompt: 'conformance probe',
    dataClass: 'public',
    safetyTier: 'low',
    maxOutputTokens: 64,
    requiresAccessibilityContract: false,
  };
}

/** Run an adapter through every conformance rule. */
export async function runAdapterConformance(
  adapter: ProviderAdapter,
  opts: ConformanceOptions = {},
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  const record = (ruleId: string, passed: boolean, detail: string): void => {
    const rule = CONFORMANCE_RULES.find((candidate) => candidate.id === ruleId);
    results.push({
      ruleId,
      description: rule?.description ?? ruleId,
      passed,
      detail,
    });
  };

  const request = opts.request ?? probeRequest();
  const funded = createBudgetLedger('conformance-pool', 100_000, 'token');
  const ctx = opts.ctx ?? probeContext(funded);

  // ---- Rule 1 & 2: the capability declaration ----------------------------
  let capabilities: ProviderCapabilities | undefined;
  let capabilitiesError: string | undefined;
  try {
    capabilities = adapter.capabilities();
  } catch (err) {
    capabilitiesError = describeError(err);
  }

  if (!capabilities) {
    record('capabilities-coherent', false, `capabilities() threw: ${capabilitiesError ?? 'unknown error'}`);
    record('max-data-class-declared', false, 'capabilities() threw, so no data class could be read');
  } else {
    const problems: string[] = [];
    if (!Array.isArray(capabilities.modalities) || capabilities.modalities.length === 0) {
      problems.push('modalities is empty');
    } else if (!capabilities.modalities.every((modality) => VALID_MODALITIES.includes(modality))) {
      problems.push(`modalities contains an unknown modality: ${capabilities.modalities.join(', ')}`);
    }
    if (typeof capabilities.maxContextTokens !== 'number' || capabilities.maxContextTokens <= 0) {
      problems.push(`maxContextTokens must be a positive number, got ${String(capabilities.maxContextTokens)}`);
    }
    if (!Array.isArray(capabilities.clearedSafetyTiers) || capabilities.clearedSafetyTiers.length === 0) {
      problems.push('clearedSafetyTiers is empty');
    } else if (!capabilities.clearedSafetyTiers.every((tier) => VALID_SAFETY_TIERS.includes(tier))) {
      problems.push(
        `clearedSafetyTiers contains an unknown safety tier: ${capabilities.clearedSafetyTiers.join(', ')}`,
      );
    }
    if (typeof capabilities.supportsContextCaching !== 'boolean') {
      problems.push('supportsContextCaching must be a boolean');
    }
    record(
      'capabilities-coherent',
      problems.length === 0,
      problems.length === 0 ? 'capabilities are coherent' : problems.join('; '),
    );

    const declared = VALID_DATA_CLASSES.includes(adapter.maxDataClass);
    const snapshot = VALID_DATA_CLASSES.includes(capabilities.maxDataClass);
    const agrees = adapter.maxDataClass === capabilities.maxDataClass;
    record(
      'max-data-class-declared',
      declared && snapshot && agrees,
      declared && snapshot && agrees
        ? `maxDataClass '${adapter.maxDataClass}' is declared and consistent`
        : `adapter maxDataClass '${String(adapter.maxDataClass)}' (valid: ${declared}) vs capabilities maxDataClass '${String(capabilities.maxDataClass)}' (valid: ${snapshot}); they agree: ${agrees}`,
    );
  }

  // ---- Rule 3: complete() returns a usable result ------------------------
  let probeResult: CompletionResult | undefined;
  let completeError: string | undefined;
  try {
    probeResult = await adapter.complete(request, ctx);
  } catch (err) {
    completeError = describeError(err);
  }
  if (!probeResult) {
    record('complete-returns-text-and-usage', false, `complete() threw: ${completeError ?? 'unknown error'}`);
  } else {
    const problems: string[] = [];
    if (typeof probeResult.text !== 'string' || probeResult.text.trim().length === 0) {
      problems.push('text is empty');
    }
    const usage = probeResult.usage;
    if (!usage || typeof usage !== 'object') {
      problems.push('usage is missing');
    } else {
      if (!Number.isFinite(usage.inputTokens) || usage.inputTokens < 0) {
        problems.push(`usage.inputTokens is invalid: ${String(usage.inputTokens)}`);
      }
      if (!Number.isFinite(usage.outputTokens) || usage.outputTokens < 0) {
        problems.push(`usage.outputTokens is invalid: ${String(usage.outputTokens)}`);
      }
      if (Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens) && usage.inputTokens + usage.outputTokens <= 0) {
        problems.push('usage reports no consumed tokens');
      }
    }
    record(
      'complete-returns-text-and-usage',
      problems.length === 0,
      problems.length === 0
        ? `complete() returned ${probeResult.usage.inputTokens} input and ${probeResult.usage.outputTokens} output tokens`
        : problems.join('; '),
    );
  }

  // ---- Rule 4: health() shape --------------------------------------------
  try {
    const health: ProviderHealth = await adapter.health();
    const problems: string[] = [];
    if (typeof health?.ok !== 'boolean') {
      problems.push(`ok must be a boolean, got ${typeof health?.ok}`);
    }
    if (!Number.isFinite(health?.consecutiveFailures)) {
      problems.push(`consecutiveFailures must be a finite number, got ${String(health?.consecutiveFailures)}`);
    }
    record(
      'health-returns-shape',
      problems.length === 0,
      problems.length === 0 ? 'health() returned the expected shape' : problems.join('; '),
    );
  } catch (err) {
    record('health-returns-shape', false, `health() threw: ${describeError(err)}`);
  }

  // ---- Rule 5 is run LAST, after every behavioural rule --------------------
  // WHY: dispose() releases the adapter's credential. Calling it here would
  // destroy the adapter under test, and the LATER rules (over-budget, output
  // ceiling) would then pass or fail on the resulting "no API key" refusal
  // rather than on the adapter's behaviour — rule 7 in particular passed
  // VACUOUSLY, because the adapter always threw. The destructive call is
  // therefore made at the end of the suite, where it can affect nothing.

  // ---- Rule 6: an over-budget request is refused -------------------------
  const emptyBudget = createBudgetLedger('conformance-empty-pool', 1, 'token');
  emptyBudget.consume(1);
  const emptyCtx: RequestContext = { ...ctx, budget: emptyBudget };
  let refused = false;
  let refusalDetail = 'the provider accepted a request the budget cannot pay for';
  try {
    await adapter.complete(request, emptyCtx);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      refused = true;
      refusalDetail = 'the provider refused with BudgetExceededError';
    } else {
      refusalDetail = `the provider refused with an untyped error: ${describeError(err)}`;
    }
  }
  record('over-budget-refused', refused, refusalDetail);

  // ---- Rule 7: the output ceiling is respected ---------------------------
  const ceilingRequest: CompletionRequest = { ...request, maxOutputTokens: 4 };
  try {
    const ceilingResult = await adapter.complete(ceilingRequest, ctx);
    const outputTokens = ceilingResult.usage?.outputTokens;
    const respected = typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens <= 4;
    record(
      'max-output-tokens-respected',
      respected,
      respected
        ? `the response was clamped to ${String(outputTokens)} output tokens`
        : `the response reported ${String(outputTokens)} output tokens for a 4 token ceiling`,
    );
  } catch (err) {
    // Refusing the request is an acceptable outcome (Doc 2 §7).
    record('max-output-tokens-respected', true, `the request was refused: ${describeError(err)}`);
  }

  // ---- Rule 5: dispose() is callable — run LAST --------------------------
  if (typeof adapter.dispose !== 'function') {
    record('dispose-callable', false, 'dispose is not a function');
  } else {
    try {
      await adapter.dispose();
      record('dispose-callable', true, 'dispose() resolved');
    } catch (err) {
      record('dispose-callable', false, `dispose() threw: ${describeError(err)}`);
    }
  }

  return results;
}
