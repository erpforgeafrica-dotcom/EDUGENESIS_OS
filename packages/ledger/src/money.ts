/**
 * EduGenesis OS — money primitives.
 *
 * WHY MONEY IS AN INTEGER
 * A ledger that cannot add up cannot be evidence. `0.1 + 0.2 === 0.30000000000000004`
 * in IEEE-754, so a float-based ledger would show a sponsor a total that is
 * off by fractions of a cent and could not be reconciled with a bank statement
 * — the exact opposite of the transparency the platform promises (Doc 1 v1.2 §6;
 * Doc 2 §15).
 *
 * THEREFORE: every monetary value in this package is an INTEGER number of
 * minor units (cents). No float ever holds a monetary amount. Where a division
 * is unavoidable (cost per task), the division is performed in integer
 * arithmetic with an explicit rounding rule, so the result is reproducible and
 * never drifts.
 */

/** The payload fields that may carry a monetary amount, in priority order. */
export const MONEY_FIELD_CANDIDATES: readonly string[] = [
  'amount_cents',
  'amount_minor_units',
  'amount',
];

/** The canonical money field for ledger payloads. */
export const MONEY_FIELD = 'amount_cents';

/** The outcome of reading a monetary amount from a payload. */
export interface AmountReadResult {
  ok: boolean;
  /** The amount in minor units (cents). Present only when `ok` is true. */
  cents?: number;
  /** The field the amount came from. Present only when `ok` is true. */
  field?: string;
  /** Why the amount could not be read. Present only when `ok` is false. */
  reason?: string;
}

/**
 * Read a monetary amount from a ledger payload.
 *
 * `amount_cents` is canonical; `amount_minor_units` and `amount` are accepted
 * aliases (all three are minor units). A non-integer or negative value is
 * REFUSED rather than rounded, because a silently rounded amount is a
 * misstatement in a public record.
 */
export function readAmountCents(payload: Record<string, string | number | boolean | null>): AmountReadResult {
  for (const field of MONEY_FIELD_CANDIDATES) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const value = payload[field];
    if (typeof value !== 'number') {
      return {
        ok: false,
        reason: `field "${field}" is not a number (${typeof value}); money must be integer minor units`,
      };
    }
    if (!Number.isInteger(value)) {
      return {
        ok: false,
        reason: `field "${field}" is not an integer (${value}); money must be integer minor units (cents)`,
      };
    }
    if (value < 0) {
      return { ok: false, reason: `field "${field}" is negative (${value})` };
    }
    if (!Number.isSafeInteger(value)) {
      return { ok: false, reason: `field "${field}" exceeds the safe integer range` };
    }
    return { ok: true, cents: value, field };
  }
  return {
    ok: false,
    reason: `no money field present (expected one of ${MONEY_FIELD_CANDIDATES.join(', ')})`,
  };
}

/**
 * Integer division with round-half-up, computed exactly.
 *
 * `roundDiv(10, 3) === 3`, `roundDiv(-10, 3) === -3`, `roundDiv(5, 2) === 3`.
 * Used for cost-per-task so the published figure is reproducible and never
 * carries a float rounding artefact.
 */
export function roundDiv(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new Error('roundDiv operates on integers only; money is never a float.');
  }
  if (denominator === 0) {
    throw new Error('roundDiv cannot divide by zero.');
  }
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  const negative = n < 0n !== d < 0n;
  const absN = n < 0n ? -n : n;
  const absD = d < 0n ? -d : d;
  const magnitude = (2n * absN + absD) / (2n * absD);
  return Number(negative ? -magnitude : magnitude);
}

/**
 * Sum integer minor-unit amounts exactly.
 *
 * The sum is computed in BigInt so a long chain of cent amounts cannot lose a
 * cent to floating point, and the result is returned as a number only after a
 * safe-integer check.
 */
export function sumCents(values: readonly number[]): number {
  let total = 0n;
  for (const value of values) {
    if (!Number.isInteger(value)) {
      throw new Error(`Cannot sum a non-integer money value (${value}); money is integer minor units.`);
    }
    total += BigInt(value);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('Money total exceeds the safe integer range.');
  }
  return Number(total);
}
