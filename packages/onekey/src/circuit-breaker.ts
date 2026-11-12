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
  /** Current state, promoting `open` to `half_open` once the cooldown elapsed. */
  state(providerId: string): CircuitState;
  /** True while the circuit is open — such a provider is never routed to. */
  isTripped(providerId: string): boolean;
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
    const created: CircuitEntry = { state: 'closed', consecutiveFailures: 0, openedAt: 0 };
    entries.set(providerId, created);
    return created;
  };

  const breaker: CircuitBreaker = {
    state(providerId: string): CircuitState {
      const entry = entries.get(providerId);
      if (!entry) {
        return 'closed';
      }
      if (entry.state === 'open' && now() - entry.openedAt >= cooldownMs) {
        // The cooldown elapsed: allow exactly one probe (half-open).
        entry.state = 'half_open';
      }
      return entry.state;
    },
    isTripped(providerId: string): boolean {
      return breaker.state(providerId) === 'open';
    },
    recordFailure(providerId: string, detail?: string): void {
      const entry = entryFor(providerId);
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
