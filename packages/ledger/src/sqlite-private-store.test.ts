/**
 * SQLite-backed private store tests.
 *
 * WHY THESE TESTS EXIST
 * `private-store.ts` is in-memory BY DESIGN: it holds identity, consent and
 * safeguarding records for the minimum time, and persistence was left to the
 * service that owns the data. This module is the piece that makes that
 * ownership real — the same `PrivateStore` contract, backed by a file, so the
 * private records are still there after a restart.
 *
 * WHAT IS PROVED HERE
 *   - the store behaves like the in-memory store it replaces (put/get/all/byKind);
 *   - a record SURVIVES A CLOSE AND REOPEN — the durability proof;
 *   - a missing parent directory is created, so a fresh deployment works;
 *   - `close()` is idempotent, because shutdown paths run twice;
 *   - the defensive-copy contract is preserved (a caller cannot mutate stored
 *     identity data through a record it kept, nor through one it read back);
 *   - a payload that cannot be stored FAILS LOUDLY rather than losing fields.
 *
 * WHAT IS NOT PROVED HERE (and must never be)
 *   Nothing in this file writes to the public ledger. The two stores are
 *   separate surfaces (Doc 2 §2.5, §15).
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import type { PrivateRecord } from '@edugenesis/contracts';

import { createSqlitePrivateStore } from './sqlite-private-store.js';

/** A scratch directory outside the repository tree. */
const root = mkdtempSync(join(tmpdir(), 'edugenesis-ledger-private-'));

/** Every handle opened by a test, so shutdown can never leak a file lock. */
const handles: Array<{ close(): void }> = [];

after(() => {
  for (const handle of handles) {
    try {
      handle.close();
    } catch {
      // Already closed by the test itself; closing twice is a documented no-op.
    }
  }
  rmSync(root, { recursive: true, force: true });
});

/** Open a store on `file` and remember it for cleanup. */
function openStore(file: string, now?: () => string): ReturnType<typeof createSqlitePrivateStore> {
  const store = createSqlitePrivateStore({ path: file, now });
  handles.push(store);
  return store;
}

/** A synthetic record. No real learner data exists in this repo. */
function record(id: string, kind: PrivateRecord['kind'] = 'identity'): PrivateRecord {
  return {
    id,
    kind,
    at: '2026-02-01T00:00:00.000Z',
    data: { cohort: 'Kisumu-G7-A', learnerRef: 'L1' },
  };
}

test('the store puts, reads back and filters by kind', () => {
  const store = openStore(join(root, 'basic.db'));
  store.put(record('r1', 'assessment'));
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

test('DURABILITY: a record survives a close and a reopen of the same file', () => {
  const file = join(root, 'durable.db');
  const first = openStore(file);
  first.put(record('r1', 'assessment'));
  first.close();

  const second = openStore(file);
  const found = second.get('r1');
  assert.ok(found, 'the record must still be there after the restart');
  assert.equal(found.kind, 'assessment');
  assert.equal(found.at, '2026-02-01T00:00:00.000Z');
  assert.equal(found.data['cohort'], 'Kisumu-G7-A');
  assert.equal(second.all().length, 1);
  assert.equal(second.byKind('assessment').length, 1);
});

test('a parent directory that does not exist is created', () => {
  const directory = join(root, 'nested', 'deeper');
  const file = join(directory, 'private.db');
  assert.equal(existsSync(directory), false);

  const store = openStore(file);
  store.put(record('r1'));

  assert.equal(existsSync(directory), true, 'the parent directory must be created');
  assert.equal(store.get('r1')?.id, 'r1');
});

test('close is safe to call twice', () => {
  const store = openStore(join(root, 'double-close.db'));
  store.put(record('r1'));
  store.close();
  assert.doesNotThrow(() => {
    store.close();
  });
});

test('the store copies on the way in and on the way out', () => {
  const store = openStore(join(root, 'copies.db'));
  const original = record('r1', 'assessment');
  store.put(original);

  const payload = original.data as Record<string, unknown>;
  payload['cohort'] = 'Mutated';
  assert.equal(store.get('r1')?.data['cohort'], 'Kisumu-G7-A');

  const read = store.get('r1');
  assert.ok(read);
  const readPayload = read.data as Record<string, unknown>;
  readPayload['cohort'] = 'MutatedAgain';
  assert.equal(store.get('r1')?.data['cohort'], 'Kisumu-G7-A');
});

test('a record written twice is replaced, not duplicated', () => {
  const store = openStore(join(root, 'replace.db'));
  store.put(record('r1'));
  store.put({
    id: 'r1',
    kind: 'consent',
    at: '2026-02-02T00:00:00.000Z',
    data: { granted: true },
  });

  assert.equal(store.all().length, 1);
  assert.equal(store.get('r1')?.kind, 'consent');
});

test('the store refuses malformed records, exactly as the in-memory store does', () => {
  const store = openStore(join(root, 'malformed.db'));

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
  assert.throws(() => {
    store.put({ id: 'x', kind: 'identity', at: 'not-a-date', data: {} });
  });
  assert.throws(() => {
    store.put({
      id: 'x',
      kind: 'identity',
      at: '2026-02-01T00:00:00.000Z',
      data: null as unknown as Record<string, unknown>,
    });
  });

  assert.equal(store.all().length, 0);
});

test('a payload that cannot be stored FAILS LOUDLY instead of losing fields', () => {
  const store = openStore(join(root, 'unserialisable.db'));

  assert.throws(
    () => {
      store.put({
        id: 'fn',
        kind: 'identity',
        at: '2026-02-01T00:00:00.000Z',
        data: { callback: ((): void => {}) as unknown as string },
      });
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /callback/);
      return true;
    },
  );

  const circular: Record<string, unknown> = { name: 'loop' };
  circular['self'] = circular;
  assert.throws(() => {
    store.put({
      id: 'loop',
      kind: 'identity',
      at: '2026-02-01T00:00:00.000Z',
      data: circular,
    });
  });

  assert.equal(store.get('fn'), undefined);
  assert.equal(store.get('loop'), undefined);
});

test('the injected clock stamps a record that omits its timestamp', () => {
  const store = openStore(join(root, 'clock.db'), () => '2026-03-01T00:00:00.000Z');

  // `at` is optional at runtime: the contract type requires it, the store
  // accepts a record without one and stamps it from the injected clock.
  store.put({ id: 'stamped', kind: 'identity', data: {} } as unknown as PrivateRecord);

  assert.equal(store.get('stamped')?.at, '2026-03-01T00:00:00.000Z');
});

test('the store refuses to be used after it is closed', () => {
  const store = openStore(join(root, 'closed.db'));
  store.close();
  assert.throws(() => {
    store.put(record('r1'));
  });
});
