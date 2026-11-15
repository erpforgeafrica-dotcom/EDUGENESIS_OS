/**
 * Durable audit log tests.
 *
 * WHY THIS MODULE EXISTS
 * Consent and enrolment decisions are child-safeguarding evidence. An
 * in-memory trail that evaporates on restart is not evidence, and an evidence
 * record that can be quietly edited is worse than no record at all. This log
 * is append-only, hash-chained and durable: an auditor can re-derive every
 * link and see exactly where a record was tampered with.
 *
 * WHAT IS PROVED HERE
 *   - the chain starts at seq 1 and links to 'genesis';
 *   - every event commits to its predecessor;
 *   - a HEALTHY chain verifies;
 *   - a TAMPERED chain is DETECTED, at the right seq, and `verify()` REPORTS
 *     it instead of throwing — an auditor must be able to READ a broken chain;
 *   - events survive a close and a reopen;
 *   - the sequence number belongs to the log and can never be supplied by a
 *     caller;
 *   - the hash is reproducible by anyone with the canonical preimage.
 *
 * THERE IS NO UPDATE AND NO DELETE. A mistake is answered by appending a
 * compensating event, never by editing the record it replaces.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { DatabaseSync } from 'node:sqlite';

import { canonicalJson, sha256Hex } from './hash.js';
import { createDurableAuditLog } from './durable-audit-log.js';

/** A scratch directory outside the repository tree. */
const root = mkdtempSync(join(tmpdir(), 'edugenesis-ledger-audit-'));

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

/** Open a log on `file` and remember it for cleanup. */
function openLog(file: string): ReturnType<typeof createDurableAuditLog> {
  const log = createDurableAuditLog({ path: file, now: (): string => '2026-02-01T00:00:00.000Z' });
  handles.push(log);
  return log;
}

test('the first event is seq 1 and chains to genesis', () => {
  const log = openLog(join(root, 'first.db'));
  const event = log.append('consent.granted', {
    subjectId: 'learner-1',
    detail: { scope: 'progress_visible_to_guardian', granted: true },
  });

  assert.equal(event.seq, 1);
  assert.equal(event.previousHash, 'genesis');
  assert.equal(event.kind, 'consent.granted');
  assert.equal(event.subjectId, 'learner-1');
  assert.match(event.hash, /^[0-9a-f]{64}$/);
  assert.equal(event.at, '2026-02-01T00:00:00.000Z');
});

test('every event commits to its predecessor', () => {
  const log = openLog(join(root, 'chain.db'));
  const first = log.append('consent.granted', { subjectId: 'learner-1' });
  const second = log.append('enrolment.provisional', { subjectId: 'learner-1' });
  const third = log.append('enrolment.refused', {
    subjectId: 'learner-2',
    detail: { reason: 'guardian consent missing' },
  });

  assert.equal(second.seq, 2);
  assert.equal(second.previousHash, first.hash);
  assert.equal(third.seq, 3);
  assert.equal(third.previousHash, second.hash);
  assert.equal(log.all().length, 3);
});

test('a healthy chain verifies', () => {
  const log = openLog(join(root, 'healthy.db'));
  log.append('consent.granted', { subjectId: 'learner-1', detail: { granted: true } });
  log.append('consent.withdrawal', { subjectId: 'learner-1' });
  log.append('enrolment.enrolled', { subjectId: 'learner-1' });

  const result = log.verify();
  assert.equal(result.ok, true);
  assert.equal(result.entriesChecked, 3);
  assert.equal(result.brokenAtSeq, undefined);
});

test('the hash is reproducible by anyone from the canonical preimage', () => {
  const log = openLog(join(root, 'reproducible.db'));
  const event = log.append('consent.granted', {
    actorId: 'guardian-1',
    subjectId: 'learner-1',
    detail: { scope: 'progress_visible_to_guardian' },
  });

  const preimage = {
    seq: event.seq,
    at: event.at,
    kind: event.kind,
    actorId: event.actorId,
    subjectId: event.subjectId,
    detail: event.detail,
    previousHash: event.previousHash,
  };
  assert.equal(event.hash, sha256Hex(canonicalJson(preimage)));
});

test('TAMPER: a changed hash in the persisted file is DETECTED at its seq', () => {
  const file = join(root, 'tampered.db');
  const log = openLog(file);
  log.append('consent.granted', { subjectId: 'learner-1' });
  log.append('enrolment.provisional', { subjectId: 'learner-1' });
  log.append('enrolment.refused', { subjectId: 'learner-2' });
  log.close();

  // Attack the stored bytes directly, the way someone with filesystem access
  // would: the hash of seq 1 is rewritten.
  const tamper = new DatabaseSync(file);
  tamper.prepare('UPDATE audit_events SET hash = ? WHERE seq = ?').run('0'.repeat(64), 1);
  tamper.close();

  const reopened = openLog(file);
  const result = reopened.verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAtSeq, 1);
  assert.equal(result.entriesChecked, 1);
  assert.ok((result.detail ?? '').length > 0, 'a break must be explained');
});

test('TAMPER: the broken chain is still READABLE, and verify() never throws', () => {
  const file = join(root, 'readable.db');
  const log = openLog(file);
  log.append('consent.granted', { subjectId: 'learner-1' });
  log.append('enrolment.provisional', { subjectId: 'learner-1' });
  log.close();

  const tamper = new DatabaseSync(file);
  tamper.prepare('UPDATE audit_events SET hash = ? WHERE seq = ?').run('f'.repeat(64), 1);
  tamper.close();

  const reopened = openLog(file);
  assert.doesNotThrow(() => {
    reopened.verify();
  });
  // The evidence stays readable: a broken chain is still evidence.
  assert.equal(reopened.all().length, 2);
  assert.equal(reopened.all()[0]?.kind, 'consent.granted');
  assert.equal(reopened.verify().ok, false);
});

test('a broken chain still accepts a compensating append, and keeps reporting the break', () => {
  const file = join(root, 'compensating.db');
  const log = openLog(file);
  log.append('consent.granted', { subjectId: 'learner-1' });
  log.append('enrolment.provisional', { subjectId: 'learner-1' });
  log.close();

  const tamper = new DatabaseSync(file);
  tamper.prepare('UPDATE audit_events SET hash = ? WHERE seq = ?').run('0'.repeat(64), 1);
  tamper.close();

  const reopened = openLog(file);
  const compensation = reopened.append('audit.correction', {
    detail: { corrects_seq: 1, reason: 'the stored hash did not match the event contents' },
  });
  assert.equal(compensation.seq, 3);
  assert.equal(reopened.verify().ok, false);
  assert.equal(reopened.verify().brokenAtSeq, 1);
});

test('DURABILITY: events survive a close and a reopen', () => {
  const file = join(root, 'durable.db');
  const log = openLog(file);
  const first = log.append('consent.granted', {
    subjectId: 'learner-1',
    detail: { scope: 'progress_visible_to_guardian' },
  });
  log.append('enrolment.provisional', { subjectId: 'learner-1' });
  log.close();

  const reopened = openLog(file);
  const events = reopened.all();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.seq, 1);
  assert.equal(events[0]?.hash, first.hash);
  assert.equal(events[0]?.previousHash, 'genesis');
  assert.equal(events[0]?.subjectId, 'learner-1');
  assert.equal(events[0]?.detail['scope'], 'progress_visible_to_guardian');
  assert.equal(events[1]?.previousHash, first.hash);
  assert.equal(reopened.verify().ok, true);
});

test('the sequence belongs to the log and can never be supplied by a caller', () => {
  const file = join(root, 'seq.db');
  const log = openLog(file);
  log.append('consent.granted', { subjectId: 'learner-1' });
  // A caller trying to dictate the sequence is ignored: the log owns it.
  const second = log.append('enrolment.provisional', {
    subjectId: 'learner-1',
    seq: 99,
  } as unknown as { subjectId: string });
  assert.equal(second.seq, 2);
  log.close();

  const reopened = openLog(file);
  const third = reopened.append('enrolment.refused', { subjectId: 'learner-2' });
  assert.equal(third.seq, 3, 'the chain continues across a restart');
  assert.equal(reopened.verify().ok, true);
});

test('there is no update and no delete operation on the log', () => {
  const log = openLog(join(root, 'immutable.db'));
  log.append('consent.granted', { subjectId: 'learner-1' });

  const surface = log as unknown as Record<string, unknown>;
  assert.equal(surface['update'], undefined);
  assert.equal(surface['delete'], undefined);
  assert.equal(surface['remove'], undefined);
  assert.equal(surface['set'], undefined);
});

test('close is safe to call twice', () => {
  const log = openLog(join(root, 'double-close.db'));
  log.append('consent.granted', { subjectId: 'learner-1' });
  log.close();
  assert.doesNotThrow(() => {
    log.close();
  });
});

test('a malformed event is refused rather than stored half-way', () => {
  const log = openLog(join(root, 'malformed.db'));

  assert.throws(() => {
    log.append('', { subjectId: 'learner-1' });
  });
  assert.throws(() => {
    log.append('consent.granted', {
      detail: { nested: { not: 'allowed' } } as unknown as Record<string, string>,
    });
  });
  assert.throws(() => {
    log.append('consent.granted', {
      detail: { missing: undefined } as unknown as Record<string, string>,
    });
  });

  assert.equal(log.all().length, 0);
});
