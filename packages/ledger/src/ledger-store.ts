/**
 * EduGenesis OS — the public, append-only, hash-chained Generosity and
 * Transparency Ledger.
 *
 * WHY A HASH CHAIN
 * The platform's promise to a sponsor is not "we will spend your money well" but
 * "anyone can check that we did". Doc 1 v1.2 §6 and Doc 16 §3.5 make the ledger
 * the artefact that carries that promise, and Doc 2 §15 fixes its properties:
 *
 *   - APPEND ONLY. An entry is never mutated and never deleted.
 *   - TAMPER EVIDENT. Every entry commits to its predecessor, so editing entry
 *     N invalidates entries N+1..end. `verify()` recomputes the whole chain.
 *   - NO PERSONAL DATA, EVER (Doc 2 §2.5). The payload may only carry hashes,
 *     counters and proofs. The 21 forbidden field names in the frozen contract
 *     are refused at append time, recursively.
 *
 * CORRECTION DISCIPLINE (Doc 2 §15; Doc 16 §3.5)
 * There is NO update and NO delete operation, and none may be added: an
 * append-only record that can be rewritten is not a record, it is a marketing
 * page. A mistake is corrected by appending a COMPENSATING entry that names the
 * seq it corrects and quotes the hash of the entry it corrects — see
 * `appendCorrection()`. The wrong entry stays visible forever; the compensation
 * sits after it; the chain stays verifiable end to end. This is the same rule
 * that makes a blockchain auditable, applied to a few hundred entries a year.
 *
 * HASH PREIMAGE
 * `entryHash = SHA-256(canonicalJson({ seq, type, at, payload,
 * previousEntryHash }))`. The canonical serialisation sorts object keys, so a
 * third party can recompute the digest from the published entry without knowing
 * anything about this implementation. `previousEntryHash` is the literal string
 * "genesis" for seq 1 and the previous entry's `entryHash` thereafter.
 *
 * PAYLOAD SHAPE
 * The frozen contract types a payload as `Record<string, string | number |
 * boolean | null>` — flat scalars only. The append path therefore accepts a
 * nested structure at runtime (so it can be INSPECTED by the PII guard) but
 * stores it as its canonical JSON string, which keeps the stored payload
 * contract-shaped while preserving the exact bytes that were hashed. A nested
 * structure is never flattened into a lossy summary.
 */

import {
  LedgerTamperError,
  type ChainVerification,
  type LedgerEntry,
  type LedgerEntryType,
  type LedgerStore,
  type PublicProof,
} from '@edugenesis/contracts';

import { canonicalJson, sha256Bytes, sha256Hex } from './hash.js';
import { findForbiddenFieldPaths, findPersonalDataValues } from './pii-guard.js';

/** The previous-hash value used for the first entry of a chain. */
export const GENESIS_HASH = 'genesis';

/** Domain-separation tag for the Merkle root of an empty ledger. */
export const MERKLE_EMPTY_DOMAIN = 'edugenesis.ledger.merkle.empty.v1';

/** The payload type accepted by `append` (contract-compatible for flat values). */
export type LedgerPayload = Record<string, string | number | boolean | null>;

/**
 * The ledger store with the wider `append` input type.
 *
 * `LedgerStore.append` in the frozen contract takes a flat payload. The store
 * additionally accepts a nested structure at runtime so that the recursive PII
 * check can inspect it — the guard must see what the caller actually sent, not
 * a type-narrowed version of it. This interface extends the contract type, so
 * it remains assignable to `LedgerStore`.
 */
export interface LedgerStoreFacade extends LedgerStore {
  append(type: LedgerEntryType, payload: Record<string, unknown>, at?: string): LedgerEntry;
}

/** Options for `createLedgerStore`. */
export interface LedgerStoreOptions {
  /** Clock injection, so tests and replays are deterministic. */
  now?: () => string;
  /**
   * Value-level PII scanning on append. Default `enforce`.
   *
   * `off` exists only for a controlled migration of an existing store; the
   * field-name rule can never be switched off.
   */
  valueScan?: 'enforce' | 'off';
}

/** Thrown when a payload would put personal data into the public ledger. */
export class LedgerPiiError extends Error {
  public readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(
      `Refused to append to the public ledger: ${violations.length} personal-data violation(s). ` +
        `The ledger is published and cannot be retracted (Doc 2 §2.5, Doc 16 §3.5). Violations: ` +
        violations.join('; '),
    );
    this.name = 'LedgerPiiError';
    this.violations = violations;
  }
}

/** Thrown when a payload violates the ledger's structural rules. */
export class LedgerPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerPayloadError';
  }
}

/**
 * Keys that carry money. Their values MUST be integers in minor units.
 *
 * The platform never uses floating point for money: `0.1 + 0.2 !== 0.3` in
 * IEEE-754, and a ledger that cannot add up is not evidence of anything. Money
 * is counted in cents (integer minor units) everywhere in this package.
 */
const MONEY_KEY_PATTERN = /(^|_)(cents?|minor_units)$/i;

/**
 * The exact preimage of an entry hash.
 *
 * Module-internal: `computeEntryHash` is the public verifier, and an auditor
 * needs the hash, not the preimage. Keeping this private stops the public
 * surface from carrying a function no caller needs.
 */
function entryHashPreimage(entry: Omit<LedgerEntry, 'entryHash'>): {
  seq: number;
  type: LedgerEntryType;
  at: string;
  payload: LedgerPayload;
  previousEntryHash: string;
} {
  return {
    seq: entry.seq,
    type: entry.type,
    at: entry.at,
    payload: entry.payload,
    previousEntryHash: entry.previousEntryHash,
  };
}

/**
 * Recompute the hash of an entry.
 *
 * Exported so an auditor (or a test) can verify a chain with nothing but this
 * function and the published entry.
 */
export function computeEntryHash(entry: LedgerEntry): string {
  return sha256Hex(canonicalJson(entryHashPreimage(entry)));
}

/**
 * Validate and canonicalise a payload into the flat, contract-shaped form that
 * is stored and hashed.
 *
 * Nested objects and arrays become their canonical JSON string: the stored
 * payload stays `Record<string, string | number | boolean | null>` as the frozen
 * contract requires, and the bytes that were hashed are exactly the bytes that
 * are stored, so verification remains exact.
 */
function canonicalisePayload(payload: Record<string, unknown>): LedgerPayload {
  const out: LedgerPayload = {};
  for (const key of Object.keys(payload)) {
    const value = payload[key];
    if (value === undefined) continue;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new LedgerPayloadError(
          `Payload field "${key}" is not a finite number; a non-finite value cannot be hashed reproducibly.`,
        );
      }
      if (MONEY_KEY_PATTERN.test(key)) {
        if (!Number.isInteger(value)) {
          throw new LedgerPayloadError(
            `Payload field "${key}" carries money and must be an integer number of minor units (cents). ` +
              `Floating point money is forbidden because it cannot be reconciled exactly.`,
          );
        }
        if (value < 0) {
          // A negative amount is a sign, not an amount. Every money field in
          // this ledger records something that WAS spent, allocated or
          // received, and each of those is non-negative. A refund or a
          // reversal must be its own entry type, so that the public chain
          // never needs a negative number to express it.
          throw new LedgerPayloadError(
            `Payload field "${key}" carries money and must not be negative (got ${String(value)}). ` +
              `A refund or a reversal must be recorded as its own entry type, not as a negative amount.`,
          );
        }
      }
      out[key] = value;
      continue;
    }
    if (typeof value === 'object') {
      out[key] = canonicalJson(value);
      continue;
    }
    throw new LedgerPayloadError(
      `Payload field "${key}" has unsupported type "${typeof value}". ` +
        'A ledger payload may only contain strings, numbers, booleans, null, or nested structures.',
    );
  }
  return out;
}

/** Validate an ISO-8601 timestamp. */
function assertTimestamp(at: string): void {
  if (typeof at !== 'string' || at.length === 0) {
    throw new LedgerPayloadError('A ledger entry needs an ISO-8601 timestamp.');
  }
  if (Number.isNaN(Date.parse(at))) {
    throw new LedgerPayloadError(`"${at}" is not a parseable ISO-8601 timestamp.`);
  }
}

/**
 * Create the public ledger.
 *
 * The store owns its entries: the sequence number is assigned by the store and
 * can never be supplied by a caller, which is what makes it impossible to
 * overwrite an earlier seq.
 */
export function createLedgerStore(options: LedgerStoreOptions = {}): LedgerStoreFacade {
  const now = options.now ?? ((): string => new Date().toISOString());
  const valueScan = options.valueScan ?? 'enforce';
  const entries: LedgerEntry[] = [];

  const append = (type: LedgerEntryType, payload: Record<string, unknown>, at?: string): LedgerEntry => {
    // LINE 1 of defence: forbidden field names, recursively (Doc 2 §2.5).
    const violations: string[] = findForbiddenFieldPaths(payload).map(
      (path) => `forbidden field name at "${path}"`,
    );
    // LINE 2 of defence: value shapes that identify a person.
    if (valueScan === 'enforce') {
      violations.push(...findPersonalDataValues(payload));
    }
    if (violations.length > 0) {
      throw new LedgerPiiError(violations);
    }

    const flatPayload = canonicalisePayload(payload);
    const timestamp = at ?? now();
    assertTimestamp(timestamp);

    const seq = entries.length + 1;
    const previous = entries[entries.length - 1];
    const previousEntryHash = previous ? previous.entryHash : GENESIS_HASH;
    const preimage = entryHashPreimage({ seq, type, at: timestamp, payload: flatPayload, previousEntryHash });
    const entryHash = sha256Hex(canonicalJson(preimage));

    const entry: LedgerEntry = {
      seq,
      type,
      at: timestamp,
      payload: flatPayload,
      previousEntryHash,
      entryHash,
    };
    entries.push(entry);
    return entry;
  };

  const all = (): LedgerEntry[] => {
    // The LIVE entry array.
    //
    // WHY: the chain is tamper-EVIDENT, not tamper-resistant (Doc 2 §15). An
    // auditor must be able to reach the stored bytes to try to alter them, and
    // `verify()` must then report the break with the right seq. A copy here
    // would make the tamper scenario untestable and would give a false sense
    // of immutability.
    //
    // TREAT THE RESULT AS READ-ONLY. Do not sort, splice or push into it: the
    // sequence numbers are the chain. `exportPublic()` is the safe,
    // copy-returning accessor for anything you hand to somebody else.
    return entries;
  };

  const verify = (): ChainVerification => {
    let entriesChecked = 0;
    for (const [index, entry] of entries.entries()) {
      entriesChecked = index + 1;
      const expectedSeq = index + 1;
      if (entry.seq !== expectedSeq) {
        return {
          ok: false,
          entriesChecked,
          brokenAtSeq: expectedSeq,
          detail:
            `entry at position ${expectedSeq} declares seq ${entry.seq}; ` +
            'the sequence must be monotonic from 1',
        };
      }
      const previous = entries[index - 1];
      const expectedPrevious = previous ? previous.entryHash : GENESIS_HASH;
      if (entry.previousEntryHash !== expectedPrevious) {
        return {
          ok: false,
          entriesChecked,
          brokenAtSeq: entry.seq,
          detail:
            `previousEntryHash does not match the entryHash of seq ${expectedSeq - 1}; ` +
            'the link between this entry and its predecessor is broken',
        };
      }
      const expectedHash = computeEntryHash(entry);
      if (entry.entryHash !== expectedHash) {
        return {
          ok: false,
          entriesChecked,
          brokenAtSeq: entry.seq,
          detail: 'entryHash does not match the hash recomputed from the entry contents',
        };
      }
    }
    return { ok: true, entriesChecked };
  };

  const exportPublic = (): PublicProof[] =>
    entries.map((entry) => ({
      seq: entry.seq,
      type: entry.type,
      at: entry.at,
      payload: { ...entry.payload },
      entryHash: entry.entryHash,
      previousEntryHash: entry.previousEntryHash,
    }));

  const merkleRoot = (): string => {
    if (entries.length === 0) return sha256Hex(MERKLE_EMPTY_DOMAIN);
    let level: Buffer[] = entries.map((entry) => Buffer.from(entry.entryHash, 'hex'));
    while (level.length > 1) {
      const next: Buffer[] = [];
      for (let index = 0; index < level.length; index += 2) {
        const pair = level.slice(index, index + 2);
        const left = pair[0];
        const right = pair.length > 1 ? pair[1] : pair[0];
        if (left === undefined || right === undefined) {
          throw new Error('Merkle level became inconsistent; this is a programming error.');
        }
        // An odd node is paired with a copy of itself (the standard duplication
        // rule), so the tree shape depends only on the leaf count.
        next.push(sha256Bytes(left, right));
      }
      level = next;
    }
    const root = level[0];
    if (root === undefined) {
      throw new Error('Merkle root could not be computed; this is a programming error.');
    }
    return root.toString('hex');
  };

  return { append, all, verify, exportPublic, merkleRoot };
}

/** Input for `appendCorrection`. */
export interface CorrectionInput {
  /** The seq of the entry being corrected. */
  correctsSeq: number;
  /** Why the correction is being made (free text, but stored in the ledger). */
  reason: string;
  /** Extra payload fields to record with the compensation. */
  payload?: LedgerPayload;
  /** Entry type of the compensation. Defaults to `reconciliation_proof`. */
  type?: LedgerEntryType;
  /** Timestamp of the compensation. */
  at?: string;
}

/**
 * Append a COMPENSATING entry that corrects an earlier entry.
 *
 * This is the ONLY way to answer for a mistake. Nothing is edited and nothing
 * is deleted: the original entry stays in the chain, the compensation names it
 * by seq and by hash, and both remain verifiable forever (Doc 2 §15).
 */
export function appendCorrection(store: LedgerStore, input: CorrectionInput): LedgerEntry {
  const target = store.all().find((entry) => entry.seq === input.correctsSeq);
  if (!target) {
    throw new LedgerPayloadError(`Cannot correct seq ${input.correctsSeq}: no such entry.`);
  }
  const payload: LedgerPayload = {
    corrects_seq: target.seq,
    corrects_entry_hash: target.entryHash,
    reason: input.reason,
    ...(input.payload ?? {}),
  };
  return store.append(input.type ?? 'reconciliation_proof', payload, input.at);
}

/**
 * Throw `LedgerTamperError` when the chain does not verify.
 *
 * The frozen contract's error type exists for exactly this: a caller that must
 * refuse to act on a broken ledger gets a typed error naming the broken seq.
 */
export function assertChainIntact(store: LedgerStore): void {
  const result = store.verify();
  if (!result.ok) {
    throw new LedgerTamperError(result.brokenAtSeq ?? 0, result.detail ?? 'chain verification failed');
  }
}
