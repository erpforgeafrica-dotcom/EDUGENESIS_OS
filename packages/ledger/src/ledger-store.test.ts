/**
 * Ledger store tests: the chain, the tamper detection, the PII refusal, and the
 * correction discipline.
 *
 * These are the tests an auditor would run. Each one is an attack on the
 * ledger's promises (Doc 2 §15; Doc 16 §3.5):
 *
 *   - the chain verifies after every append;
 *   - editing a stored entry is DETECTED, at the right seq;
 *   - personal data cannot be appended at all, however it is spelled;
 *   - a mistake is corrected by a COMPENSATING entry, never by an edit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LedgerTamperError, type LedgerEntry } from '@edugenesis/contracts';

import {
  appendCorrection,
  assertChainIntact,
  computeEntryHash,
  createLedgerStore,
  GENESIS_HASH,
  LedgerPayloadError,
  LedgerPiiError,
} from './ledger-store.js';

/** A store with a deterministic clock, so hashes are reproducible in tests. */
function makeStore(): ReturnType<typeof createLedgerStore> {
  let tick = 0;
  return createLedgerStore({
    now: (): string => {
      tick += 1;
      return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString();
    },
  });
}

test('appending produces a chain that verifies', () => {
  const store = makeStore();
  store.append('sponsor_pledge', { amount_cents: 1_000_000, sponsor_ref: 'SP-001' });
  store.append('sponsor_deposit', { amount_cents: 500_000, sponsor_ref: 'SP-001' });
  store.append('reinvestment_allocation', { amount_cents: 900_000, category: 'devices' });

  const result = store.verify();
  assert.equal(result.ok, true);
  assert.equal(result.entriesChecked, 3);
  assert.equal(result.brokenAtSeq, undefined);
  assert.equal(store.all().length, 3);
});

test('the sequence starts at 1 and the first entry chains to genesis', () => {
  const store = makeStore();
  const first = store.append('sponsor_pledge', { amount_cents: 100 });
  assert.equal(first.seq, 1);
  assert.equal(first.previousEntryHash, GENESIS_HASH);
  const second = store.append('sponsor_deposit', { amount_cents: 100 });
  assert.equal(second.seq, 2);
  assert.equal(second.previousEntryHash, first.entryHash);
  assert.equal(store.verify().ok, true);
});

test('the entry hash is the SHA-256 of the canonical preimage, reproducible by anyone', () => {
  const store = makeStore();
  const entry = store.append('sponsor_pledge', { amount_cents: 1_750_000 }, '2026-01-05T00:00:00.000Z');
  assert.equal(entry.entryHash, computeEntryHash(entry));
  assert.match(entry.entryHash, /^[0-9a-f]{64}$/);
});

test('TAMPER: editing a stored payload breaks the chain at that seq', () => {
  const store = makeStore();
  store.append('sponsor_pledge', { amount_cents: 1_000_000 });
  store.append('sponsor_deposit', { amount_cents: 500_000 });
  store.append('grant_awarded', { amount_cents: 250_000 });
  assert.equal(store.verify().ok, true);

  const entries = store.rawEntries();
  const first = entries[0];
  assert.ok(first);
  first.payload['amount_cents'] = 9_999_999;

  const result = store.verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAtSeq, 1);
  assert.match(result.detail ?? '', /entryHash/);
});

test('TAMPER: editing a previousEntryHash breaks the chain at that seq', () => {
  const store = makeStore();
  store.append('sponsor_pledge', { amount_cents: 1_000_000 });
  store.append('sponsor_deposit', { amount_cents: 500_000 });
  store.append('grant_awarded', { amount_cents: 250_000 });

  const entries = store.rawEntries();
  const second = entries[1];
  assert.ok(second);
  second.previousEntryHash = 'f'.repeat(64);

  const result = store.verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAtSeq, 2);
  assert.match(result.detail ?? '', /previousEntryHash/);
});

test('TAMPER: deleting an entry breaks the chain', () => {
  const store = makeStore();
  store.append('sponsor_pledge', { amount_cents: 1_000_000 });
  store.append('sponsor_deposit', { amount_cents: 500_000 });
  const entries = store.rawEntries();
  entries.splice(0, 1);
  const result = store.verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAtSeq, 1);
});

test('TAMPER: assertChainIntact throws the contract error with the broken seq', () => {
  const store = makeStore();
  store.append('sponsor_pledge', { amount_cents: 1_000_000 });
  store.append('sponsor_deposit', { amount_cents: 500_000 });
  assert.doesNotThrow(() => {
    assertChainIntact(store);
  });

  const entries = store.rawEntries();
  const second = entries[1];
  assert.ok(second);
  second.entryHash = '0'.repeat(64);

  assert.throws(
    () => {
      assertChainIntact(store);
    },
    (error: unknown) => {
      assert.ok(error instanceof LedgerTamperError);
      assert.equal(error.brokenAtSeq, 2);
      return true;
    },
  );
});

test('PII REFUSAL: a payload with a forbidden field name is refused', () => {
  const store = makeStore();
  assert.throws(
    () => {
      store.append('sponsor_deposit', { amount_cents: 100, learner_name: 'Synthetic Learner' });
    },
    (error: unknown) => {
      assert.ok(error instanceof LedgerPiiError);
      assert.match(error.message, /learner_name/);
      return true;
    },
  );
  assert.equal(store.all().length, 0);
});

test('PII REFUSAL: a nested forbidden field name is refused', () => {
  const store = makeStore();
  assert.throws(
    () => {
      store.append('sponsor_deposit', { amount_cents: 100, meta: { learnerId: 'x' } });
    },
    LedgerPiiError,
  );
});

test('PII REFUSAL: a shouting forbidden field name is refused', () => {
  const store = makeStore();
  assert.throws(() => {
    store.append('sponsor_deposit', { amount_cents: 100, LEARNER_ID: 'x' });
  }, LedgerPiiError);
});

test('PII REFUSAL: an email value under an innocuous key is refused', () => {
  const store = makeStore();
  assert.throws(
    () => {
      store.append('sponsor_deposit', { amount_cents: 100, contact: 'ada@example.org' });
    },
    LedgerPiiError,
  );
});

test('a payload with only allowed fields appends fine', () => {
  const store = makeStore();
  const entry = store.append('sponsor_deposit', {
    amount_cents: 1_750_000,
    currency: 'USD',
    sponsor_ref: 'SP-001',
    devices_planned: 40,
    note: 'quarterly allocation',
  });
  assert.equal(entry.payload['amount_cents'], 1_750_000);
  assert.equal(store.verify().ok, true);
});

test('exportPublic returns copies: a caller cannot mutate the store through it', () => {
  const store = makeStore();
  store.append('sponsor_pledge', { amount_cents: 1_000_000 });
  const exported = store.exportPublic();
  assert.equal(exported.length, 1);
  const proof = exported[0];
  assert.ok(proof);
  proof.payload['amount_cents'] = 0;
  proof.entryHash = 'tampered';

  const stored = store.all()[0];
  assert.ok(stored);
  assert.equal(stored.payload['amount_cents'], 1_000_000);
  assert.equal(store.verify().ok, true);
});

test('the merkle root is deterministic and changes when the chain grows', () => {
  const build = (): ReturnType<typeof createLedgerStore> => {
    const store = createLedgerStore({ now: (): string => '2026-01-05T00:00:00.000Z' });
    store.append('sponsor_pledge', { amount_cents: 1_000_000 });
    store.append('sponsor_deposit', { amount_cents: 500_000 });
    return store;
  };

  const one = build();
  const two = build();
  assert.equal(one.merkleRoot(), two.merkleRoot());
  assert.match(one.merkleRoot(), /^[0-9a-f]{64}$/);

  const before = one.merkleRoot();
  one.append('reinvestment_allocation', { amount_cents: 900_000, category: 'devices' });
  assert.notEqual(one.merkleRoot(), before);
});

test('the merkle root of an empty ledger is stable', () => {
  const store = makeStore();
  assert.equal(store.merkleRoot(), store.merkleRoot());
  assert.match(store.merkleRoot(), /^[0-9a-f]{64}$/);
});

test('a correction is a COMPENSATING entry: nothing is edited, nothing is deleted', () => {
  const store = makeStore();
  const wrong = store.append('sponsor_deposit', { amount_cents: 500_000 });
  const correction = appendCorrection(store, {
    correctsSeq: wrong.seq,
    reason: 'amount transposed',
    payload: { amount_cents: 50_000 },
  });

  assert.equal(correction.seq, 2);
  assert.equal(correction.type, 'reconciliation_proof');
  assert.equal(correction.payload['corrects_seq'], 1);
  assert.equal(correction.payload['corrects_entry_hash'], wrong.entryHash);
  assert.equal(correction.payload['reason'], 'amount transposed');

  // The original entry is untouched and still verifiable.
  const original = store.all()[0];
  assert.ok(original);
  assert.equal(original.payload['amount_cents'], 500_000);
  assert.equal(store.verify().ok, true);
  assert.equal(store.all().length, 2);
});

test('an appended entry can never overwrite an earlier seq', () => {
  const store = makeStore();
  const first = store.append('sponsor_pledge', { amount_cents: 100 });
  const second = store.append('sponsor_pledge', { amount_cents: 200 });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.notEqual(first.entryHash, second.entryHash);
  assert.equal(store.verify().ok, true);
});

test('money in the payload must be an integer number of minor units', () => {
  const store = makeStore();
  assert.throws(
    () => {
      store.append('sponsor_deposit', { amount_cents: 100.5 });
    },
    LedgerPayloadError,
  );
  assert.doesNotThrow(() => {
    store.append('sponsor_deposit', { amount_cents: 100 });
  });
});

test('a nested structure is inspected and then stored in canonical form', () => {
  const store = makeStore();
  const entry = store.append('impact_milestone', {
    milestone: 'first-class-primary',
    detail: { cohort: 'Kisumu-G7-A', devices: 12 },
  });
  assert.equal(entry.payload['detail'], '{"cohort":"Kisumu-G7-A","devices":12}');
  assert.equal(store.verify().ok, true);
});

test('an unparseable timestamp is refused', () => {
  const store = makeStore();
  assert.throws(
    () => {
      store.append('sponsor_pledge', { amount_cents: 100 }, 'not-a-date');
    },
    LedgerPayloadError,
  );
});

test('the value scan can be switched off for a migration, but the field rule never can', () => {
  // `valueScan: 'off'` exists for one narrow purpose: a controlled migration of
  // an existing store whose VALUES look personal but whose FIELD NAMES are
  // legitimate. It exists at all because a name-based rule alone is not a
  // guarantee.
  const migrated = createLedgerStore({ valueScan: 'off' });
  migrated.append('sponsor_pledge', { amount_cents: 100, sponsor_ref: 'SP-001' });
  assert.equal(migrated.verify().ok, true);

  // The escape hatch must not open the other door. A forbidden FIELD NAME is
  // refused whatever the value scan is set to — this is the property that
  // makes the option safe to expose at all.
  assert.throws(
    () => {
      migrated.append('sponsor_pledge', { amount_cents: 100, learner_name: 'Synthetic Learner' });
    },
    (error: unknown) => {
      assert.ok(error instanceof LedgerPiiError);
      assert.match(error.message, /forbidden field name/i);
      return true;
    },
  );

  // And with the scan ON, the same value is refused for its shape.
  const enforcing = createLedgerStore();
  assert.throws(
    () => {
      enforcing.append('sponsor_pledge', { amount_cents: 100, note: 'learner@example.org' });
    },
    (error: unknown) => {
      assert.ok(error instanceof LedgerPiiError);
      assert.match(error.message, /email|personal/i);
      return true;
    },
  );
});

// ===========================================================================
// F5-02 — THE SEQUENCE BELONGS TO THE STORE, NOT TO THE CALLER
//
// The store assigns every seq, so a caller can never supply one. What the
// store must ALSO guarantee is that the seq it assigns is the next one: it
// comes from the store's own counter, never from the length of an array the
// store handed out, so no caller can make two entries claim the same seq or
// make the store adopt an entry it never wrote.
//
// F5-03 — THE CHAIN IS VERIFIED ON READ AND ON WRITE
//
// A tamper-evident record that is only checked when somebody remembers to
// ask is not tamper evident at the moment it matters. The trusted reads (the
// public export and the merkle root) and the write path refuse a broken
// chain with the contract's typed error, while `verify()` keeps REPORTING a
// broken chain instead of throwing: an auditor must be able to read it.
// ===========================================================================

test('the sequence belongs to the store: removing an entry cannot make the store issue its seq again', () => {
  const store = makeStore();
  store.append('sponsor_pledge', { amount_cents: 100 });
  const second = store.append('sponsor_deposit', { amount_cents: 200 });
  assert.equal(second.seq, 2);

  // The RAW accessor hands out the live array on purpose (tamper evidence
  // needs an auditor to be able to reach the stored bytes); `all()` hands out
  // defensive copies. A caller that removes an entry must NOT be able to make
  // the store slide its sequence back: seq 2 is already issued and must never
  // be issued again.
  store.rawEntries().splice(0, 1);

  assert.throws(
    () => {
      store.append('grant_awarded', { amount_cents: 300 });
    },
    (error: unknown) => {
      assert.ok(error instanceof LedgerTamperError, 'the store must refuse to extend a chain it knows is broken');
      assert.equal(error.brokenAtSeq, 1);
      return true;
    },
  );

  // And no seq is ever issued twice.
  const seqs = store.all().map((entry) => entry.seq);
  assert.equal(new Set(seqs).size, seqs.length, 'a seq must never be issued twice');
});

test('the sequence belongs to the store: an entry injected into the chain is refused, not adopted', () => {
  const store = makeStore();
  const first = store.append('sponsor_pledge', { amount_cents: 100 });

  // A caller reaches into the live array the store handed out and splices in
  // an entry the store never wrote. Its own hash is perfectly valid, so the
  // hash chain alone cannot see it.
  const injected: LedgerEntry = {
    seq: 2,
    type: 'sponsor_deposit',
    at: '2026-01-01T00:00:00.000Z',
    payload: { amount_cents: 666_666 },
    previousEntryHash: first.entryHash,
    entryHash: '',
  };
  injected.entryHash = computeEntryHash(injected);
  store.rawEntries().push(injected);

  // The store must not adopt it: it never issued that seq, and the chain it
  // is about to extend is not the chain it wrote.
  assert.throws(
    () => {
      store.append('grant_awarded', { amount_cents: 300 });
    },
    (error: unknown) => {
      assert.ok(error instanceof LedgerTamperError);
      return true;
    },
  );

  // And the report must say the chain is broken — a chain that holds an entry
  // the store never wrote is broken, however well-formed its hashes are.
  const result = store.verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAtSeq, 2);
});

test('two appends in the same tick produce two distinct seq values and one unbroken chain', () => {
  // A clock that re-enters the store: the second append is issued from inside
  // the first one, before the first one has been written.
  const holder: { store?: ReturnType<typeof createLedgerStore> } = {};
  let reentered = false;
  holder.store = createLedgerStore({
    now: (): string => {
      if (!reentered) {
        reentered = true;
        holder.store?.append('sponsor_pledge', { amount_cents: 111 });
      }
      return '2026-01-01T00:00:00.000Z';
    },
  });
  const store = holder.store;
  assert.ok(store);

  const outer = store.append('sponsor_deposit', { amount_cents: 222 });

  const seqs = store.all().map((entry) => entry.seq);
  assert.deepEqual(seqs, [1, 2], 'the overlapping appends must take two different seq values');
  assert.equal(store.verify().ok, true, 'the chain must still verify');
  assert.equal(outer.seq, 2);

  // ONE chain, not two: the second entry links to the first.
  const entries = store.rawEntries();
  const first = entries[0];
  const second = entries[1];
  assert.ok(first);
  assert.ok(second);
  assert.equal(second.previousEntryHash, first.entryHash);
});

test('a tampered entry makes a read throw', () => {
  const store = makeStore();
  store.append('sponsor_pledge', { amount_cents: 1_000_000 });
  store.append('sponsor_deposit', { amount_cents: 500_000 });

  const second = store.rawEntries()[1];
  assert.ok(second);
  second.payload['amount_cents'] = 999;

  assert.throws(
    () => {
      store.exportPublic();
    },
    (error: unknown) => {
      assert.ok(error instanceof LedgerTamperError);
      assert.equal(error.brokenAtSeq, 2);
      return true;
    },
  );
});

test('the merkle root of a tampered chain is refused', () => {
  const store = makeStore();
  store.append('sponsor_pledge', { amount_cents: 1_000_000 });
  store.append('sponsor_deposit', { amount_cents: 500_000 });

  const second = store.rawEntries()[1];
  assert.ok(second);
  second.payload['amount_cents'] = 999;

  assert.throws(
    () => {
      store.merkleRoot();
    },
    (error: unknown) => {
      assert.ok(error instanceof LedgerTamperError);
      assert.equal(error.brokenAtSeq, 2);
      return true;
    },
  );
});

test('the write path refuses to extend a tampered chain', () => {
  const store = makeStore();
  store.append('sponsor_pledge', { amount_cents: 1_000_000 });
  const second = store.append('sponsor_deposit', { amount_cents: 500_000 });

  second.payload['amount_cents'] = 999;

  assert.throws(
    () => {
      store.append('grant_awarded', { amount_cents: 250_000 });
    },
    (error: unknown) => {
      assert.ok(error instanceof LedgerTamperError);
      assert.equal(error.brokenAtSeq, 2);
      return true;
    },
  );
  assert.equal(store.all().length, 2, 'the refused append must not have been written');
});

test('verify() reports a broken chain instead of throwing', () => {
  const store = makeStore();
  store.append('sponsor_pledge', { amount_cents: 1_000_000 });
  store.append('sponsor_deposit', { amount_cents: 500_000 });

  const second = store.rawEntries()[1];
  assert.ok(second);
  second.payload['amount_cents'] = 999;

  // An auditor must be able to READ a broken chain and see where it broke.
  const result = store.verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAtSeq, 2);
  assert.equal(result.entriesChecked, 2);
  assert.match(result.detail ?? '', /entryHash/);
});

test('a read refusal names the same seq and detail verify() reports', () => {
  const store = makeStore();
  store.append('sponsor_pledge', { amount_cents: 1_000_000 });
  store.append('sponsor_deposit', { amount_cents: 500_000 });

  const second = store.rawEntries()[1];
  assert.ok(second);
  second.payload['amount_cents'] = 999;

  const report = store.verify();
  assert.throws(
    () => {
      store.exportPublic();
    },
    (error: unknown) => {
      assert.ok(error instanceof LedgerTamperError);
      assert.equal(error.brokenAtSeq, report.brokenAtSeq);
      assert.equal(error.detail, report.detail);
      return true;
    },
  );
});

test('all() still hands out the raw chain after a break: the auditor must be able to read it', () => {
  const store = makeStore();
  store.append('sponsor_pledge', { amount_cents: 1_000_000 });
  store.append('sponsor_deposit', { amount_cents: 500_000 });

  const second = store.rawEntries()[1];
  assert.ok(second);
  second.payload['amount_cents'] = 999;

  // The RAW access is deliberately not a trust boundary: tamper evidence
  // needs an auditor to be able to reach the stored bytes of a broken chain
  // and see what was done to them. The trusted reads (exportPublic,
  // merkleRoot) and the write path are the ones that refuse.
  assert.equal(store.all().length, 2);
});

test('ledger: a NEGATIVE money amount is refused', () => {
  // A negative amount is a sign, not an amount. Every money field in this
  // ledger records something that WAS spent, allocated or received. A refund
  // must be its own entry type, so that the public chain never needs a
  // negative number to express it.
  const store = createLedgerStore({ now: (): string => '2026-01-05T00:00:00.000Z' });

  assert.throws(
    () => {
      store.append('sponsor_pledge', { amount_cents: -1 }, '2026-01-05T00:00:00.000Z');
    },
    (error: unknown) => {
      assert.match((error as Error).message, /negative/i);
      return true;
    },
  );
});

test('ledger: a homoglyph or zero-width spelling of a forbidden field is refused at append', () => {
  // F5-13: the field-name rule must see what a human READER sees, not the raw
  // code points. A Cyrillic look-alike and a zero-width joiner both collapse
  // onto the forbidden token after normalisation.
  const store = makeStore();
  const cyrillic = `l\u0435arnerid`; // Cyrillic small letter IE
  const zeroWidth = `learner\u200Bid`; // ZERO WIDTH SPACE inside the token

  assert.equal(store.all().length, 0);
  assert.throws(() => {
    store.append('sponsor_deposit', { amount_cents: 100, [cyrillic]: 'x' });
  }, LedgerPiiError);
  assert.throws(() => {
    store.append('sponsor_deposit', { amount_cents: 100, [zeroWidth]: 'x' });
  }, LedgerPiiError);
  assert.equal(store.all().length, 0, 'neither evasion was adopted into the chain');
});

test('ledger: a non-ISO but parseable timestamp is refused (strict ISO-8601 only)', () => {
  // F5-12: Date.parse accepts many locale-dependent spellings. A public chain
  // needs one canonical, unambiguous encoding, so only strict ISO-8601 instant
  // strings are admitted.
  const store = makeStore();
  const nonIso = ['2026/01/05', 'January 5, 2026', '2026-01-05', '05-01-2026'];
  for (const value of nonIso) {
    assert.equal(Number.isNaN(Date.parse(value)), false, `${value} is parseable by Date.parse`);
    assert.throws(
      () => {
        store.append('sponsor_pledge', { amount_cents: 100 }, value);
      },
      LedgerPayloadError,
      `${value} is not strict ISO-8601 and must be refused`,
    );
  }
  assert.equal(store.all().length, 0);
});

test('ledger: equivalent ISO-8601 spellings of one instant share the canonical hash', () => {
  // F5-12: the preimage hashes the NORMALISED timestamp, so two spellings of
  // the same instant are not two different auditable facts.
  const build = (at: string): LedgerEntry =>
    createLedgerStore({ now: (): string => at }).append('sponsor_pledge', { amount_cents: 100 }, at);

  const withZ = build('2026-01-05T00:00:00Z');
  const withMillis = build('2026-01-05T00:00:00.000Z');
  const withOffset = build('2026-01-05T03:00:00+03:00');

  assert.equal(withZ.at, '2026-01-05T00:00:00.000Z');
  assert.equal(withOffset.at, '2026-01-05T00:00:00.000Z');
  assert.equal(withZ.entryHash, withMillis.entryHash);
  assert.equal(withZ.entryHash, withOffset.entryHash);
});

test('all() returns defensive copies: in-process mutation cannot change a stored entry', () => {
  // F5-04: `all()` is the convenient read accessor. A caller holding a
  // reference from it must not be able to alter a published entry; the RAW
  // accessor (`rawEntries`) remains for auditor/tamper-test tooling.
  const store = makeStore();
  store.append('sponsor_pledge', { amount_cents: 1_000_000 });

  const snapshot = store.all();
  const first = snapshot[0];
  assert.ok(first);
  first.payload['amount_cents'] = 0;
  first.entryHash = 'tampered';
  first.previousEntryHash = 'tampered';
  snapshot.splice(0, 1);

  const stored = store.all();
  assert.equal(stored.length, 1, 'splicing the returned array did not remove the stored entry');
  assert.equal(stored[0]?.payload['amount_cents'], 1_000_000);
  assert.equal(stored[0]?.entryHash !== 'tampered', true);
  assert.equal(store.verify().ok, true, 'the chain the store wrote is untouched');
});
