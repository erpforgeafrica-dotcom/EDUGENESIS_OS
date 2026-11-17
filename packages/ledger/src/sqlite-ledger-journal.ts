/**
 * EduGenesis OS — the DURABLE journal for the PUBLIC sponsor ledger (ADR-0019).
 *
 * WHY THIS MODULE EXISTS
 * The public ledger (`ledger-store.ts`) is the platform's promise to a sponsor:
 * "anyone can check that we did". Until now that promise lived entirely in
 * memory — a process restart erased the published record with no residue
 * (gap-register F8-04's named remainder; F5-01's durability demand). The owner
 * took the design decision (Option A of the 2026-11-16 design brief): a
 * file-backed, INSERT-only SQLite journal in the durable-data directory,
 * wired behind the store's EXISTING seams so no frozen contract changes.
 *
 * THE SEAM
 * The journal does NOT own the ledger's rules. The store owns its seq, its
 * head, its hash preimage, its PII guard and its correction discipline —
 * none of that is duplicated here. The journal supplies exactly two things
 * to `createLedgerStore`:
 *
 *   - `persist(entry)` — the file-first sink called inside the store's
 *     critical section (see the constrained hook contract there);
 *   - `load()` — the rows verified on open, handed to the store as
 *     `initialEntries` so a restart CONTINUES the chain instead of
 *     restarting it (the design brief's blocker: an empty reboot store would
 *     issue seq 1 again and collide with the file forever).
 *
 * THE EVIDENCE IS THE CANONICAL TEXT
 * The payload is stored as the canonical JSON text exactly as it was hashed.
 * On open, every row is checked against `computeEntryHash` — the SAME public
 * function a third-party auditor runs — and against the stored text: the
 * canonical form of what the text decodes to must equal the text itself, so
 * an edit that only reorders the keys of a stored payload is still a
 * detected break, not a silent no-op (the `durable-audit-log.ts` trick).
 *
 * A BROKEN CHAIN IS READABLE, NOT FATAL
 * Loading never fails because the chain is broken, and `verify()` never
 * throws. An auditor must be able to open a tampered file, read the evidence
 * and be told exactly where it broke. The only thing that refuses to load is
 * a row whose stored JSON is structurally corrupt — that is a broken file,
 * not a broken chain. A broken chain refuses every WRITE (the store refuses
 * its own hash-level breaks; the journal refuses to extend a chain whose
 * stored bytes no longer match their canonical form), because a broken
 * chain must not grow.
 *
 * THE PRAGMAS ARE THE DEFAULTS, ON RECORD
 * Single-writer journal (one web service, render.yaml): the node:sqlite
 * defaults are kept — the rollback journal (`journal_mode = delete`) and
 * `synchronous = FULL` — so a returned append is committed. WAL is
 * deliberately NOT enabled: it is a concurrency/performance mode, not a
 * stronger crash guarantee, and ADR-0019 records that departure from the
 * F5-01 fix text. The `pragma()` accessor makes the defaults observable so
 * the ADR and the file can never drift apart silently.
 *
 * PORTABILITY
 * The file path is supplied by the caller and resolved at runtime; no path,
 * user name or drive letter is baked into this source (GLOBAL.md §9).
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { LedgerTamperError, type LedgerEntry, type LedgerEntryType } from '@edugenesis/contracts';

import { canonicalJson } from './hash.js';
import { computeEntryHash } from './ledger-store.js';

/** Thrown when the journal cannot persist an append. ONE error type for ONE condition. */
export class LedgerPersistenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LedgerPersistenceError';
  }
}

/** The chain report shape shared with the store's `verify()`. */
export interface JournalVerification {
  readonly ok: boolean;
  readonly entriesChecked: number;
  readonly brokenAtSeq?: number;
  readonly detail?: string;
}

/** The durable journal behind the public ledger. */
export interface SqliteLedgerJournal {
  /** The verified rows on disk, in seq order. Supplied to the store as `initialEntries`. */
  load(): LedgerEntry[];
  /** The file-first sink for the store's `persist` hook. Throws before anything is committed. */
  persist(entry: LedgerEntry): void;
  /** Verify the file's chain. Reports; never throws (structural corruption still throws). */
  verify(): JournalVerification;
  /** Read a connection pragma (diagnostic surface: the recorded defaults are observable). */
  pragma(name: string): string | number;
  /** Close the file handle. A closed journal refuses further writes, typed. */
  close(): void;
}

/** Options for `createSqliteLedgerJournal`. */
export interface SqliteLedgerJournalOptions {
  readonly path: string;
}

/** Read a TEXT column, refusing a corrupt row. */
function readText(value: unknown, column: string, seq: number): string {
  if (typeof value !== 'string') {
    throw new Error(
      `The ledger row at seq ${seq} has a "${column}" column that is not text; the journal file is corrupt.`,
    );
  }
  return value;
}

const PRAGMA_NAME = /^[a-z_]+$/;

/** Create the durable journal for the public ledger. */
export function createSqliteLedgerJournal(options: SqliteLedgerJournalOptions): SqliteLedgerJournal {
  if (typeof options.path !== 'string' || options.path.trim().length === 0) {
    throw new Error('The ledger journal needs a non-empty path to its SQLite file.');
  }

  const file = resolve(options.path);
  mkdirSync(dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec(
    `CREATE TABLE IF NOT EXISTS ledger_entries (
       seq           INTEGER PRIMARY KEY,
       type          TEXT NOT NULL,
       at            TEXT NOT NULL,
       payload       TEXT NOT NULL,
       previous_hash TEXT NOT NULL,
       hash          TEXT NOT NULL
     )`,
  );

  let closed = false;

  const readRows = db.prepare(
    `SELECT seq, type, at, payload, previous_hash, hash
       FROM ledger_entries ORDER BY seq ASC`,
  );

  /**
   * The rows with their EXACT stored payload text. The text is what makes the
   * byte-level check possible: the canonical form of what a payload decodes
   * to must equal the stored text, or the evidence bytes have been edited.
   */
  const readStored = (): { entry: LedgerEntry; payloadText: string }[] => {
    const rows: { entry: LedgerEntry; payloadText: string }[] = [];
    for (const row of readRows.all()) {
      const rawSeq = row['seq'];
      if (typeof rawSeq !== 'number' || !Number.isInteger(rawSeq)) {
        throw new Error('A ledger row in the journal has a non-integer seq; the file is corrupt.');
      }
      const seq = rawSeq;
      const type = readText(row['type'], 'type', seq) as LedgerEntryType;
      const at = readText(row['at'], 'at', seq);
      const payloadText = readText(row['payload'], 'payload', seq);
      const previousEntryHash = readText(row['previous_hash'], 'previous_hash', seq);
      const entryHash = readText(row['hash'], 'hash', seq);

      let payload: unknown;
      try {
        payload = JSON.parse(payloadText);
      } catch (error) {
        throw new Error(
          `The ledger row at seq ${seq} does not contain valid JSON payload: ${(error as Error).message}.`,
        );
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error(`The ledger row at seq ${seq} does not contain a JSON object payload.`);
      }

      rows.push({
        entry: {
          seq,
          type,
          at,
          payload: payload as LedgerEntry['payload'],
          previousEntryHash,
          entryHash,
        },
        payloadText,
      });
    }
    return rows;
  };

  const load = (): LedgerEntry[] => readStored().map((row) => row.entry);

  /**
   * Verify the file's chain, INCLUDING the byte-level check the hash cannot
   * see: the canonical form of a stored payload must equal its stored text.
   */
  const verify = (): JournalVerification => {
    const rows = readStored();
    for (const [index, row] of rows.entries()) {
      const entry = row.entry;
      const expectedSeq = index + 1;
      if (entry.seq !== expectedSeq) {
        return {
          ok: false,
          entriesChecked: index + 1,
          brokenAtSeq: expectedSeq,
          detail: `the row at position ${expectedSeq} declares seq ${entry.seq}; the sequence must be monotonic from 1`,
        };
      }
      const expectedPrevious = index === 0 ? 'genesis' : rows[index - 1]?.entry.entryHash;
      if (entry.previousEntryHash !== expectedPrevious) {
        return {
          ok: false,
          entriesChecked: index + 1,
          brokenAtSeq: entry.seq,
          detail: `previousEntryHash does not match the entryHash of seq ${expectedSeq - 1}; the link is broken`,
        };
      }
      if (entry.entryHash !== computeEntryHash(entry)) {
        return {
          ok: false,
          entriesChecked: index + 1,
          brokenAtSeq: entry.seq,
          detail: 'entryHash does not match the hash recomputed from the row contents',
        };
      }
      if (canonicalJson(entry.payload) !== row.payloadText) {
        return {
          ok: false,
          entriesChecked: index + 1,
          brokenAtSeq: entry.seq,
          detail: 'the stored payload text is not the canonical form of its value; the stored bytes were edited',
        };
      }
    }
    return { ok: true, entriesChecked: rows.length };
  };

  const insert = db.prepare(
    `INSERT INTO ledger_entries (seq, type, at, payload, previous_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const persist = (entry: LedgerEntry): void => {
    if (closed) {
      throw new LedgerPersistenceError(
        `The ledger journal at ${file} is closed; the append at seq ${entry.seq} was refused with nothing recorded.`,
      );
    }
    if (!openVerification.ok) {
      // The stored bytes of the chain no longer match the canonical form of
      // their values. Extending that chain would bury the break under new
      // evidence — the same refusal the store makes for a hash-level break.
      throw new LedgerTamperError(
        openVerification.brokenAtSeq ?? 0,
        openVerification.detail ?? 'the journal chain does not verify',
      );
    }
    try {
      insert.run(
        entry.seq,
        entry.type,
        entry.at,
        canonicalJson(entry.payload),
        entry.previousEntryHash,
        entry.entryHash,
      );
    } catch (error) {
      throw new LedgerPersistenceError(
        `The ledger journal refused to record seq ${entry.seq}: the row was NOT committed, ` +
          `so nothing is in memory either (file first, memory second). ${(error as Error).message}`,
        error,
      );
    }
  };

  const pragma = (name: string): string | number => {
    if (!PRAGMA_NAME.test(name)) {
      throw new Error(`"${name}" is not a pragma name.`);
    }
    const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    const value = row === undefined ? undefined : Object.values(row)[0];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`The pragma "${name}" returned no readable value.`);
    }
    return value;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    db.close();
  };

  // The open-time verification is remembered: it decides whether the journal
  // may extend the chain at all.
  const openVerification = verify();

  return { load, persist, verify, pragma, close };
}
