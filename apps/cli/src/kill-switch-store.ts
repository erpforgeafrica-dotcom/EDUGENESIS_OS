/**
 * The durable kill-switch store (Seam 1 implementation, audit finding F3-11).
 *
 * WHAT THIS IS
 *   The `KillSwitchStore` seam Wave 1 defined in `packages/onekey`, given its
 *   durable implementation. The seam deliberately has NO package dependency:
 *   the application owns the durable stores, so the implementation lives here,
 *   over the SQLite private store the learner services already create.
 *
 * WHY THE PRIVATE STORE AND NOT A NEW TABLE
 *   The private store already persists arbitrary JSON payloads keyed by id
 *   (`private_records`: id, kind, at, data). The kill-switch state is a plain
 *   JSON snapshot, so it fits as ONE record there. No new table, no new
 *   package, and every durability guarantee the store already makes (file
 *   first, memory second, loud refusals on lossy payloads) applies to the
 *   kill switch for free.
 *
 * WHY THE `safeguarding` KIND
 *   A kill is a governance disablement for a safety incident, a data-residency
 *   breach or a licence problem (Doc 6 §5) - the closest of the six private
 *   record kinds the frozen contract declares. No application code queries
 *   `byKind('safeguarding')`, and the de-identified sponsor view reads only an
 *   allowlist of keys this payload never carries, so the record cannot
 *   influence a sponsor report. A dedicated governance kind would be a
 *   contracts change, which this wave reports rather than makes.
 *
 * WHY A CORRUPT STATE FAILS LOUDLY
 *   A state that cannot be parsed must never be read as "nothing is killed":
 *   that would silently re-enable a provider a human disabled. The refusal is
 *   an Error, the same discipline the private store itself applies to a row it
 *   cannot read.
 */
import type { PrivateStore } from '@edugenesis/contracts';
import type { KillSwitchRecord, KillSwitchState, KillSwitchStore } from '@edugenesis/onekey';

/** The id of the single private record that holds the kill-switch state. */
export const KILL_SWITCH_RECORD_ID = 'onekey-kill-switch';

/** The private record kind the kill-switch state is stored under. */
const KILL_SWITCH_RECORD_KIND = 'safeguarding';

export interface SqliteKillSwitchStoreOptions {
  /** The existing SQLite private store the application already owns. */
  readonly privateStore: PrivateStore;
  /** Clock injection for the record timestamp. Defaults to the system clock. */
  readonly now?: () => string;
}

/** True for a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a persisted payload into a kill-switch state, refusing anything that
 * is not exactly one.
 */
function parseState(data: Record<string, unknown>): KillSwitchState {
  const killedRaw = data['killed'];
  const recordsRaw = data['records'];
  if (!Array.isArray(killedRaw) || !Array.isArray(recordsRaw)) {
    throw new Error(
      'The persisted kill-switch state is corrupt: "killed" and "records" must be arrays.',
    );
  }

  const killed = killedRaw.map((entry): { providerId: string; reason: string } => {
    if (
      !isRecord(entry) ||
      typeof entry['providerId'] !== 'string' ||
      typeof entry['reason'] !== 'string'
    ) {
      throw new Error(
        'The persisted kill-switch state is corrupt: a killed entry needs a providerId and a reason.',
      );
    }
    return { providerId: entry['providerId'], reason: entry['reason'] };
  });

  const records = recordsRaw.map((entry): KillSwitchRecord => {
    const kind = entry && isRecord(entry) ? entry['kind'] : undefined;
    if (
      !isRecord(entry) ||
      typeof entry['providerId'] !== 'string' ||
      typeof entry['reason'] !== 'string' ||
      typeof entry['at'] !== 'string' ||
      Number.isNaN(Date.parse(entry['at'])) ||
      (kind !== 'kill' && kind !== 'revive')
    ) {
      throw new Error(
        'The persisted kill-switch state is corrupt: a trail record needs a providerId, a reason, ' +
          'a parseable timestamp and a kill/revive kind.',
      );
    }
    return {
      providerId: entry['providerId'],
      reason: entry['reason'],
      at: entry['at'],
      kind,
    };
  });

  return { killed, records };
}

/**
 * Create the durable kill-switch store.
 *
 * `load` reads the one record; `save` writes it back over the same id, so the
 * state is always exactly one row that carries the killed set and the
 * append-only trail together.
 */
export function createSqliteKillSwitchStore(options: SqliteKillSwitchStoreOptions): KillSwitchStore {
  const now = options.now ?? ((): string => new Date().toISOString());

  return {
    load(): KillSwitchState | undefined {
      const record = options.privateStore.get(KILL_SWITCH_RECORD_ID);
      if (!record) return undefined;
      return parseState(record.data);
    },

    save(state: KillSwitchState): void {
      // Plain JSON in, plain JSON out: every field is copied, so the stored
      // bytes are exactly the state the switch handed over.
      options.privateStore.put({
        id: KILL_SWITCH_RECORD_ID,
        kind: KILL_SWITCH_RECORD_KIND,
        at: now(),
        data: {
          killed: state.killed.map((entry) => ({
            providerId: entry.providerId,
            reason: entry.reason,
          })),
          records: state.records.map((record) => ({
            providerId: record.providerId,
            reason: record.reason,
            at: record.at,
            kind: record.kind,
          })),
        },
      });
    },
  };
}
