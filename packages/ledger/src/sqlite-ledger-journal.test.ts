/**
 * Durable public-ledger journal tests.
 *
 * ADR-0019: the public sponsor ledger becomes durable behind the EXISTING
 * seams — one optional `persist` hook and one optional `initialEntries`
 * restore in `createLedgerStore`, plus a file-backed journal module. These
 * tests attack the promises the decision makes:
 *
 *   - an append returned means the row is on disk (file first, memory second);
 *   - state restored from the file continues the SAME chain, never re-inserts;
 *   - a tampered row is DETECTED at its seq on open, and is never fatal to
 *     boot (the evidence stays readable);
 *   - a broken chain refuses every trust boundary, including the write path;
 *   - a persistence failure aborts the append with NOTHING in memory, typed;
 *   - without the options, the store behaves exactly as it did before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { LedgerTamperError } from '@edugenesis/contracts';

import {
  computeEntryHash,
  createLedgerStore,
  type LedgerStoreFacade,
  type LedgerStoreOptions,
} from './ledger-store.js';
import {
  createSqliteLedgerJournal,
  LedgerPersistenceError,
  type SqliteLedgerJournal,
} from './sqlite-ledger-journal.js';

/** A scratch directory per test run, inside the OS temp dir (never the repo). */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'eg-ledger-journal-'));
}

/** A deterministic clock, so hashes are reproducible across reopen. */
function tickClock(): () => string {
  let tick = 0;
  return (): string => {
    tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString();
  };
}

/**
 * Wire a store onto a journal exactly the way the application will: the hook
 * persists file-first, and the restored rows rebuild the store's state.
 */
function wire(journal: SqliteLedgerJournal, extra: LedgerStoreOptions = {}): LedgerStoreFacade {
  return createLedgerStore({
    now: tickClock(),
    persist: (entry) => journal.persist(entry),
    initialEntries: journal.load(),
    ...extra,
  });
}

test('the journal file is created when missing and the parent directory is created on first run', () => {
  const dir = scratch();
  const file = join(dir, 'nested', 'ledger.sqlite');
  const journal = createSqliteLedgerJournal({ path: file });
  try {
    assert.ok(existsSync(file), 'the journal file must exist after the journal is created');
  } finally {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an entry survives a close and a reopen: same seq, same payload, same hashes', () => {
  const dir = scratch();
  const file = join(dir, 'ledger.sqlite');
  const now = tickClock();

  const journalA = createSqliteLedgerJournal({ path: file });
  const storeA = createLedgerStore({ now, persist: (entry) => journalA.persist(entry) });
  const first = storeA.append('sponsor_pledge', { amount_cents: 1_000_000, sponsor_ref: 'SP-001' });
  const second = storeA.append('sponsor_deposit', { amount_cents: 500_000, sponsor_ref: 'SP-001' });
  const rootA = storeA.merkleRoot();
  journalA.close();

  const journalB = createSqliteLedgerJournal({ path: file });
  const storeB = createLedgerStore({ now, persist: (entry) => journalB.persist(entry), initialEntries: journalB.load() });
  try {
    const restored = storeB.all();
    assert.equal(restored.length, 2);
    assert.deepEqual(
      {
        seq: restored[0]?.seq,
        type: restored[0]?.type,
        at: restored[0]?.at,
        payload: restored[0]?.payload,
        previousEntryHash: restored[0]?.previousEntryHash,
        entryHash: restored[0]?.entryHash,
      },
      { seq: first.seq, type: first.type, at: first.at, payload: first.payload, previousEntryHash: first.previousEntryHash, entryHash: first.entryHash },
    );
    assert.equal(restored[1]?.entryHash, second.entryHash);
    assert.deepEqual(storeB.verify(), { ok: true, entriesChecked: 2 });
    assert.equal(storeB.merkleRoot(), rootA, 'the reopened chain is the same chain');
  } finally {
    journalB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reopened store continues the chain without re-inserting a single row', () => {
  // THE BLOCKER THE GOLDFISH FOUND: a restore mechanism that reboots into an
  // empty store would issue seq 1 again and collide with the file forever.
  const dir = scratch();
  const file = join(dir, 'ledger.sqlite');
  const now = tickClock();

  const journalA = createSqliteLedgerJournal({ path: file });
  const storeA = createLedgerStore({ now, persist: (entry) => journalA.persist(entry) });
  storeA.append('sponsor_pledge', { amount_cents: 100 });
  storeA.append('sponsor_pledge', { amount_cents: 200 });
  storeA.append('sponsor_pledge', { amount_cents: 300 });
  journalA.close();

  const journalB = createSqliteLedgerJournal({ path: file });
  const storeB = createLedgerStore({ now, persist: (entry) => journalB.persist(entry), initialEntries: journalB.load() });
  try {
    const fourth = storeB.append('sponsor_deposit', { amount_cents: 400 });
    assert.equal(fourth.seq, 4, 'the store must continue the file seq, not restart at 1');
    assert.deepEqual(storeB.verify(), { ok: true, entriesChecked: 4 });
    const counter = new DatabaseSync(file);
    try {
      const rows = counter.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get();
      assert.equal((rows as { n: number }).n, 4, 'the file must hold exactly four rows: no duplicate insert on restore');
    } finally {
      counter.close();
    }
  } finally {
    journalB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tampered row is detected at its seq on open, and is never fatal to boot', () => {
  const dir = scratch();
  const file = join(dir, 'ledger.sqlite');
  const now = tickClock();

  const journalA = createSqliteLedgerJournal({ path: file });
  const storeA = createLedgerStore({ now, persist: (entry) => journalA.persist(entry) });
  storeA.append('sponsor_pledge', { amount_cents: 100 });
  storeA.append('sponsor_pledge', { amount_cents: 200 });
  storeA.append('sponsor_pledge', { amount_cents: 300 });
  journalA.close();

  // An attacker edits a stored payload in place.
  const attacker = new DatabaseSync(file);
  attacker
    .prepare('UPDATE ledger_entries SET payload = ? WHERE seq = 2')
    .run(JSON.stringify({ amount_cents: 9_999_999, sponsor_ref: 'EVIL' }));
  attacker.close();

  const journalB = createSqliteLedgerJournal({ path: file });
  const storeB = createLedgerStore({ now, persist: (entry) => journalB.persist(entry), initialEntries: journalB.load() });
  try {
    const report = journalB.verify();
    assert.equal(report.ok, false, 'the journal must report the tamper, never throw on open');
    assert.equal(report.brokenAtSeq, 2);
    assert.ok(report.detail && report.detail.length > 0);

    const storeReport = storeB.verify();
    assert.equal(storeReport.ok, false);
    assert.equal(storeReport.brokenAtSeq, 2, 'the store must name the same broken seq');
    assert.equal(storeB.all().length, 3, 'the evidence stays readable');
  } finally {
    journalB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken chain refuses append, exportPublic and merkleRoot, naming the seq, and stays readable', () => {
  const dir = scratch();
  const file = join(dir, 'ledger.sqlite');
  const now = tickClock();

  const journalA = createSqliteLedgerJournal({ path: file });
  const storeA = createLedgerStore({ now, persist: (entry) => journalA.persist(entry) });
  storeA.append('sponsor_pledge', { amount_cents: 100 });
  storeA.append('sponsor_pledge', { amount_cents: 200 });
  storeA.append('sponsor_pledge', { amount_cents: 300 });
  journalA.close();

  const attacker = new DatabaseSync(file);
  attacker
    .prepare('UPDATE ledger_entries SET payload = ? WHERE seq = 2')
    .run(JSON.stringify({ amount_cents: 9_999_999, sponsor_ref: 'EVIL' }));
  attacker.close();

  const journalB = createSqliteLedgerJournal({ path: file });
  const storeB = createLedgerStore({ now, persist: (entry) => journalB.persist(entry), initialEntries: journalB.load() });
  try {
    assert.throws(() => storeB.append('sponsor_pledge', { amount_cents: 1 }), LedgerTamperError);
    assert.throws(() => storeB.exportPublic(), LedgerTamperError);
    assert.throws(() => storeB.merkleRoot(), LedgerTamperError);
    assert.equal(storeB.all().length, 3, 'all() is the raw access and never refuses');
  } finally {
    journalB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a key-reorder edit of a stored payload is detected by the journal and further writes refuse', () => {
  // The store hashes the CANONICAL form, so a key-reorder edit is invisible to
  // it by design. The journal stores the canonical TEXT as the evidence, so the
  // journal is the surface that detects the edit — and it must then refuse to
  // extend the chain, exactly as the store refuses a hash-level break.
  const dir = scratch();
  const file = join(dir, 'ledger.sqlite');
  const now = tickClock();

  const journalA = createSqliteLedgerJournal({ path: file });
  const storeA = createLedgerStore({ now, persist: (entry) => journalA.persist(entry) });
  storeA.append('sponsor_pledge', { sponsor_ref: 'SP-001', amount_cents: 100 });
  journalA.close();

  const attacker = new DatabaseSync(file);
  // The canonical form sorts keys (amount_cents < sponsor_ref); the edit
  // writes the SAME value with the keys in the other order — different
  // bytes, identical canonical form, invisible to the hash.
  attacker
    .prepare('UPDATE ledger_entries SET payload = ? WHERE seq = 1')
    .run('{"sponsor_ref":"SP-001","amount_cents":100}');
  attacker.close();

  const journalB = createSqliteLedgerJournal({ path: file });
  const storeB = createLedgerStore({ now, persist: (entry) => journalB.persist(entry), initialEntries: journalB.load() });
  try {
    const report = journalB.verify();
    assert.equal(report.ok, false, 'the journal detects the byte-level edit the hash cannot see');
    assert.equal(report.brokenAtSeq, 1);
    assert.throws(
      () => storeB.append('sponsor_pledge', { amount_cents: 1 }),
      (error: unknown) => error instanceof LedgerTamperError || error instanceof LedgerPersistenceError,
      'no further write may extend a chain whose stored bytes no longer match their canonical form',
    );
  } finally {
    journalB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a persist hook that throws aborts the append with nothing in memory', () => {
  // The hook contract: synchronous, atomic commit-or-nothing. A hook that
  // throws leaves the store untouched — the failed entry never happened.
  const dir = scratch();
  try {
    let fail = false;
    let tick = 0;
    const store = createLedgerStore({
      now: (): string => {
        tick += 1;
        return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString();
      },
      persist: (): void => {
        if (fail) throw new Error('disk gone');
      },
    });
    const first = store.append('sponsor_pledge', { amount_cents: 100 });
    assert.equal(first.seq, 1);

    fail = true;
    assert.throws(() => store.append('sponsor_pledge', { amount_cents: 200 }), /disk gone/);
    assert.equal(store.all().length, 1, 'the aborted append left nothing behind');

    fail = false;
    const retried = store.append('sponsor_pledge', { amount_cents: 200 });
    assert.equal(retried.seq, 2, 'the seq was not consumed by the failed attempt');
    assert.deepEqual(store.verify(), { ok: true, entriesChecked: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a persistence failure from the journal surfaces typed and aborts the append', () => {
  const dir = scratch();
  const file = join(dir, 'ledger.sqlite');
  const now = tickClock();

  const journal = createSqliteLedgerJournal({ path: file });
  const store = createLedgerStore({ now, persist: (entry) => journal.persist(entry) });
  store.append('sponsor_pledge', { amount_cents: 100 });
  journal.close(); // the underlying file handle is gone

  try {
    assert.throws(
      () => store.append('sponsor_pledge', { amount_cents: 200 }),
      (error: unknown) => error instanceof LedgerPersistenceError,
      'a closed journal must produce a TYPED persistence failure, never a raw sqlite error',
    );
    assert.equal(store.all().length, 1, 'nothing from the failed append stays in memory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two appends in the same tick take two distinct seqs and one unbroken chain across the disk', () => {
  const dir = scratch();
  const file = join(dir, 'ledger.sqlite');
  const journal = createSqliteLedgerJournal({ path: file });
  const store = wire(journal);
  try {
    const [a, b] = [
      store.append('sponsor_pledge', { amount_cents: 100 }),
      store.append('sponsor_deposit', { amount_cents: 200 }),
    ];
    assert.notEqual(a.seq, b.seq);
    assert.equal(b.previousEntryHash, a.entryHash);
    assert.deepEqual(store.verify(), { ok: true, entriesChecked: 2 });
    assert.equal(journal.verify().ok, true);
  } finally {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the journal runs the node:sqlite crash defaults, not WAL', () => {
  // ADR-0019 records the departure from the F5-01 fix text: no WAL for a
  // single-writer journal. This test locks what the journal actually runs, so
  // the ADR and the file can never drift apart silently.
  const dir = scratch();
  const file = join(dir, 'ledger.sqlite');
  const journal = createSqliteLedgerJournal({ path: file });
  try {
    assert.equal(journal.pragma('journal_mode'), 'delete', 'the rollback journal, not WAL');
    assert.equal(journal.pragma('synchronous'), 2, 'synchronous FULL: a returned append is committed');
  } finally {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a restored entry is never re-checked by the PII guard, but new appends still are', () => {
  // Guard rules can evolve after an entry was published; rehydration must not
  // wedge the boot on a rule that did not exist when the entry was appended.
  const dir = scratch();
  try {
    const tick = tickClock();
    const publisher = createLedgerStore({ now: tick, valueScan: 'off' });
    publisher.append('sponsor_pledge', { note: 'contact@example.com' }); // a value the guard would refuse today

    const store = createLedgerStore({
      now: tick,
      initialEntries: publisher.all(), // restore skips the guard: the entry is already published
    });
    assert.deepEqual(store.verify(), { ok: true, entriesChecked: 1 }, 'the boot is not wedged by a guard-rule evolution');

    assert.throws(
      () => store.append('sponsor_pledge', { contact: 'someone@example.com' }),
      /personal-data violation/i,
      'the guard is still enforced on everything appended after the restore',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without the new options the store behaves exactly as it did before', () => {
  const dir = scratch();
  try {
    const store = createLedgerStore({ now: tickClock() });
    const entry = store.append('sponsor_pledge', { amount_cents: 100 });
    assert.equal(entry.seq, 1);
    assert.deepEqual(store.verify(), { ok: true, entriesChecked: 1 });
    assert.equal(computeEntryHash(entry), entry.entryHash, 'the auditor recompute path is unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
