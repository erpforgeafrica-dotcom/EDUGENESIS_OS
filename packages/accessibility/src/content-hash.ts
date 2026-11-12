/**
 * Deterministic hashing of canonical content.
 *
 * ARC-I9 is a tamper and drift check: `metadata.content_hash` must match the
 * canonical content bytes (07 §5.3). The bytes are produced by canonicalising
 * the content first — object keys sorted at every depth, array order kept —
 * so that the same content always yields the same digest regardless of how
 * the emitting service happened to build the object, and so that any real
 * change to the content changes the digest.
 *
 * The digest shape is `sha256:<hex>` because the reference emission in
 * 07 §5.2 records `"content_hash": "sha256:…"`.
 */
import { createHash } from 'node:crypto';

import type { CanonicalContent } from '@edugenesis/contracts';

const HASH_ALGORITHM = 'sha256';
const HASH_PREFIX = 'sha256:';

/**
 * Serialises a value to canonical JSON: object keys sorted, array order
 * preserved, `undefined` properties omitted. Anything that cannot be
 * represented canonically is refused loudly rather than silently dropped —
 * a dropped field would change the digest without changing the content.
 */
function canonicaliseValue(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `value at "${path}" cannot be canonicalised: ${String(value)} is not a finite number`,
        );
      }
      return JSON.stringify(value);
    case 'undefined':
      return 'null';
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new TypeError(
        `value at "${path}" cannot be canonicalised: a ${typeof value} has no canonical JSON form`,
      );
    default:
      break;
  }

  if (typeof value === 'object') {
    if (value instanceof Date) {
      const time = value.getTime();
      if (Number.isNaN(time)) {
        throw new TypeError(`value at "${path}" cannot be canonicalised: invalid date`);
      }
      return JSON.stringify(value.toISOString());
    }
    if (Array.isArray(value)) {
      const items = value.map((item, index) => canonicaliseValue(item, `${path}[${index}]`));
      return `[${items.join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicaliseValue(record[key], `${path}.${key}`)}`,
    );
    return `{${parts.join(',')}}`;
  }

  throw new TypeError(`value at "${path}" cannot be canonicalised`);
}

/** The canonical JSON text of a canonical content payload. */
export function canonicaliseContent(canonical: CanonicalContent): string {
  return canonicaliseValue(canonical, 'canonical_content');
}

/**
 * The ARC-I9 digest of a canonical content payload: `sha256:<hex>`.
 * Two payloads with the same meaning hash identically; any change to the
 * content — body, media size, payload — changes the digest.
 */
export function hashCanonicalContent(canonical: CanonicalContent): string {
  const digest = createHash(HASH_ALGORITHM)
    .update(canonicaliseContent(canonical), 'utf8')
    .digest('hex');
  return `${HASH_PREFIX}${digest}`;
}
