/**
 * The kill switch (Doc 6 §5 — emergency disablement).
 *
 * WHY it is separate from the circuit breaker: a tripped circuit is a
 * *health* signal that recovers on its own; a killed provider is a *governance
 * decision* (safety incident, data-residency breach, licence problem). It
 * takes effect immediately and outranks every routing preference.
 *
 * F8-11: a governance decision is not a note in one process. A kill carries an
 * actor, a reason, a timestamp and a classification, is written through an
 * injectable durable sink in ONE atomic save, and is reconstructed at startup.
 * Reviving a safety/residency/licence kill needs a SECOND authorised person —
 * the actor who killed may not quietly undo their own incident.
 */

/** Why a provider was killed — drives the second-person rule on revive. */
export type KillClassification = 'safety' | 'residency' | 'licence' | 'operational';

const KILL_CLASSIFICATIONS: readonly KillClassification[] = [
  'safety', 'residency', 'licence', 'operational',
];

/** Classifications whose revive requires a different authorised actor. */
export const SECOND_PERSON_CLASSIFICATIONS: readonly KillClassification[] = [
  'safety', 'residency', 'licence',
];

export interface KillSwitchRecord {
  providerId: string;
  reason: string;
  at: string;
  /** `kill` removes the provider from routing; `revive` puts it back. */
  kind: 'kill' | 'revive';
  /** The authorised actor who issued the decision. Absent on legacy records. */
  actor?: string;
  /** Why the provider was killed. Absent on legacy records and on revives. */
  classification?: KillClassification;
}

/** One entry of the persisted killed set. */
export interface KillEntry {
  providerId: string;
  reason: string;
  /** Optional for backward compatibility with states written before F8-11. */
  actor?: string;
  classification?: KillClassification;
}

/**
 * The state a kill switch persists.
 *
 * WHY the state is a value and not a live object: the store owns the
 * durable copy, so the switch can hand a plain snapshot to it and take a
 * plain snapshot back without sharing any mutable structure.
 */
export interface KillSwitchState {
  readonly killed: ReadonlyArray<KillEntry>;
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
  /** Persist the state atomically. Called on every kill and every revive. */
  save(state: KillSwitchState): void;
}

export interface KillSwitchOptions {
  now?: () => number;
  store?: KillSwitchStore;
  /**
   * Actors entitled to kill or revive. When non-empty, every call must name an
   * actor from this set; an unattributed call is refused. When omitted, the
   * legacy unattributed form keeps working (recorded as actor `system`).
   */
  authorisedActors?: readonly string[];
}

export interface KillSwitch {
  /** Emergency-disable a provider. Effective immediately. */
  killSwitch(
    providerId: string,
    reason: string,
    actor?: string,
    classification?: KillClassification,
  ): void;
  /** Re-enable a previously killed provider. */
  revive(providerId: string, reason: string, actor?: string): void;
  isKilled(providerId: string): boolean;
  /** The reason recorded for the current kill, if any. */
  reasonFor(providerId: string): string | undefined;
  /** The audit trail, oldest first. */
  records(): KillSwitchRecord[];
}

/** A governance decision without a valid actor, reason or class is refused. */
export class KillGovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KillGovernanceError';
  }
}

/** A persisted state that cannot be reconstructed is refused, never treated as empty. */
export class KillSwitchCorruptStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KillSwitchCorruptStateError';
  }
}

/** The internal value of the killed map (the id lives in the map key). */
interface KillInfo {
  reason: string;
  actor?: string;
  classification?: KillClassification;
}

/** Unattributed calls are legal only in legacy mode, never anonymous. */
const LEGACY_ACTOR = 'system';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClassification(value: unknown): value is KillClassification {
  return typeof value === 'string' && (KILL_CLASSIFICATIONS as readonly string[]).includes(value);
}

/**
 * Validate a persisted state BEFORE it is trusted to keep a provider killed or
 * to re-enable one. A partial/corrupt write must fail loudly: treating it as
 * "nothing is killed" would silently re-enable a provider a human disabled.
 * Missing NEW optional metadata (actor/classification) is accepted for
 * backward compatibility with states written before F8-11.
 */
function validateState(state: KillSwitchState): void {
  if (!isRecord(state) || !Array.isArray(state.killed) || !Array.isArray(state.records)) {
    throw new KillSwitchCorruptStateError(
      'the persisted kill-switch state is corrupt: "killed" and "records" must be arrays',
    );
  }
  for (const entry of state.killed) {
    if (
      !isRecord(entry) ||
      typeof entry['providerId'] !== 'string' ||
      entry['providerId'].length === 0 ||
      typeof entry['reason'] !== 'string'
    ) {
      throw new KillSwitchCorruptStateError(
        'the persisted kill-switch state is corrupt: a killed entry needs a providerId and a reason',
      );
    }
    if (entry['actor'] !== undefined && typeof entry['actor'] !== 'string') {
      throw new KillSwitchCorruptStateError(
        'the persisted kill-switch state is corrupt: an actor must be a string',
      );
    }
    if (entry['classification'] !== undefined && !isClassification(entry['classification'])) {
      throw new KillSwitchCorruptStateError(
        'the persisted kill-switch state is corrupt: an unknown kill classification',
      );
    }
  }
  for (const record of state.records) {
    const kind = isRecord(record) ? record['kind'] : undefined;
    if (
      !isRecord(record) ||
      typeof record['providerId'] !== 'string' ||
      typeof record['reason'] !== 'string' ||
      typeof record['at'] !== 'string' ||
      Number.isNaN(Date.parse(record['at'])) ||
      (kind !== 'kill' && kind !== 'revive')
    ) {
      throw new KillSwitchCorruptStateError(
        'the persisted kill-switch state is corrupt: a trail record needs a providerId, a reason, ' +
          'a parseable timestamp and a kill/revive kind',
      );
    }
    if (record['actor'] !== undefined && typeof record['actor'] !== 'string') {
      throw new KillSwitchCorruptStateError(
        'the persisted kill-switch state is corrupt: an actor must be a string',
      );
    }
    if (record['classification'] !== undefined && !isClassification(record['classification'])) {
      throw new KillSwitchCorruptStateError(
        'the persisted kill-switch state is corrupt: an unknown kill classification',
      );
    }
  }
}

/** The identity of a trail record, so the same record is never stored twice. */
function recordIdentity(record: KillSwitchRecord): string {
  return `${record.providerId}\u0000${record.kind}\u0000${record.at}\u0000${record.reason}`;
}

export function createKillSwitch(opts: KillSwitchOptions = {}): KillSwitch {
  const now = opts.now ?? ((): number => Date.now());
  const store = opts.store;
  const authorisedActors = opts.authorisedActors;
  const killed = new Map<string, KillInfo>();
  const records: KillSwitchRecord[] = [];

  const requireReason = (reason: string): void => {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new KillGovernanceError('a kill or revive requires a non-empty reason');
    }
  };

  const requireActor = (actor: string | undefined): string => {
    if (authorisedActors && authorisedActors.length > 0) {
      if (typeof actor !== 'string' || actor.length === 0 || !authorisedActors.includes(actor)) {
        throw new KillGovernanceError('an authorised actor is required to change the kill switch');
      }
      return actor;
    }
    return actor ?? LEGACY_ACTOR;
  };

  const requireClassification = (classification: KillClassification | undefined): KillClassification => {
    if (classification === undefined) return 'operational';
    if (!isClassification(classification)) {
      throw new KillGovernanceError('an unknown kill classification was supplied');
    }
    return classification;
  };

  /**
   * Take the shared state into the local view.
   *
   * WHY the killed set is REPLACED and the trail is MERGED: the store is the
   * authority on what is killed — a revive issued on another replica must
   * un-kill it here — while the trail is append-only and must never lose a
   * record. A corrupt state is thrown, never read as "nothing is killed".
   */
  const hydrate = (): void => {
    if (!store) {
      return;
    }
    const state = store.load();
    if (!state) {
      return;
    }
    validateState(state);
    killed.clear();
    for (const entry of state.killed) {
      const info: KillInfo = { reason: entry.reason };
      if (entry.actor !== undefined) info.actor = entry.actor;
      if (entry.classification !== undefined) info.classification = entry.classification;
      killed.set(entry.providerId, info);
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
   * only in one process — the defect this seam exists to close. ONE save
   * carries the killed set and the trail together; that single call is the
   * atomic unit the sink must make durable.
   */
  const persist = (): void => {
    if (!store) {
      return;
    }
    store.save({
      killed: [...killed.entries()].map(([providerId, info]) => ({ providerId, ...info })),
      records: records.map((record) => ({ ...record })),
    });
  };

  // Hydrate at construction: a kill made elsewhere — before this process
  // started — must be visible from the very first read.
  hydrate();

  return {
    killSwitch(providerId, reason, actor, classification): void {
      requireReason(reason);
      const who = requireActor(actor);
      const cls = requireClassification(classification);
      const info: KillInfo = { reason };
      if (actor !== undefined) info.actor = who;
      if (classification !== undefined) info.classification = cls;
      killed.set(providerId, info);
      records.push({
        providerId,
        reason,
        at: new Date(now()).toISOString(),
        kind: 'kill',
        actor: who,
        classification: cls,
      });
      persist();
    },
    revive(providerId, reason, actor): void {
      requireReason(reason);
      const who = requireActor(actor);
      // The last kill that has not already been revived is the active one.
      let active: KillSwitchRecord | undefined;
      for (const record of records) {
        if (record.providerId !== providerId) continue;
        if (record.kind === 'kill') active = record;
        else if (record.kind === 'revive') active = undefined;
      }
      if (active) {
        const cls = active.classification ?? 'operational';
        if (
          authorisedActors &&
          authorisedActors.length > 0 &&
          SECOND_PERSON_CLASSIFICATIONS.includes(cls) &&
          active.actor !== undefined &&
          active.actor === who
        ) {
          throw new KillGovernanceError(
            `a ${cls} kill requires a second authorised person to revive; '${who}' issued the kill`,
          );
        }
      }
      killed.delete(providerId);
      records.push({
        providerId,
        reason,
        at: new Date(now()).toISOString(),
        kind: 'revive',
        actor: who,
      });
      persist();
    },
    isKilled(providerId): boolean {
      // Refresh first: a kill issued on another replica must stop this one
      // too, without waiting for a restart (audit finding F3-11).
      hydrate();
      return killed.has(providerId);
    },
    reasonFor(providerId): string | undefined {
      hydrate();
      return killed.get(providerId)?.reason;
    },
    records(): KillSwitchRecord[] {
      hydrate();
      return records.map((record) => ({ ...record }));
    },
  };
}
