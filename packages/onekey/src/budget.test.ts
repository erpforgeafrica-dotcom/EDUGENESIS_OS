import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetExceededError } from '@edugenesis/contracts';
import { createBudgetLedger } from './budget.js';

test('budget: consuming exactly to the cap is allowed', () => {
  const ledger = createBudgetLedger('pool-a', 10, 'token');
  ledger.consume(6);
  ledger.consume(4);
  assert.equal(ledger.consumedUnits, 10);
  assert.equal(ledger.remaining(), 0);
});

test('budget: one unit beyond the cap throws BudgetExceededError', () => {
  const ledger = createBudgetLedger('pool-a', 10, 'token');
  ledger.consume(10);
  assert.throws(
    () => ledger.consume(1),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError, 'expected BudgetExceededError');
      assert.equal(err.poolId, 'pool-a');
      assert.equal(err.remaining, 0);
      assert.equal(err.attempted, 1);
      return true;
    },
  );
  // The refused consumption must not be recorded.
  assert.equal(ledger.consumedUnits, 10);
});

test('budget: a single consume past the cap is refused in full', () => {
  const ledger = createBudgetLedger('pool-b', 10, 'token');
  assert.throws(() => ledger.consume(11), BudgetExceededError);
  assert.equal(ledger.consumedUnits, 0);
});

test('budget: remaining() never goes negative', () => {
  const ledger = createBudgetLedger('pool-c', 5, 'request');
  assert.equal(ledger.remaining(), 5);
  ledger.consume(5);
  assert.equal(ledger.remaining(), 0);
  assert.throws(() => ledger.consume(1), BudgetExceededError);
  assert.equal(ledger.remaining(), 0);
});

test('budget: overage is permanently disabled', () => {
  const ledger = createBudgetLedger('pool-d', 1, 'credit');
  assert.equal(ledger.overageEnabled, false);
  assert.equal(ledger.snapshot().overageEnabled, false);
});

test('budget: snapshot records the entries with provider metadata', () => {
  const ledger = createBudgetLedger('pool-e', 100, 'token');
  ledger.consume(3, { providerId: 'p1', modelId: 'm1', requestId: 'r1' });
  const snap = ledger.snapshot();
  assert.equal(snap.poolId, 'pool-e');
  assert.equal(snap.hardCapUnits, 100);
  assert.equal(snap.consumedUnits, 3);
  assert.equal(snap.remainingUnits, 97);
  assert.equal(snap.overageEnabled, false);
  assert.equal(snap.unit, 'token');
  assert.equal(snap.entries.length, 1);
  const entry = snap.entries[0];
  assert.ok(entry, 'expected one recorded entry');
  assert.equal(entry.units, 3);
  assert.equal(entry.providerId, 'p1');
  assert.equal(entry.modelId, 'm1');
  assert.equal(entry.requestId, 'r1');
  assert.ok(!Number.isNaN(Date.parse(entry.at)), 'entry must carry an ISO timestamp');
});

test('budget: a non-positive or non-finite consumption is refused', () => {
  const ledger = createBudgetLedger('pool-f', 10, 'token');
  assert.throws(() => ledger.consume(0), /positive/i);
  assert.throws(() => ledger.consume(-1), /positive/i);
  assert.throws(() => ledger.consume(Number.NaN), /finite/i);
  assert.equal(ledger.consumedUnits, 0);
});
