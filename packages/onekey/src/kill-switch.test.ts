import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKillSwitch } from './kill-switch.js';
import type { KillSwitchState, KillSwitchStore } from './kill-switch.js';

/**
 * An in-memory store, standing in for the application's durable store.
 *
 * WHY a test double and not a real database: the seam under test is the
 * CONTRACT between the switch and a store — load once, save on every change.
 * The store's own durability is the application's concern, and a double keeps
 * this test about the seam.
 */
interface MemoryStore extends KillSwitchStore {
  readonly state: KillSwitchState | undefined;
  readonly saves: number;
}

function memoryStore(): MemoryStore {
  let state: KillSwitchState | undefined;
  let saves = 0;
  return {
    load: () => state,
    save: (next) => {
      state = next;
      saves += 1;
    },
    get state() {
      return state;
    },
    get saves() {
      return saves;
    },
  };
}

test('kill switch: kills a provider and records the reason for the audit trail', () => {
  const ks = createKillSwitch();
  ks.killSwitch('p1', 'data residency incident INC-42');
  assert.equal(ks.isKilled('p1'), true);
  assert.equal(ks.reasonFor('p1'), 'data residency incident INC-42');
  assert.equal(ks.isKilled('p2'), false);
  assert.equal(ks.reasonFor('p2'), undefined);
});

test('kill switch: the audit trail keeps every kill with a timestamp', () => {
  const ks = createKillSwitch();
  ks.killSwitch('p1', 'safety incident');
  ks.killSwitch('p2', 'budget abuse');
  const records = ks.records();
  assert.equal(records.length, 2);
  const first = records[0];
  const second = records[1];
  assert.ok(first && second);
  assert.equal(first.providerId, 'p1');
  assert.equal(first.reason, 'safety incident');
  assert.equal(second.providerId, 'p2');
  assert.ok(!Number.isNaN(Date.parse(first.at)), 'kill records must carry an ISO timestamp');
});

test('kill switch: killing a provider twice keeps the latest reason', () => {
  const ks = createKillSwitch();
  ks.killSwitch('p1', 'first reason');
  ks.killSwitch('p1', 'second reason');
  assert.equal(ks.reasonFor('p1'), 'second reason');
  assert.equal(ks.records().length, 2, 'both kills stay in the audit trail');
});

test('kill switch: a provider can be revived', () => {
  const ks = createKillSwitch();
  ks.killSwitch('p1', 'temporary hold');
  assert.equal(ks.isKilled('p1'), true);
  ks.revive('p1', 'hold lifted');
  assert.equal(ks.isKilled('p1'), false);
  assert.equal(ks.reasonFor('p1'), undefined);
});

test('kill switch: it hydrates from the store, so a kill made elsewhere is visible here', () => {
  // F3-11. The killed set used to live in a Map inside one closure, so it was
  // per-process: a kill issued on one replica did not stop another.
  const store = memoryStore();
  store.save({
    killed: [{ providerId: 'p1', reason: 'data residency incident INC-42' }],
    records: [
      {
        providerId: 'p1',
        reason: 'data residency incident INC-42',
        at: '2026-01-01T00:00:00.000Z',
        kind: 'kill',
      },
    ],
  });

  const ks = createKillSwitch({ store });

  assert.equal(ks.isKilled('p1'), true, 'a kill made elsewhere must be visible to this switch');
  assert.equal(ks.reasonFor('p1'), 'data residency incident INC-42');
  assert.equal(ks.records().length, 1, 'the trail written elsewhere must be restored too');
});

test('kill switch: a kill issued through one switch stops another switch that shares the store', () => {
  const store = memoryStore();
  const issued = createKillSwitch({ store });
  const elsewhere = createKillSwitch({ store });

  issued.killSwitch('p1', 'safety incident INC-9');

  assert.equal(
    elsewhere.isKilled('p1'),
    true,
    'the kill must cross to the other switch — a per-process switch stops nothing',
  );
  assert.equal(elsewhere.reasonFor('p1'), 'safety incident INC-9');
});

test('kill switch: every kill and every revive is written through to the store', () => {
  const store = memoryStore();
  const ks = createKillSwitch({ store });

  ks.killSwitch('p1', 'safety incident');

  assert.deepEqual(
    store.state?.killed,
    [{ providerId: 'p1', reason: 'safety incident' }],
    'the kill must be persisted the moment it is issued',
  );
  assert.equal(store.state?.records.length, 1, 'the trail must be persisted with it');

  ks.revive('p1', 'hold lifted');

  assert.deepEqual(store.state?.killed, [], 'the revive must be persisted too');
  assert.equal(store.state?.records.length, 2, 'the trail must keep both records');
});

test('kill switch: without a store the behaviour is exactly as it was', () => {
  const ks = createKillSwitch();
  ks.killSwitch('p1', 'safety incident');
  assert.equal(ks.isKilled('p1'), true);
  assert.equal(ks.reasonFor('p1'), 'safety incident');
  assert.equal(ks.records().length, 1);
  ks.revive('p1', 'hold lifted');
  assert.equal(ks.isKilled('p1'), false);
  assert.equal(ks.records().length, 2);
});
