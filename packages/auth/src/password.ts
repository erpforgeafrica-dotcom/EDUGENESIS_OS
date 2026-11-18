/**
 * Password hashing with `node:crypto` only.
 *
 * The stored form is a self-describing envelope:
 *   scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>
 * Carrying the parameters means a future cost increase can be verified against
 * old hashes without a migration table.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCHEME = 'scrypt';
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/** scrypt needs roughly 128*N*r bytes; 64 MiB leaves headroom over the defaults. */
const MAX_MEM = 64 * 1024 * 1024;

/** Hash a password with a fresh random salt. Two calls for one password differ. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const derived = scryptSync(password, salt, KEY_LEN, {
    cost: N,
    blockSize: R,
    parallelization: P,
    maxmem: MAX_MEM,
  });
  return [
    SCHEME,
    String(N),
    String(R),
    String(P),
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verify a password against an envelope. Returns false for malformed input and
 * never throws: a corrupt stored value is a failed login, not a server error.
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    if (parts[0] !== SCHEME) return false;

    const n = parsePositiveInt(parts[1] ?? '');
    const r = parsePositiveInt(parts[2] ?? '');
    const p = parsePositiveInt(parts[3] ?? '');
    if (n === null || r === null || p === null) return false;
    // Bound attacker-supplied parameters so verification cannot become a DoS.
    if (n > (1 << 20) || r > 1024 || p > 1024) return false;

    const salt = Buffer.from(parts[4] ?? '', 'base64');
    const expected = Buffer.from(parts[5] ?? '', 'base64');
    if (expected.length === 0) return false;

    const actual = scryptSync(password, salt, expected.length, {
      cost: n,
      blockSize: r,
      parallelization: p,
      maxmem: MAX_MEM,
    });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
