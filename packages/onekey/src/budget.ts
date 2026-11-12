import { BudgetExceededError } from '@edugenesis/contracts';
import type { BudgetLedger, BudgetSnapshot } from '@edugenesis/contracts';

/**
 * The budget ledger (Doc 16 §3.6, §4.2).
 *
 * WHY a hard cap with no overage: the platform is zero-cost for learners and
 * the sponsor's pledge is a CEILING, not a suggestion. `overageEnabled` is
 * permanently `false` — the contract's type forbids `true`, so a caller cannot
 * even express an overage. A request that would exceed the cap is REFUSED,
 * never silently over-spent.
 */
export interface BudgetEntryMeta {
  providerId?: string;
  modelId?: string;
  requestId?: string;
}

/**
 * How many units of `ledger`'s unit a request costs.
 *
 * WHY: the same request must be costed the same way by the adapter (before it
 * runs) and by the gateway (after it ran), or the ledger and the refusal
 * would disagree.
 */
export function requiredUnits(ledger: BudgetLedger, inputTokens: number, outputTokens: number): number {
  switch (ledger.unit) {
    case 'token':
      return inputTokens + outputTokens;
    case 'request':
      return 1;
    case 'credit':
      return 1;
    default: {
      const exhaustive: never = ledger.unit;
      throw new Error(`Unknown budget unit "${String(exhaustive)}" for pool "${ledger.poolId}".`);
    }
  }
}

/**
 * Create a hard-capped budget ledger.
 *
 * @param poolId       The pool the sponsor or the platform pays from.
 * @param hardCapUnits The ceiling. Never exceeded.
 * @param unit         How consumption is counted (tokens, requests or credits).
 */
export function createBudgetLedger(
  poolId: string,
  hardCapUnits: number,
  unit: BudgetLedger['unit'],
): BudgetLedger {
  if (!Number.isFinite(hardCapUnits) || hardCapUnits < 0) {
    throw new Error(`Budget pool "${poolId}" requires a finite, non-negative hard cap.`);
  }

  let consumed = 0;
  const entries: BudgetSnapshot['entries'] = [];

  const ledger: BudgetLedger = {
    poolId,
    hardCapUnits,
    unit,
    // Doc 16 §3.6 — overage is structurally impossible, not merely disabled.
    overageEnabled: false,
    get consumedUnits(): number {
      return consumed;
    },
    remaining(): number {
      const left = hardCapUnits - consumed;
      // Never negative: a caller must be able to do `remaining() > 0` safely.
      return left > 0 ? left : 0;
    },
    consume(units: number, meta?: BudgetEntryMeta): void {
      if (!Number.isFinite(units)) {
        throw new Error(`Budget consumption for pool "${poolId}" must be a finite number of units.`);
      }
      if (units <= 0) {
        throw new Error(`Budget consumption for pool "${poolId}" must be a positive number of units.`);
      }
      if (consumed + units > hardCapUnits) {
        // Refused, not partially applied: the ledger never overspends.
        throw new BudgetExceededError(poolId, units, ledger.remaining());
      }
      consumed += units;
      entries.push({
        at: new Date().toISOString(),
        units,
        ...(meta?.providerId !== undefined ? { providerId: meta.providerId } : {}),
        ...(meta?.modelId !== undefined ? { modelId: meta.modelId } : {}),
        ...(meta?.requestId !== undefined ? { requestId: meta.requestId } : {}),
      });
    },
    snapshot(): BudgetSnapshot {
      return {
        poolId,
        hardCapUnits,
        consumedUnits: consumed,
        remainingUnits: ledger.remaining(),
        overageEnabled: false,
        unit,
        entries: entries.map((entry) => ({ ...entry })),
      };
    },
  };

  return ledger;
}
