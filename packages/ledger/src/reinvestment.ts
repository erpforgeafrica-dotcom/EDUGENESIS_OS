/**
 * EduGenesis OS — the 60 % reinvestment engine.
 *
 * THE RULE
 * Doc 1 v1.2 §6 and Doc 16 §3.5 make the platform's central promise: of every
 * unit a sponsor puts in, 60 % must be reinvested into the platform's own
 * delivery capacity (devices, content, exam slots, connectivity), not consumed
 * as operating margin. This engine computes, for a period:
 *
 *   eligibleBase        — the money that actually arrived in the period
 *   requiredReinvestment — 60 % of that base, in integer cents
 *   allocated           — what was reinvested, by category, in integer cents
 *   compliant           — allocated >= required
 *
 * WHAT COUNTS AS THE BASE
 * Only the funding entry types: `sponsor_pledge`, `sponsor_deposit` and
 * `grant_awarded`. Everything else in the chain is either an allocation (which
 * is the OTHER side of the comparison) or an operational event (a device
 * purchase, a prize payout, a credit consumption) which is not new money.
 *
 * EVERY EXCLUSION IS RECORDED WITH A REASON. An audit that cannot explain why
 * a figure was left out cannot be trusted (Doc 7 independent audit plan), so
 * nothing is silently dropped: each entry that did not contribute to the base
 * appears in `excluded` with a reason string.
 *
 * REPRODUCIBILITY
 * The same entries and the same period always produce byte-identical output:
 * entries are processed in `seq` order, categories are emitted in sorted order,
 * and every amount is integer arithmetic. No clock, no randomness, no locale
 * dependence.
 *
 * MONEY IS INTEGER MINOR UNITS. `requiredReinvestment` is computed as
 * floor(base * bps / 10000) in BigInt, so 60 % of 1,750,000 cents is exactly
 * 1,050,000 cents and never 1,049,999.9999999998.
 */

import type { LedgerEntry, LedgerEntryType, ReinvestmentEngine, ReinvestmentResult } from '@edugenesis/contracts';

import { MONEY_FIELD, readAmountCents } from './money.js';

/** The funding entry types that make up the eligible base. */
export const FUNDING_ENTRY_TYPES: readonly LedgerEntryType[] = [
  'sponsor_pledge',
  'sponsor_deposit',
  'grant_awarded',
];

/** The entry type that records a reinvestment allocation. */
export const ALLOCATION_ENTRY_TYPE: LedgerEntryType = 'reinvestment_allocation';

/** The default reinvestment rate: 60 % (Doc 1 v1.2 §6). */
export const DEFAULT_REINVESTMENT_RATE_BPS = 6000;

/** Options for `createReinvestmentEngine`. */
export interface ReinvestmentEngineOptions {
  /**
   * The reinvestment rate in BASIS POINTS (6000 = 60 %).
   *
   * Basis points are an integer, so the rate itself is exact — a percentage
   * expressed as a float (0.6) is not exactly representable and would make the
   * required figure depend on binary rounding.
   */
  reinvestmentRateBps?: number;
  /** Convenience form of the rate as a fraction (0.6). Rounded to basis points. */
  reinvestmentRate?: number;
  /** Funding entry types that form the eligible base. */
  fundingTypes?: readonly LedgerEntryType[];
  /** The entry type that records allocations. */
  allocationType?: LedgerEntryType;
  /** The category value used when an allocation carries no category. */
  uncategorisedCategory?: string;
}

/** The period a computation covers. */
export interface ReinvestmentPeriod {
  /** ISO-8601 start, inclusive. */
  from: string;
  /** ISO-8601 end, inclusive. */
  to: string;
}

/**
 * Create the reinvestment engine.
 *
 * `reinvestmentRateBps` wins over `reinvestmentRate` when both are given.
 */
export function createReinvestmentEngine(options: ReinvestmentEngineOptions = {}): ReinvestmentEngine {
  const fundingTypes = options.fundingTypes ?? FUNDING_ENTRY_TYPES;
  const allocationType = options.allocationType ?? ALLOCATION_ENTRY_TYPE;
  const uncategorised = options.uncategorisedCategory ?? 'uncategorised';

  let rateBps = options.reinvestmentRateBps ?? DEFAULT_REINVESTMENT_RATE_BPS;
  if (options.reinvestmentRateBps === undefined && options.reinvestmentRate !== undefined) {
    rateBps = Math.round(options.reinvestmentRate * 10_000);
  }
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new Error(
      `The reinvestment rate must be an integer number of basis points between 0 and 10000 (got ${rateBps}).`,
    );
  }

  const compute = (entries: LedgerEntry[], period: ReinvestmentPeriod): ReinvestmentResult => {
    const fromMs = Date.parse(period.from);
    const toMs = Date.parse(period.to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      throw new Error('The reinvestment period needs parseable ISO-8601 boundaries.');
    }

    // Process in sequence order so the result is reproducible regardless of the
    // order in which the caller happened to hold the entries.
    const ordered = [...entries].sort((a, b) => a.seq - b.seq);

    let baseCents = 0n;
    const allocatedByCategory = new Map<string, bigint>();
    const excluded: Array<{ seq: number; reason: string }> = [];

    for (const entry of ordered) {
      const atMs = Date.parse(entry.at);
      if (Number.isNaN(atMs)) {
        excluded.push({ seq: entry.seq, reason: `unparseable timestamp "${entry.at}"` });
        continue;
      }
      if (atMs < fromMs) {
        excluded.push({
          seq: entry.seq,
          reason: `outside period: entry at ${entry.at} is before the period start ${period.from}`,
        });
        continue;
      }
      if (atMs > toMs) {
        excluded.push({
          seq: entry.seq,
          reason: `outside period: entry at ${entry.at} is after the period end ${period.to}`,
        });
        continue;
      }

      const isFunding = fundingTypes.includes(entry.type);
      const isAllocation = entry.type === allocationType;

      if (isFunding) {
        const amount = readAmountCents(entry.payload);
        if (!amount.ok || amount.cents === undefined) {
          excluded.push({
            seq: entry.seq,
            reason: `funding entry "${entry.type}" has no usable money field: ${amount.reason ?? 'unknown reason'}`,
          });
          continue;
        }
        baseCents += BigInt(amount.cents);
        continue;
      }

      if (isAllocation) {
        const amount = readAmountCents(entry.payload);
        if (!amount.ok || amount.cents === undefined) {
          excluded.push({
            seq: entry.seq,
            reason: `allocation entry has no usable money field: ${amount.reason ?? 'unknown reason'}`,
          });
          continue;
        }
        const rawCategory = entry.payload['category'];
        const category =
          typeof rawCategory === 'string' && rawCategory.trim().length > 0
            ? rawCategory.trim()
            : uncategorised;
        const current = allocatedByCategory.get(category) ?? 0n;
        allocatedByCategory.set(category, current + BigInt(amount.cents));
        // The allocation is counted on the allocated side, not the base side;
        // it is still recorded as excluded from the base so that the audit
        // trail shows every entry that did not enlarge the eligible base.
        excluded.push({
          seq: entry.seq,
          reason: `not a funding entry type ("${entry.type}"): counted in the allocation, not in the eligible base`,
        });
        continue;
      }

      excluded.push({
        seq: entry.seq,
        reason: `not a funding entry type ("${entry.type}")`,
      });
    }

    const requiredCents = (baseCents * BigInt(rateBps)) / 10_000n;

    let allocatedTotal = 0n;
    for (const amount of allocatedByCategory.values()) allocatedTotal += amount;

    const allocated: Record<string, number> = {};
    for (const category of [...allocatedByCategory.keys()].sort()) {
      const amount = allocatedByCategory.get(category);
      if (amount === undefined) continue;
      allocated[category] = Number(amount);
    }

    const eligibleBase = Number(baseCents);
    const required = Number(requiredCents);

    return {
      eligibleBase,
      requiredReinvestment: required,
      allocated,
      excluded,
      compliant: allocatedTotal >= requiredCents,
    };
  };

  return { compute };
}

/** The money field the engine reads by default. */
export { MONEY_FIELD };
