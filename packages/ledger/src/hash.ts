/**
 * EduGenesis OS — deterministic hashing helpers.
 *
 * WHY THIS EXISTS
 * The Generosity and Transparency Ledger is a public, append-only record of where
 * sponsored resources went (Doc 1 v1.2 §6; Doc 2 §15; Doc 16 §3.5). Its entire
 * credibility rests on two properties an auditor can re-check independently:
 *
 *   1. STABILITY — the same logical entry always produces the same hash, on any
 *      machine, in any process, regardless of the order in which the keys of a
 *      payload object happened to be inserted. JavaScript object key order is an
 *      implementation detail of insertion; it must never leak into a hash that
 *      a third party is expected to reproduce.
 *   2. UNIQUENESS — the hash covers a canonical serialisation, so two different
 *      payloads cannot collapse into the same digest.
 *
 * Both are achieved with `canonicalJson()`: a recursive, key-sorted serialiser.
 * Object keys are sorted by code unit (`Array.prototype.sort` default), which is
 * locale-independent — a locale-aware sort would make the chain non-reproducible
 * on a machine with a different locale, which is exactly the portability failure
 * the platform must avoid (GLOBAL.md §9 portability law).
 *
 * ARRAYS KEEP THEIR ORDER. Unlike object keys, array order is semantically
 * meaningful in a ledger (it encodes the order of operations, e.g. a sequence of
 * allocations), so arrays are never sorted. Sorting them would silently destroy
 * information while still producing a "valid" hash — the worst kind of bug in an
 * append-only record.
 *
 * ZERO DEPENDENCIES. `node:crypto` is a built-in; the platform ships no runtime
 * dependencies at all (ADR-0014), so the hash of a public proof can be recomputed
 * by anyone with a stock Node install and a text editor.
 */

import { createHash } from 'node:crypto';

/** A JSON value that survives canonicalisation without loss. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * SHA-256 of a UTF-8 string, lowercase hex.
 *
 * SHA-256 is chosen because it is (a) in every platform's trust store, so an
 * auditor can recompute a proof without installing anything, and (b) collision
 * resistant enough that a deliberate chain edit cannot produce a valid-looking
 * entry. The lowercase hex encoding matches what a standard `sha256sum` produces,
 * so the proof can be checked with `sha256sum` on Linux, `Get-FileHash` on
 * Windows, or `shasum -a 256` on macOS.
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Recursively rewrite a value into its canonical form.
 *
 * - Objects: keys sorted by code unit, `undefined` properties dropped (JSON has
 *   no representation for them, and dropping is deterministic).
 * - Arrays: order preserved (see the file header).
 * - Numbers: must be finite. `NaN` and `Infinity` serialise to `null` in JSON,
 *   which would make two different payloads hash identically — a silent
 *   collision in a tamper-evident record. They are rejected instead.
 */
function canonicalize(value: unknown, path: string): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `Cannot canonicalise a non-finite number at "${path}": ` +
          'NaN and Infinity would serialise to null and collide with a null payload.',
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    const out: JsonValue[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      out.push(canonicalize(item, `${path}[${i}]`));
    }
    return out;
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    // Default string sort = code-unit order = locale independent.
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child === undefined) continue;
      out[key] = canonicalize(child, path === '' ? key : `${path}.${key}`);
    }
    return out;
  }
  throw new TypeError(
    `Cannot canonicalise a value of type "${typeof value}" at "${path}": ` +
      'only strings, numbers, booleans, null, arrays and plain objects are permitted.',
  );
}

/**
 * Canonical JSON serialisation: stable key order, array order preserved.
 *
 * Two objects that differ only in key insertion order produce byte-identical
 * output, which is what makes the ledger hash reproducible by a third party.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, ''));
}

/**
 * SHA-256 over the canonical JSON form of a value.
 *
 * Convenience wrapper used by the ledger entry hash and the Merkle tree so that
 * no call site can accidentally hash a non-canonical serialisation.
 */
export function sha256Canonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * SHA-256 over the concatenation of byte arrays.
 *
 * Used by the Merkle tree to hash a left/right node pair. Kept in this module so
 * that every hash in the ledger package is produced by the same, single code
 * path — an auditor can then trust that "the ledger hashes things with SHA-256"
 * means exactly one thing.
 */
export function sha256Bytes(...parts: readonly Uint8Array[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}
