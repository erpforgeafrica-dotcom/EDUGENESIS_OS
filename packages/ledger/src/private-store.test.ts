/**
 * Private store tests.
 *
 * The private store is where learner identity lives. These tests pin two
 * things: it behaves like a proper store, and its de-identified view cannot
 * leak the identity it holds — not by name, not by count, not by subtraction
 * (Doc 2 §2.5, §15; Doc 16 §3.5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PrivateRecord } from '@edugenesis/contracts';

import { createPrivateStore, DEFAULT_MIN_COHORT_SIZE, redactForSponsor } from './private-store.js';

/** Build a synthetic assessment record. No real learner data exists in this repo. */
function assessment(
  id: string,
  cohort: string,
  learnerRef: string,
  region: string,
  learningArea: string,
): PrivateRecord {
  return {
    id,
    kind: 'assessment',
    at: '2026-02-01T00:00:00.000Z',
    data: {
      cohort,
      learnerRef,
      region,
      learningArea,
      // Free text that must never reach a sponsor report.
      tutorNote: 'Struggled with fractions this week; contacted guardian about extra practice.',
      transcriptFragment: 'the learner said: I do not understand long division yet',
    },
  };
}

test('the private store stores, reads back and filters by kind', () => {
  const store = createPrivateStore();
  store.put(assessment('r1', 'Kisumu-G7-A', 'L1', 'Kisumu', 'algebra'));
  store.put({
    id: 'c1',
    kind: 'consent',
    at: '2026-02-01T00:00:00.000Z',
    data: { scope: 'sponsor_aggregate_reporting', granted: true },
  });

  assert.equal(store.all().length, 2);
  assert.equal(store.get('r1')?.kind, 'assessment');
  assert.equal(store.get('missing'), undefined);
  assert.equal(store.byKind('consent').length, 1);
  assert.equal(store.byKind('safeguarding').length, 0);
});

test('the private store refuses malformed records', () => {
  const store = createPrivateStore();
  assert.throws(() => {
    store.put({ id: '', kind: 'identity', at: '2026-02-01T00:00:00.000Z', data: {} });
  });
  assert.throws(() => {
    store.put({
      id: 'x',
      kind: 'not_a_kind' as PrivateRecord['kind'],
      at: '2026-02-01T00:00:00.000Z',
      data: {},
    });
  });
});

test('the private store copies on the way in and on the way out', () => {
  const store = createPrivateStore();
  const record = assessment('r1', 'Kisumu-G7-A', 'L1', 'Kisumu', 'algebra');
  store.put(record);

  const original = record.data as Record<string, unknown>;
  original['cohort'] = 'Mutated';

  const read = store.get('r1');
  assert.ok(read);
  assert.equal(read.data['cohort'], 'Kisumu-G7-A');

  const readData = read.data as Record<string, unknown>;
  readData['cohort'] = 'MutatedAgain';
  const readAgain = store.get('r1');
  assert.ok(readAgain);
  assert.equal(readAgain.data['cohort'], 'Kisumu-G7-A');
});

test('the de-identified view suppresses a cohort below the minimum size entirely', () => {
  const store = createPrivateStore();
  // Six learners in one cohort: published.
  for (let index = 0; index < 6; index += 1) {
    store.put(assessment(`big-${index}`, 'Kisumu-G7-A', `L${index}`, 'Kisumu', 'algebra'));
  }
  // Two learners in another cohort: suppressed, and it must not leak through
  // any other aggregate either (a "suppressed" label would still allow the
  // cell to be recovered by subtraction).
  store.put(assessment('small-0', 'Nakuru-G5-B', 'S0', 'Nakuru', 'geometry'));
  store.put(assessment('small-1', 'Nakuru-G5-B', 'S1', 'Nakuru', 'geometry'));

  const view = redactForSponsor(store, { minCohortSize: DEFAULT_MIN_COHORT_SIZE });

  assert.equal(view.cohorts.length, 1);
  assert.equal(view.cohorts[0]?.cohort, 'Kisumu-G7-A');
  assert.equal(view.cohorts[0]?.learnerCount, 6);
  assert.equal(view.suppressedCohortCount, 1);
  assert.equal(view.regions.length, 1);
  assert.equal(view.regions[0]?.region, 'Kisumu');
  assert.equal(view.learningAreas.length, 1);
  assert.equal(view.learningAreas[0]?.learningArea, 'algebra');
  assert.equal(view.learnerCount, 6);
});

test('the de-identified view contains no identifier and no free text', () => {
  const store = createPrivateStore();
  for (let index = 0; index < 6; index += 1) {
    store.put(assessment(`big-${index}`, 'Kisumu-G7-A', `L${index}`, 'Kisumu', 'algebra'));
  }
  const view = redactForSponsor(store, { minCohortSize: 5 });
  const serialised = JSON.stringify(view);

  assert.equal(serialised.includes('L0'), false);
  assert.equal(serialised.includes('tutorNote'), false);
  assert.equal(serialised.includes('long division'), false);
  assert.equal(serialised.includes('guardian'), false);
  assert.equal(view.piiScan.ok, true);
  assert.deepEqual(view.piiScan.violations, []);
});

test('the minimum cohort size is configurable', () => {
  const store = createPrivateStore();
  for (let index = 0; index < 3; index += 1) {
    store.put(assessment(`r-${index}`, 'Kisumu-G7-A', `L${index}`, 'Kisumu', 'algebra'));
  }
  assert.equal(redactForSponsor(store, { minCohortSize: 5 }).cohorts.length, 0);
  assert.equal(redactForSponsor(store, { minCohortSize: 3 }).cohorts.length, 1);
});

test('records with no cohort attribution are counted separately, never merged', () => {
  const store = createPrivateStore();
  store.put({
    id: 'loose',
    kind: 'session_transcript',
    at: '2026-02-01T00:00:00.000Z',
    data: { learnerRef: 'L9' },
  });
  const view = redactForSponsor(store, { minCohortSize: 5 });
  assert.equal(view.unattributedRecordCount, 1);
  assert.equal(view.cohorts.length, 0);
  assert.equal(view.learnerCount, 0);
});
