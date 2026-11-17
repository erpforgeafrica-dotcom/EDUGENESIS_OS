/**
 * The durable kill-switch store, implemented over the EXISTING SQLite private
 * store (gap close-out plan, Seam 1 - audit finding F3-11).
 *
 * WHY THESE TESTS EXIST
 *   The kill switch used to be a `Map` inside one process, so a kill issued on
 *   one replica did not stop another. Wave 1 put the seam in `packages/onekey`
 *   (`KillSwitchStore`: load/save). The IMPLEMENTATION belongs to the
 *   application, because the application owns the durable stores. These tests
 *   lock that implementation: the state survives a file round-trip, a revive
 *   overwrites the killed set, a corrupt state is refused loudly, and two
 *   switches over one file share one view.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSqlitePrivateStore } from '@edugenesis/ledger';
import { HOSTED_PROVIDER_ID, createKillSwitch, type KillSwitchState } from '@edugenesis/onekey';
import { createSqliteKillSwitchStore, KILL_SWITCH_RECORD_ID } from './kill-switch-store.js';

/** A fresh SQLite private-store file for one test. */
function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'edugenesis-killswitch-')), 'private.sqlite');
}

/** A kill-switch state with one killed provider and one trail record. */
function killedState(): KillSwitchState {
  return {
    killed: [{ providerId: HOSTED_PROVIDER_ID, reason: 'a safety incident' }],
    records: [
      {
        providerId: HOSTED_PROVIDER_ID,
        reason: 'a safety incident',
        at: '2026-11-15T10:00:00.000Z',
        kind: 'kill',
      },
    ],
  };
}

test('a saved state reads back intact from a fresh store over the same file', () => {
  const path = storePath();
  const first = createSqlitePrivateStore({ path });
  const killStore = createSqliteKillSwitchStore({ privateStore: first });
  killStore.save(killedState());

  // A NEW process would open the file again; a second store instance over the
  // same file is the test stand-in for that restart.
  const second = createSqlitePrivateStore({ path });
  const reloaded = createSqliteKillSwitchStore({ privateStore: second }).load();

  assert.deepEqual(reloaded, killedState());
});

test('load returns undefined when nothing has ever been recorded', () => {
  const store = createSqlitePrivateStore({ path: storePath() });
  assert.equal(createSqliteKillSwitchStore({ privateStore: store }).load(), undefined);
});

test('a revive overwrites the killed set and appends to the trail', () => {
  const store = createSqlitePrivateStore({ path: storePath() });
  const killStore = createSqliteKillSwitchStore({ privateStore: store });
  killStore.save(killedState());
  killStore.save({
    killed: [],
    records: [
      ...killedState().records,
      {
        providerId: HOSTED_PROVIDER_ID,
        reason: 'the incident was cleared',
        at: '2026-11-15T11:00:00.000Z',
        kind: 'revive',
      },
    ],
  });

  const reloaded = createSqliteKillSwitchStore({ privateStore: store }).load();
  assert.deepEqual(reloaded?.killed, [], 'the revive must un-kill the provider');
  assert.equal(reloaded?.records.length, 2, 'the trail is append-only');
});

test('the state is stored as one private record, at the documented id', () => {
  const store = createSqlitePrivateStore({ path: storePath() });
  createSqliteKillSwitchStore({ privateStore: store }).save(killedState());

  const record = store.get(KILL_SWITCH_RECORD_ID);
  assert.ok(record, 'the kill-switch state must be a record in the private store');
  assert.ok(record.data['killed'] !== undefined, 'the payload must carry the killed set');
  assert.ok(record.data['records'] !== undefined, 'the payload must carry the trail');
});

test('a corrupt persisted state is refused loudly, never silently skipped', () => {
  const store = createSqlitePrivateStore({ path: storePath() });
  // A row at the kill-switch id whose payload is not a kill-switch state is a
  // corrupt durable store. Silently treating it as "nothing killed" would
  // re-enable a provider a human disabled - the opposite of the finding.
  store.put({
    id: KILL_SWITCH_RECORD_ID,
    kind: 'safeguarding',
    at: '2026-11-15T10:00:00.000Z',
    data: { killed: 'not-an-array' },
  });

  assert.throws(
    () => createSqliteKillSwitchStore({ privateStore: store }).load(),
    /corrupt/,
  );
});

test('two switches over one file share one view, and a new kill is visible to both', () => {
  const path = storePath();
  const switchA = createKillSwitch({
    store: createSqliteKillSwitchStore({ privateStore: createSqlitePrivateStore({ path }) }),
  });
  switchA.killSwitch(HOSTED_PROVIDER_ID, 'a safety incident');

  // A second switch - another replica, or this process after a restart.
  const switchB = createKillSwitch({
    store: createSqliteKillSwitchStore({ privateStore: createSqlitePrivateStore({ path }) }),
  });
  assert.equal(
    switchB.isKilled(HOSTED_PROVIDER_ID),
    true,
    'a kill issued elsewhere must stop this switch from the very first read',
  );

  switchB.killSwitch('local-echo', 'a licence problem');
  const switchC = createKillSwitch({
    store: createSqliteKillSwitchStore({ privateStore: createSqlitePrivateStore({ path }) }),
  });
  assert.equal(switchC.isKilled(HOSTED_PROVIDER_ID), true);
  assert.equal(switchC.isKilled('local-echo'), true);
});
