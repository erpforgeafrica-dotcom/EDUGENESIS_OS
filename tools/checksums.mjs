#!/usr/bin/env node
/**
 * EDUGENESIS OS — the checksum manifest.
 *
 * WHAT THIS IS
 *   A sorted list of `sha256  <path>` lines over every file a reviewer reads:
 *   the source tree, the documents, the configuration, and the evidence
 *   artefacts. `tools/attest.mjs` stores the digest of THIS file, so the
 *   attestation transitively binds every file listed here.
 *
 * WHY THE SCOPE IS EXPLICIT AND NOT `git ls-files`
 *   A fresh copy of the project may have no `.git` directory at all — the
 *   portability law requires the folder to work when it is copied to another
 *   machine. The scope therefore cannot depend on git. It is a fixed include
 *   list, so the same tree produces the same manifest everywhere.
 *
 * WHY SOME PATHS ARE EXCLUDED
 *   - `node_modules/`, `dist/`, `.git/` — installed or generated, not shipped.
 *   - `artifacts/checksums.sha256` — a file cannot contain its own digest.
 *   - `artifacts/attestation.json` — it contains this file's digest; including
 *     it would make the pair circular.
 *   The SBOM and the verification report ARE included: they are evidence.
 *
 * Output is sorted by repository-relative posix path, with LF line endings, so
 * two runs over an unchanged tree produce byte-identical output.
 *
 * Usage:  node tools/checksums.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS_DIR = join(ROOT, 'artifacts');
const OUTPUT_PATH = join(ARTIFACTS_DIR, 'checksums.sha256');

/** Directories never descended into. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', 'tmp', '.cache']);

/** Root-level entries that are part of the shipped project. */
const INCLUDE_ROOTS = [
  '.github',
  '.gitignore',
  'apps',
  'assets',
  'docs',
  'package-lock.json',
  'package.json',
  'packages',
  'README.md',
  'render.yaml',
  'REVIEW_RUBRIC.md',
  'SESSION_PROCESS_LOG.md',
  'settings',
  'tools',
  'tsconfig.base.json',
];

/**
 * Files that must never appear in the manifest.
 *
 * WHY THE BUILD STATE IS EXCLUDED: `*.tsbuildinfo` is TypeScript's incremental
 * cache. It is gitignored, it changes on every compile, and it is not shipped —
 * so attesting it made the manifest describe the build machine rather than the
 * product, and made two otherwise identical trees disagree. The round-4 audit
 * found seven of them in the manifest while `assets/` — which IS shipped — was
 * absent entirely.
 */
const EXCLUDE_SUFFIXES = ['.tsbuildinfo'];

/** Evidence artefacts included by name, because they live in a skipped scope. */
const INCLUDE_ARTIFACTS = ['artifacts/sbom.cdx.json', 'artifacts/verify-report.json'];

/** Files that must never appear in the manifest (self-reference / circularity). */
const EXCLUDE_PATHS = new Set(['artifacts/checksums.sha256', 'artifacts/attestation.json']);

/**
 * Paths that are runtime state, not shipped files.
 *
 * WHY: `settings/settings.local.json` is gitignored — it holds the learner's
 * own overrides, including API keys — so it differs on every machine that runs
 * the project. Attesting it made two copies of the same commit produce
 * different manifests, and put a digest of a secret-bearing file into a public
 * artefact. The manifest's own claim is "every SHIPPED file"; this keeps it
 * true.
 */
const EXCLUDE_PATTERNS = [/^settings\/.*\.local\.json$/, /^\.edugenesis-data\//];

function toPosix(value) {
  return value.split(sep).join('/');
}

function walk(absoluteDir, collected) {
  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(absolute, collected);
      continue;
    }
    if (!entry.isFile()) continue;
    collected.push(absolute);
  }
}

const files = [];

for (const entry of INCLUDE_ROOTS) {
  const absolute = join(ROOT, entry);
  if (!existsSync(absolute)) continue;
  const info = statSync(absolute);
  if (info.isDirectory()) {
    walk(absolute, files);
  } else if (info.isFile()) {
    files.push(absolute);
  }
}

for (const entry of INCLUDE_ARTIFACTS) {
  const absolute = join(ROOT, entry);
  if (existsSync(absolute) && statSync(absolute).isFile()) files.push(absolute);
}

const rows = [];
for (const absolute of files) {
  const relPath = toPosix(relative(ROOT, absolute));
  if (EXCLUDE_PATHS.has(relPath)) continue;
  if (EXCLUDE_SUFFIXES.some((suffix) => relPath.endsWith(suffix))) continue;
  if (EXCLUDE_PATTERNS.some((pattern) => pattern.test(relPath))) continue;
  const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
  rows.push({ relPath, digest });
}

if (rows.length === 0) {
  process.stdout.write('RESULT: FAIL — the checksum scope is empty, so the manifest would attest nothing.\n');
  process.exit(1);
}

rows.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

const lines = rows.map((row) => `${row.digest}  ${row.relPath}`);
mkdirSync(ARTIFACTS_DIR, { recursive: true });
writeFileSync(OUTPUT_PATH, `${lines.join('\n')}\n`, 'utf8');

const manifestDigest = createHash('sha256').update(readFileSync(OUTPUT_PATH)).digest('hex');

process.stdout.write('EDUGENESIS OS — checksum manifest\n\n');
process.stdout.write(`files hashed     : ${rows.length}\n`);
process.stdout.write(`manifest         : ${toPosix(relative(ROOT, OUTPUT_PATH))}\n`);
process.stdout.write(`manifest sha256  : ${manifestDigest}\n`);
process.stdout.write(`RESULT: PASS — every shipped file is in the manifest.\n`);
process.exit(0);
