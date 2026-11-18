/**
 * Reinvestment engine tests — the 60 % rule.
 *
 * The worked fixture below is the canonical example: it is quoted in the
 * package README, so an auditor can read the same arithmetic in the code, in
 * the test and in the documentation (Doc 1 v1.2 §6; Doc 2 §15; Doc 16 §3.5).
 *
 * Every monetary value is an integer number of minor units (cents). The test
 * asserts that explicitly, because a float creeping back into a money path is
 * the classic way a ledger stops reconciling.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLedgerStore } from './ledger-store.js';
import { createReinvestmentEngine, FUNDING_ENTRY_TYPES } from './reinvestment.js';

const PERIOD = { from: '2026-01-01T00:00:00.000Z', to: '2026-03-31T23:59:59.999Z' };

/**
 * The worked fixture.
 *
 *   seq 1  sponsor_pledge        1,000,000 cents  2026-01-05   funding
 *   seq 2  sponsor_deposit         500,000 cents  2026-02-10   funding
 *   seq 3  grant_awarded           250,000 cents  2026-03-15   funding
 *   seq 4  credit_consumed               100 units 2026-03-20   operational
 *   seq 5  sponsor_pledge           100,000 cents  2025-12-01   before the period
 *   seq 6  reinvestment_allocation  900,000 cents  2026-03-31   devices
 *   seq 7  reinvestment_allocation  300,000 cents  2026-03-25   content
 *   seq 8  reinvestment_allocation  150,000 cents  2026-04-02   after the period
 *
 * eligible base  = 1,000,000 + 500,000 + 250,000       = 1,750,000 cents ($17,500)
 * required (60%) = 1,750,000 * 6000 / 10000            = 1,050,000 cents ($10,500)
 * allocated      = 900,000 (devices) + 300,000 (content) = 1,200,000 cents
 * compliant      = 1,200,000 >= 1,050,000              = true
 */
function fixture() {
  const store = createLedgerStore({ now: (): string => '2026-01-01T00:00:00.000Z' });
  store.append('sponsor_pledge', { amount_cents: 1_000_000, sponsor_ref: 'SP-001' }, '2026-01-05T00:00:00.000Z');
  store.append('sponsor_deposit', { amount_cents: 500_000, sponsor_ref: 'SP-001' }, '2026-02-10T00:00:00.000Z');
  store.append('grant_awarded', { amount_cents: 250_000, grant_ref: 'GR-009' }, '2026-03-15T00:00:00.000Z');
  store.append('credit_consumed', { units: 100, cost_cents: 4_200 }, '2026-03-20T00:00:00.000Z');
  store.append('sponsor_pledge', { amount_cents: 100_000, sponsor_ref: 'SP-002' }, '2025-12-01T00:00:00.000Z');
  store.append('reinvestment_allocation', { amount_cents: 900_000, category: 'devices' }, '2026-03-31T00:00:00.000Z');
  store.append('reinvestment_allocation', { amount_cents: 300_000, category: 'content' }, '2026-03-25T00:00:00.000Z');
  store.append('reinvestment_allocation', { amount_cents: 150_000, category: 'content' }, '2026-04-02T00:00:00.000Z');
  return store;
}

test('the eligible base counts only the funding entries inside the period', () => {
  const engine = createReinvestmentEngine();
  const result = engine.compute(fixture().all(), PERIOD);
  assert.equal(result.eligibleBase, 1_750_000);
});

test('the required reinvestment is exactly 60 % of the base, in integer cents', () => {
  const engine = createReinvestmentEngine();
  const result = engine.compute(fixture().all(), PERIOD);
  assert.equal(result.requiredReinvestment, 1_050_000);
  assert.equal(Number.isInteger(result.requiredReinvestment), true);
  assert.equal(Number.isInteger(result.eligibleBase), true);
  for (const value of Object.values(result.allocated)) {
    assert.equal(Number.isInteger(value), true);
  }
});

test('the allocation is grouped by category and the 60 % rule is satisfied', () => {
  const engine = createReinvestmentEngine();
  const result = engine.compute(fixture().all(), PERIOD);
  assert.deepEqual(result.allocated, { content: 300_000, devices: 900_000 });
  assert.equal(result.compliant, true);
});

test('every exclusion is recorded with a reason', () => {
  const engine = createReinvestmentEngine();
  const result = engine.compute(fixture().all(), PERIOD);
  const reasons = new Map(result.excluded.map((item) => [item.seq, item.reason]));

  assert.equal(result.excluded.length, 5);
  assert.match(reasons.get(4) ?? '', /not a funding entry type \("credit_consumed"\)/);
  assert.match(reasons.get(5) ?? '', /outside period/);
  assert.match(reasons.get(6) ?? '', /counted in the allocation/);
  assert.match(reasons.get(7) ?? '', /counted in the allocation/);
  assert.match(reasons.get(8) ?? '', /outside period/);
  for (const item of result.excluded) {
    assert.ok(item.reason.length > 0, `seq ${item.seq} must carry a reason`);
  }
});

test('the computation is reproducible: same entries, same period, same result', () => {
  const engine = createReinvestmentEngine();
  const entries = fixture().all();
  const first = engine.compute(entries, PERIOD);
  const second = engine.compute(entries, PERIOD);
  assert.deepEqual(first, second);

  // The input order must not matter either: entries are processed in seq order.
  const shuffled = [...entries].reverse();
  assert.deepEqual(engine.compute(shuffled, PERIOD), first);
});

test('a period with no funding is not compliant', () => {
  const store = createLedgerStore({ now: (): string => '2026-01-01T00:00:00.000Z' });
  store.append('sponsor_pledge', { amount_cents: 100_000 }, '2026-01-05T00:00:00.000Z');
  const result = createReinvestmentEngine().compute(store.all(), PERIOD);
  assert.equal(result.eligibleBase, 100_000);
  assert.equal(result.requiredReinvestment, 60_000);
  assert.deepEqual(result.allocated, {});
  assert.equal(result.compliant, false);
});

test('the reinvestment rate is configurable', () => {
  const engine = createReinvestmentEngine({ reinvestmentRateBps: 5000 });
  const result = engine.compute(fixture().all(), PERIOD);
  assert.equal(result.requiredReinvestment, 875_000);

  const fromFraction = createReinvestmentEngine({ reinvestmentRate: 0.6 });
  assert.equal(fromFraction.compute(fixture().all(), PERIOD).requiredReinvestment, 1_050_000);
});

test('a funding entry with unusable money is excluded with a reason, not counted', () => {
  const store = createLedgerStore({ now: (): string => '2026-01-01T00:00:00.000Z' });
  store.append('sponsor_pledge', { amount: 100.5 }, '2026-01-05T00:00:00.000Z');
  const result = createReinvestmentEngine().compute(store.all(), PERIOD);
  assert.equal(result.eligibleBase, 0);
  assert.equal(result.excluded.length, 1);
  assert.match(result.excluded[0]?.reason ?? '', /integer/);
});

test('the funding types are the three documented ones', () => {
  assert.deepEqual([...FUNDING_ENTRY_TYPES], ['sponsor_pledge', 'sponsor_deposit', 'grant_awarded']);
});

test('F5-10: a funding event recorded twice with the same event_ref is counted once', () => {
  // Two entries carrying the same economic-event reference are one fact. The
  // engine must not let a double posting inflate the eligible base.
  const store = createLedgerStore({ now: (): string => '2026-01-01T00:00:00.000Z' });
  const payload = { amount_cents: 400_000, sponsor_ref: 'SP-100', event_ref: 'pledge-evt-1' };
  store.append('sponsor_pledge', payload, '2026-01-05T00:00:00.000Z');
  store.append('sponsor_pledge', payload, '2026-01-05T00:00:00.000Z');

  const result = createReinvestmentEngine().compute(store.all(), PERIOD);
  assert.equal(result.eligibleBase, 400_000, 'the duplicate must not enlarge the base');
  const duplicates = result.excluded.filter((item) => /duplicate/i.test(item.reason));
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]?.seq, 2);
  assert.match(duplicates[0]?.reason ?? '', /seq 1/);
});

test('F5-10: a semantically duplicated allocation is detected and counted once', () => {
  // Without an explicit event_ref, an identical allocation (same type, amount,
  // category and posting instant) is the same economic event recorded twice.
  const store = createLedgerStore({ now: (): string => '2026-01-01T00:00:00.000Z' });
  store.append('sponsor_pledge', { amount_cents: 1_000_000 }, '2026-01-05T00:00:00.000Z');
  const allocation = { amount_cents: 700_000, category: 'devices' };
  store.append('reinvestment_allocation', allocation, '2026-02-10T00:00:00.000Z');
  store.append('reinvestment_allocation', allocation, '2026-02-10T00:00:00.000Z');

  const result = createReinvestmentEngine().compute(store.all(), PERIOD);
  assert.deepEqual(result.allocated, { devices: 700_000 });
  const duplicates = result.excluded.filter((item) => /duplicate/i.test(item.reason));
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]?.seq, 3);
});

test('F5-09: a late allocation is excluded by default and attributed when enabled', () => {
  const store = createLedgerStore({ now: (): string => '2026-01-01T00:00:00.000Z' });
  store.append('sponsor_pledge', { amount_cents: 1_000_000 }, '2026-01-05T00:00:00.000Z');
  store.append(
    'reinvestment_allocation',
    { amount_cents: 700_000, category: 'devices' },
    '2026-05-01T00:00:00.000Z',
  );
  const entries = store.all();

  const strict = createReinvestmentEngine().compute(entries, PERIOD);
  assert.equal(strict.compliant, false, 'a posting-after-period allocation is out by default');
  assert.match(strict.excluded.find((item) => item.seq === 2)?.reason ?? '', /outside period/);

  const attributed = createReinvestmentEngine({
    allocationAttribution: 'include-late',
    lateAllocationCutoff: '2026-06-30T23:59:59.999Z',
  }).compute(entries, PERIOD);
  assert.equal(attributed.compliant, true, 'the late allocation now funds this period');
  assert.deepEqual(attributed.allocated, { devices: 700_000 });
  assert.match(attributed.excluded.find((item) => item.seq === 2)?.reason ?? '', /late allocation/i);
});

test('F5-09: late attribution never reaches an allocation beyond the cutoff', () => {
  const store = createLedgerStore({ now: (): string => '2026-01-01T00:00:00.000Z' });
  store.append('sponsor_pledge', { amount_cents: 1_000_000 }, '2026-01-05T00:00:00.000Z');
  store.append(
    'reinvestment_allocation',
    { amount_cents: 700_000, category: 'devices' },
    '2026-12-01T00:00:00.000Z',
  );

  const result = createReinvestmentEngine({
    allocationAttribution: 'include-late',
    lateAllocationCutoff: '2026-06-30T23:59:59.999Z',
  }).compute(store.all(), PERIOD);
  assert.equal(result.compliant, false);
  assert.deepEqual(result.allocated, {});
  assert.match(result.excluded.find((item) => item.seq === 2)?.reason ?? '', /outside period/);
});
