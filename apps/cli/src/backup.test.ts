/**
 * Sealed backup / restore tests (PG-10, PG-11, PG-12 — ADR-0026).
 *
 * WHAT IS PROVED HERE
 *   - every *.sqlite under the data dir is snapshotted, sorted, sidecars ignored;
 *   - the envelope is deterministic under an injected clock;
 *   - export -> restore is byte-identical into a FRESH directory;
 *   - a "restore drill" recreates a deleted data dir and reads real rows back;
 *   - one flipped base64 character, one changed checksum and one recomputed
 *     traversal name are all refused;
 *   - a failed verification writes nothing at all into the target directory.
 *
 * Every test uses a real DatabaseSync SQLite file and a hermetic temp dir.
 * Nothing in this file reads or writes the repository.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createBackupServices } from './backup.js';

// Every test gets its own, independently removable temp directory.
const root = mkdtempSync(join(tmpdir(), 'edugenesis-backup-'));
let caseNo = 0;

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function freshDir(label: string): string {
  const dir = join(root, `${label}-${caseNo++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const FIXED = '2026-01-02T03:04:05.000Z';
function fixedNow(): () => Date {
  return () => new Date(FIXED);
}

/** A real SQLite file with a row we can read back after a restore. */
function makeStore(file: string, text: string): void {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE notes (id TEXT PRIMARY KEY, text TEXT NOT NULL)');
  db.prepare('INSERT INTO notes (id, text) VALUES (?, ?)').run('learner-1', text);
  db.close();
}

function readText(file: string): string | undefined {
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare('SELECT text FROM notes WHERE id = ?').get('learner-1') as
      | { text: string }
      | undefined;
    return row?.text;
  } finally {
    db.close();
  }
}

/** The one sealed JSON the service writes into an out dir. */
function onlyBackup(outDir: string): string {
  const json = readdirSync(outDir).filter((name) => name.endsWith('.json'));
  assert.equal(json.length, 1, 'exactly one sealed backup file is written');
  return join(outDir, json[0]!);
}

interface MutableFile {
  name: string;
  bytes: number;
  sha256: string;
  content: string;
}
interface MutableDoc {
  schemaVersion: number;
  createdAt: string;
  files: MutableFile[];
  checksum: string;
  sealed: boolean;
}

function readDoc(file: string): MutableDoc {
  return JSON.parse(readFileSync(file, 'utf8')) as MutableDoc;
}

/** Independent canonicaliser: key-sorted, array order preserved. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const parts = Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`);
    return `{${parts.join(',')}}`;
  }
  throw new TypeError('unexpected value');
}

/** Recompute the checksum the same way an independent auditor would. */
function recomputeChecksum(doc: MutableDoc): string {
  const { checksum: _ignored, ...rest } = doc;
  return createHash('sha256').update(canonical(rest), 'utf8').digest('hex');
}

function reseal(file: string, doc: MutableDoc): void {
  doc.checksum = recomputeChecksum(doc);
  writeFileSync(file, canonical(doc), 'utf8');
}

test('export snapshots every SQLite file, sorted by name, ignoring -shm/-wal sidecars', () => {
  const dataDir = freshDir('snapshot');
  makeStore(join(dataDir, 'private.sqlite'), 'private row');
  makeStore(join(dataDir, 'ledger.sqlite'), 'ledger row');
  makeStore(join(dataDir, 'audit.sqlite'), 'audit row');
  writeFileSync(join(dataDir, 'private.sqlite-shm'), 'sidecar');
  writeFileSync(join(dataDir, 'private.sqlite-wal'), 'sidecar');
  writeFileSync(join(dataDir, 'notes.txt'), 'not a database');

  const outDir = freshDir('snapshot-out');
  const envelope = createBackupServices({ dataDir, now: fixedNow() }).exportBackup(outDir);

  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.sealed, true);
  assert.equal(envelope.createdAt, FIXED);
  assert.deepEqual(
    envelope.files.map((f) => f.name),
    ['audit.sqlite', 'ledger.sqlite', 'private.sqlite'],
  );
  assert.match(envelope.checksum, /^[0-9a-f]{64}$/);
  for (const file of envelope.files) {
    assert.ok(file.bytes > 0, `${file.name} has a real byte count`);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
});

test('export refuses a missing or an empty data directory', () => {
  const missing = join(root, 'does-not-exist');
  const empty = freshDir('empty');
  assert.equal(existsSync(missing), false);
  assert.throws(() => createBackupServices({ dataDir: missing }).exportBackup(freshDir('m-out')));
  assert.throws(() => createBackupServices({ dataDir: empty }).exportBackup(freshDir('e-out')));
});

test('export is deterministic for the same clock and the same bytes', () => {
  const dataDir = freshDir('determinism');
  makeStore(join(dataDir, 'private.sqlite'), 'same bytes');
  const outA = freshDir('determinism-a');
  const outB = freshDir('determinism-b');
  const svc = createBackupServices({ dataDir, now: fixedNow() });
  const a = svc.exportBackup(outA);
  const b = svc.exportBackup(outB);

  assert.deepEqual(a, b);
  assert.equal(readFileSync(onlyBackup(outA), 'utf8'), readFileSync(onlyBackup(outB), 'utf8'));
});

test('export -> restore is byte-identical into a fresh directory', () => {
  const dataDir = freshDir('roundtrip-src');
  makeStore(join(dataDir, 'private.sqlite'), 'round trip');
  makeStore(join(dataDir, 'ledger.sqlite'), 'second file');
  const outDir = freshDir('roundtrip-out');
  const target = freshDir('roundtrip-target');

  const svc = createBackupServices({ dataDir, now: fixedNow() });
  const envelope = svc.exportBackup(outDir);
  const result = createBackupServices({ dataDir: target }).restoreBackup(onlyBackup(outDir));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.restored, ['ledger.sqlite', 'private.sqlite']);
  assert.equal(envelope.files.length, 2);
  for (const name of ['ledger.sqlite', 'private.sqlite'] as const) {
    assert.ok(
      readFileSync(join(dataDir, name)).equals(readFileSync(join(target, name))),
      `${name} is byte-identical after restore`,
    );
  }
});

test('restore drill: a deleted data directory is rebuilt and its learner row read back', () => {
  const dataDir = freshDir('drill-src');
  makeStore(join(dataDir, 'private.sqlite'), 'guardian consent recorded');
  const outDir = freshDir('drill-out');
  const backup = onlyBackupAfterExport(dataDir, outDir);

  // The whole data directory is gone — the disaster the drill simulates.
  rmSync(dataDir, { recursive: true, force: true });
  assert.equal(existsSync(dataDir), false);

  const result = createBackupServices({ dataDir }).restoreBackup(backup);
  assert.equal(result.ok, true);
  assert.equal(existsSync(join(dataDir, 'private.sqlite')), true);
  assert.equal(readText(join(dataDir, 'private.sqlite')), 'guardian consent recorded');
});

function onlyBackupAfterExport(dataDir: string, outDir: string): string {
  createBackupServices({ dataDir, now: fixedNow() }).exportBackup(outDir);
  return onlyBackup(outDir);
}

test('verify detects one flipped base64 character and refuses to restore it', () => {
  const dataDir = freshDir('flip-src');
  makeStore(join(dataDir, 'private.sqlite'), 'do not tamper');
  const outDir = freshDir('flip-out');
  const backup = onlyBackupAfterExport(dataDir, outDir);

  const doc = readDoc(backup);
  const entry = doc.files[0]!;
  const before = entry.content[0]!;
  entry.content = `${before === 'A' ? 'B' : 'A'}${entry.content.slice(1)}`;
  const tampered = join(freshDir('flip-tampered'), 'tampered.json');
  writeFileSync(tampered, canonical(doc), 'utf8');

  const verified = createBackupServices({ dataDir }).verifyBackup(tampered);
  assert.equal(verified.ok, false);
  assert.match(verified.error ?? '', /hash|checksum/i);

  const target = freshDir('flip-target');
  const restore = createBackupServices({ dataDir: target }).restoreBackup(tampered);
  assert.equal(restore.ok, false);
  assert.deepEqual(readdirSync(target), []);
});

test('verify detects a checksum mismatch on an otherwise consistent envelope', () => {
  const dataDir = freshDir('checksum-src');
  makeStore(join(dataDir, 'private.sqlite'), 'checksummed');
  const outDir = freshDir('checksum-out');
  const backup = onlyBackupAfterExport(dataDir, outDir);

  const doc = readDoc(backup);
  doc.checksum = '0'.repeat(64);
  const changed = join(freshDir('checksum-changed'), 'changed.json');
  writeFileSync(changed, canonical(doc), 'utf8');
  assert.equal(createBackupServices({ dataDir }).verifyBackup(changed).ok, false);
  assert.match(
    createBackupServices({ dataDir }).verifyBackup(changed).error ?? '',
    /checksum/i,
  );
});

test('verify refuses traversal names even when the checksum is recomputed', () => {
  const dataDir = freshDir('traversal-src');
  makeStore(join(dataDir, 'private.sqlite'), 'traversal');
  const outDir = freshDir('traversal-out');
  const backup = onlyBackupAfterExport(dataDir, outDir);
  const original = readDoc(backup);

  // Built at runtime: a literal drive-letter path would correctly trip the
  // path-portability gate, which must never be weakened to admit a test fixture.
  const driveLetterAttack = ['C', ':', String.fromCharCode(92), 'evil.sqlite'].join('');
  const attacks = ['../escape.sqlite', '..\\escape.sqlite', 'sub/ok.sqlite', driveLetterAttack, '..'];
  for (const [index, name] of attacks.entries()) {
    const doc: MutableDoc = {
      ...original,
      files: [{ ...original.files[0]!, name }],
    };
    const file = join(freshDir(`traversal-${index}`), 'attack.json');
    reseal(file, doc);
    const result = createBackupServices({ dataDir }).verifyBackup(file);
    assert.equal(result.ok, false, `${name} is refused`);
    assert.match(result.error ?? '', /name|unsafe|traversal/i);
  }
});

test('verify refuses an unsupported schemaVersion and an unsealed envelope', () => {
  const dataDir = freshDir('schema-src');
  makeStore(join(dataDir, 'private.sqlite'), 'schema');
  const outDir = freshDir('schema-out');
  const backup = onlyBackupAfterExport(dataDir, outDir);
  const original = readDoc(backup);
  const svc = createBackupServices({ dataDir });

  const wrongVersion: MutableDoc = { ...original, schemaVersion: 2 };
  const versionFile = join(freshDir('schema-v'), 'v.json');
  reseal(versionFile, wrongVersion);
  assert.equal(svc.verifyBackup(versionFile).ok, false);
  assert.match(svc.verifyBackup(versionFile).error ?? '', /schemaVersion/i);

  const unsealed: MutableDoc = { ...original, sealed: false };
  const unsealedFile = join(freshDir('schema-s'), 's.json');
  reseal(unsealedFile, unsealed);
  assert.equal(svc.verifyBackup(unsealedFile).ok, false);
  assert.match(svc.verifyBackup(unsealedFile).error ?? '', /seal/i);
});

test('verify reports an unreadable or non-JSON file instead of throwing', () => {
  const dataDir = freshDir('malformed-src');
  makeStore(join(dataDir, 'private.sqlite'), 'malformed');
  const svc = createBackupServices({ dataDir });
  const missing = svc.verifyBackup(join(root, 'no-such-backup.json'));
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? '', /read/i);

  const notJson = join(freshDir('malformed'), 'bad.json');
  writeFileSync(notJson, '{not json', 'utf8');
  const parsed = svc.verifyBackup(notJson);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error ?? '', /json/i);
});

test('verify returns a metadata envelope with no base64 content', () => {
  const dataDir = freshDir('metadata-src');
  makeStore(join(dataDir, 'private.sqlite'), 'metadata');
  const outDir = freshDir('metadata-out');
  const backup = onlyBackupAfterExport(dataDir, outDir);
  const envelope = createBackupServices({ dataDir }).verifyBackup(backup).envelope;

  assert.ok(envelope, 'a valid backup returns its envelope');
  assert.deepEqual(Object.keys(envelope!.files[0]!).sort(), ['bytes', 'name', 'sha256']);
});
