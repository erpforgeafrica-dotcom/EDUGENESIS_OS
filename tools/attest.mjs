#!/usr/bin/env node
/**
 * EDUGENESIS OS — the attestation.
 *
 * WHAT THIS IS
 *   One small JSON document that says, in machine-readable form: "on this tree,
 *   with this toolchain, the verification report passed N of N gates with zero
 *   blocker failures, and here are the digests of the evidence."
 *
 * WHY IT REFUSES RATHER THAN RECORDS A FAILURE
 *   An attestation that can describe a red build is not an attestation; it is a
 *   log line. This tool exits non-zero and writes nothing when the report is
 *   red, so the existence of `artifacts/attestation.json` is itself a claim that
 *   the gates passed.
 *
 * WHY IT RE-HASHES EVERY FILE IN THE MANIFEST
 *   Hashing the manifest alone proves only that the manifest is intact. If
 *   somebody edited `verify-report.json` after the manifest was generated, the
 *   manifest digest would still match while the evidence had changed. So the
 *   manifest is verified against the bytes on disk, file by file, before
 *   anything is attested. A missing file or a changed digest is a hard refusal.
 *
 * WHY THE ATTESTATION NAMES NO COMMIT, AND HAS NO DEFAULT TIMESTAMP
 *   An attestation lives inside the tree it describes, so it cannot name the
 *   commit that contains it: the name would have to be known before the commit
 *   exists, and every commit would then change the file it just committed. The
 *   same applies to a timestamp taken from the HEAD commit. The bytes are
 *   therefore a function of the tree and nothing else. When the build system
 *   supplies `SOURCE_DATE_EPOCH` (the reproducible-builds convention) that
 *   value is recorded; otherwise the field is omitted rather than faked. The
 *   commit that introduced an artifact is recoverable with
 *   `git log -1 --format=%H -- artifacts/attestation.json`.
 *
 * Usage:  node tools/attest.mjs
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS_DIR = join(ROOT, 'artifacts');
const REPORT_PATH = join(ARTIFACTS_DIR, 'verify-report.json');
const SBOM_PATH = join(ARTIFACTS_DIR, 'sbom.cdx.json');
const MANIFEST_PATH = join(ARTIFACTS_DIR, 'checksums.sha256');
const OUTPUT_PATH = join(ARTIFACTS_DIR, 'attestation.json');

function refuse(message) {
  // A refusal must also remove any attestation left by an earlier green run.
  // Otherwise the file's existence would keep asserting a pass that the
  // current tree cannot support — the exact false green this tool exists to
  // prevent.
  let removedStale = false;
  if (existsSync(OUTPUT_PATH)) {
    try {
      rmSync(OUTPUT_PATH, { force: true });
      removedStale = true;
    } catch {
      // If it cannot be removed, say so rather than pretend it is gone.
    }
  }
  process.stdout.write(`RESULT: FAIL — ${message}\n`);
  if (removedStale) process.stdout.write('removed the stale attestation from an earlier run.\n');
  else if (existsSync(OUTPUT_PATH)) process.stdout.write('WARNING: a stale attestation could not be removed and must be deleted by hand.\n');
  process.exit(1);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

for (const [label, path] of [
  ['the verification report', REPORT_PATH],
  ['the SBOM', SBOM_PATH],
  ['the checksum manifest', MANIFEST_PATH],
]) {
  if (!existsSync(path)) refuse(`${label} is missing at ${relative(ROOT, path)}. Run "npm run verify" from the top.`);
}

/* ---- 1. The report must be green ---------------------------------------- */

let report;
try {
  report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
} catch (error) {
  refuse(`the verification report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

if (report.result !== 'PASS') {
  refuse(`the verification report says "${String(report.result)}". A red build is never attested.`);
}
const counts = report.counts ?? {};
if (counts.blockersFailed !== 0) {
  refuse(`the verification report records ${String(counts.blockersFailed)} failed blocker(s). A red build is never attested.`);
}
if (!Array.isArray(report.gates) || report.gates.length === 0) {
  refuse('the verification report contains no gates, so it proves nothing.');
}
if (counts.gates !== report.gates.length) {
  refuse(`the report counts ${String(counts.gates)} gates but lists ${String(report.gates.length)} — the report is internally inconsistent.`);
}

/* ---- 2. The manifest must match the bytes on disk ------------------------ */

const manifestLines = readFileSync(MANIFEST_PATH, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

if (manifestLines.length === 0) refuse('the checksum manifest is empty.');

const verified = [];
const problems = [];
for (const line of manifestLines) {
  const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
  if (!match) {
    problems.push(`malformed manifest line: ${line}`);
    continue;
  }
  const digest = match[1];
  const relPath = match[2];
  const absolute = join(ROOT, relPath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    problems.push(`${relPath} is listed but missing`);
    continue;
  }
  const actual = sha256File(absolute);
  if (actual !== digest) {
    problems.push(`${relPath} changed since the manifest was written`);
    continue;
  }
  verified.push(relPath);
}

if (problems.length > 0) {
  process.stdout.write('REFUSED\n');
  for (const problem of problems.slice(0, 20)) process.stdout.write(`  - ${problem}\n`);
  if (problems.length > 20) process.stdout.write(`  - … and ${problems.length - 20} more\n`);
  refuse('the checksum manifest does not describe the current tree. Regenerate it with "node tools/checksums.mjs".');
}

/* ---- 3. The evidence must be inside the manifest ------------------------- */

const verifiedSet = new Set(verified);
for (const required of ['artifacts/sbom.cdx.json', 'artifacts/verify-report.json']) {
  if (!verifiedSet.has(required)) refuse(`${required} is not covered by the checksum manifest, so the attestation would not bind it.`);
}

/* ---- 4. Provenance ------------------------------------------------------ */

function reproducibleTimestamp() {
  const epoch = process.env['SOURCE_DATE_EPOCH'];
  if (typeof epoch !== 'string' || !/^\d+$/.test(epoch.trim())) return null;
  const declared = new Date(Number(epoch.trim()) * 1000);
  return Number.isNaN(declared.getTime()) ? null : declared.toISOString();
}

function gitValue(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) return null;
  const value = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  return value.length > 0 ? value : null;
}

const head = gitValue(['rev-parse', 'HEAD']);

/**
 * Read `git status --porcelain` WITHOUT trimming the output.
 *
 * WHY NOT gitValue(): `.trim()` removes the leading space of the first line,
 * and in porcelain format that space is the index-status column. Trimming it
 * shifted the first path by one character — `apps/cli/public/index.html` was
 * attested as `pps/cli/public/index.html`. gitValue stays for scalar values.
 */
function gitStatusPaths() {
  const result = spawnSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=normal'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length >= 4)
    .map((line) => {
      // Format: XY<space>PATH. A rename appends " -> ORIGINAL" in v1.
      const rest = line.slice(3);
      const arrow = rest.lastIndexOf(' -> ');
      return (arrow === -1 ? rest : rest.slice(arrow + 4)).replace(/^"(.*)"$/, '$1');
    });
}

const changedPaths = gitStatusPaths();
const treeKnown = changedPaths !== null;
const allPaths = changedPaths ?? [];

/*
 * WHY NO GIT STATE IS WRITTEN INTO THE ATTESTATION
 *
 * This tool rewrites artifacts/attestation.json, artifacts/checksums.sha256 and
 * artifacts/sbom.cdx.json on every run, so the whole tree is dirty immediately
 * after a successful run. The obvious repair — record `codeTreeDirty` over
 * source only — does not work either, and the reason is worth stating because
 * it is the same defect as `gitHead`:
 *
 *   Committing `attestation.json` is exactly what makes the code tree clean.
 *   A file that stores the tree's dirty state therefore contradicts itself the
 *   moment it is committed: a clean checkout regenerates it with
 *   `codeTreeDirty: false`, the bytes differ from the committed ones, the tree
 *   is dirty again, and `git status --porcelain` can never be empty.
 *
 *   So the dirty state, the changed paths, HEAD and any HEAD-derived timestamp
 *   are all reported to the console and never stored. The attested bytes are a
 *   function of the tree's CONTENT and of nothing else: re-running the chain on
 *   a committed checkout reproduces this file byte for byte. That is the
 *   property `npm run verify:repro` checks.
 */
const artifactPaths = allPaths.filter(
  (path) => path === 'artifacts' || path.startsWith('artifacts/'),
);
const codePaths = allPaths.filter(
  (path) => !(path === 'artifacts' || path.startsWith('artifacts/')),
);

const subjects = [
  { name: 'artifacts/verify-report.json', sha256: sha256File(REPORT_PATH), bytes: statSync(REPORT_PATH).size },
  { name: 'artifacts/sbom.cdx.json', sha256: sha256File(SBOM_PATH), bytes: statSync(SBOM_PATH).size },
  { name: 'artifacts/checksums.sha256', sha256: sha256File(MANIFEST_PATH), bytes: statSync(MANIFEST_PATH).size },
];

const timestamp = reproducibleTimestamp();

const attestation = {
  schemaVersion: 1,
  tool: 'tools/attest.mjs',
  statement:
    'The EduGenesis OS verification gates passed on this tree with zero blocker failures, and every file in the checksum manifest matched its recorded digest at attestation time.',
  result: 'PASS',
  counts: {
    gates: report.gates.length,
    passed: counts.passed,
    blockersFailed: counts.blockersFailed,
    warnings: counts.warnings,
    filesVerified: verified.length,
  },
  subjects,
  ...(timestamp === null ? {} : { buildTime: timestamp }),
  toolchain: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
};

mkdirSync(ARTIFACTS_DIR, { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(attestation, null, 2)}\n`, 'utf8');

const toPosix = (value) => value.split('\\').join('/');

process.stdout.write('EDUGENESIS OS — attestation\n\n');
process.stdout.write(`gates attested     : ${String(attestation.counts.gates)} (${String(attestation.counts.passed)} passed, ${String(attestation.counts.blockersFailed)} blocker failures)\n`);
process.stdout.write(`files verified     : ${String(verified.length)} against the checksum manifest\n`);
process.stdout.write(`git HEAD           : ${head ?? '(not a git checkout)'} (informational; the attestation names no commit)\n`);
process.stdout.write(`code tree          : ${treeKnown ? (codePaths.length === 0 ? 'clean' : `${String(codePaths.length)} changed path(s), artifacts excluded`) : '(git unavailable)'} (reported, never attested)\n`);
process.stdout.write(`artifact tree      : ${artifactPaths.length === 0 ? 'unchanged' : `${String(artifactPaths.length)} regenerated path(s)`} (reported, never attested)\n`);
process.stdout.write(`attestation        : ${toPosix(relative(ROOT, OUTPUT_PATH))}\n`);
process.stdout.write(`attestation sha256 : ${sha256File(OUTPUT_PATH)}\n`);
process.stdout.write('RESULT: PASS — the evidence is bound and the build is green.\n');
process.exit(0);
