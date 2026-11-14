#!/usr/bin/env node
/**
 * EDUGENESIS OS — the guardian coverage gate.
 *
 * THE CLAIM THIS PROVES
 *   Every learner-facing emission is intercepted by the accessibility guardian
 *   exactly once, on every delivery path — not just on the happy path a unit
 *   test happens to exercise.
 *
 * WHERE THE PATHS COME FROM (F6-R4-03)
 *   The path list used to be a literal array in this script, so a new
 *   learner-facing delivery path added to the gateway was never counted. The
 *   list now comes from the DELIVERY-PATH REGISTRY exported by
 *   `packages/onekey/src/testing/delivery-paths.ts` — declared in the package
 *   that owns the gateway and the ladder, covered by its own unit test
 *   (`delivery-paths.test.ts`), and checked here against `FALLBACK_TIER_ROLE`
 *   from the contracts: every rung of the ladder must keep at least one
 *   learner-facing path, and every entry must serve from the tier its name
 *   claims. This script carries no path knowledge of its own any more.
 *
 * WHY A COUNTING WRAPPER AND NOT A UNIT TEST
 *   A unit test asserts that ONE path calls the guardian. It cannot tell you
 *   that a path was added later which forgot to. This gate wraps the REAL
 *   guardian in a counter, drives every delivery path in the registry, and
 *   compares two numbers that must agree:
 *
 *       deliveries   — `complete()` resolved, so text reached a caller
 *       interceptions — the guardian's `intercept()` was entered
 *
 *   deliveries === interceptions === 1 per learner path, or the gate fails.
 *
 * WHY THE OPERATOR CONTROL IS IN THE REGISTRY
 *   `learnerFacing: false` is the operator path, where the guardian is not
 *   applicable by design. Running it proves the counter counts INTERCEPTIONS
 *   rather than counting requests: if it incremented there too, a 100% score
 *   below would mean nothing.
 *
 * Exit 0 only when every learner-facing delivery was guarded exactly once.
 *
 * Usage:  node tools/verify-coverage.mjs
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ONEKEY = join(ROOT, 'packages', 'onekey', 'dist');
const CONTRACTS = join(ROOT, 'packages', 'contracts', 'dist');
const ACCESSIBILITY = join(ROOT, 'packages', 'accessibility', 'dist');
const REGISTRY = join(ONEKEY, 'testing', 'delivery-paths.js');

function die(message) {
  process.stdout.write(`RESULT: FAIL — ${message}\n`);
  process.exit(1);
}

for (const [label, entry] of [
  ['packages/onekey', join(ONEKEY, 'index.js')],
  ['packages/contracts', join(CONTRACTS, 'index.js')],
  ['packages/accessibility', join(ACCESSIBILITY, 'index.js')],
]) {
  if (!existsSync(entry)) die(`${label} is not built. Run "npm run build" first.`);
}

if (!existsSync(REGISTRY)) {
  die('the delivery-path registry is not built. Run "npm run build" first.');
}

const registry = await import(pathToFileURL(REGISTRY).href);
const { DELIVERY_PATHS, registryTierCoverage, runDeliveryPath } = registry;

process.stdout.write('EDUGENESIS OS — guardian coverage gate\n\n');

const entries = DELIVERY_PATHS ?? [];
if (entries.length === 0) {
  die('the delivery-path registry is empty — the gate has no paths to drive, so it proves nothing.');
}

const runs = [];
for (const entry of entries) {
  runs.push(await runDeliveryPath(entry.build()));
}

const pad = (value, width) => String(value).padEnd(width);

process.stdout.write(`${pad('path', 26)}${pad('tier', 6)}${pad('delivered', 11)}${pad('guarded', 9)}bytes\n`);
process.stdout.write(`${'-'.repeat(26 + 6 + 11 + 9 + 8)}\n`);
for (const run of runs) {
  process.stdout.write(
    `${pad(run.name, 26)}${pad(run.servedTier ?? '-', 6)}${pad(run.delivered ? 'yes' : 'NO', 11)}${pad(run.interceptions, 9)}${run.bytes}\n`,
  );
}

const learner = runs.filter((run) => run.learnerFacing);
const controls = runs.filter((run) => !run.learnerFacing);

const problems = [];

/* The registry must still cover the whole ladder (F6-R4-03). */
const coverage = registryTierCoverage(entries);
if (coverage.missing.length > 0) {
  problems.push(
    `the delivery-path registry does not cover tier(s) ${coverage.missing.join(', ')} — a ladder rung lost its only learner path`,
  );
}

for (const run of learner) {
  if (!run.delivered) {
    problems.push(`${run.name}: the path did not deliver, so it proves nothing (${run.failure ?? 'no error recorded'})`);
    continue;
  }
  if (run.servedTier !== run.declaredTier) {
    problems.push(
      `${run.name}: served from tier ${String(run.servedTier)} but the registry declares tier ${String(run.declaredTier)} — the registry must not lie about the path it names`,
    );
  }
  if (run.interceptions === 0) {
    problems.push(`${run.name}: delivered without the guardian — an unguarded learner-facing emission`);
    continue;
  }
  if (run.interceptions !== 1) {
    problems.push(`${run.name}: the guardian ran ${run.interceptions} times for one delivery — expected exactly once`);
  }
}

for (const control of controls) {
  if (control.delivered && control.interceptions === 0) {
    process.stdout.write(
      `\ncontrol: ${control.name} delivered tier ${String(control.servedTier)} with 0 interceptions — the counter measures interception, not requests.\n`,
    );
  } else if (!control.delivered) {
    problems.push(`${control.name}: the operator control did not deliver (${control.failure ?? 'no error recorded'}), so the counter is unproven`);
  } else {
    problems.push(`${control.name}: the operator control was intercepted ${control.interceptions} times — the counter cannot distinguish learner from operator paths`);
  }
}

const delivered = learner.filter((run) => run.delivered).length;
const guarded = learner.filter((run) => run.delivered && run.interceptions === 1).length;
const percent = delivered === 0 ? 0 : Math.round((guarded / delivered) * 1000) / 10;

process.stdout.write(`\ncoverage: ${guarded}/${delivered} learner-facing deliveries guarded exactly once = ${percent}%\n`);

if (delivered !== learner.length) {
  problems.push(`${learner.length - delivered} of ${learner.length} learner-facing paths never delivered`);
}

if (problems.length > 0) {
  process.stdout.write('\nFAILURES\n');
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  process.stdout.write('\nRESULT: FAIL — guardian coverage is not 100%.\n');
  process.exit(1);
}

process.stdout.write('\nRESULT: PASS — every learner-facing delivery path in the registry is guarded exactly once.\n');
process.exit(0);
