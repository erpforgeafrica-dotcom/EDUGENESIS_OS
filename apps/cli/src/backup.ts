/**
 * EduGenesis OS — sealed backup and restore of the durable SQLite stores.
 *
 * WHY THIS MODULE EXISTS (ADR-0026, PG-10/PG-11/PG-12)
 * ADR-0018 and ADR-0019 made the private store, the consent/enrolment audit log
 * and the public sponsor ledger durable across a crash or a restart. On the
 * Render free tier the filesystem is EPHEMERAL: a redeploy or a spin-down erases
 * every one of those files. Durability inside an instance is not custody.
 * This module supplies the missing, zero-cost half: a SEALED, tamper-evident
 * snapshot that an operator can carry to a location they control, and a restore
 * that verifies before it writes a single byte.
 *
 * THE SEAL
 * One JSON document. Every `*.sqlite` under the data directory is read as
 * bytes, base64-encoded into a file entry with its size and SHA-256, entries
 * are sorted by name, and the whole document is covered by a SHA-256 checksum
 * over its canonical form with the `checksum` field excluded. `verifyBackup`
 * recomputes every file hash and the envelope checksum and compares them with
 * `timingSafeEqual`. A single-character edit to any byte is therefore reported, not
 * restored. The public `BackupEnvelope` is the METADATA view of that document;
 * the base64 payload stays inside the sealed file on disk and is never logged.
 *
 * THE RESTORE CONTRACT
 * Verify first, write second. A name must be a flat, safe file name — no `..`,
 * no separators, no drive letter — before any path is formed. Each file is
 * staged to a temp file and renamed into place, and a failure rolls back every
 * file already written. A rejected backup leaves the target untouched.
 *
 * ZERO DEPENDENCIES AND PORTABILITY
 * Only `node:crypto`, `node:fs` and `node:path` are imported (ADR-0014). The
 * data directory and the output directory are supplied by the caller and
 * resolved at runtime; no path, user name or drive letter is baked in
 * (GLOBAL.md §9). The canonical serialiser sorts keys by code unit, so a
 * snapshot verified on one machine verifies on another.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

/** Caller-supplied configuration for a backup service. */
export interface BackupOptions {
  readonly dataDir: string;
  readonly now?: () => Date;
}

/** The metadata view of one sealed snapshot. */
export interface BackupEnvelope {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly files: readonly {
    readonly name: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly checksum: string;
  readonly sealed: true;
}

/** Outcome of a restore attempt (inlined in `BackupServices` below). */
type RestoreResult =
  | { readonly ok: true; readonly restored: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** Outcome of a verification attempt (inlined in `BackupServices` below). */
type VerifyResult = {
  readonly ok: boolean;
  readonly error?: string;
  readonly envelope?: BackupEnvelope;
};

/** The service the CLI wires behind `backup:export` and `backup:restore`. */
export interface BackupServices {
  exportBackup(outDir: string): BackupEnvelope;
  restoreBackup(file: string): { ok: true; restored: readonly string[] } | { ok: false; error: string };
  verifyBackup(file: string): { ok: boolean; error?: string; envelope?: BackupEnvelope };
}

/** A file entry including the base64 payload. Never exposed on `BackupEnvelope`. */
interface SealedFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly content: string;
}

/** The exact on-disk document. */
interface SealedDocument {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly files: readonly SealedFile[];
  readonly checksum: string;
  readonly sealed: true;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const DRIVE_LETTER = /^[a-zA-Z]:/;

/** SHA-256 of a string or a byte buffer, lowercase hex. */
function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Locale-independent canonical JSON: object keys sorted, array order kept. */
function canonicalize(value: unknown, path: string): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalise a non-finite number at "${path}".`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child === undefined) continue;
      out[key] = canonicalize(child, path === '' ? key : `${path}.${key}`);
    }
    return out;
  }
  throw new TypeError(`Cannot canonicalise a value of type "${typeof value}" at "${path}".`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, ''));
}

/** The checksum covers everything except the checksum field itself. */
function checksumOf(document: Omit<SealedDocument, 'checksum'>): string {
  return sha256Hex(
    canonicalJson({
      schemaVersion: document.schemaVersion,
      createdAt: document.createdAt,
      files: document.files,
      sealed: document.sealed,
    }),
  );
}

/** Constant-time comparison of two lowercase hex digests. */
function sameDigest(actual: string, expected: string): boolean {
  if (!HEX_SHA256.test(expected) || !HEX_SHA256.test(actual)) return false;
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A flat name cannot escape the data directory. */
function isSafeName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('..') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !DRIVE_LETTER.test(value) &&
    !isAbsolute(value) &&
    basename(value) === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `target` is exactly one flat child of `root`. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, resolve(target));
  return rel.length > 0 && rel === basename(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Discover every SQLite file under `dir`, recursively, excluding sidecars. */
function collectSqliteFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSqliteFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith('.sqlite')) continue;
    if (name.endsWith('-shm') || name.endsWith('-wal')) continue;
    if (name.endsWith('-shm.sqlite') || name.endsWith('-wal.sqlite')) continue;
    found.push(full);
  }
  return found;
}

/** Read and fully validate a sealed document from disk. */
function loadDocument(file: string):
  | { readonly ok: true; readonly document: SealedDocument }
  | { readonly ok: false; readonly error: string } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, error: `The backup file could not be read: ${(error as Error).message}.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'The backup file is not valid JSON.' };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: 'The backup file must contain a JSON object.' };
  }
  if (parsed['schemaVersion'] !== 1) {
    return {
      ok: false,
      error: `Unsupported backup schemaVersion: ${String(parsed['schemaVersion'])}; only 1 is accepted.`,
    };
  }
  if (parsed['sealed'] !== true) {
    return { ok: false, error: 'The backup file is not sealed and cannot be trusted.' };
  }
  const createdAt = parsed['createdAt'];
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    return { ok: false, error: 'The backup createdAt is not a parseable ISO-8601 timestamp.' };
  }
  const checksum = parsed['checksum'];
  if (typeof checksum !== 'string' || !HEX_SHA256.test(checksum)) {
    return { ok: false, error: 'The backup checksum is missing or malformed.' };
  }
  const rawFiles = parsed['files'];
  if (!Array.isArray(rawFiles)) {
    return { ok: false, error: 'The backup files field is not an array.' };
  }

  const files: SealedFile[] = [];
  for (const [index, rawFile] of rawFiles.entries()) {
    if (!isRecord(rawFile)) {
      return { ok: false, error: `Backup entry ${index} is not an object.` };
    }
    const name = rawFile['name'];
    if (!isSafeName(name)) {
      return {
        ok: false,
        error:
          `Backup entry ${index} has an unsafe file name (traversal, separator or drive letter refused).`,
      };
    }
    const bytes = rawFile['bytes'];
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
      return { ok: false, error: `Backup entry "${name}" has an invalid byte count.` };
    }
    const sha256 = rawFile['sha256'];
    if (typeof sha256 !== 'string' || !HEX_SHA256.test(sha256)) {
      return { ok: false, error: `Backup entry "${name}" has a malformed sha256.` };
    }
    const content = rawFile['content'];
    if (typeof content !== 'string' || content.length % 4 !== 0) {
      return { ok: false, error: `Backup entry "${name}" has malformed base64 content.` };
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(content, 'base64');
    } catch {
      return { ok: false, error: `Backup entry "${name}" could not be base64-decoded.` };
    }
    if (decoded.length !== bytes) {
      return {
        ok: false,
        error: `Backup entry "${name}" declares ${bytes} bytes but its content decodes to ${decoded.length}.`,
      };
    }
    if (!sameDigest(sha256Hex(decoded), sha256)) {
      return { ok: false, error: `Backup entry "${name}" failed its per-file hash check.` };
    }
    files.push({ name, bytes, sha256, content });
  }

  const document: SealedDocument = {
    schemaVersion: 1,
    createdAt,
    files,
    checksum,
    sealed: true,
  };
  if (!sameDigest(checksumOf(document), checksum)) {
    return { ok: false, error: 'Backup checksum mismatch: the sealed envelope was altered.' };
  }
  return { ok: true, document };
}

/** Strip base64 content down to the public metadata view. */
function metadataOf(document: SealedDocument): BackupEnvelope {
  return {
    schemaVersion: document.schemaVersion,
    createdAt: document.createdAt,
    files: document.files.map((file) => ({
      name: file.name,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
    checksum: document.checksum,
    sealed: true,
  };
}

/** Create the backup service bound to one data directory. */
export function createBackupServices(options: BackupOptions): BackupServices {
  if (typeof options.dataDir !== 'string' || options.dataDir.trim().length === 0) {
    throw new Error('Backups need a non-empty data directory.');
  }
  const dataDir = resolve(options.dataDir);
  const now = options.now ?? ((): Date => new Date());

  const exportBackup = (outDir: string): BackupEnvelope => {
    if (typeof outDir !== 'string' || outDir.trim().length === 0) {
      throw new Error('Backups need a non-empty output directory.');
    }
    if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
      throw new Error(`Backup export refused: the data directory "${dataDir}" does not exist.`);
    }

    const paths = collectSqliteFiles(dataDir);
    if (paths.length === 0) {
      throw new Error(`Backup export refused: no *.sqlite files found under "${dataDir}".`);
    }

    // Flat names: the sealed format refuses separators, so nested layouts are
    // flattened to a basename and a collision is refused rather than silently
    // overwriting one store with another.
    const byName = new Map<string, string>();
    for (const path of paths) {
      const name = basename(path);
      if (byName.has(name)) {
        throw new Error(
          `Backup export refused: two SQLite files share the name "${name}"; the sealed format needs unique flat names.`,
        );
      }
      byName.set(name, path);
    }

    const files: SealedFile[] = [...byName.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, path]) => {
        const bytes = readFileSync(path);
        return {
          name,
          bytes: bytes.length,
          sha256: sha256Hex(bytes),
          content: bytes.toString('base64'),
        };
      });

    const instant = now();
    const createdAt = instant.toISOString();
    const unsigned = {
      schemaVersion: 1 as const,
      createdAt,
      files,
      sealed: true as const,
    };
    const document: SealedDocument = { ...unsigned, checksum: checksumOf(unsigned) };

    const target = resolve(outDir);
    mkdirSync(target, { recursive: true });
    const file = join(target, `backup-${createdAt.replace(/:/g, '-')}.json`);
    const temp = join(target, `.backup-${randomBytes(6).toString('hex')}.tmp`);
    try {
      writeFileSync(temp, canonicalJson(document), 'utf8');
      renameSync(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw new Error(`The sealed backup could not be written: ${(error as Error).message}.`);
    }
    return metadataOf(document);
  };

  const verifyBackup = (file: string): VerifyResult => {
    const checked = loadDocument(file);
    if (!checked.ok) return { ok: false, error: checked.error };
    return { ok: true, envelope: metadataOf(checked.document) };
  };

  const restoreBackup = (file: string): RestoreResult => {
    const checked = loadDocument(file);
    if (!checked.ok) return { ok: false, error: checked.error };
    const document = checked.document;

    mkdirSync(dataDir, { recursive: true });
    const staged: { readonly temp: string; readonly target: string }[] = [];
    const committed: string[] = [];
    try {
      // Stage every byte before touching a destination: a failed write cannot
      // leave a half-restored store behind.
      for (const entry of document.files) {
        const target = join(dataDir, entry.name);
        if (!isSafeName(entry.name) || !isInside(dataDir, target)) {
          throw new Error(`Refusing to write outside the data directory: "${entry.name}".`);
        }
        const temp = join(
          dataDir,
          `.${entry.name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
        );
        writeFileSync(temp, Buffer.from(entry.content, 'base64'));
        staged.push({ temp, target });
      }
      for (const { temp, target } of staged) {
        renameSync(temp, target);
        committed.push(target);
      }
      return { ok: true, restored: document.files.map((entry) => entry.name) };
    } catch (error) {
      for (const target of committed) rmSync(target, { force: true });
      for (const { temp } of staged) rmSync(temp, { force: true });
      return {
        ok: false,
        error: `Restore failed: ${(error as Error).message}; no files were written.`,
      };
    }
  };

  return { exportBackup, restoreBackup, verifyBackup };
}
