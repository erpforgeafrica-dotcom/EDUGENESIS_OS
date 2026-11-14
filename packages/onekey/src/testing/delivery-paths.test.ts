/**
 * The delivery-path registry test.
 *
 * WHAT IT PROVES
 *   The registry that `tools/verify-coverage.mjs` drives is not a wall
 *   decoration: it covers every rung of the fallback ladder, every
 *   learner-facing entry really delivers from the tier it claims (driven
 *   end to end through a REAL gateway with the REAL guardian), and the
 *   operator control really is not intercepted.
 *
 * WHY THESE ARE NOT THE GATE'S JOB ALONE
 *   The gate reads the registry at verification time; a lie in the registry
 *   (an entry that claims tier 2 but serves from tier 3) would otherwise be
 *   discovered only when the gate went red for the wrong reason. A unit test
 *   pins each entry's truth, and this file is the same code path the gate
 *   uses: `runDeliveryPath`, not a second driver.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { FallbackTier } from '@edugenesis/contracts';
import { FALLBACK_TIER_ROLE } from '@edugenesis/contracts';

import {
  DELIVERY_PATHS,
  LADDER_TIERS,
  learnerEntries,
  registryTierCoverage,
  runDeliveryPath,
} from './delivery-paths.js';

test('the delivery-path registry carries unique, non-empty names', () => {
  const names = DELIVERY_PATHS.map((entry) => entry.name);
  for (const name of names) {
    assert.ok(name.length > 0, 'a delivery path must be named');
  }
  assert.equal(new Set(names).size, names.length, `delivery path names must be unique: ${names.join(', ')}`);
});

test('the registry covers every rung of the fallback ladder', () => {
  const coverage = registryTierCoverage(DELIVERY_PATHS);
  assert.deepEqual(
    coverage.missing,
    [],
    `the registry must cover every tier of ${FALLBACK_TIER_ROLE ? 'the ladder' : '(unavailable)'}; missing: ${coverage.missing.join(', ')}`,
  );
});

test('LADDER_TIERS is exactly the fallback ladder from the contracts', () => {
  const ladder = Object.keys(FALLBACK_TIER_ROLE)
    .map((tier) => Number(tier) as FallbackTier)
    .sort((a, b) => a - b);
  assert.deepEqual(
    [...LADDER_TIERS].sort((a, b) => a - b),
    ladder,
  );
});

test('every learner-facing entry delivers exactly once, guarded exactly once, from its declared tier', async () => {
  const entries = learnerEntries(DELIVERY_PATHS);
  assert.ok(entries.length > 0, 'the registry carries learner-facing paths');
  for (const entry of entries) {
    const run = await runDeliveryPath(entry.build());
    assert.equal(
      run.delivered,
      true,
      `${entry.name}: the path must deliver (${run.failure ?? 'no error recorded'})`,
    );
    assert.equal(
      run.interceptions,
      1,
      `${entry.name}: the guardian must intercept exactly once, saw ${run.interceptions}`,
    );
    assert.equal(
      run.servedTier,
      entry.tier,
      `${entry.name}: served from tier ${String(run.servedTier)}, declared tier ${String(entry.tier)} — the registry must not lie about the path it names`,
    );
  }
});

test('the operator control delivers without interception', async () => {
  const control = DELIVERY_PATHS.find((entry) => !entry.learnerFacing);
  assert.ok(control, 'the registry carries an operator control path');
  const run = await runDeliveryPath(control.build());
  assert.equal(
    run.delivered,
    true,
    `${control.name}: the control must deliver (${run.failure ?? 'no error recorded'})`,
  );
  assert.equal(
    run.interceptions,
    0,
    `${control.name}: the control was intercepted ${run.interceptions} time(s) — the counter cannot distinguish learner from operator paths`,
  );
});
