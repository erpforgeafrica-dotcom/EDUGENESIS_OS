/**
 * Per-provider circuit breaker (Doc 2 §7; Doc 16 §6.4).
 *
 * WHY a breaker and not just a retry: a provider that is failing must stop
 * consuming the learner's latency budget and stop burning sponsor credit on
 * requests that cannot succeed. A tripped circuit is INELIGIBLE for routing
 * (see src/policy.ts), so it is never used while open.
 */
export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. Default 3. */
  failureThreshold?: number;
  /** How long the circuit stays open before a probe is allowed. Default 30_000 ms. */
  cooldownMs?: number;
  /** Injectable clock, so the cooldown is deterministic under test. */
  now?: () => number;
}

export interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
  lastDetail?: string;
}

export interface CircuitBreaker {
  /**
   * Current state. Once the cooldown elapsed an open circuit is reported as
   * `half_open`, but READING this never grants probe permission (audit finding
   * F3-28): use `tryAcquireProbe` for that.
   */
  state(providerId: string): CircuitState;
  /** True while the circuit is open — such a provider is never routed to. */
  isTripped(providerId: string): boolean;
  /**
   * Claim the single in-flight half-open probe. Returns true for the one
   * caller allowed to probe (and for normal, closed routing); false while the
   * circuit is cooling down or another probe is already in flight. The latch
   * is released by `recordSuccess`, `recordFailure` or `releaseProbe`.
   */
  tryAcquireProbe(providerId: string): boolean;
  /** Release an in-flight probe without recording an outcome (idempotent). */
  releaseProbe(providerId: string): void;
  recordFailure(providerId: string, detail?: string): void;
  recordSuccess(providerId: string): void;
  reset(providerId: string): void;
  snapshot(): Record<string, CircuitSnapshot>;
}

interface CircuitEntry {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
  lastDetail?: string;
  /** True while the single half-open probe is in flight. */
  probeInFlight: boolean;
}

export function createCircuitBreaker(opts: CircuitBreakerOptions = {}): CircuitBreaker {
  const failureThreshold = opts.failureThreshold ?? 3;
  const cooldownMs = opts.cooldownMs ?? 30_000;
  const now = opts.now ?? ((): number => Date.now());

  if (failureThreshold < 1) {
    throw new Error('Circuit breaker failureThreshold must be at least 1.');
  }
  if (cooldownMs < 0) {
    throw new Error('Circuit breaker cooldownMs must not be negative.');
  }

  const entries = new Map<string, CircuitEntry>();

  const entryFor = (providerId: string): CircuitEntry => {
    const existing = entries.get(providerId);
    if (existing) {
      return existing;
    }
    const created: CircuitEntry = { state: 'closed', consecutiveFailures: 0, openedAt: 0, probeInFlight: false };
    entries.set(providerId, created);
    return created;
  };

  const breaker: CircuitBreaker = {
    state(providerId: string): CircuitState {
      const entry = entries.get(providerId);
      if (!entry) {
        return 'closed';
      }
      // F3-28: a READ is pure. The cooldown making a circuit probe-eligible is
      // reported as `half_open`, but promoting the stored entry (and admitting
      // a probe) happens only through tryAcquireProbe, never through a read.
      if (entry.state === 'open' && now() - entry.openedAt >= cooldownMs) {
        return 'half_open';
      }
      return entry.state;
    },
    isTripped(providerId: string): boolean {
      return breaker.state(providerId) === 'open';
    },
    tryAcquireProbe(providerId: string): boolean {
      const entry = entries.get(providerId);
      if (!entry) {
        // No circuit state exists: normal routing, not a probe.
        return true;
      }
      if (entry.state === 'closed') {
        return true;
      }
      if (entry.state === 'open') {
        if (now() - entry.openedAt < cooldownMs) {
          return false;
        }
        // Cooldown elapsed: this caller promotes the circuit to half-open and
        // claims the single probe slot.
        entry.state = 'half_open';
      }
      // Half-open (either already, or just promoted): exactly one probe.
      if (entry.probeInFlight) {
        return false;
      }
      entry.probeInFlight = true;
      return true;
    },
    releaseProbe(providerId: string): void {
      const entry = entries.get(providerId);
      if (entry) {
        entry.probeInFlight = false;
      }
    },
    recordFailure(providerId: string, detail?: string): void {
      const entry = entryFor(providerId);
      entry.probeInFlight = false;
      entry.consecutiveFailures += 1;
      if (detail !== undefined) {
        entry.lastDetail = detail;
      }
      if (entry.state === 'half_open') {
        // The probe failed: the circuit trips again and the cooldown restarts.
        entry.state = 'open';
        entry.openedAt = now();
        return;
      }
      if (entry.consecutiveFailures >= failureThreshold) {
        entry.state = 'open';
        entry.openedAt = now();
      }
    },
    recordSuccess(providerId: string): void {
      const entry = entryFor(providerId);
      entry.probeInFlight = false;
      entry.state = 'closed';
      entry.consecutiveFailures = 0;
      entry.openedAt = 0;
    },
    reset(providerId: string): void {
      entries.delete(providerId);
    },
    snapshot(): Record<string, CircuitSnapshot> {
      const out: Record<string, CircuitSnapshot> = {};
      for (const [providerId, entry] of entries) {
        out[providerId] = {
          state: breaker.state(providerId),
          consecutiveFailures: entry.consecutiveFailures,
          openedAt: entry.openedAt,
          ...(entry.lastDetail !== undefined ? { lastDetail: entry.lastDetail } : {}),
        };
      }
      return out;
    },
  };

  return breaker;
}
