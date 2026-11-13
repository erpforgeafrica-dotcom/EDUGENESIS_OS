/**
 * The Tier 0 last-resort seam (Doc 16 §6.4; the §6.6 ladder 2 -> 3 -> 0 -> 4).
 *
 * WHY this is not in `providers/`: the gateway is a learner-path module and the
 * registry guard forbids a learner-path module from importing a concrete
 * provider implementation. The interface and its type guard live here, so the
 * gateway can narrow a `TierZeroProvider` without reaching into the provider
 * directory, and the provider can implement the same seam without a cycle.
 *
 * WHY the method is not on the frozen contract: `TierZeroProvider` in
 * `@edugenesis/contracts` is frozen (ADR-0013..0016). The contract describes
 * the exact-match floor; this interface adds the last-resort behaviour without
 * editing the frozen surface.
 */
import type {
  CompletionRequest,
  CompletionResult,
  TaskPolicy,
  TierZeroProvider,
} from '@edugenesis/contracts';

export interface TierZeroFallbackProvider extends TierZeroProvider {
  /**
   * Serve the closest cached lesson when the exact curriculum reference is
   * absent and every hosted model has failed. Returns null when no cached
   * lesson covers the task class and locale, which is the signal to defer.
   */
  serveFallback(policy: TaskPolicy, req: CompletionRequest): Promise<CompletionResult | null>;
}

/** True when a Tier 0 provider can also serve a last-resort cached lesson. */
export function hasTierZeroFallback(
  provider: TierZeroProvider | undefined,
): provider is TierZeroFallbackProvider {
  return (
    provider !== undefined &&
    typeof (provider as Partial<TierZeroFallbackProvider>).serveFallback === 'function'
  );
}
