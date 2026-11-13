#!/usr/bin/env node
/**
 * EDUGENESIS OS — reproducibility probe.
 *
 * WHAT THIS PROVES
 *   That two consecutive `npm run verify` runs over the same source tree
 *   produce byte-identical evidence: the checksum manifest, the SBOM, the
 *   verification report and the attestation. If any of them drifts, the
 *   committed evidence describes a run that a reviewer cannot reproduce.
 *
 * WHY IT RUNS THE CHAIN TWICE
 *   Comparing against the files already on disk cannot distinguish "the chain
 *   is deterministic" from "the chain did not run". Both runs start from the
 *   same unmodified source, so any difference between their outputs is drift
 *   in the tooling, not in the code under audit.
 *
 * TWO MODES
 *   `npm run verify:repro`            run `npm run verify` twice (build, tests,
 *                                    gates, evidence). The complete probe; the
 *                                    release checklist uses this.
 *   `npm run verify:repro:evidence`   run only the four artifact writers twice.
 *                                    Build and tests write no evidence, so they
 *                                    cannot affect the compared bytes; this mode
 *                                    assumes a green `npm run verify` has just
 *                                    run in this tree (it does not rebuild).
 *                                    Use it when the full probe is impractical.
 *
 * WHEN TO RUN IT
 *   Before committing an evidence refresh, and in the release checklist. It is
 *   deliberately not part of `npm run verify`: it doubles the run time.
 *
 * Usage:  npm run verify:repro
 *         npm run verify:repro:evidence
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The evidence a reviewer reads. Order is stable for the report. */
const SUBJECTS = [
  'artifacts/checksums.sha256',
  'artifacts/sbom.cdx.json',
  'artifacts/verify-report.json',
  'artifacts/attestation.json',
];

function digest(relativePath) {
  const absolute = join(ROOT, relativePath);
  if (!existsSync(absolute)) return null;
  return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

function snapshot() {
  const state = {};
  for (const relativePath of SUBJECTS) state[relativePath] = digest(relativePath);
  return state;
}

function runVerify(label) {
  process.stdout.write(`\n--- ${label} ---\n`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // Windows cannot spawn a .cmd shim directly; the shell resolves the shim and
  // the arguments are fixed, so there is no interpolation surface here.
  const result = spawnSync(npm, ['run', 'verify'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    process.stdout.write(`RESULT: FAIL — ${label} could not start: ${result.error.message}.\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stdout.write(`RESULT: FAIL — ${label} exited ${String(result.status)}.\n`);
    process.exit(1);
  }
}

runVerify('verify run 1 of 2');
const first = snapshot();

runVerify('verify run 2 of 2');
const second = snapshot();

const drift = SUBJECTS.filter((relativePath) => first[relativePath] !== second[relativePath]);

process.stdout.write('\nEDUGENESIS OS — reproducibility probe\n\n');
for (const relativePath of SUBJECTS) {
  const value = second[relativePath] ?? '(missing)';
  process.stdout.write(`${drift.includes(relativePath) ? 'DRIFT' : 'same '}  ${relativePath}  ${value}\n`);
}

if (drift.length > 0) {
  process.stdout.write(`\nRESULT: FAIL — ${String(drift.length)} evidence file(s) changed between two runs over the same source.\n`);
  process.exit(1);
}

process.stdout.write('\nRESULT: PASS — two runs over the same source produced byte-identical evidence.\n');
process.exit(0);
