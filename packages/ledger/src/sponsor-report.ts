/**
 * EduGenesis OS — the Anchor Sponsor report.
 *
 * WHAT THIS ARTEFACT IS
 * The one thing the Anchor Sponsor actually receives (Doc 16 §3.5; Doc 7 public
 * impact reporting). It answers four questions in a form a sponsor can audit:
 *
 *   1. WHERE DID THE MONEY GO?      funding + allocation, 60 % rule (Doc 1 v1.2 §6)
 *   2. DID THE PLATFORM WORK?       availability, latency, fallback rate
 *   3. WHAT DID IT COST?            cost in integer cents, cost per task
 *   4. WHO BENEFITED, SAFELY?       cohort / region / learning-area counts with
 *                                   small cohorts suppressed
 *
 * WHAT THIS ARTEFACT MUST NEVER BE
 * A learner. Not a name, not an identifier, not a free-text note, not a cell
 * from which a person could be inferred. Three mechanisms enforce that:
 *
 *   - It is built from AGGREGATES only. The private store is read through
 *     `redactForSponsor()`, which reads four whitelisted keys and suppresses
 *     every cohort below the minimum size.
 *   - It is SELF-CHECKED. The finished report is scanned with the same PII guard
 *     that protects the ledger, and the verdict is published inside the report
 *     so a reader can see that the check ran and what it found.
 *   - It carries a Merkle root over the ledger chain, so the sponsor can tie
 *     the report to the exact ledger state it was computed from.
 *
 * LEDGER PAYLOAD CONVENTIONS USED HERE (all flat, all non-personal):
 *   credit_consumed : units (tasks served), requested_units, cost_cents,
 *                     latency_ms, fallback_tier (0..4), served_offline
 *   credit_received : units (credits received)
 *   funding entries : amount_cents (integer minor units)
 *   allocations     : amount_cents, category
 *
 * EVERY MONEY FIGURE IS AN INTEGER NUMBER OF MINOR UNITS. Rates are published
 * as integer basis points (the canonical value) plus a convenience decimal.
 */

import type { LedgerEntry, LedgerStore, PrivateStore } from '@edugenesis/contracts';

import { assertNoPersonalData } from './pii-guard.js';
import {
  redactForSponsor,
  type SponsorRedactionCohort,
  type SponsorRedactionLearningArea,
  type SponsorRedactionRegion,
} from './private-store.js';
import { createReinvestmentEngine } from './reinvestment.js';
import { roundDiv, sumCents } from './money.js';

/** The report schema version, bumped when the shape changes. */
export const SPONSOR_REPORT_SCHEMA_VERSION = 1;

/** Options for `buildSponsorReport`. */
export interface SponsorReportOptions {
  /** Reporting period, ISO-8601 inclusive. Defaults to the whole chain. */
  period?: { from: string; to: string };
  /** Cohorts below this many distinct learners are suppressed. */
  minCohortSize?: number;
  /** Timestamp of the report (injection keeps the output reproducible). */
  generatedAt?: string;
  /** The sponsor's pseudonymous reference. Never a personal contact. */
  sponsorRef?: string;
  /** Reinvestment rate in basis points. Default 6000 (60 %). */
  reinvestmentRateBps?: number;
}

/** The sponsor-facing report. */
export interface SponsorReport {
  schemaVersion: number;
  generatedAt: string;
  sponsorRef?: string;
  period: { from: string; to: string };
  ledger: {
    entries: number;
    chainOk: boolean;
    brokenAtSeq?: number;
    chainDetail?: string;
    merkleRoot: string;
    verifiedAt: string;
  };
  funding: {
    eligibleBaseCents: number;
    requiredReinvestmentCents: number;
    allocatedCents: number;
    compliant: boolean;
    byCategory: Record<string, number>;
  };
  usage: {
    tasks: number;
    requestedTasks: number;
    costCents: number;
    costPerTaskCents: number;
    /** Tasks served without a model provider (Tier 0 offline path). */
    offlineTasks: number;
  };
  availability: {
    requestedTasks: number;
    servedTasks: number;
    availabilityBps: number;
    availabilityRate: number;
  };
  fallback: {
    fallbackTasks: number;
    totalTasks: number;
    fallbackRateBps: number;
    fallbackRate: number;
    byTier: Record<string, number>;
  };
  latency: {
    samples: number;
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
  };
  credits: {
    receivedUnits: number;
    consumedUnits: number;
    balanceUnits: number;
  };
  cohorts: SponsorRedactionCohort[];
  regions: SponsorRedactionRegion[];
  learningAreas: SponsorRedactionLearningArea[];
  privacy: {
    minCohortSize: number;
    suppressedCohortCount: number;
    unattributedRecordCount: number;
    learnerCount: number;
    piiScan: { ok: boolean; violations: string[] };
  };
}

/** Read an integer field from a ledger payload. */
/**
 * Thrown when the report cannot be produced honestly.
 *
 * WHY IT EXISTS: this report is what a SPONSOR reads. Every figure in it must
 * mean what it says. A report that quietly reports zero because a producer
 * renamed a key is worse than no report: it is a clean number that means
 * nothing, presented as accountability.
 */
export class SponsorReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SponsorReportError';
  }
}

/**
 * Read a number the report DEPENDS on, or refuse.
 *
 * WHY NOT A DEFAULT: every one of these keys carries a figure the sponsor
 * reads — tasks, demand, fallbacks, offline serving. Defaulting a missing one
 * to zero does not make the report conservative; it makes it wrong in the
 * direction that looks best. The report names the entry and the key instead.
 */
function requireInt(
  payload: Record<string, string | number | boolean | null>,
  field: string,
  seq: number,
): number {
  const value = readInt(payload, field);
  if (value === undefined) {
    throw new SponsorReportError(
      `ledger entry ${String(seq)} does not carry "${field}", so the report would state a figure it cannot know. ` +
        `The producer and the report must agree on the key name.`,
    );
  }
  return value;
}

/** Read a boolean the report DEPENDS on, or refuse. See requireInt. */
function requireBool(
  payload: Record<string, string | number | boolean | null>,
  field: string,
  seq: number,
): boolean {
  const value = readBool(payload, field);
  if (value === undefined) {
    throw new SponsorReportError(
      `ledger entry ${String(seq)} does not carry "${field}", so the report would state a figure it cannot know. ` +
        `The producer and the report must agree on the key name.`,
    );
  }
  return value;
}

function readInt(payload: Record<string, string | number | boolean | null>, field: string): number | undefined {
  const value = payload[field];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return undefined;
}

/** Read a boolean field from a ledger payload. */
function readBool(
  payload: Record<string, string | number | boolean | null>,
  field: string,
): boolean | undefined {
  const value = payload[field];
  return typeof value === 'boolean' ? value : undefined;
}

/** Nearest-rank percentile over an ascending array. Deterministic. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? 0;
}

/** Bounds of a ledger chain, used as the default reporting period. */
function chainPeriod(entries: readonly LedgerEntry[]): { from: string; to: string } {
  if (entries.length === 0) return { from: '', to: '' };
  let from = entries[0]?.at ?? '';
  let to = entries[0]?.at ?? '';
  for (const entry of entries) {
    if (entry.at < from) from = entry.at;
    if (entry.at > to) to = entry.at;
  }
  return { from, to };
}

/**
 * Build the aggregate, de-identified, privacy-reviewed sponsor report.
 *
 * The ledger contributes money and operational metrics; the private store
 * contributes ONLY the suppressed aggregate produced by `redactForSponsor()`.
 * Nothing else crosses the boundary.
 */
export function buildSponsorReport(
  ledger: LedgerStore,
  privateStore: PrivateStore,
  options: SponsorReportOptions = {},
): SponsorReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const allEntries = ledger.all();
  const period = options.period ?? chainPeriod(allEntries);
  const fromMs = Date.parse(period.from);
  const toMs = Date.parse(period.to);
  const inPeriod = (entry: LedgerEntry): boolean => {
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) return false;
    if (!Number.isNaN(fromMs) && at < fromMs) return false;
    if (!Number.isNaN(toMs) && at > toMs) return false;
    return true;
  };

  const periodEntries = allEntries.filter(inPeriod);

  // ---- operational metrics, all integer arithmetic ------------------------
  let tasks = 0;
  let requestedTasks = 0;
  const costs: number[] = [];
  const latencies: number[] = [];
  let fallbackTasks = 0;
  let offlineTasks = 0;
  const byTier: Record<string, number> = {};
  let receivedUnits = 0;
  let consumedUnits = 0;

  for (const entry of periodEntries) {
    if (entry.type === 'credit_consumed') {
      // The keys below are a CROSS-PACKAGE convention: another package writes
      // these entries, and this report is what a sponsor reads. A missing key
      // is therefore CONTRACT DRIFT, and it is refused rather than defaulted.
      const units = requireInt(entry.payload, 'units', entry.seq);
      const requested = requireInt(entry.payload, 'requested_units', entry.seq);
      const tier = requireInt(entry.payload, 'fallback_tier', entry.seq);
      const offline = requireBool(entry.payload, 'served_offline', entry.seq);
      tasks += units;
      consumedUnits += units;
      requestedTasks += requested;
      const cost = readInt(entry.payload, 'cost_cents');
      if (cost !== undefined) costs.push(cost);
      const latency = readInt(entry.payload, 'latency_ms');
      if (latency !== undefined) latencies.push(latency);
      byTier[String(tier)] = (byTier[String(tier)] ?? 0) + units;
      if (tier > 0) fallbackTasks += units;
      if (offline) offlineTasks += units;
      continue;
    }
    if (entry.type === 'credit_received') {
      receivedUnits += requireInt(entry.payload, 'units', entry.seq);
    }
  }

  const costCents = sumCents(costs);
  const costPerTaskCents = tasks > 0 ? roundDiv(costCents, tasks) : 0;
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const latencyTotal = latencies.reduce((total, value) => total + value, 0);
  const latencyMeanMs = latencies.length > 0 ? roundDiv(latencyTotal, latencies.length) : 0;

  // Availability: served tasks over requested tasks. When nothing was
  // requested there is no unmet demand, so availability is 100 %.
  const availabilityBps =
    requestedTasks > 0 ? roundDiv(tasks * 10_000, requestedTasks) : 10_000;
  const fallbackRateBps = tasks > 0 ? roundDiv(fallbackTasks * 10_000, tasks) : 0;

  // ---- funding and the 60 % rule ------------------------------------------
  const engine = createReinvestmentEngine(
    options.reinvestmentRateBps === undefined
      ? {}
      : { reinvestmentRateBps: options.reinvestmentRateBps },
  );
  const reinvestment = engine.compute(periodEntries, { from: period.from, to: period.to });
  const allocatedCents = sumCents(Object.values(reinvestment.allocated));

  // ---- private, de-identified aggregates -----------------------------------
  const redaction = redactForSponsor(privateStore, {
    minCohortSize: options.minCohortSize,
    generatedAt,
  });

  const verification = ledger.verify();
  if (!verification.ok) {
    // A report computed over a broken chain is not accountability, it is a
    // decoration. The chain is verified before any figure is published.
    throw new SponsorReportError(
      `the ledger chain is broken at sequence ${String(verification.brokenAtSeq ?? 'unknown')}` +
        `${verification.detail === undefined ? '' : `: ${verification.detail}`} — ` +
        `the report refuses to publish over a broken chain.`,
    );
  }

  const report: SponsorReport = {
    schemaVersion: SPONSOR_REPORT_SCHEMA_VERSION,
    generatedAt,
    ...(options.sponsorRef === undefined ? {} : { sponsorRef: options.sponsorRef }),
    period,
    ledger: {
      entries: allEntries.length,
      chainOk: verification.ok,
      ...(verification.brokenAtSeq === undefined ? {} : { brokenAtSeq: verification.brokenAtSeq }),
      ...(verification.detail === undefined ? {} : { chainDetail: verification.detail }),
      merkleRoot: ledger.merkleRoot(),
      verifiedAt: generatedAt,
    },
    funding: {
      eligibleBaseCents: reinvestment.eligibleBase,
      requiredReinvestmentCents: reinvestment.requiredReinvestment,
      allocatedCents,
      compliant: reinvestment.compliant,
      byCategory: reinvestment.allocated,
    },
    usage: {
      tasks,
      requestedTasks,
      costCents,
      costPerTaskCents,
      offlineTasks,
    },
    availability: {
      requestedTasks,
      servedTasks: tasks,
      availabilityBps,
      availabilityRate: availabilityBps / 10_000,
    },
    fallback: {
      fallbackTasks,
      totalTasks: tasks,
      fallbackRateBps,
      fallbackRate: fallbackRateBps / 10_000,
      byTier,
    },
    latency: {
      samples: latencies.length,
      meanMs: latencyMeanMs,
      p50Ms: percentile(sortedLatencies, 0.5),
      p95Ms: percentile(sortedLatencies, 0.95),
      maxMs: sortedLatencies.length > 0 ? (sortedLatencies[sortedLatencies.length - 1] ?? 0) : 0,
    },
    credits: {
      receivedUnits,
      consumedUnits,
      balanceUnits: receivedUnits - consumedUnits,
    },
    cohorts: redaction.cohorts,
    regions: redaction.regions,
    learningAreas: redaction.learningAreas,
    privacy: {
      minCohortSize: redaction.minCohortSize,
      suppressedCohortCount: redaction.suppressedCohortCount,
      unattributedRecordCount: redaction.unattributedRecordCount,
      learnerCount: redaction.learnerCount,
      piiScan: { ok: true, violations: [] },
    },
  };

  // Self-check: the artefact that leaves the building is scanned for personal
  // data, and the verdict is published inside it.
  const scan = assertNoPersonalData(report);
  report.privacy.piiScan = scan;

  return report;
}
