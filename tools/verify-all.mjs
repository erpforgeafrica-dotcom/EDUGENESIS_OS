#!/usr/bin/env node
/**
 * EDUGENESIS OS — the full verification report.
 *
 * Runs every gate in `packages/verification`, plus the token contrast gate
 * and the portability gate, and prints one table.
 *
 * This is the single command that answers "is this build real, or is it
 * merely claimed to be?".
 *
 * Exit code 0 when no BLOCKER failed. A failed WARNING means a gate could
 * not be evaluated (usually a sibling package that another swarm unit has
 * not finished) — that is reported honestly, never as a pass.
 *
 * Usage:  node tools/verify-all.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFICATION_ENTRY = join(ROOT, 'packages', 'verification', 'dist', 'index.js');

/** A row of the report table. */
function row(id, title, severity, passed, detail) {
  return { id, title, severity, passed, detail };
}

/* -------------------------------------------------------------------------- */

async function buildVerificationPackage() {
  if (existsSync(VERIFICATION_ENTRY)) return true;
  process.stdout.write('building packages/verification ...\n');
  const build = spawnSync('npx', ['tsc', '-b', 'packages/verification'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 10 * 60 * 1000,
  });
  if (build.status !== 0) {
    process.stdout.write(`${build.stdout ?? ''}${build.stderr ?? ''}\n`);
    return false;
  }
  return existsSync(VERIFICATION_ENTRY);
}

function runTool(toolName, label) {
  const toolPath = join(ROOT, 'tools', toolName);
  const result = spawnSync(process.execPath, [toolPath], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const ok = result.status === 0;
  const summary = lastMeaningfulLine(stdout) || lastMeaningfulLine(stderr) || `exit ${String(result.status)}`;
  return {
    row: row(label, label, 'blocker', ok, ok ? summary : `failed — ${summary}`),
    stdout,
    stderr,
    ok,
  };
}

function lastMeaningfulLine(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.startsWith('RESULT:') || line.startsWith('checks:') || line.startsWith('EDUGENESIS')) return line;
  }
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padLeft(value, width) {
  const text = String(value);
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

/* -------------------------------------------------------------------------- */

async function main() {
  process.stdout.write('EDUGENESIS OS — full verification report\n\n');

  if (!(await buildVerificationPackage())) {
    process.stdout.write('RESULT: FAIL — packages/verification could not be built, so no gate could run.\n');
    process.exit(1);
  }

  const harness = await import(pathToFileURL(VERIFICATION_ENTRY).href);
  const results = await harness.runAllGates(harness.GATE_REGISTRY, { root: ROOT });

  const rows = results.map((result) =>
    row(result.id, result.id, result.severity, result.passed, result.detail),
  );

  const contrast = runTool('verify-contrast.mjs', 'token-contrast');
  const portability = runTool('verify-portability.mjs', 'path-portability-runtime');

  const allRows = [...rows, contrast.row, portability.row];

  const idWidth = Math.max(...allRows.map((r) => r.id.length), 10);
  const titleWidth = Math.max(...allRows.map((r) => r.title.length), 10);

  process.stdout.write(
    `${pad('id', idWidth)}  ${pad('title', titleWidth)}  ${pad('severity', 8)}  ${pad('result', 7)}  detail\n`,
  );
  process.stdout.write(`${'-'.repeat(idWidth + titleWidth + 8 + 7 + 4 + 40)}\n`);
  for (const r of allRows) {
    const verdict = r.passed ? 'PASS' : r.severity === 'blocker' ? 'FAIL' : 'WARN';
    process.stdout.write(
      `${pad(r.id, idWidth)}  ${pad(r.title, titleWidth)}  ${pad(r.severity, 8)}  ${pad(verdict, 7)}  ${r.detail}\n`,
    );
  }

  const blockerFailures = allRows.filter((r) => !r.passed && r.severity === 'blocker');
  const warningFailures = allRows.filter((r) => !r.passed && r.severity === 'warning');

  process.stdout.write('\n');
  process.stdout.write(
    `gates: ${String(allRows.length)}   passed: ${String(allRows.filter((r) => r.passed).length)}   blockers failed: ${String(blockerFailures.length)}   warnings: ${String(warningFailures.length)}\n`,
  );

  if (blockerFailures.length > 0) {
    process.stdout.write('\nBLOCKER FAILURES\n');
    for (const r of blockerFailures) process.stdout.write(`  - ${r.id}: ${r.detail}\n`);
  }
  if (warningFailures.length > 0) {
    process.stdout.write('\nWARNINGS (could not be evaluated — not a pass)\n');
    for (const r of warningFailures) process.stdout.write(`  - ${r.id}: ${r.detail}\n`);
  }

  process.stdout.write('\n');
  if (blockerFailures.length > 0) {
    process.stdout.write('RESULT: FAIL — the build has unmet blockers.\n');
    process.exit(1);
  }
  process.stdout.write('RESULT: PASS — no blocker failed. Warnings above are unverified areas, not passes.\n');
  process.exit(0);
}

main().catch((error) => {
  process.stdout.write(`RESULT: FAIL — the verification harness itself threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
