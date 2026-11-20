#!/usr/bin/env node
/**
 * tools/durable-export.mjs — PG-10 scheduled durability on a free instance.
 *
 * WHY IT EXISTS: a free Render instance has an ephemeral filesystem, so the
 * durable stores survive a restart but not a redeploy. ADR-0026 answers that
 * with a sealed export/restore. This tool is the scheduled half: it seals the
 * stores, verifies the seal by re-reading it, rotates old exports, and prints
 * one machine-readable line. A cron/scheduled task runs it; an operator can
 * restore from any sealed file with tools/backup or the backup service.
 *
 * It refuses to declare success unless the sealed file re-verifies byte-for-byte.
 * Zero runtime dependencies (ADR-0014).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(process.cwd());
const DATA_DIR = join(ROOT, '.edugenesis-data');
const OUT_DIR = join(ROOT, 'data', 'backups');
const KEEP = Number(process.env['EG_BACKUP_KEEP'] ?? 7);

const { createBackupServices } = await import(
  pathToFileURL(join(ROOT, 'apps', 'cli', 'dist', 'backup.js')).href
);

if (!existsSync(DATA_DIR)) {
  console.log('RESULT: SKIP — no durable store exists yet; nothing to seal.');
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
const backup = createBackupServices({ dataDir: DATA_DIR });
const envelope = backup.exportBackup(OUT_DIR);
const newest = readdirSync(OUT_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ name: f, mtime: statSync(join(OUT_DIR, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];

const verification = backup.verifyBackup(join(OUT_DIR, newest.name));
if (!verification.ok) {
  console.error(`RESULT: FAIL — the sealed export did not re-verify: ${verification.error ?? 'unknown'}`);
  process.exit(1);
}

// Rotate: keep the newest KEEP sealed exports, remove older ones only.
const all = readdirSync(OUT_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ name: f, mtime: statSync(join(OUT_DIR, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
const removed = [];
for (const old of all.slice(KEEP)) {
  rmSync(join(OUT_DIR, old.name), { force: true });
  removed.push(old.name);
}

const record = {
  tool: 'tools/durable-export.mjs',
  schemaVersion: 1,
  result: 'PASS',
  file: newest.name,
  createdAt: envelope.createdAt,
  files: envelope.files.length,
  bytes: envelope.files.reduce((sum, f) => sum + f.bytes, 0),
  checksum: envelope.checksum,
  verified: verification.ok,
  kept: Math.min(all.length, KEEP),
  removed,
  note: 'A free instance is still ephemeral: this export is the durability, and restoring it is the drill. A paid persistent disk remains an owner upgrade (ADR-0026).',
};
mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
writeFileSync(join(ROOT, 'artifacts', 'durable-export.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
console.log(`RESULT: PASS — sealed ${record.files} file(s) into ${record.file}; re-verified; kept ${record.kept}, removed ${removed.length}.`);
