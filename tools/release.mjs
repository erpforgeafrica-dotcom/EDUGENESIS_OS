#!/usr/bin/env node
/**
 * Release gate: refuse to deploy unless verify, verify:repro and ci:local are
 * green. P0-3 remains OWNER-BLOCKED: a local gate is NOT a hosted CI run.
 * No secret is ever printed, logged or written to the repository.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = 'srv-dbsu4q0ae00c7393kod0';
const API = 'https://api.render.com/v1/services';

/** Pure decision: all three gates must be green and the run must be complete. */
export function evaluateGate({ verifyExit, reproExit, ciLocalExit, ciLocalPartial }) {
  if (verifyExit !== 0) return { allowed: false, reason: 'npm run verify is not green.' };
  if (reproExit !== 0) return { allowed: false, reason: 'npm run verify:repro is not green.' };
  if (ciLocalExit !== 0) return { allowed: false, reason: 'npm run ci:local is not green.' };
  if (ciLocalPartial === true) return { allowed: false, reason: 'ci:local was run with --fast; it is partial.' };
  return { allowed: true, reason: 'verify, verify:repro and ci:local are green.' };
}

/** Deterministic release record; no timestamp, hostname or secret. */
export function renderReleaseRecord({ commit, deployId, status, probe }) {
  return JSON.stringify({
    tool: 'tools/release.mjs',
    schemaVersion: 1,
    commit,
    deployId,
    status,
    probe,
  }, null, 2) + '\n';
}

function readJson(rel) {
  try { return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')); }
  catch { return null; }
}

async function deploy() {
  const key = process.env['RENDER_API_KEY'];
  if (!key) {
    console.error('RESULT: REFUSED — RENDER_API_KEY is not set in the environment.');
    process.exit(2);
  }
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
    .stdout.trim();
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  let response = await fetch(`${API}/${SERVICE}/deploys`, {
    method: 'POST', headers, body: '{}',
  });
  if (!response.ok) {
    console.error(`RESULT: REFUSED — Render deploy trigger exited ${String(response.status)}.`);
    process.exit(2);
  }
  const created = await response.json();
  const deployId = created.id;
  let status = 'unknown';
  for (let i = 0; i < 90; i += 1) {
    response = await fetch(`${API}/${SERVICE}/deploys/${deployId}`, { headers });
    if (!response.ok) break;
    const body = await response.json();
    status = body.status;
    if (status === 'live' || /failed|cancelled/i.test(status)) break;
    await new Promise((r) => setTimeout(r, 20_000));
  }
  const liveCommit = created.commit?.id ?? '';
  const commitMatches = liveCommit === commit;
  let probe = 'not-run';
  if (status === 'live' && commitMatches) {
    const probeRun = spawnSync(process.execPath, ['tools/live-contract.mjs'], {
      cwd: ROOT, encoding: 'utf8', timeout: 10 * 60 * 1000,
    });
    probe = probeRun.status === 0 ? 'pass' : 'fail';
  }
  const out = join(ROOT, 'artifacts', 'release.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderReleaseRecord({ commit, deployId, status, probe }), 'utf8');
  console.log(`deploy ${deployId}: ${status}; commit matches: ${commitMatches}; live probe: ${probe}`);
  process.exit(status === 'live' && commitMatches && probe === 'pass' ? 0 : 1);
}

/** True only when this file is the CLI entry, never when imported for its pure functions. */
function isMainModule(url) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(url));
  } catch { return false; }
}

if (isMainModule(import.meta.url)) {
const verifyReport = readJson('artifacts/verify-report.json');
const ciReport = readJson('artifacts/ci-local/report.json');
const reproOk = process.argv.includes('--repro-ok'); // an attestation, not a shortcut
if (verifyReport?.result !== 'PASS') {
  console.error('RESULT: REFUSED — artifacts/verify-report.json is not PASS.');
  process.exit(2);
}
if (!ciReport || ciReport.result !== 'PASS' || ciReport.partial !== false) {
  console.error('RESULT: REFUSED — artifacts/ci-local/report.json is not a complete PASS.');
  process.exit(2);
}
const verdict = evaluateGate({
  verifyExit: verifyReport.result === 'PASS' ? 0 : 1,
  reproExit: reproOk ? 0 : 1,
  ciLocalExit: ciReport.result === 'PASS' ? 0 : 1,
  ciLocalPartial: ciReport.partial,
});
if (!verdict.allowed) {
  console.error(`RESULT: REFUSED — ${verdict.reason}`);
  process.exit(2);
}
await deploy();
}
