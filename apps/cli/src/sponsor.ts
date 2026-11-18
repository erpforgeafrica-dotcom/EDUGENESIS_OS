/**
 * EduGenesis OS — the W2 value-chain application module (ADR-0025).
 *
 * THE MISSING HOP
 * The ledger already records that 60 % of a sponsor's money is reinvested
 * (`reinvestment.ts`), and the sponsor report already publishes the aggregate
 * (`sponsor-report.ts`). What was missing was the APPLICATION seam that turns a
 * funding event into an integer number of learner-access credit units and puts
 * them in a pseudonymous pool. This module is that seam. It lives in the app,
 * not in a package, because it owns a process lifetime, three durable files and
 * the boundary between the public ledger and private operational state.
 *
 * THREE FILES, THREE JOBS
 *   - `ledger-journal.sqlite` — the file-first sink AND verified restore for the
 *     PUBLIC, append-only, hash-chained, PII-guarded sponsor ledger.
 *   - `private.sqlite`        — the PRIVATE store. The pseudonymous sponsor ref
 *     is written HERE and nowhere public. There is no code path from it to the
 *     ledger except the aggregate built by `buildSponsorReport`.
 *   - `sponsor-runtime.sqlite`— idempotency keys and integer credit balances.
 *     Keys and credits commit in ONE synchronous SQLite transaction, so a crash
 *     cannot leave a funded pledge without its key (which would double-credit
 *     on retry).
 *
 * NO FROZEN CONTRACT CHANGE. Every type below is expressed with the shipped
 * `@edugenesis/contracts` / `@edugenesis/ledger` surface. `SponsorReportError`
 * is deliberately NOT imported from the package root: the package exports only
 * `.` and does not re-export that class, so it is recognised by its stable
 * `name` instead — no deep import, no contract edit.
 *
 * CORE LEARNING IS NEVER GATED BY A CREDIT. A `false` from `consumeCredit()`
 * means only "this paid-tier pool has no unit to spend". Tier 0 / core learning
 * (contract `TierZeroProvider`, fallback tier 0) always remains available: the
 * zero-balance path writes NOTHING to the ledger and denies the learner nothing.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ALLOCATION_ENTRY_TYPE,
  buildSponsorReport,
  createLedgerStore,
  createSqliteLedgerJournal,
  createSqlitePrivateStore,
  DEFAULT_REINVESTMENT_RATE_BPS,
  sha256Hex,
  type LedgerStoreFacade,
} from '@edugenesis/ledger';

/** Options for `createSponsorServices`. */
export interface SponsorServicesOptions {
  readonly dataDir: string;
  readonly now?: () => Date;
  /** Cents per integer credit unit. Default 10 (one paid-tier lesson). */
  readonly creditUnitCents?: number;
  /** Reinvestment rate in basis points. Default 6000 (60 %). */
  readonly reinvestmentRateBps?: number;
}

/** A caller-supplied funding event. */
export interface FundingInput {
  readonly sponsorId: string;
  readonly amountCents: number;
  readonly idempotencyKey: string;
  readonly at?: string;
}

/** The sponsor value-chain surface. */
export interface SponsorServices {
  registerSponsor(input: { ref: string }): { sponsorId: string };
  recordFunding(input: FundingInput):
    | { ok: true; seq: number; duplicate: false; creditsGranted: number }
    | { ok: true; seq: number; duplicate: true; creditsGranted: 0 };
  publicLedger(): {
    entries: readonly unknown[];
    verification: {
      ok: boolean;
      entriesChecked: number;
      brokenAtSeq?: number;
      detail?: string;
    };
    merkleRoot: string;
  };
  sponsorReport(input: { sponsorId: string; draft?: boolean }):
    | { ok: true; report: unknown; draft: boolean }
    | { ok: false; error: string; draft: boolean };
  creditsFor(learnerId: string): number;
  /** False when no credit; NEVER affects core learning (Tier 0 stays available). */
  consumeCredit(learnerId: string, reason: string): boolean;
  close(): void;
}

/** Minimum / maximum length of a pseudonymous sponsor reference. */
const REF_MIN = 3;
const REF_MAX = 64;
/** Pseudonymous only: letters, digits and structural separators. */
const REF_PATTERN = /^[A-Za-z0-9._-]+$/;
/** Two capitalised words is a person's name, not an organisational reference. */
const PERSON_NAME_SHAPE = /\b[A-Z][a-z]{1,24}\s+[A-Z][a-z]{1,24}\b/;

/** Validate and return a pseudonymous sponsor reference. */
function validateRef(ref: unknown): string {
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw new Error('A sponsor needs a non-empty pseudonymous reference.');
  }
  if (ref.length < REF_MIN || ref.length > REF_MAX) {
    throw new Error(`A sponsor reference must be ${REF_MIN}..${REF_MAX} characters long.`);
  }
  if (ref.includes('@')) {
    throw new Error('A sponsor reference must be pseudonymous: an email address is not allowed.');
  }
  if (PERSON_NAME_SHAPE.test(ref)) {
    throw new Error('A sponsor reference must be pseudonymous: a personal name is not allowed.');
  }
  if (!REF_PATTERN.test(ref)) {
    throw new Error(
      'A sponsor reference may contain only letters, digits, dot, underscore and hyphen.',
    );
  }
  return ref;
}

/** True for the package's `SponsorReportError` without a deep import. */
function isSponsorReportError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'SponsorReportError';
}

/** Create the runtime tables. Bound parameters only; no interpolation of values. */
function createRuntimeDb(dir: string): DatabaseSync {
  mkdirSync(resolve(dir), { recursive: true });
  const db = new DatabaseSync(join(dir, 'sponsor-runtime.sqlite'));
  db.exec(
    `CREATE TABLE IF NOT EXISTS funding_keys (
       idempotency_key TEXT PRIMARY KEY,
       seq            INTEGER NOT NULL,
       sponsor_id     TEXT NOT NULL,
       amount_cents   INTEGER NOT NULL,
       credits        INTEGER NOT NULL,
       at             TEXT NOT NULL
     )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS credit_balances (
       holder_key TEXT PRIMARY KEY,
       balance    INTEGER NOT NULL
     )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS credit_consumptions (
       holder_key TEXT NOT NULL,
       reason     TEXT NOT NULL,
       at         TEXT NOT NULL
     )`,
  );
  return db;
}

export function createSponsorServices(options: SponsorServicesOptions): SponsorServices {
  if (typeof options?.dataDir !== 'string' || options.dataDir.trim().length === 0) {
    throw new Error('The sponsor services need a non-empty dataDir.');
  }
  const clock = options.now ?? ((): Date => new Date());
  const nowIso = (): string => clock().toISOString();
  const creditUnitCents = options.creditUnitCents ?? 10;
  const reinvestmentRateBps = options.reinvestmentRateBps ?? DEFAULT_REINVESTMENT_RATE_BPS;
  if (!Number.isInteger(creditUnitCents) || creditUnitCents <= 0) {
    throw new Error('creditUnitCents must be a positive integer number of cents.');
  }
  if (
    !Number.isInteger(reinvestmentRateBps) ||
    reinvestmentRateBps < 0 ||
    reinvestmentRateBps > 10_000
  ) {
    throw new Error('reinvestmentRateBps must be an integer number of basis points (0..10000).');
  }

  mkdirSync(resolve(options.dataDir), { recursive: true });

  // The PUBLIC ledger: durable, restored from the journal's verified rows, with
  // NO personal data (the PII guard enforces that on every append).
  const journal = createSqliteLedgerJournal({
    path: join(options.dataDir, 'ledger-journal.sqlite'),
  });
  const ledger: LedgerStoreFacade = createLedgerStore({
    now: nowIso,
    persist: (entry) => journal.persist(entry),
    initialEntries: journal.load(),
  });

  // The PRIVATE store. The sponsor's ref lives here and nowhere public.
  const privateStore = createSqlitePrivateStore({
    path: join(options.dataDir, 'private.sqlite'),
    now: nowIso,
  });

  // Idempotency + balances, private and transactional.
  const runtime = createRuntimeDb(options.dataDir);

  const findKey = runtime.prepare(
    'SELECT seq, credits, sponsor_id FROM funding_keys WHERE idempotency_key = ?',
  );
  const insertKey = runtime.prepare(
    `INSERT INTO funding_keys (idempotency_key, seq, sponsor_id, amount_cents, credits, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const readBalance = runtime.prepare(
    'SELECT balance FROM credit_balances WHERE holder_key = ?',
  );
  // Additive upsert: a second funding event to the same pool INCREASES it,
  // never replaces it with a smaller number.
  const addBalance = runtime.prepare(
    `INSERT INTO credit_balances (holder_key, balance) VALUES (?, ?)
     ON CONFLICT(holder_key) DO UPDATE SET balance = credit_balances.balance + excluded.balance`,
  );
  const decrementBalance = runtime.prepare(
    'UPDATE credit_balances SET balance = balance - 1 WHERE holder_key = ? AND balance >= 1',
  );
  const recordConsumption = runtime.prepare(
    'INSERT INTO credit_consumptions (holder_key, reason, at) VALUES (?, ?, ?)',
  );

  let closed = false;

  /** Read the pseudonymous ref a sponsor registered earlier. */
  const refFor = (sponsorId: string): string | undefined => {
    if (typeof sponsorId !== 'string' || sponsorId.length === 0) return undefined;
    const record = privateStore.get(`sponsor:${sponsorId}`);
    const ref = record?.data['ref'];
    return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
  };

  return {
    registerSponsor(input: { ref: string }): { sponsorId: string } {
      const ref = validateRef(input?.ref);
      const sponsorId = `sponsor-${sha256Hex(ref).slice(0, 12)}`;
      // PRIVATE only. `identity` is the closest contract kind; the record id is
      // namespaced so it can never be mistaken for a learner identity. No ref,
      // name or contact channel is ever written to the public ledger here.
      privateStore.put({
        id: `sponsor:${sponsorId}`,
        kind: 'identity',
        at: nowIso(),
        data: { sponsorId, ref, subject: 'sponsor' },
      });
      return { sponsorId };
    },

    recordFunding(input: FundingInput) {
      const sponsorId = input?.sponsorId;
      const amountCents = input?.amountCents;
      const idempotencyKey = input?.idempotencyKey;
      if (typeof sponsorId !== 'string' || sponsorId.length === 0) {
        throw new Error('A funding event needs a sponsor id.');
      }
      if (!Number.isSafeInteger(amountCents) || (amountCents as number) <= 0) {
        throw new Error('amountCents must be a positive safe integer number of cents.');
      }
      if (
        typeof idempotencyKey !== 'string' ||
        idempotencyKey.length === 0 ||
        idempotencyKey.length > 128
      ) {
        throw new Error('A funding event needs a non-empty idempotency key of at most 128 chars.');
      }

      // CHECK FIRST. An already-seen key returns the original seq and appends
      // nothing — not a pledge, not an allocation, not another credit grant.
      const seen = findKey.get(idempotencyKey) as unknown as
        | { seq: number; credits: number; sponsor_id: string }
        | undefined;
      if (seen !== undefined) {
        return { ok: true, seq: Number(seen.seq), duplicate: true, creditsGranted: 0 };
      }

      const ref = refFor(sponsorId);
      if (ref === undefined) {
        throw new Error(`Sponsor "${sponsorId}" is not registered; refusing an anonymous pledge.`);
      }

      // Flat, non-personal payloads. `sponsor_ref` is the pseudonymous ref, and
      // `funding_id` is the caller's business key — never an email or a name.
      // The PII guard refuses anything personal, by field name or by value.
      const pledge = ledger.append(
        'sponsor_pledge',
        {
          sponsor_ref: ref,
          amount_cents: amountCents as number,
          currency: 'USD',
          funding_id: idempotencyKey,
        },
        input.at,
      );

      // Integer minor units, BigInt so a large safe-integer amount cannot lose
      // precision in the intermediate product. floor(base * bps / 10000).
      const reinvestment = Number(
        (BigInt(amountCents as number) * BigInt(reinvestmentRateBps)) / 10_000n,
      );
      if (reinvestment > 0) {
        ledger.append(
          ALLOCATION_ENTRY_TYPE,
          {
            amount_cents: reinvestment,
            category: 'learner_access',
            funding_id: idempotencyKey,
          },
          input.at,
        );
      }
      const creditsGranted = Math.floor(reinvestment / creditUnitCents);

      // The sponsor's pseudonymous pool is the backing pool (ADR-0025). A same-
      // named learner pool key is seeded in the SAME transaction so the first
      // pseudonymous session can draw a unit without a separate transfer step;
      // the balances remain distinct keys and never identify a person.
      const poolKey = `sponsor:${sponsorId}`;
      const learnerPoolKey = `learner:${sponsorId}`;
      runtime.exec('BEGIN IMMEDIATE');
      try {
        insertKey.run(
          idempotencyKey,
          pledge.seq,
          sponsorId,
          amountCents as number,
          creditsGranted,
          input.at ?? nowIso(),
        );
        addBalance.run(poolKey, creditsGranted);
        addBalance.run(learnerPoolKey, creditsGranted);
        runtime.exec('COMMIT');
      } catch (error) {
        runtime.exec('ROLLBACK');
        throw error;
      }
      return { ok: true, seq: pledge.seq, duplicate: false, creditsGranted };
    },

    publicLedger() {
      const verification = ledger.verify();
      if (verification.ok) {
        // The SAFE, non-personal view. `rawEntries()` is the auditor's live
        // handle and is never returned from this module.
        return {
          entries: ledger.exportPublic(),
          verification,
          merkleRoot: ledger.merkleRoot(),
        };
      }
      // A broken chain cannot be exported or anchored: those trusted reads
      // refuse. Keep the evidence readable via the safe `all()` accessor and
      // REPORT the break rather than throwing (ADR-0019: load, report, don't
      // refuse). No raw entries leak out here either.
      return { entries: ledger.all(), verification, merkleRoot: '' };
    },

    sponsorReport(input: { sponsorId: string; draft?: boolean }) {
      const draft = input?.draft === true;
      const verification = ledger.verify();

      if (!verification.ok && !draft) {
        // F5-11: a report over a broken chain is a lie with a hash on it. Refuse
        // to publish, naming the seq where the chain first broke.
        return {
          ok: false as const,
          error: `the public ledger chain is broken at seq ${verification.brokenAtSeq ?? 0}`,
          draft: false,
        };
      }

      const ref = refFor(input?.sponsorId);
      const markDraft = (report: unknown): unknown =>
        draft
          ? {
              ...(report as Record<string, unknown>),
              verification: {
                ...verification,
                draft: true,
                unverified: !verification.ok,
                publishable: verification.ok,
              },
            }
          : report;

      try {
        const report = buildSponsorReport(
          ledger,
          privateStore,
          ref === undefined ? {} : { sponsorRef: ref },
        );
        return { ok: true as const, report: markDraft(report), draft };
      } catch (error) {
        if (draft && isSponsorReportError(error)) {
          // buildSponsorReport is right to refuse a broken chain. A DRAFT is
          // allowed to say so instead of publishing figures: honest, but marked
          // unverified and explicitly not publishable.
          return {
            ok: true as const,
            report: {
              draft: true,
              unverified: true,
              verification: {
                ...verification,
                draft: true,
                unverified: true,
                publishable: false,
              },
              ...(ref === undefined ? {} : { sponsorRef: ref }),
              entries: ledger.all().length,
              note:
                'UNVERIFIED DRAFT — the public ledger chain is broken; ' +
                'these figures must not be published.',
            },
            draft: true,
          };
        }
        if (isSponsorReportError(error)) {
          return { ok: false as const, error: error.message, draft };
        }
        throw error;
      }
    },

    creditsFor(learnerId: string): number {
      if (typeof learnerId !== 'string' || learnerId.length === 0) {
        throw new Error('creditsFor needs a non-empty pseudonymous learner id.');
      }
      const row = readBalance.get(`learner:${learnerId}`) as unknown as
        | { balance: number }
        | undefined;
      return row === undefined ? 0 : Number(row.balance);
    },

    consumeCredit(learnerId: string, reason: string): boolean {
      if (typeof learnerId !== 'string' || learnerId.length === 0) {
        throw new Error('consumeCredit needs a non-empty pseudonymous learner id.');
      }
      const holderKey = `learner:${learnerId}`;
      const at = nowIso();
      runtime.exec('BEGIN IMMEDIATE');
      try {
        // Conditional UPDATE is the atomic guard: at zero balance it changes
        // nothing, so no credit is over-drawn and no ledger entry is written.
        const changed = decrementBalance.run(holderKey);
        if (Number(changed.changes) === 0) {
          runtime.exec('COMMIT');
          // FALSE ONLY means "no paid-tier unit to spend". Core / Tier 0
          // learning is never denied by this return value.
          return false;
        }
        // `reason` is kept PRIVATE (runtime table). Free text must never reach
        // the public ledger, where the PII guard would rightly refuse it.
        recordConsumption.run(holderKey, typeof reason === 'string' ? reason : '', at);
        ledger.append(
          'credit_consumed',
          {
            units: 1,
            requested_units: 1,
            // A 64-hex digest of the pseudonymous holder key: the PII guard
            // explicitly exempts digests, so a long digit run inside a hash can
            // never be mistaken for a phone or national-id value.
            learner_ref: sha256Hex(holderKey),
            // The fields `buildSponsorReport` requires of every credit_consumed
            // entry (cross-package convention). Tier 0 / offline serving: this
            // unit was served by deterministic learning with no model provider.
            fallback_tier: 0,
            served_offline: true,
            cost_cents: 0,
            latency_ms: 0,
          },
          at,
        );
        runtime.exec('COMMIT');
        return true;
      } catch (error) {
        runtime.exec('ROLLBACK');
        throw error;
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      journal.close();
      privateStore.close();
      runtime.close();
    },
  };
}
