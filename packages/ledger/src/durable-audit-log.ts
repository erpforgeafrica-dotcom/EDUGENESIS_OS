/**
 * EduGenesis OS — the DURABLE audit log for consent and enrolment events.
 *
 * THE BOUNDARY THIS MODULE PROTECTS
 * A consent decision and an enrolment attempt are child-safeguarding
 * evidence. Two properties make them evidence rather than a log line:
 *
 *   - DURABLE. A record that evaporates on restart proves nothing. This log
 *     is backed by a file, and every event is written before it is returned.
 *   - TAMPER EVIDENT. A record that can be quietly edited is worse than no
 *     record, because it invites reliance. Every event commits to its
 *     predecessor, so altering event N invalidates events N+1..end, and
 *     `verify()` names the seq where the chain first broke.
 *
 * WHY THIS IS NOT THE PUBLIC LEDGER
 * The public ledger (`ledger-store.ts`) is published, carries no personal
 * data and is meant to be read by sponsors and auditors. THIS log is private:
 * it may carry a learner id, a guardian id and the reason an enrolment was
 * refused, because a safeguarding record that cannot name the child it is
 * about is not a safeguarding record. The two are different surfaces, so this
 * module deliberately does NOT import the public ledger, and the public ledger
 * must never import this one. What the two share is the DISCIPLINE, not the
 * data: append only, hash chained, correction by compensation.
 *
 * NO UPDATE AND NO DELETE
 * There is no operation in this module that rewrites or removes an event, and
 * none may be added. A mistake is answered by appending a COMPENSATING event
 * that names the seq it corrects and why — the wrong event stays visible
 * forever, the compensation sits after it, and the chain stays verifiable end
 * to end. A record that can be rewritten is not a record, it is a marketing
 * page.
 *
 * THE HASH PREIMAGE
 * `hash = SHA-256(canonicalJson({ seq, at, kind, actorId, subjectId, detail,
 * previousHash }))`. The canonical serialisation sorts object keys, so a
 * third party can recompute the digest from the published event without
 * knowing anything about this implementation. `previousHash` is the literal
 * string "genesis" for seq 1 and the previous event's hash thereafter.
 *
 * THE DETAIL IS CANONICALISED BEFORE IT IS STORED
 * The `detail` text written to the file IS the canonical form of the detail,
 * and the hash is computed over that same canonical form. Verification
 * therefore compares the stored bytes with the canonical form of what they
 * decode to: an edit that only reorders the keys of the stored detail is
 * still a detected break, not a silent no-op.
 *
 * A BROKEN CHAIN IS READABLE, NOT FATAL
 * Loading never fails because the chain is broken, and `verify()` never
 * throws. An auditor must be able to open a tampered file, read the evidence
 * and be told exactly where it broke. The only thing that refuses to load is
 * a file that cannot be read at all.
 *
 * PORTABILITY
 * The file path is supplied by the caller and resolved at runtime; no path,
 * user name or drive letter is baked into this source (GLOBAL.md §9).
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJson, sha256Hex } from './hash.js';

/** The previous-hash value used for the first event of a chain. */
const GENESIS_HASH = 'genesis';

/** The scalar values an audit detail may carry. */
export type AuditDetailValue = string | number | boolean | null;

/** One immutable, hash-chained audit event. */
export interface DurableAuditEvent {
  readonly seq: number;
  readonly at: string; // ISO-8601
  readonly kind: string; // e.g. 'consent.granted', 'enrolment.provisional', 'enrolment.refused'
  readonly actorId?: string;
  readonly subjectId?: string;
  readonly detail: Record<string, string | number | boolean | null>;
  readonly previousHash: string;
  readonly hash: string;
}

/** Options for `createDurableAuditLog`. */
export interface DurableAuditLogOptions {
  readonly path: string; // SQLite file
  readonly now?: () => string; // clock injection; defaults to the system clock
}

/** The append-only, tamper-evident, durable audit log. */
export interface DurableAuditLog {
  append(
    kind: string,
    event?: {
      actorId?: string;
      subjectId?: string;
      detail?: Record<string, string | number | boolean | null>;
    },
  ): DurableAuditEvent;
  all(): DurableAuditEvent[];
  verify(): { ok: boolean; entriesChecked: number; brokenAtSeq?: number; detail?: string };
  close(): void;
}

/**
 * A stored event together with the EXACT bytes that were written.
 *
 * The raw text is kept so verification can compare the stored bytes with the
 * canonical form of what they decode to. Without it, a detail rewritten into
 * a different key order would canonicalise back to the same value and the
 * edit would go unnoticed.
 */
interface StoredEvent {
  readonly event: DurableAuditEvent;
  readonly detailText: string;
}

/**
 * Validate and canonicalise a detail payload.
 *
 * The detail is flat scalars only: it is hashed, stored and read back, and a
 * nested structure would have to be flattened into a lossy summary to fit
 * that contract. `undefined` is refused rather than dropped, because an
 * audit record that silently loses a field is not an audit record.
 */
function canonicaliseDetail(
  detail: Record<string, AuditDetailValue> | undefined,
): { readonly text: string; readonly value: Record<string, AuditDetailValue> } {
  if (detail === undefined) {
    return { text: '{}', value: {} };
  }
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
    throw new Error('An audit event detail must be an object of flat scalar values.');
  }
  const flat: Record<string, AuditDetailValue> = {};
  for (const key of Object.keys(detail)) {
    const value = detail[key];
    if (value === undefined) {
      throw new Error(
        `The audit event detail field "${key}" is undefined; an audit record must not drop a field silently.`,
      );
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      flat[key] = value;
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error(
          `The audit event detail field "${key}" is not a finite number and cannot be hashed reproducibly.`,
        );
      }
      flat[key] = value;
      continue;
    }
    throw new Error(
      `The audit event detail field "${key}" has unsupported type "${typeof value}". ` +
        'A detail may only contain strings, numbers, booleans and null.',
    );
  }
  const text = canonicalJson(flat);
  return { text, value: JSON.parse(text) as Record<string, AuditDetailValue> };
}

/** The exact preimage of an event hash. */
function hashPreimage(event: {
  readonly seq: number;
  readonly at: string;
  readonly kind: string;
  readonly actorId?: string;
  readonly subjectId?: string;
  readonly detail: Record<string, AuditDetailValue>;
  readonly previousHash: string;
}): Record<string, unknown> {
  return {
    seq: event.seq,
    at: event.at,
    kind: event.kind,
    actorId: event.actorId,
    subjectId: event.subjectId,
    detail: event.detail,
    previousHash: event.previousHash,
  };
}

/** Recompute the hash of an event. */
function computeEventHash(event: {
  readonly seq: number;
  readonly at: string;
  readonly kind: string;
  readonly actorId?: string;
  readonly subjectId?: string;
  readonly detail: Record<string, AuditDetailValue>;
  readonly previousHash: string;
}): string {
  return sha256Hex(canonicalJson(hashPreimage(event)));
}

/** Read a text column, refusing a column that is not text. */
function readText(value: unknown, column: string, seq: number): string {
  if (typeof value !== 'string') {
    throw new Error(
      `The audit event at seq ${seq} has a "${column}" column that is not text; the log file is corrupt.`,
    );
  }
  return value;
}

/** Parse a stored detail, refusing a blob that is not a JSON object. */
function parseDetail(text: string, seq: number): Record<string, AuditDetailValue> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `The audit event at seq ${seq} does not contain valid JSON detail: ${(error as Error).message}.`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`The audit event at seq ${seq} does not contain a JSON object detail.`);
  }
  return parsed as Record<string, AuditDetailValue>;
}

/** Create the durable audit log. */
export function createDurableAuditLog(options: DurableAuditLogOptions): DurableAuditLog {
  if (typeof options.path !== 'string' || options.path.trim().length === 0) {
    throw new Error('The durable audit log needs a non-empty path to its SQLite file.');
  }
  const now = options.now ?? ((): string => new Date().toISOString());

  // Resolved at runtime, never hardcoded (GLOBAL.md §9).
  const file = resolve(options.path);
  mkdirSync(dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec(
    `CREATE TABLE IF NOT EXISTS audit_events (
       seq          INTEGER PRIMARY KEY,
       at           TEXT NOT NULL,
       kind         TEXT NOT NULL,
       actor_id     TEXT,
       subject_id   TEXT,
       detail       TEXT NOT NULL,
       previous_hash TEXT NOT NULL,
       hash         TEXT NOT NULL
     )`,
  );

  const stored: StoredEvent[] = [];
  let closed = false;

  // LOAD: the evidence stays readable even when the chain is broken. A broken
  // chain is reported by `verify()`, never by refusing to open the file.
  const readRows = db.prepare(
    `SELECT seq, at, kind, actor_id, subject_id, detail, previous_hash, hash
       FROM audit_events ORDER BY seq ASC`,
  );
  for (const row of readRows.all()) {
    const rawSeq = row['seq'];
    if (typeof rawSeq !== 'number' || !Number.isInteger(rawSeq)) {
      throw new Error('An audit event in the log file has a non-integer seq; the file is corrupt.');
    }
    const seq = rawSeq;
    const at = readText(row['at'], 'at', seq);
    const kind = readText(row['kind'], 'kind', seq);
    const detailText = readText(row['detail'], 'detail', seq);
    const previousHash = readText(row['previous_hash'], 'previous_hash', seq);
    const hash = readText(row['hash'], 'hash', seq);
    const rawActor = row['actor_id'];
    const rawSubject = row['subject_id'];
    const actorId = rawActor === null || rawActor === undefined ? undefined : readText(rawActor, 'actor_id', seq);
    const subjectId =
      rawSubject === null || rawSubject === undefined ? undefined : readText(rawSubject, 'subject_id', seq);

    stored.push({
      event: {
        seq,
        at,
        kind,
        ...(actorId === undefined ? {} : { actorId }),
        ...(subjectId === undefined ? {} : { subjectId }),
        detail: parseDetail(detailText, seq),
        previousHash,
        hash,
      },
      detailText,
    });
  }

  const insert = db.prepare(
    `INSERT INTO audit_events (seq, at, kind, actor_id, subject_id, detail, previous_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const append: DurableAuditLog['append'] = (kind, event) => {
    if (closed) {
      throw new Error('The durable audit log is closed; it cannot accept another event.');
    }
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new Error('An audit event needs a non-empty kind.');
    }
    const at = now();
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
      throw new Error('An audit event needs a parseable ISO-8601 timestamp.');
    }
    const rawActor = event?.actorId;
    const rawSubject = event?.subjectId;
    if (rawActor !== undefined && typeof rawActor !== 'string') {
      throw new Error('An audit event actor id must be a string.');
    }
    if (rawSubject !== undefined && typeof rawSubject !== 'string') {
      throw new Error('An audit event subject id must be a string.');
    }
    const { text: detailText, value: detail } = canonicaliseDetail(event?.detail);

    // The sequence belongs to the log. A caller cannot supply it, so an
    // earlier event can never be overwritten or renumbered.
    const previous = stored.length > 0 ? stored[stored.length - 1] : undefined;
    const seq = previous === undefined ? 1 : previous.event.seq + 1;
    const previousHash = previous === undefined ? GENESIS_HASH : previous.event.hash;
    const hash = computeEventHash({ seq, at, kind, actorId: rawActor, subjectId: rawSubject, detail, previousHash });

    // The file first, the memory second.
    insert.run(
      seq,
      at,
      kind,
      rawActor ?? null,
      rawSubject ?? null,
      detailText,
      previousHash,
      hash,
    );

    const record: DurableAuditEvent = {
      seq,
      at,
      kind,
      ...(rawActor === undefined ? {} : { actorId: rawActor }),
      ...(rawSubject === undefined ? {} : { subjectId: rawSubject }),
      detail,
      previousHash,
      hash,
    };
    stored.push({ event: record, detailText });
    return record;
  };

  const verify = (): {
    ok: boolean;
    entriesChecked: number;
    brokenAtSeq?: number;
    detail?: string;
  } => {
    let entriesChecked = 0;
    for (const [index, entry] of stored.entries()) {
      entriesChecked = index + 1;
      const expectedSeq = index + 1;
      if (entry.event.seq !== expectedSeq) {
        return {
          ok: false,
          entriesChecked,
          brokenAtSeq: expectedSeq,
          detail:
            `the event at position ${expectedSeq} declares seq ${entry.event.seq}; ` +
            'the sequence must be monotonic from 1',
        };
      }
      const previous = stored[index - 1];
      const expectedPrevious = previous === undefined ? GENESIS_HASH : previous.event.hash;
      if (entry.event.previousHash !== expectedPrevious) {
        return {
          ok: false,
          entriesChecked,
          brokenAtSeq: entry.event.seq,
          detail:
            'previousHash does not match the hash of the preceding event; ' +
            'the link between this event and its predecessor is broken',
        };
      }
      // The stored bytes must still be the canonical form of the detail: an
      // edit that only reorders keys would otherwise slip through.
      if (canonicalJson(entry.event.detail) !== entry.detailText) {
        return {
          ok: false,
          entriesChecked,
          brokenAtSeq: entry.event.seq,
          detail:
            'the stored detail is not the canonical form of the event detail; ' +
            'the stored bytes were altered',
        };
      }
      const expectedHash = computeEventHash(entry.event);
      if (entry.event.hash !== expectedHash) {
        return {
          ok: false,
          entriesChecked,
          brokenAtSeq: entry.event.seq,
          detail: 'hash does not match the hash recomputed from the event contents',
        };
      }
    }
    return { ok: true, entriesChecked };
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    db.close();
  };

  return {
    append,
    // Frozen copies: the chain is evidence, and evidence must not be
    // editable through the accessor that hands it out.
    all(): DurableAuditEvent[] {
      return stored.map((entry) =>
        Object.freeze({
          ...entry.event,
          detail: Object.freeze({ ...entry.event.detail }),
        }),
      );
    },
    verify,
    close,
  };
}
