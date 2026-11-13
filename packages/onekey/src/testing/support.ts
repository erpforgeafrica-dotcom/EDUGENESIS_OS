/**
 * Shared test doubles for the OneKey package.
 *
 * WHY this lives in the package (not in a test file): the conformance suite
 * (src/conformance.ts) needs a RequestContext and a guardian to probe an
 * adapter with, and it must be able to do that WITHOUT a network and WITHOUT a
 * provider (Doc 16 §6.4 — the whole system has to be provable offline).
 * Test-only doubles live here so that no learner-path module has to import
 * them. Nothing in this file is re-exported from src/index.ts.
 */

import { fileURLToPath } from 'node:url';
import type {
  AccessibilityEmission,
  AccessibilityGuardian,
  ArcViolation,
  BudgetLedger,
  CompletionRequest,
  CompletionResult,
  DataClass,
  ProviderAdapter,
  ProviderCapabilities,
  RequestContext,
  SafetyTier,
  SourceLineage,
  TaskPolicy,
} from '@edugenesis/contracts';
import { createBudgetLedger } from '../budget.js';

/**
 * Absolute path of the package's `src/` directory, derived from this module.
 *
 * WHY relative-to-module: GLOBAL.md §9 (portability law) forbids hardcoded
 * absolute paths. `fileURLToPath` is used because `URL.pathname` is
 * percent-encoded and would break on paths containing spaces.
 */
export function srcDir(): string {
  return fileURLToPath(new URL('../../src/', import.meta.url));
}

export interface GuardianOptions {
  /** Whether the guardian lets the emission through. */
  deliver?: boolean;
  /** Violations reported when the emission is blocked. */
  violations?: ArcViolation[];
  /** Rewrites the emission, proving the gateway returns the POST-guardian text. */
  transform?: (emission: AccessibilityEmission) => AccessibilityEmission;
}

/** A guardian that delivers everything (the "no violations" baseline). */
export function createGuardian(opts: GuardianOptions = {}): AccessibilityGuardian {
  const deliver = opts.deliver ?? true;
  const violations = opts.violations ?? [];
  return {
    async intercept(emission: AccessibilityEmission) {
      const out = opts.transform ? opts.transform(emission) : emission;
      if (!deliver) {
        return { deliver: false, violations };
      }
      return { deliver: true, emission: out, violations };
    },
  };
}

/** A guardian that blocks everything — used to prove blocked emissions never ship. */
export function createBlockingGuardian(reason = 'ARC-I1 equivalence not verified'): AccessibilityGuardian {
  return createGuardian({
    deliver: false,
    violations: [
      {
        id: 'ARC-I1',
        severity: 'Blocker',
        message: reason,
        path: 'canonical_content.body',
      },
    ],
  });
}

export function createContext(overrides: Partial<RequestContext> = {}): RequestContext {
  const budget = overrides.budget ?? createBudgetLedger('pool-test', 10_000, 'token');
  return {
    requestId: 'req-test',
    deadlineAt: Date.now() + 30_000,
    budget,
    guardian: createGuardian(),
    learnerFacing: false,
    ...overrides,
  };
}

export function createRequest(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    prompt: 'Explain curriculum:algebra/linear-eq',
    dataClass: 'public',
    safetyTier: 'low',
    maxOutputTokens: 256,
    requiresAccessibilityContract: true,
    ...overrides,
  };
}

export function createPolicy(overrides: Partial<TaskPolicy> = {}): TaskPolicy {
  return {
    taskClass: 'explain',
    safetyTier: 'low',
    dataClass: 'public',
    ...overrides,
  };
}

export function createSource(overrides: Partial<SourceLineage> = {}): SourceLineage {
  return {
    sourceId: 'src-1',
    locator: 'curriculum:algebra/linear-eq',
    licence: 'CC-BY-4.0',
    retrievedAt: '2026-01-01T00:00:00.000Z',
    tier: 1,
    ...overrides,
  };
}

export interface MockAdapterOptions {
  id: string;
  modelId?: string;
  tier?: 1 | 2 | 3;
  maxDataClass?: DataClass;
  modalities?: ProviderCapabilities['modalities'];
  clearedSafetyTiers?: SafetyTier[];
  maxContextTokens?: number;
  text?: string;
  /** The provenance the provider reports for its answer. */
  sourceLineage?: SourceLineage[];
  /** When set, complete() rejects with this error. */
  failWith?: Error;
  /** When set, complete() rejects with a BudgetExceededError-shaped refusal. */
  refuseOverBudget?: boolean;
}

export interface MockAdapterHandle {
  adapter: ProviderAdapter;
  /** Number of times complete() was entered. */
  calls: () => number;
}

/**
 * A hand-written adapter double. It is intentionally NOT built on the
 * production local-echo adapter, so that a bug in local-echo cannot make the
 * policy and gateway tests pass by accident.
 */
export function createMockAdapter(opts: MockAdapterOptions): MockAdapterHandle {
  let calls = 0;
  const modelId = opts.modelId ?? `${opts.id}-model`;
  const maxDataClass = opts.maxDataClass ?? 'public';
  const adapter: ProviderAdapter = {
    id: opts.id,
    modelId,
    tier: opts.tier ?? 1,
    maxDataClass,
    capabilities(): ProviderCapabilities {
      return {
        modalities: opts.modalities ?? ['text'],
        supportsContextCaching: false,
        maxContextTokens: opts.maxContextTokens ?? 8_000,
        maxDataClass,
        clearedSafetyTiers: opts.clearedSafetyTiers ?? ['low', 'medium'],
      };
    },
    async complete(req: CompletionRequest, ctx: RequestContext): Promise<CompletionResult> {
      calls += 1;
      if (opts.refuseOverBudget && ctx.budget.remaining() <= 0) {
        const { BudgetExceededError } = await import('@edugenesis/contracts');
        throw new BudgetExceededError(ctx.budget.poolId, req.maxOutputTokens, ctx.budget.remaining());
      }
      if (opts.failWith) {
        throw opts.failWith;
      }
      return {
        text: opts.text ?? `mock completion from ${opts.id}`,
        providerId: opts.id,
        modelId,
        usage: { inputTokens: 12, outputTokens: 24 },
        latencyMs: 7,
        sourceLineage: opts.sourceLineage ?? [],
      };
    },
    async health() {
      return { ok: true, consecutiveFailures: 0 };
    },
    async dispose() {
      /* nothing held */
    },
  };
  return { adapter, calls: () => calls };
}
