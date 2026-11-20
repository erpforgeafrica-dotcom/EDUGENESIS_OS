#!/usr/bin/env node
/**
 * tools/backup-restore.mjs — the restore half of ADR-0026.
 *
 *   node tools/backup-restore.mjs <sealed-export.json> [--data-dir <dir>]
 *
 * WHY IT EXISTS: `docs/RUNBOOK-BACKUP-RESTORE.md` tells an operator to run
 * `npm run backup:restore -- <file>`. A runbook instruction that has no
 * implementation is a false promise, and a backup nobody can restore is not a
 * backup. This tool VERIFIES the seal before it writes a single byte, restores
 * into the project's durable store, and prints the file NAMES only — never the
 * contents, which can contain learner and guardian data.
 *
 * Refusals:
 *   - no path given
 *   - the file does not exist
 *   - the seal fails (checksum mismatch, tampered envelope, foreign schema)
 *   - a restore target outside the project (the portability law keeps data
 *     inside the project folder; an absolute path outside it is refused)
 *
 * Zero runtime dependencies (ADR-0014).
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`backup:restore — ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let file = '';
let dataDir = join(ROOT, '.edugenesis-data');
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--data-dir') {
    const value = args[i + 1];
    if (typeof value !== 'string' || value === '') fail('--data-dir needs a path');
    dataDir = isAbsolute(value) ? value : resolve(ROOT, value);
    i += 1;
  } else if (file === '') {
    file = isAbsolute(args[i]) ? args[i] : resolve(ROOT, args[i]);
  } else {
    fail(`unexpected argument ${args[i]}`);
  }
}

if (file === '') fail('usage: node tools/backup-restore.mjs <sealed-export.json> [--data-dir <dir>]');
if (!existsSync(file)) fail(`no such export: ${relative(ROOT, file) || file}`);
if (statSync(file).isDirectory()) fail('the export path is a directory, not a sealed file');

const insideProject = !relative(ROOT, dataDir).startsWith(`..${sep}`) && !isAbsolute(relative(ROOT, dataDir));
if (!insideProject) fail('the restore target must be inside the project folder (portability law)');

const { createBackupServices } = await import(
  pathToFileURL(join(ROOT, 'apps', 'cli', 'dist', 'backup.js')).href
);
const backup = createBackupServices({ dataDir });

// Verify BEFORE writing: a restore of an unverified envelope is data loss.
const verification = backup.verifyBackup(file);
if (!verification.ok) fail(`the seal did not verify: ${verification.error ?? 'unknown'}`);
const envelope = verification.envelope;
if (envelope === undefined) fail('the seal verified but carried no envelope');

const result = backup.restoreBackup(file);
if (!result.ok) fail(`restore refused: ${result.error}`);

console.log(`RESULT: PASS — restored ${result.restored.length} file(s) into ${relative(ROOT, dataDir) || '.'}`);
console.log(`sealed at: ${envelope.createdAt}`);
console.log(`checksum : ${envelope.checksum}`);
for (const name of result.restored) console.log(`restored : ${name} (${String(envelope.files.find((f) => f.name === name)?.bytes ?? '?')} bytes)`);
console.log('No file contents were printed.');
