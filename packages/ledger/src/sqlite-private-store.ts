/**
 * EduGenesis OS — the DURABLE private operational store (SQLite backed).
 *
 * THE BOUNDARY THIS MODULE PROTECTS
 * `private-store.ts` holds identity, consent, safeguarding, accessibility,
 * assessment and transcript records. That store is in-memory BY DESIGN: the
 * package that owns learner data must also own its retention policy, its data
 * directory and its wipe path. This module is the other half of that decision —
 * the same `PrivateStore` contract, backed by a file, for the service that has
 * already decided it OWNS the data and is responsible for keeping it.
 *
 * It is PRIVATE for the same reason the in-memory store is private: these
 * records carry learner and guardian identifiers. This file therefore
 * deliberately does NOT import `ledger-store.ts`. There is no code path from
 * here to the public, hash-chained ledger, and adding one would put personal
 * data into a published artefact (Doc 2 §2.5, §15; Doc 16 §3.5). A store that
 * cannot reach the ledger cannot leak into it.
 *
 * WHAT THE FILE STORES
 * One table, `private_records`, holding the id, the kind, the timestamp and
 * the payload as JSON text. The payload is stored as TEXT rather than as a
 * SQLite value because the shape of `data` is arbitrary and owned by the
 * caller: JSON keeps the file readable, portable and inspectable by whoever
 * has to answer for it, with no schema migration to write when a service adds
 * a field.
 *
 * WHY A RECORD THAT CANNOT BE STORED FAILS LOUDLY
 * `JSON.stringify` DROPS a field whose value is `undefined` and a function,
 * silently, and throws on a cycle. A private record that quietly loses a
 * field is worse than a private record that was never written: the first looks
 * like evidence, the second looks like a mistake. Every lossy case is
 * therefore refused here — the write fails, the caller learns, and the store
 * keeps exactly what it accepted.
 *
 * THE MEMORY IS A CACHE, NOT THE SOURCE OF TRUTH
 * Every row is read into memory when the store is opened, and every write
 * goes to the file first and to the memory second. The memory therefore holds
 * exactly the bytes that were persisted, so a record read back after a
 * restart is byte-for-byte the record read back before it — the durable store
 * and the in-memory store do not disagree about what was stored.
 *
 * DEFENSIVE COPIES
 * The in-memory store copies on the way in and on the way out, and so does
 * this one. A caller cannot mutate stored identity data through a record it
 * kept a reference to, nor through a record it read back.
 *
 * PORTABILITY
 * The file path is supplied by the caller and resolved at runtime; no path,
 * user name or drive letter is baked into this source (GLOBAL.md §9). The
 * parent directory is created when it is missing, so a first run on a fresh
 * machine works without an install step.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { PrivateRecord, PrivateRecordKind, PrivateStore } from '@edugenesis/contracts';

import { PRIVATE_RECORD_KINDS } from './private-store.js';

/** Options for `createSqlitePrivateStore`. */
export interface SqlitePrivateStoreOptions {
  /** Absolute path of the SQLite file. The parent directory is created if missing. */
  readonly path: string;
  /** Clock injection for the record timestamp when a caller omits `at`. Defaults to the system clock. */
  readonly now?: () => string;
}

/** The single table this store owns. */
const TABLE = 'private_records';

/**
 * Deep copy of a private record payload.
 *
 * The same contract as the in-memory store: a payload must be plain data.
 */
function copyData(data: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(data);
  } catch {
    throw new Error(
      'A private record payload must be structured-cloneable (plain data only). ' +
        'Functions, class instances with methods and other exotic values are not storable.',
    );
  }
}

/**
 * Serialise a payload to JSON text, refusing every lossy case.
 *
 * `JSON.stringify` drops `undefined` and function values without a word and
 * throws on a cycle. A private record must not lose a field quietly, so each
 * of those is refused here and the write fails loudly instead.
 */
function serialiseData(data: Record<string, unknown>, id: string): string {
  let text: string;
  try {
    text = JSON.stringify(data, (key, value: unknown): unknown => {
      if (value === undefined) {
        throw new TypeError(
          `the field "${key}" is undefined, and JSON would drop it from the record`,
        );
      }
      if (typeof value === 'function') {
        throw new TypeError(`the field "${key}" is a function, which cannot be stored`);
      }
      if (typeof value === 'symbol') {
        throw new TypeError(`the field "${key}" is a symbol, which cannot be stored`);
      }
      if (typeof value === 'bigint') {
        throw new TypeError(`the field "${key}" is a bigint, which cannot be stored`);
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new TypeError(
          `the field "${key}" is a non-finite number, which cannot be stored reproducibly`,
        );
      }
      return value;
    });
  } catch (error) {
    throw new Error(
      `The private record "${id}" cannot be stored: ${(error as Error).message}.`,
    );
  }
  if (typeof text !== 'string') {
    throw new Error(`The private record "${id}" cannot be stored: it produced no JSON.`);
  }
  return text;
}

/** Read a text column, refusing a column that is not text. */
function readText(value: unknown, column: string, id: string): string {
  if (typeof value !== 'string') {
    throw new Error(
      `The private record "${id}" has a "${column}" column that is not text; the store file is corrupt.`,
    );
  }
  return value;
}

/** Parse a stored payload, refusing a row that is not a JSON object. */
function parseData(text: string, id: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `The private record "${id}" does not contain valid JSON: ${(error as Error).message}.`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`The private record "${id}" does not contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Create the durable private store.
 *
 * The returned object satisfies the frozen `PrivateStore` contract, so a
 * service can swap the in-memory store for this one without touching a line
 * of its own code — and the swap changes nothing about what the store
 * guarantees.
 */
export function createSqlitePrivateStore(
  options: SqlitePrivateStoreOptions,
): PrivateStore & { close(): void } {
  if (typeof options.path !== 'string' || options.path.trim().length === 0) {
    throw new Error('The private store needs a non-empty path to its SQLite file.');
  }
  const now = options.now ?? ((): string => new Date().toISOString());

  // Resolved at runtime, never hardcoded: the same build must run from any
  // directory on any machine (GLOBAL.md §9).
  const file = resolve(options.path);
  mkdirSync(dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       id   TEXT PRIMARY KEY,
       kind TEXT NOT NULL,
       at   TEXT NOT NULL,
       data TEXT NOT NULL
     )`,
  );

  const records = new Map<string, PrivateRecord>();
  let closed = false;

  const clone = (record: PrivateRecord): PrivateRecord => ({
    id: record.id,
    kind: record.kind,
    at: record.at,
    data: copyData(record.data),
  });

  // LOAD: the file is the source of truth. A row that cannot be read is a
  // corrupt file, and a corrupt private record must be reported, never
  // skipped: a silently dropped consent record is a safeguarding failure.
  const readRows = db.prepare(
    `SELECT id, kind, at, data FROM ${TABLE} ORDER BY rowid ASC`,
  );
  for (const row of readRows.all()) {
    const id = readText(row['id'], 'id', '<unknown>');
    const kind = readText(row['kind'], 'kind', id);
    const at = readText(row['at'], 'at', id);
    const data = readText(row['data'], 'data', id);
    if (!PRIVATE_RECORD_KINDS.includes(kind as PrivateRecordKind)) {
      throw new Error(
        `The private record "${id}" has an unknown kind "${kind}". ` +
          `Expected one of: ${PRIVATE_RECORD_KINDS.join(', ')}.`,
      );
    }
    records.set(id, { id, kind: kind as PrivateRecordKind, at, data: parseData(data, id) });
  }

  const write = db.prepare(
    `INSERT OR REPLACE INTO ${TABLE} (id, kind, at, data) VALUES (?, ?, ?, ?)`,
  );

  const put = (record: PrivateRecord): void => {
    if (closed) {
      throw new Error('The private store is closed; it cannot accept another record.');
    }
    const candidate = record as unknown as {
      id?: unknown;
      kind?: unknown;
      at?: unknown;
      data?: unknown;
    };
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      throw new Error('A private record needs a non-empty id.');
    }
    if (!PRIVATE_RECORD_KINDS.includes(candidate.kind as PrivateRecordKind)) {
      throw new Error(
        `Unknown private record kind "${String(candidate.kind)}". ` +
          `Expected one of: ${PRIVATE_RECORD_KINDS.join(', ')}.`,
      );
    }
    // A record may arrive without a timestamp; the injected clock supplies one.
    const at = candidate.at === undefined ? now() : candidate.at;
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
      throw new Error('A private record needs a parseable ISO-8601 timestamp.');
    }
    if (
      candidate.data === null ||
      typeof candidate.data !== 'object' ||
      Array.isArray(candidate.data)
    ) {
      throw new Error('A private record needs a data object.');
    }

    const id = candidate.id;
    const kind = candidate.kind as PrivateRecordKind;
    const serialised = serialiseData(candidate.data as Record<string, unknown>, id);

    // The file first, the memory second: a failed write must never leave a
    // record in the cache that is not on disk.
    write.run(id, kind, at, serialised);

    // The in-memory copy is the PARSED text, not the caller's object, so what
    // the store holds now is exactly what a restart would hand back.
    records.set(id, {
      id,
      kind,
      at,
      data: parseData(serialised, id),
    });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    db.close();
  };

  return {
    put,
    get(id: string): PrivateRecord | undefined {
      const found = records.get(id);
      return found ? clone(found) : undefined;
    },
    all(): PrivateRecord[] {
      return [...records.values()].map(clone);
    },
    byKind(kind: PrivateRecordKind): PrivateRecord[] {
      return [...records.values()].filter((record) => record.kind === kind).map(clone);
    },
    close,
  };
}
