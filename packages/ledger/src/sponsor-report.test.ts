/**
 * Sponsor report tests.
 *
 * The Anchor Sponsor receives this artefact and nothing else. These tests pin
 * the two obligations that come with it:
 *
 *   1. It must be CORRECT — the money, the rates and the counts must add up.
 *   2. It must be SAFE — no learner may be identifiable from it, directly or by
 *      subtracting one published number from another (Doc 7 public impact
 *      reporting; Doc 16 §3.5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertNoPersonalData } from './pii-guard.js';
import { createLedgerStore } from './ledger-store.js';
import { createPrivateStore } from './private-store.js';
import { buildSponsorReport } from './sponsor-report.js';

/** Ledger + private store fixture for one quarter. */
function fixture(): { ledger: ReturnType<typeof createLedgerStore>; priv: ReturnType<typeof createPrivateStore> } {
  const ledger = createLedgerStore({ now: (): string => '2026-01-01T00:00:00.000Z' });
  ledger.append('sponsor_pledge', { amount_cents: 1_000_000, sponsor_ref: 'SP-001' }, '2026-01-05T00:00:00.000Z');
  ledger.append('sponsor_deposit', { amount_cents: 500_000, sponsor_ref: 'SP-001' }, '2026-02-10T00:00:00.000Z');
  ledger.append('grant_awarded', { amount_cents: 250_000, grant_ref: 'GR-009' }, '2026-03-15T00:00:00.000Z');
  ledger.append(
    'credit_received',
    { units: 1_000, sponsor_ref: 'SP-001' },
    '2026-01-06T00:00:00.000Z',
  );
  ledger.append(
    'credit_consumed',
    { units: 100, requested_units: 120, cost_cents: 4_200, latency_ms: 800, fallback_tier: 2 },
    '2026-03-20T00:00:00.000Z',
  );
  ledger.append(
    'credit_consumed',
    { units: 50, requested_units: 50, cost_cents: 1_000, latency_ms: 200, fallback_tier: 0, served_offline: true },
    '2026-03-21T00:00:00.000Z',
  );
  ledger.append(
    'credit_consumed',
    { units: 25, requested_units: 25, cost_cents: 500, latency_ms: 1_200, fallback_tier: 1 },
    '2026-03-22T00:00:00.000Z',
  );
  ledger.append('reinvestment_allocation', { amount_cents: 900_000, category: 'devices' }, '2026-03-31T00:00:00.000Z');
  ledger.append('reinvestment_allocation', { amount_cents: 300_000, category: 'content' }, '2026-03-25T00:00:00.000Z');

  const priv = createPrivateStore();
  for (let index = 0; index < 6; index += 1) {
    priv.put({
      id: `assessment-${index}`,
      kind: 'assessment',
      at: '2026-03-01T00:00:00.000Z',
      data: {
        cohort: 'Kisumu-G7-A',
        learnerRef: `learner-${index}`,
        region: 'Kisumu',
        learningArea: 'algebra',
        tutorNote: 'Private tutor note that must never be published.',
        transcriptFragment: 'Private transcript fragment that must never be published.',
      },
    });
  }
  for (let index = 0; index < 2; index += 1) {
    priv.put({
      id: `small-${index}`,
      kind: 'assessment',
      at: '2026-03-01T00:00:00.000Z',
      data: {
        cohort: 'Nakuru-G5-B',
        learnerRef: `small-learner-${index}`,
        region: 'Nakuru',
        learningArea: 'geometry',
      },
    });
  }
  return { ledger, priv };
}

test('the report states the money in integer cents and applies the 60 % rule', () => {
  const { ledger, priv } = fixture();
  const report = buildSponsorReport(ledger, priv, { generatedAt: '2026-04-01T00:00:00.000Z' });

  assert.equal(report.funding.eligibleBaseCents, 1_750_000);
  assert.equal(report.funding.requiredReinvestmentCents, 1_050_000);
  assert.equal(report.funding.allocatedCents, 1_200_000);
  assert.equal(report.funding.compliant, true);
  assert.deepEqual(report.funding.byCategory, { content: 300_000, devices: 900_000 });
  assert.equal(Number.isInteger(report.funding.eligibleBaseCents), true);
  assert.equal(Number.isInteger(report.funding.requiredReinvestmentCents), true);
  assert.equal(Number.isInteger(report.funding.allocatedCents), true);
  assert.equal(Number.isInteger(report.usage.costCents), true);
});

test('the report states availability, fallback, latency and cost per task', () => {
  const { ledger, priv } = fixture();
  const report = buildSponsorReport(ledger, priv, { generatedAt: '2026-04-01T00:00:00.000Z' });

  assert.equal(report.usage.tasks, 175);
  assert.equal(report.usage.requestedTasks, 195);
  assert.equal(report.usage.costCents, 5_700);
  assert.equal(report.usage.costPerTaskCents, 33);
  assert.equal(report.usage.offlineTasks, 50);

  assert.equal(report.availability.servedTasks, 175);
  assert.equal(report.availability.requestedTasks, 195);
  assert.equal(report.availability.availabilityBps, 8_974);

  assert.equal(report.fallback.fallbackTasks, 125);
  assert.equal(report.fallback.totalTasks, 175);
  assert.equal(report.fallback.fallbackRateBps, 7_143);
  assert.deepEqual(report.fallback.byTier, { '0': 50, '1': 25, '2': 100 });

  assert.equal(report.latency.samples, 3);
  assert.equal(report.latency.p50Ms, 800);
  assert.equal(report.latency.p95Ms, 1_200);
  assert.equal(report.latency.maxMs, 1_200);
  assert.equal(report.latency.meanMs, 733);

  assert.equal(report.credits.receivedUnits, 1_000);
  assert.equal(report.credits.consumedUnits, 175);
  assert.equal(report.credits.balanceUnits, 825);
});

test('the report is tied to the exact ledger state it was computed from', () => {
  const { ledger, priv } = fixture();
  const report = buildSponsorReport(ledger, priv, { generatedAt: '2026-04-01T00:00:00.000Z' });
  assert.equal(report.ledger.chainOk, true);
  assert.equal(report.ledger.entries, 9);
  assert.equal(report.ledger.merkleRoot, ledger.merkleRoot());
  assert.match(report.ledger.merkleRoot, /^[0-9a-f]{64}$/);
});

test('the report contains no learner personal data', () => {
  const { ledger, priv } = fixture();
  const report = buildSponsorReport(ledger, priv, { generatedAt: '2026-04-01T00:00:00.000Z' });

  assert.equal(report.privacy.piiScan.ok, true);
  assert.deepEqual(report.privacy.piiScan.violations, []);
  assert.equal(assertNoPersonalData(report).ok, true);

  const serialised = JSON.stringify(report);
  assert.equal(serialised.includes('learner-0'), false);
  assert.equal(serialised.includes('small-learner-0'), false);
  assert.equal(serialised.includes('tutorNote'), false);
  assert.equal(serialised.includes('Private transcript'), false);
  assert.equal(serialised.includes('assessment-0'), false);
});

test('a cohort below the minimum size is suppressed from every aggregate', () => {
  const { ledger, priv } = fixture();
  const report = buildSponsorReport(ledger, priv, {
    minCohortSize: 5,
    generatedAt: '2026-04-01T00:00:00.000Z',
  });

  assert.equal(report.cohorts.length, 1);
  assert.equal(report.cohorts[0]?.cohort, 'Kisumu-G7-A');
  assert.equal(report.cohorts[0]?.learnerCount, 6);
  assert.equal(report.privacy.suppressedCohortCount, 1);
  assert.equal(report.privacy.learnerCount, 6);

  // The suppressed cohort must not be recoverable by subtraction from any other
  // published aggregate.
  assert.deepEqual(
    report.regions.map((region) => region.region),
    ['Kisumu'],
  );
  assert.deepEqual(
    report.learningAreas.map((area) => area.learningArea),
    ['algebra'],
  );
  const serialised = JSON.stringify(report);
  assert.equal(serialised.includes('Nakuru'), false);
  assert.equal(serialised.includes('geometry'), false);
});

test('the report is reproducible for the same inputs', () => {
  const { ledger, priv } = fixture();
  const options = { generatedAt: '2026-04-01T00:00:00.000Z' };
  assert.deepEqual(buildSponsorReport(ledger, priv, options), buildSponsorReport(ledger, priv, options));
});
