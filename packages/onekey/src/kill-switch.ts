/**
 * The kill switch (Doc 6 §5 — emergency disablement).
 *
 * WHY it is separate from the circuit breaker: a tripped circuit is a
 * *health* signal that recovers on its own; a killed provider is a *governance
 * decision* (safety incident, data-residency breach, licence problem). It
 * takes effect immediately and outranks every routing preference.
 */
export interface KillSwitchRecord {
  providerId: string;
  reason: string;
  at: string;
  /** `kill` removes the provider from routing; `revive` puts it back. */
  kind: 'kill' | 'revive';
}

export interface KillSwitch {
  /** Emergency-disable a provider. Effective immediately. */
  killSwitch(providerId: string, reason: string): void;
  /** Re-enable a previously killed provider. */
  revive(providerId: string, reason: string): void;
  isKilled(providerId: string): boolean;
  /** The reason recorded for the current kill, if any. */
  reasonFor(providerId: string): string | undefined;
  /** The audit trail, oldest first. */
  records(): KillSwitchRecord[];
}

export function createKillSwitch(opts: { now?: () => number } = {}): KillSwitch {
  const now = opts.now ?? ((): number => Date.now());
  const killed = new Map<string, string>();
  const records: KillSwitchRecord[] = [];

  return {
    killSwitch(providerId: string, reason: string): void {
      killed.set(providerId, reason);
      records.push({ providerId, reason, at: new Date(now()).toISOString(), kind: 'kill' });
    },
    revive(providerId: string, reason: string): void {
      killed.delete(providerId);
      records.push({ providerId, reason, at: new Date(now()).toISOString(), kind: 'revive' });
    },
    isKilled(providerId: string): boolean {
      return killed.has(providerId);
    },
    reasonFor(providerId: string): string | undefined {
      return killed.get(providerId);
    },
    records(): KillSwitchRecord[] {
      return records.map((record) => ({ ...record }));
    },
  };
}
