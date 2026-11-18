import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createKillSwitch,
  KillGovernanceError,
  KillSwitchCorruptStateError,
} from './kill-switch.js';
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

/**
 * F8-11. The governance authority, the second-person rule and the loud refusal
 * of a corrupt persisted state are what turn a process-local Map into a
 * governance decision that survives a restart.
 */
test('kill switch (F8-11): a governed kill persists across a restart with its governance', () => {
  const store = memoryStore();
  const issuer = createKillSwitch({
    store,
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    authorisedActors: ['alice', 'bob'],
  });
  issuer.killSwitch('qwen', 'data residency breach INC-42', 'alice', 'residency');

  const restarted = createKillSwitch({ store, authorisedActors: ['alice', 'bob'] });
  assert.equal(restarted.isKilled('qwen'), true, 'the kill must survive a restart');
  assert.equal(restarted.reasonFor('qwen'), 'data residency breach INC-42');

  const kill = restarted.records().find((record) => record.kind === 'kill');
  assert.ok(kill);
  assert.equal(kill?.actor, 'alice');
  assert.equal(kill?.classification, 'residency');
  assert.equal(kill?.at, '2026-01-01T00:00:00.000Z');

  const persisted = store.state?.killed[0];
  assert.ok(persisted);
  assert.equal(persisted?.actor, 'alice', 'the persisted kill list must carry the actor');
  assert.equal(persisted?.classification, 'residency', 'the persisted kill list must carry the classification');
});

test('kill switch (F8-11): kill and revive require an authorised actor and a reason', () => {
  const ks = createKillSwitch({ authorisedActors: ['alice', 'bob'] });

  assert.throws(
    () => ks.killSwitch('qwen', 'safety incident INC-9'),
    KillGovernanceError,
    'a kill without an actor is refused',
  );
  assert.throws(
    () => ks.killSwitch('qwen', ''),
    KillGovernanceError,
    'a kill without a reason is refused',
  );

  ks.killSwitch('qwen', 'safety incident INC-9', 'alice', 'safety');
  assert.equal(ks.isKilled('qwen'), true);

  assert.throws(
    () => ks.revive('qwen', 'all clear'),
    KillGovernanceError,
    'a revive without an actor is refused',
  );
  assert.throws(
    () => ks.revive('qwen', '', 'bob'),
    KillGovernanceError,
    'a revive without a reason is refused',
  );
  assert.throws(
    () => ks.revive('qwen', 'all clear', 'mallory'),
    KillGovernanceError,
    'an unauthorised actor is refused',
  );
  assert.equal(ks.isKilled('qwen'), true, 'every refused decision leaves the provider killed');
});

test('kill switch (F8-11): the killer cannot revive their own safety kill', () => {
  const ks = createKillSwitch({ authorisedActors: ['alice', 'bob'] });
  ks.killSwitch('qwen', 'safeguarding incident', 'alice', 'safety');

  assert.throws(
    () => ks.revive('qwen', 'all clear', 'alice'),
    KillGovernanceError,
    'a second person is required for a safety kill',
  );
  assert.equal(ks.isKilled('qwen'), true, 'the refused same-actor revive changes nothing');
});

test('kill switch (F8-11): an authorised different actor revives and clears the persisted kill', () => {
  const store = memoryStore();
  const ks = createKillSwitch({ store, authorisedActors: ['alice', 'bob'] });
  ks.killSwitch('qwen', 'licence lapse', 'alice', 'licence');

  ks.revive('qwen', 'licence renewed and independently reviewed', 'bob');

  assert.equal(ks.isKilled('qwen'), false);
  assert.equal(ks.reasonFor('qwen'), undefined);
  assert.deepEqual(store.state?.killed, [], 'the persisted kill list must clear on revive');
  const revive = ks.records().find((record) => record.kind === 'revive');
  assert.ok(revive);
  assert.equal(revive?.actor, 'bob');
});

test('kill switch (F8-11): a corrupt or partial persisted write is refused loudly', () => {
  const partial = memoryStore();
  partial.save({
    killed: [{ providerId: 'qwen' } as unknown as { providerId: string; reason: string }],
    records: [],
  });
  assert.throws(
    () => createKillSwitch({ store: partial }),
    KillSwitchCorruptStateError,
    'a killed entry missing its reason must not be read as an empty kill list',
  );

  const badTrail = memoryStore();
  badTrail.save({
    killed: [],
    records: [{ providerId: 'qwen', reason: 'x', at: 'not-a-date', kind: 'kill' }],
  });
  assert.throws(
    () => createKillSwitch({ store: badTrail }),
    KillSwitchCorruptStateError,
    'a trail record without a parseable timestamp must be refused',
  );
});
