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

/**
 * The state a kill switch persists.
 *
 * WHY the state is a value and not a live object: the store owns the
 * durable copy, so the switch can hand a plain snapshot to it and take a
 * plain snapshot back without sharing any mutable structure.
 */
export interface KillSwitchState {
  readonly killed: ReadonlyArray<{ providerId: string; reason: string }>;
  readonly records: readonly KillSwitchRecord[];
}

/**
 * The durable store behind the kill switch.
 *
 * WHY it is a seam and not a dependency: the switch used to keep the killed
 * set in a `Map` inside one closure, so a kill issued on one replica did not
 * stop another (audit finding F3-11). The store is what makes the switch
 * shareable — and the IMPLEMENTATION belongs to the application, because the
 * application owns the durable stores. No new package dependency is needed.
 */
export interface KillSwitchStore {
  /** The persisted state, or undefined when nothing has ever been recorded. */
  load(): KillSwitchState | undefined;
  /** Persist the state. Called on every kill and every revive. */
  save(state: KillSwitchState): void;
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

/** The identity of a trail record, so the same record is never stored twice. */
function recordIdentity(record: KillSwitchRecord): string {
  return `${record.providerId}\u0000${record.kind}\u0000${record.at}\u0000${record.reason}`;
}

export function createKillSwitch(opts: { now?: () => number; store?: KillSwitchStore } = {}): KillSwitch {
  const now = opts.now ?? ((): number => Date.now());
  const store = opts.store;
  const killed = new Map<string, string>();
  const records: KillSwitchRecord[] = [];

  /**
   * Take the shared state into the local view.
   *
   * WHY the killed set is REPLACED and the trail is MERGED: the store is the
   * authority on what is killed — a revive issued on another replica must
   * un-kill it here — while the trail is append-only and must never lose a
   * record.
   */
  const hydrate = (): void => {
    if (!store) {
      return;
    }
    const state = store.load();
    if (!state) {
      return;
    }
    killed.clear();
    for (const entry of state.killed) {
      killed.set(entry.providerId, entry.reason);
    }
    for (const record of state.records) {
      if (!records.some((known) => recordIdentity(known) === recordIdentity(record))) {
        records.push({ ...record });
      }
    }
  };

  /**
   * Write the local view through to the shared store.
   *
   * WHY a failed write is NOT swallowed: a kill that could not be persisted
   * must be loud. Swallowing it would leave a safety decision that exists
   * only in one process — the defect this seam exists to close.
   */
  const persist = (): void => {
    if (!store) {
      return;
    }
    store.save({
      killed: [...killed.entries()].map(([providerId, reason]) => ({ providerId, reason })),
      records: records.map((record) => ({ ...record })),
    });
  };

  // Hydrate at construction: a kill made elsewhere — before this process
  // started — must be visible from the very first read.
  hydrate();

  return {
    killSwitch(providerId: string, reason: string): void {
      killed.set(providerId, reason);
      records.push({ providerId, reason, at: new Date(now()).toISOString(), kind: 'kill' });
      persist();
    },
    revive(providerId: string, reason: string): void {
      killed.delete(providerId);
      records.push({ providerId, reason, at: new Date(now()).toISOString(), kind: 'revive' });
      persist();
    },
    isKilled(providerId: string): boolean {
      // Refresh first: a kill issued on another replica must stop this one
      // too, without waiting for a restart (audit finding F3-11).
      hydrate();
      return killed.has(providerId);
    },
    reasonFor(providerId: string): string | undefined {
      hydrate();
      return killed.get(providerId);
    },
    records(): KillSwitchRecord[] {
      hydrate();
      return records.map((record) => ({ ...record }));
    },
  };
}
