#!/usr/bin/env node
/**
 * EDUGENESIS OS — the guardian coverage gate.
 *
 * THE CLAIM THIS PROVES
 *   Every learner-facing emission is intercepted by the accessibility guardian
 *   exactly once, on every delivery path — not just on the happy path a unit
 *   test happens to exercise.
 *
 * WHY A COUNTING WRAPPER AND NOT A UNIT TEST
 *   A unit test asserts that ONE path calls the guardian. It cannot tell you
 *   that a path was added later which forgot to. This gate wraps the REAL
 *   guardian in a counter, drives every delivery path the gateway can produce,
 *   and compares two numbers that must agree:
 *
 *       deliveries   — `complete()` resolved, so text reached a caller
 *       interceptions — the guardian's `intercept()` was entered
 *
 *   deliveries === interceptions === 1 per path, or the gate fails.
 *
 * WHY THE OPERATOR CONTROL IS IN THE REPORT
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

const onekey = await import(pathToFileURL(join(ONEKEY, 'index.js')).href);
const support = await import(pathToFileURL(join(ONEKEY, 'testing', 'support.js')).href);
const contracts = await import(pathToFileURL(join(CONTRACTS, 'index.js')).href);
const accessibility = await import(pathToFileURL(join(ACCESSIBILITY, 'index.js')).href);

const { createOneKeyGateway, createTierZeroProvider } = onekey;
const { createContext, createMockAdapter, createPolicy, createRequest } = support;
const { ProviderUnavailableError } = contracts;
const { createAccessibilityGuardian, createAccessibilityValidator } = accessibility;

/** A request the offline curriculum bundle can answer exactly. */
const OFFLINE_PROMPT = 'Explain curriculum:algebra/linear-eq';
/** A request the offline bundle has no exact entry for. */
const LIVE_PROMPT = 'Explain photosynthesis in simple terms';

/** Wrap the real guardian so every interception is counted. */
function countingGuardian(real, sink) {
  return {
    async intercept(emission, ctx) {
      sink.interceptions += 1;
      return real.intercept(emission, ctx);
    },
  };
}

/** One delivery path, driven end to end through a real gateway. */
async function runPath(spec) {
  const real = createAccessibilityGuardian(createAccessibilityValidator());
  const sink = { interceptions: 0 };
  const guardian = countingGuardian(real, sink);
  const gateway = createOneKeyGateway(spec.gatewayOptions ?? {});
  for (const adapter of spec.adapters ?? []) gateway.register(adapter);

  const ctx = createContext({ learnerFacing: spec.learnerFacing, guardian });
  const request = createRequest({ prompt: spec.prompt });

  let delivered = false;
  let tier = null;
  let bytes = 0;
  let failure = null;
  try {
    const result = await gateway.complete(createPolicy(), request, ctx);
    delivered = true;
    tier = result.meta.tier;
    bytes = result.text.length;
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  return {
    name: spec.name,
    learnerFacing: spec.learnerFacing,
    delivered,
    tier,
    bytes,
    interceptions: sink.interceptions,
    failure,
  };
}

const failing = (id, tier) => createMockAdapter({ id, tier, failWith: new ProviderUnavailableError(id, 'simulated outage') });

/** Every learner-facing delivery path the gateway can produce. */
const learnerPaths = [
  {
    name: 'tier-0-exact',
    learnerFacing: true,
    prompt: OFFLINE_PROMPT,
    gatewayOptions: { tierZero: createTierZeroProvider() },
  },
  {
    name: 'tier-1-primary',
    learnerFacing: true,
    prompt: LIVE_PROMPT,
    gatewayOptions: { tierZero: createTierZeroProvider() },
    adapters: [createMockAdapter({ id: 'p1', tier: 1 }).adapter],
  },
  {
    name: 'tier-2-fallback',
    learnerFacing: true,
    prompt: LIVE_PROMPT,
    gatewayOptions: { tierZero: createTierZeroProvider() },
    adapters: [failing('p1', 1).adapter, createMockAdapter({ id: 'p2', tier: 2 }).adapter],
  },
  {
    name: 'tier-3-local',
    learnerFacing: true,
    prompt: LIVE_PROMPT,
    gatewayOptions: { tierZero: createTierZeroProvider() },
    adapters: [
      failing('p1', 1).adapter,
      failing('p2', 2).adapter,
      createMockAdapter({ id: 'p3', tier: 3 }).adapter,
    ],
  },
  {
    name: 'tier-0-last-resort',
    learnerFacing: true,
    prompt: LIVE_PROMPT,
    gatewayOptions: { tierZero: createTierZeroProvider() },
    adapters: [failing('p1', 1).adapter, failing('p2', 2).adapter, failing('p3', 3).adapter],
  },
  {
    name: 'tier-4-human-deferral',
    learnerFacing: true,
    prompt: LIVE_PROMPT,
    gatewayOptions: {
      // No offline tier, so the ladder must reach the human rung.
      tierFour: {
        async serve() {
          return {
            text: 'A human tutor will reply within one working day.',
            providerId: 'tier-four',
            modelId: 'human-support',
            usage: { inputTokens: 0, outputTokens: 0 },
            latencyMs: 0,
            sourceLineage: [],
          };
        },
      },
    },
    adapters: [failing('p1', 1).adapter, failing('p2', 2).adapter, failing('p3', 3).adapter],
  },
];

/**
 * The negative control: an operator path, where the guardian is not applicable
 * by design. If this reports an interception, the counter is counting requests
 * and the coverage figure below is meaningless.
 */
const operatorControl = {
  name: 'operator-not-learner-facing',
  learnerFacing: false,
  prompt: LIVE_PROMPT,
  gatewayOptions: { tierZero: createTierZeroProvider() },
  adapters: [createMockAdapter({ id: 'p1', tier: 1 }).adapter],
};

process.stdout.write('EDUGENESIS OS — guardian coverage gate\n\n');

const learner = [];
for (const spec of learnerPaths) learner.push(await runPath(spec));
const control = await runPath(operatorControl);

const pad = (value, width) => String(value).padEnd(width);

process.stdout.write(`${pad('path', 26)}${pad('tier', 6)}${pad('delivered', 11)}${pad('guarded', 9)}bytes\n`);
process.stdout.write(`${'-'.repeat(26 + 6 + 11 + 9 + 8)}\n`);
for (const row of learner) {
  process.stdout.write(
    `${pad(row.name, 26)}${pad(row.tier ?? '-', 6)}${pad(row.delivered ? 'yes' : 'NO', 11)}${pad(row.interceptions, 9)}${row.bytes}\n`,
  );
}

const problems = [];

for (const row of learner) {
  if (!row.delivered) {
    problems.push(`${row.name}: the path did not deliver, so it proves nothing (${row.failure ?? 'no error recorded'})`);
    continue;
  }
  if (row.interceptions === 0) {
    problems.push(`${row.name}: delivered without the guardian — an unguarded learner-facing emission`);
    continue;
  }
  if (row.interceptions !== 1) {
    problems.push(`${row.name}: the guardian ran ${row.interceptions} times for one delivery — expected exactly once`);
  }
}

const delivered = learner.filter((row) => row.delivered).length;
const guarded = learner.filter((row) => row.delivered && row.interceptions === 1).length;
const percent = delivered === 0 ? 0 : Math.round((guarded / delivered) * 1000) / 10;

process.stdout.write('\n');
if (control.delivered && control.interceptions === 0) {
  process.stdout.write(
    `control: ${control.name} delivered tier ${control.tier} with 0 interceptions — the counter measures interception, not requests.\n`,
  );
} else if (!control.delivered) {
  problems.push(`the operator control did not deliver (${control.failure ?? 'no error recorded'}), so the counter is unproven`);
} else {
  problems.push(`the operator control was intercepted ${control.interceptions} times — the counter cannot distinguish learner from operator paths`);
}

process.stdout.write(`coverage: ${guarded}/${delivered} learner-facing deliveries guarded exactly once = ${percent}%\n`);

if (delivered !== learner.length) {
  problems.push(`${learner.length - delivered} of ${learner.length} learner-facing paths never delivered`);
}

if (problems.length > 0) {
  process.stdout.write('\nFAILURES\n');
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  process.stdout.write('\nRESULT: FAIL — guardian coverage is not 100%.\n');
  process.exit(1);
}

process.stdout.write('\nRESULT: PASS — every learner-facing delivery path is guarded exactly once.\n');
process.exit(0);
