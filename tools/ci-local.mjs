#!/usr/bin/env node
/**
 * Local GL-01..GL-08 equivalents for a zero-cost release gate.
 * Runs the REAL repo tools; never skips or weakens a step.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'artifacts', 'ci-local', 'report.json');
const FAST = process.argv.includes('--fast');

const FULL_STEPS = [
  ['GL-01 secrets', 'npm', ['run', 'secrets:scan']],
  ['GL-02 sbom', 'npm', ['run', 'sbom']],
  ['GL-03 static analysis', 'npm', ['run', 'typecheck']],
  ['GL-04 accessibility contrast', 'node', ['tools/verify-contrast.mjs']],
  ['GL-05 accessibility coverage', 'node', ['tools/verify-coverage.mjs']],
  ['GL-06 portability', 'node', ['tools/verify-portability.mjs']],
  ['GL-07 all gates', 'node', ['tools/verify-all.mjs']],
  ['GL-08 reproducibility', 'npm', ['run', 'verify:repro']],
];
const steps = FAST ? FULL_STEPS.filter(([name]) => name !== 'GL-08 reproducibility') : FULL_STEPS;

const rows = [];
for (const [name, cmd, args] of steps) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 30 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let summary = lines.at(-1) ?? `exit ${String(result.status)}`;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^(RESULT:|checks:|EDUGENESIS)/.test(lines[i])) { summary = lines[i]; break; }
  }
  const passed = result.status === 0;
  rows.push({ id: name, passed, summary });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name} — ${summary}`);
}

const failed = rows.filter((r) => !r.passed);
const report = {
  tool: 'tools/ci-local.mjs',
  schemaVersion: 1,
  partial: FAST,
  result: failed.length > 0 ? 'FAIL' : FAST ? 'PARTIAL' : 'PASS',
  steps: rows,
  failed: failed.map((r) => r.id),
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(FAST
  ? 'RESULT: PARTIAL — --fast omits GL-08; this is NOT a release gate.'
  : `RESULT: ${report.result} — ${String(rows.length)} local gate equivalents.`);
process.exit(failed.length > 0 ? 1 : 0);
