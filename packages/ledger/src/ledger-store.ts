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
 * THE SEQUENCE BELONGS TO THE STORE
 * A caller can never supply a seq, and — this is the part that is easy to get
 * wrong — a caller can never STEAL one either. The seq comes from the store's
 * own counter and the link comes from the store's own head, never from the
 * length of an array the store happened to hand out. So two appends that
 * overlap still take two different seq values and produce ONE chain: the
 * append path is a critical section with no caller-supplied code inside it,
 * and the entry is written before `append()` returns.
 *
 * The store also keeps its OWN RECORD of what it wrote. A caller that splices
 * an entry into the live array can produce an entry whose own hash is
 * perfectly valid — the hash links alone cannot see that — so the store
 * compares the chain it is about to extend with the chain it wrote, and
 * refuses to extend one that is not the same. A seq is never issued twice and
 * an entry the store never wrote is never adopted.
 *
 * THE CHAIN IS VERIFIED ON READ AND ON WRITE
 * A tamper-evident record that is only checked when somebody remembers to ask
 * is not tamper evident at the moment it matters. So:
 *
 *   - the WRITE path verifies the chain before it extends it. A broken chain
 *     must not grow: a compensation cannot repair a severed hash link.
 *   - the TRUSTED reads — the public export and the merkle root — refuse a
 *     broken chain with the contract's typed error, `LedgerTamperError`.
 *   - `verify()` never throws. It REPORTS. An auditor must be able to read a
 *     broken chain and be told exactly where it broke; that report is the
 *     same one the refusals quote.
 *   - `all()` is the safe read accessor: it returns defensive copies and
 *     deliberately does not refuse, so a broken chain stays readable.
 *     `rawEntries()` is the RAW access for auditor/tamper-test tooling — it
 *     hands out the stored objects so a break can be exercised and reported
 *     at the right seq.
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
  /**
   * The RAW, live chain — for auditors and tamper tests only (F5-04).
   *
   * `all()` is the safe read accessor and returns defensive copies. This
   * accessor deliberately hands out the stored objects so an auditor can try
   * to alter them and see `verify()` report the break. It is NOT a trust
   * boundary and must never be used to hand data to a third party; use
   * `exportPublic()` for that.
   */
  rawEntries(): LedgerEntry[];
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
  /**
   * The durable sink behind the store (ADR-0019, owner decision 2026-11-16).
   *
   * THE CONSTRAINED HOOK CONTRACT. This hook is called inside the append
   * critical section, BEFORE anything is written to memory (file first,
   * memory second, as `sqlite-private-store.ts` puts it). It is therefore
   * bound by rules stricter than an ordinary caller:
   *
   *   - SYNCHRONOUS. It must not return a promise; an append returns only
   *     when the row is on disk.
   *   - NON-REENTRANT. It must not call back into the store — the critical
   *     section admits no reentry, or the seq discipline it guarantees
   *     collapses.
   *   - ATOMIC, COMMIT-OR-NOTHING. A hook that throws must not have
   *     committed the row; a committed row with a thrown hook would wedge
   *     the ledger on the next append (the UNIQUE seq catches it as a raw
   *     error). The shipped journal is a single INSERT, which is atomic by
   *     construction; custom sinks must honour the same rule.
   *
   * A hook that throws aborts the append with NOTHING in memory: no seq is
   * consumed, the head does not move, and the error propagates to the
   * caller typed by the sink (`LedgerPersistenceError` for the shipped
   * journal). This is why the hook, though caller-supplied, may live inside
   * the critical section the no-caller-code rule protects: it is
   * construction-time infrastructure owned by the application (its own
   * journal), not per-request caller code, and its failure is a clean
   * abort rather than an interleaving window.
   *
   * Absent, the store behaves exactly as before — nothing durable happens.
   */
  persist?: (entry: LedgerEntry) => void;
  /**
   * The state restored from a durable journal at construction (ADR-0019).
   *
   * The rows are taken as the chain the store CONTINUES: `entries`, the
   * store's own record, the head and the sequence counter are all rebuilt
   * from them, and the `persist` hook is NOT fired for restored rows — a
   * restart must never re-insert what is already on disk.
   *
   * THREE RESTORE RULES:
   *   - the rows are NOT re-checked by the PII guard. Guard rules can
   *     evolve after an entry was published; rehydration must not wedge
   *     the boot on a rule that did not exist when the entry was appended.
   *     Everything appended AFTER the restore is guarded as always.
   *   - a broken restored chain is NOT fatal to boot (load, report, don't
   *     refuse, as the durable audit log puts it): `verify()` reports the
   *     break at its seq, the evidence stays readable through `all()`,
   *     and every trust boundary — including the write path — refuses.
   *   - the rows must be in seq order, ascending from the journal; the
   *     journal guarantees it.
   */
  initialEntries?: readonly LedgerEntry[];
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

/**
 * Strict ISO-8601 instant form.
 *
 * F5-12: `Date.parse` accepts many locale-dependent spellings (`2026/01/05`,
 * `January 5, 2026`, a bare date with no time). A public, hash-chained record
 * needs ONE unambiguous encoding, so only an ISO-8601 instant with an explicit
 * time and a `Z` or numeric UTC offset is admitted. The stored and hashed form
 * is then always the normalised UTC `toISOString()` of that instant.
 */
const ISO_8601_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Validate a strict ISO-8601 instant and return its normalised UTC form. */
function normalizeTimestamp(at: string): string {
  if (typeof at !== 'string' || at.length === 0) {
    throw new LedgerPayloadError('A ledger entry needs a strict ISO-8601 timestamp.');
  }
  if (!ISO_8601_INSTANT.test(at)) {
    throw new LedgerPayloadError(
      `"${at}" is not a strict ISO-8601 timestamp; expected e.g. 2026-01-05T00:00:00.000Z.`,
    );
  }
  const milliseconds = Date.parse(at);
  if (Number.isNaN(milliseconds)) {
    throw new LedgerPayloadError(`"${at}" is not a valid ISO-8601 instant.`);
  }
  return new Date(milliseconds).toISOString();
}

/** Defensive copy of a stored entry (the payload is flat scalar data). */
function cloneEntry(entry: LedgerEntry): LedgerEntry {
  return { ...entry, payload: { ...entry.payload } };
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
  // The durable sink, captured once at construction (ADR-0019). Undefined
  // means the store is exactly as it was before durability: nothing changes.
  const persist = options.persist;
  /**
   * THE LIVE VIEW: the array the store hands to callers through `all()`.
   *
   * It is live on purpose — see `all()`. It is NOT the store's record of the
   * chain: a caller can reach it and alter it, which is exactly how tamper
   * evidence is exercised.
   */
  const entries: LedgerEntry[] = [];

  /**
   * THE STORE'S OWN RECORD: the entries this store actually wrote, in order.
   *
   * The sequence counter, the head and this array belong to the STORE, not to
   * the caller. A caller that splices the live view cannot make the store
   * issue a seq twice, slide its sequence back, or adopt an entry the store
   * never wrote.
   */
  const written: LedgerEntry[] = [];
  /** The next seq the store will issue. The store's own counter, never `entries.length`. */
  let nextSeq = 1;
  /** The last entry the store wrote. The store's own head, never `entries[entries.length - 1]`. */
  let head: LedgerEntry | undefined;

  // ADR-0019 RESTORE: rebuild the store's whole state from the durable rows.
  // The live view and the store's own record both start from the restored
  // chain (a restored row IS a row the store wrote — the journal verified it
  // on open), the head is the last restored row, and the counter continues
  // from its seq. No guard re-check, no persist call, no boot refusal on a
  // broken chain: the rules are stated on `LedgerStoreOptions.initialEntries`.
  if (options.initialEntries !== undefined) {
    for (const restored of options.initialEntries) {
      entries.push(restored);
      written.push(restored);
    }
    const last = entries[entries.length - 1];
    head = last;
    nextSeq = last === undefined ? 1 : last.seq + 1;
  }

  /**
   * Where the chain the caller can see stops being the chain the store wrote.
   *
   * The hash links alone cannot see an injected entry: an attacker who
   * splices in an entry with a valid hash of its own produces a chain whose
   * every link checks out. The store's own record is the only thing that can
   * tell the difference, so the difference is checked.
   */
  const chainDivergence = (): { brokenAtSeq: number; detail: string } | undefined => {
    const shared = Math.min(entries.length, written.length);
    for (let index = 0; index < shared; index += 1) {
      if (entries[index] !== written[index]) {
        return {
          brokenAtSeq: index + 1,
          detail:
            `the entry at position ${index + 1} is not the entry this store wrote; ` +
            'the chain was altered outside the store',
        };
      }
    }
    if (entries.length > written.length) {
      return {
        brokenAtSeq: written.length + 1,
        detail:
          `the chain holds ${entries.length} entries but this store wrote ${written.length}; ` +
          'an entry was inserted into the chain',
      };
    }
    if (entries.length < written.length) {
      return {
        brokenAtSeq: entries.length + 1,
        detail:
          `the chain holds ${entries.length} entries but this store wrote ${written.length}; ` +
          'an entry was removed from the chain',
      };
    }
    return undefined;
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
    // The store's own record is the last word: a chain that holds an entry
    // the store never wrote — or is missing one it wrote — is broken, even
    // when every hash in it is internally consistent.
    const divergence = chainDivergence();
    if (divergence) {
      return {
        ok: false,
        entriesChecked: entries.length,
        brokenAtSeq: divergence.brokenAtSeq,
        detail: divergence.detail,
      };
    }
    return { ok: true, entriesChecked };
  };

  /**
   * Refuse to act on a chain that does not verify.
   *
   * The same typed error the contract defines for exactly this condition, and
   * the same seq and detail `verify()` reports — a caller never has to guess
   * which chain it is looking at.
   */
  const assertChainVerifiable = (): void => {
    const result = verify();
    if (!result.ok) {
      throw tamperError(result);
    }
  };

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
    const timestamp = normalizeTimestamp(at ?? now());

    // THE CHAIN IS VERIFIED BEFORE IT IS EXTENDED. A broken chain must not
    // grow: a compensating entry cannot repair a severed hash link, so
    // extending one would bury the break under more evidence.
    assertChainVerifiable();

    // ---- THE CRITICAL SECTION ---------------------------------------------
    // Nothing between here and the push may run per-request caller-supplied
    // code. The seq comes from the store's own counter and the link from the
    // store's own head, and the entry is written before `append()` returns.
    // That is what makes two appends that OVERLAP take two different seq
    // values and produce ONE chain: there is no window in which two writers
    // can read the same head and claim the same seq.
    //
    // THE ONE EXEMPTION IS THE PERSIST HOOK (ADR-0019): it is supplied ONCE
    // at construction by the application that owns the store (its own
    // durable journal), never per request. It is bound by the constrained
    // hook contract on `LedgerStoreOptions.persist` — synchronous,
    // non-reentrant, atomic commit-or-nothing — and it runs FILE FIRST: a
    // hook that throws aborts the append with nothing in memory, no seq
    // consumed, the head unmoved. Its failure is a clean abort, not an
    // interleaving window, which is what the no-caller-code rule exists to
    // prevent.
    const seq = nextSeq;
    const previousEntryHash = head ? head.entryHash : GENESIS_HASH;
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
    if (persist) persist(entry);
    entries.push(entry);
    written.push(entry);
    head = entry;
    nextSeq = seq + 1;
    return entry;
  };

  const all = (): LedgerEntry[] => {
    // F5-04: the safe read accessor returns DEFENSIVE COPIES. Holding a
    // reference from `all()` can no longer mutate, splice or push into the
    // published chain, so append-only is a property of the code and not a
    // matter of caller discipline. A broken chain is still readable here —
    // this accessor never refuses; the TRUSTED reads (`exportPublic()`,
    // `merkleRoot()`) and the write path do.
    return entries.map(cloneEntry);
  };

  const rawEntries = (): LedgerEntry[] => {
    // The LIVE entry array, moved here from `all()` so tamper evidence stays
    // exercisable. Auditor/tamper-test tooling only: mutating a row here is how
    // a test asks `verify()` to report a break at the right seq. The store's
    // own `written` record still detects an inserted/removed entry even when
    // the hashes of the altered chain are internally consistent.
    return entries;
  };

  const exportPublic = (): PublicProof[] => {
    // A public proof is published to a sponsor. Publishing one drawn from a
    // broken chain would be a lie with a hash on it.
    assertChainVerifiable();
    return entries.map((entry) => ({
      seq: entry.seq,
      type: entry.type,
      at: entry.at,
      payload: { ...entry.payload },
      entryHash: entry.entryHash,
      previousEntryHash: entry.previousEntryHash,
    }));
  };

  const merkleRoot = (): string => {
    // The merkle root is an anchor over the chain: a sponsor who pins it must
    // be pinning the chain the store actually wrote.
    assertChainVerifiable();
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

  return { append, all, rawEntries, verify, exportPublic, merkleRoot };
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
 * Build the contract's typed tamper error from a verification report.
 *
 * ONE error type for ONE condition. Every refusal — the write path, the
 * public export, the merkle root and `assertChainIntact()` — quotes the seq
 * the chain broke at and the detail `verify()` reports, so a caller is never
 * left guessing which chain it refused.
 */
function tamperError(result: ChainVerification): LedgerTamperError {
  return new LedgerTamperError(result.brokenAtSeq ?? 0, result.detail ?? 'chain verification failed');
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
    throw tamperError(result);
  }
}
