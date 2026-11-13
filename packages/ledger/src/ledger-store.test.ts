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

import { LedgerTamperError } from '@edugenesis/contracts';

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

  const entries = store.all();
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

  const entries = store.all();
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
  const entries = store.all();
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

  const entries = store.all();
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
