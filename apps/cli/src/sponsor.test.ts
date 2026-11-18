/**
 * W2 value-chain tests: sponsor funding -> 60 % reinvestment -> integer credit
 * units -> a pseudonymous learner pool (ADR-0025).
 *
 * Written FIRST (TDD red): every test below states the behaviour the module must
 * have before a line of production code was written. The suite is hermetic — a
 * fresh temp dataDir per test, an injected clock, real on-disk SQLite stores —
 * so nothing here touches the repo, the network or another test's state.
 *
 * The only deliberate "corruption" is done through the journal file on disk
 * (the durable equivalent of the ledger facade's auditor-only `rawEntries()`):
 * the module must never expose `rawEntries()` through its public surface, so a
 * test tampers with the stored bytes instead and reopens the services.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { createSponsorServices, type SponsorServices } from './sponsor.js';

/** A fixed instant, so every durable write is reproducible. */
const FIXED_NOW = (): Date => new Date('2026-11-17T00:00:00.000Z');

/** One data directory per test, so the durable stores never share a file. */
function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'edugenesis-sponsor-'));
}

/** Open services with an injected clock and always close the durable stores. */
function withServices<T>(
  dir: string,
  run: (services: SponsorServices) => T,
  overrides: Partial<Parameters<typeof createSponsorServices>[0]> = {},
): T {
  const services = createSponsorServices({ dataDir: dir, now: FIXED_NOW, ...overrides });
  try {
    return run(services);
  } finally {
    services.close();
  }
}

/** Narrow a funding result to its ok branch, or fail the test loudly. */
type FundingResult = ReturnType<SponsorServices['recordFunding']>;
function okFunding(result: FundingResult): Extract<FundingResult, { ok: true; duplicate: false }> {
  assert.equal(result.ok, true);
  if (!result.ok || result.duplicate) {
    throw new Error('expected a fresh, successful funding');
  }
  return result;
}

/** Narrow a report result to its ok branch, or fail the test loudly. */
type ReportResult = ReturnType<SponsorServices['sponsorReport']>;
function okReport(result: ReportResult): Extract<ReportResult, { ok: true }> {
  if (!result.ok) throw new Error(result.error);
  return result;
}

/** The shape of a public ledger proof (the safe export, never raw entries). */
interface PublicEntry {
  seq: number;
  type: string;
  at: string;
  payload: Record<string, unknown>;
  entryHash: string;
  previousEntryHash: string;
}

function publicEntries(services: SponsorServices): PublicEntry[] {
  return services.publicLedger().entries as PublicEntry[];
}

test('registerSponsor rejects an email-shaped ref and accepts a pseudonymous ref', () => {
  withServices(dataDir(), (services) => {
    // An email is a person, never a pseudonymous organisational reference.
    assert.throws(
      () => services.registerSponsor({ ref: 'ada@example.org' }),
      /pseudonymous|email address|non-empty pseudonymous reference/,
    );
    // A personal-name shape is refused even without an at-sign.
    assert.throws(
      () => services.registerSponsor({ ref: 'Ada Lovelace' }),
      /personal name|pseudonymous reference/,
    );
    // Too short is refused.
    assert.throws(() => services.registerSponsor({ ref: 'ab' }), /3/);

    const registered = services.registerSponsor({ ref: 'sponsor-alpha-7' });
    assert.match(registered.sponsorId, /^sponsor-[0-9a-f]{12}$/);

    // The pseudonymous ref never lands on the public ledger at registration.
    assert.equal(publicEntries(services).length, 0);
  });
});

test('a funding entry carries a flat, non-personal payload with the amount and pseudonymous ref', () => {
  withServices(dataDir(), (services) => {
    const { sponsorId } = services.registerSponsor({ ref: 'sponsor-alpha-7' });
    const funded = okFunding(
      services.recordFunding({
        sponsorId,
        amountCents: 1000,
        idempotencyKey: 'pledge-001',
      }),
    );

    assert.equal(funded.ok, true);
    assert.equal(funded.duplicate, false);
    assert.equal(funded.seq, 1);

    const pledge = publicEntries(services)[0];
    assert.ok(pledge);
    assert.equal(pledge.type, 'sponsor_pledge');
    assert.equal(pledge.payload['amount_cents'], 1000);
    assert.equal(pledge.payload['currency'], 'USD');
    assert.equal(pledge.payload['sponsor_ref'], 'sponsor-alpha-7');
    assert.equal(pledge.payload['funding_id'], 'pledge-001');

    // No personal field name and no personal value reached the published chain.
    const keys = Object.keys(pledge.payload);
    assert.equal(keys.includes('email'), false);
    assert.equal(keys.includes('name'), false);
    assert.equal(keys.includes('learner_id'), false);
    assert.equal(JSON.stringify(pledge.payload).includes('@'), false);
  });
});

test('a duplicate idempotency key returns duplicate:true and does not grow the chain', () => {
  withServices(dataDir(), (services) => {
    const { sponsorId } = services.registerSponsor({ ref: 'sponsor-alpha-7' });
    const first = okFunding(
      services.recordFunding({ sponsorId, amountCents: 1000, idempotencyKey: 'pledge-001' }),
    );
    const lengthAfterFirst = publicEntries(services).length;

    const second = services.recordFunding({
      sponsorId,
      amountCents: 1000,
      idempotencyKey: 'pledge-001',
    });
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error('expected funding to succeed');
    assert.equal(second.duplicate, true);
    assert.equal(second.seq, first.seq, 'the original seq is returned, not a new one');
    assert.equal(second.creditsGranted, 0);
    assert.equal(publicEntries(services).length, lengthAfterFirst, 'nothing was appended');
  });
});

test('60 % reinvestment appends a learner_access allocation and grants integer credits', () => {
  withServices(dataDir(), (services) => {
    const { sponsorId } = services.registerSponsor({ ref: 'sponsor-alpha-7' });
    const funded = okFunding(
      services.recordFunding({ sponsorId, amountCents: 1000, idempotencyKey: 'pledge-001' }),
    );

    // floor(1000 * 6000 / 10000) = 600; floor(600 / 10) = 60 credits.
    assert.equal(funded.creditsGranted, 60);
    const entries = publicEntries(services);
    assert.equal(entries.length, 2);
    const allocation = entries[1];
    assert.ok(allocation);
    assert.equal(allocation.type, 'reinvestment_allocation');
    assert.equal(allocation.payload['amount_cents'], 600);
    assert.equal(allocation.payload['category'], 'learner_access');
    assert.equal(allocation.payload['funding_id'], 'pledge-001');
    assert.equal(services.creditsFor(sponsorId), 60, 'the pseudonymous pool reflects the grant');
  });
});

test('a zero allocation is not appended and grants no credits', () => {
  withServices(
    dataDir(),
    (services) => {
      const { sponsorId } = services.registerSponsor({ ref: 'sponsor-alpha-7' });
      const funded = okFunding(
        services.recordFunding({ sponsorId, amountCents: 100, idempotencyKey: 'tiny-001' }),
      );
      // floor(100 * 0 / 10000) = 0.
      assert.equal(funded.creditsGranted, 0);
      assert.equal(
        publicEntries(services).filter((entry) => entry.type === 'reinvestment_allocation').length,
        0,
      );
    },
    { reinvestmentRateBps: 0 },
  );
});

test('creditsFor reflects the grant and consumeCredit decrements with a credit_consumed entry', () => {
  withServices(dataDir(), (services) => {
    const { sponsorId } = services.registerSponsor({ ref: 'sponsor-alpha-7' });
    okFunding(services.recordFunding({ sponsorId, amountCents: 1000, idempotencyKey: 'pledge-001' }));
    assert.equal(services.creditsFor(sponsorId), 60);

    const before = publicEntries(services).length;
    assert.equal(services.consumeCredit(sponsorId, 'paid-tier lesson'), true);
    assert.equal(services.creditsFor(sponsorId), 59);

    const entries = publicEntries(services);
    assert.equal(entries.length, before + 1);
    const consumption = entries[entries.length - 1];
    assert.ok(consumption);
    assert.equal(consumption.type, 'credit_consumed');
    assert.equal(consumption.payload['units'], 1);
    assert.equal(consumption.payload['requested_units'], 1);
    assert.equal(typeof consumption.payload['learner_ref'], 'string');
  });
});

test('consumeCredit with a zero balance returns false and does NOT grow the chain', () => {
  withServices(dataDir(), (services) => {
    const { sponsorId } = services.registerSponsor({ ref: 'sponsor-alpha-7' });
    okFunding(services.recordFunding({ sponsorId, amountCents: 1000, idempotencyKey: 'pledge-001' }));
    const before = publicEntries(services).length;

    // A pseudonymous session id with no balance: false, no ledger write.
    assert.equal(services.consumeCredit('session-with-no-credit', 'paid-tier lesson'), false);
    assert.equal(publicEntries(services).length, before);
    assert.equal(services.creditsFor('session-with-no-credit'), 0);
  });
});

test('publicLedger uses the safe export and never exposes private-store records', () => {
  withServices(dataDir(), (services) => {
    const { sponsorId } = services.registerSponsor({ ref: 'sponsor-alpha-7' });
    okFunding(services.recordFunding({ sponsorId, amountCents: 1000, idempotencyKey: 'pledge-001' }));

    const view = services.publicLedger();
    assert.equal(view.entries.length, 2);
    assert.equal(view.verification.ok, true);
    assert.equal(view.verification.entriesChecked, 2);
    assert.match(view.merkleRoot, /^[0-9a-f]{64}$/);

    // The private-store record id and its private-only fields never appear.
    const serialised = JSON.stringify(view.entries);
    assert.equal(serialised.includes(`sponsor:${sponsorId}`), false);
    assert.equal(serialised.includes('"data"'), false);
    // Every safe proof has exactly the public fields, never a raw entry hook.
    for (const entry of view.entries as PublicEntry[]) {
      assert.deepEqual(Object.keys(entry).sort(), [
        'at',
        'entryHash',
        'payload',
        'previousEntryHash',
        'seq',
        'type',
      ]);
    }
  });
});

test('sponsorReport publishes on a healthy chain, refuses a broken chain, and allows a marked draft', () => {
  const dir = dataDir();
  let sponsorId = '';

  withServices(dir, (services) => {
    sponsorId = services.registerSponsor({ ref: 'sponsor-alpha-7' }).sponsorId;
    okFunding(services.recordFunding({ sponsorId, amountCents: 1000, idempotencyKey: 'pledge-001' }));

    const healthy = okReport(services.sponsorReport({ sponsorId }));
    assert.equal(healthy.draft, false);
    const report = healthy.report as { sponsorRef?: string; ledger?: { chainOk?: boolean } };
    assert.equal(report.sponsorRef, 'sponsor-alpha-7');
    assert.equal(report.ledger?.chainOk, true);
  });

  // Tamper with the stored bytes of the durable journal (the auditor path the
  // module deliberately does NOT expose), then reopen over the same directory.
  const journal = new DatabaseSync(join(dir, 'ledger-journal.sqlite'));
  journal
    .prepare('UPDATE ledger_entries SET payload = ? WHERE seq = 1')
    .run(JSON.stringify({ amount_cents: 9_999_999 }));
  journal.close();

  withServices(dir, (services) => {
    const refused = services.sponsorReport({ sponsorId });
    assert.equal(refused.ok, false);
    if (refused.ok) throw new Error('expected a refusal');
    assert.equal(refused.draft, false);
    assert.match(refused.error, /^the public ledger chain is broken at seq 1/);

    const draft = okReport(services.sponsorReport({ sponsorId, draft: true }));
    assert.equal(draft.draft, true);
    const draftReport = draft.report as { unverified?: boolean; verification?: { ok?: boolean } };
    assert.equal(draftReport.unverified, true);
    assert.equal(draftReport.verification?.ok, false);
  });
});

test('close() is idempotent enough for teardown', () => {
  const services = createSponsorServices({ dataDir: dataDir(), now: FIXED_NOW });
  assert.doesNotThrow(() => services.close());
  assert.doesNotThrow(() => services.close());
});
