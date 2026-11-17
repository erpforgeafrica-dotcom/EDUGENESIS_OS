#!/usr/bin/env node
/**
 * EDUGENESIS OS — the provider re-point gate.
 *
 * THE CLAIM THIS PROVES
 *   "A provider change is a registry change — no learner-path code may be
 *   edited to swap a provider." (Doc 2 ADR-0001)
 *
 * HOW IT IS PROVEN, IN THREE PARTS
 *
 *   A. STATIC SEAM. No learner-path module imports a provider implementation.
 *      The registry is the only door. This is checked against the same file
 *      predicate the package's own test uses, so the gate cannot drift from it.
 *
 *   B. DYNAMIC RE-POINT. The identical request is served twice: once with
 *      provider `alpha` in the registry, once with `beta`. The learner-path
 *      source is hashed before and after. A different provider must serve, and
 *      the hashes must be byte-identical — the swap cost zero code edits.
 *
 *   C. NON-VACUITY. An empty file list, an unchanged provider id, or a stale
 *      build would each make A or B pass for the wrong reason, so each is a
 *      hard failure rather than a silent pass.
 *
 * Exit 0 only when the provider seam is a registry entry and nothing else.
 *
 * Usage:  node tools/verify-repoint.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'packages', 'onekey', 'src');
const DIST = join(ROOT, 'packages', 'onekey', 'dist');

function die(message) {
  process.stdout.write(`RESULT: FAIL — ${message}\n`);
  process.exit(1);
}

for (const entry of [join(DIST, 'index.js'), join(DIST, 'testing', 'support.js')]) {
  if (!existsSync(entry)) die(`packages/onekey is not built (${relative(ROOT, entry)} missing). Run "npm run build" first.`);
}

/**
 * The learner path: everything in the package that can run on a learner's
 * request, excluding provider implementations, the two composition roots, and
 * test doubles. Kept identical to `registry.test.ts` on purpose - two
 * definitions of "learner path" would let a file escape both.
 *
 * `provider-wiring.ts` is a COMPOSITION ROOT: the one place a settings
 * provider id maps to an adapter factory, so the application never names a
 * provider (ADR-0001). Exempt in `registry.test.ts` too - keep identical.
 */
function isProductionLearnerPath(relativePath) {
  const normalised = relativePath.replace(/\\/g, '/');
  if (normalised.startsWith('providers/')) return false;
  if (normalised === 'index.ts' || normalised === 'failover.ts' || normalised === 'provider-wiring.ts') return false;
  if (normalised.startsWith('testing/') || normalised.endsWith('.test.ts')) return false;
  return true;
}

const learnerFiles = readdirSync(SRC, { recursive: true })
  .map((file) => String(file))
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  .filter((file) => isProductionLearnerPath(file))
  .sort();

const problems = [];

/* ---- C. non-vacuity: the file list must be real -------------------------- */

if (learnerFiles.length === 0) die('the learner-path file list is empty, so every check below would pass vacuously.');
for (const required of ['gateway.ts', 'policy.ts', 'tier-zero-fallback.ts']) {
  if (!learnerFiles.includes(required)) problems.push(`the learner-path file list is missing ${required}, so the scan would not cover it`);
}

/* ---- C. non-vacuity: the build must match the source --------------------- */

for (const file of learnerFiles) {
  const srcFile = join(SRC, file);
  const distFile = join(DIST, file.replace(/\.ts$/, '.js'));
  if (!existsSync(distFile)) {
    problems.push(`${file} has no built counterpart at ${relative(ROOT, distFile)}`);
    continue;
  }
  if (statSync(distFile).mtimeMs < statSync(srcFile).mtimeMs) {
    problems.push(`${file} is newer than its build — the gate would hash source and run stale dist. Run "npm run build".`);
  }
}

/* ---- A. static seam ----------------------------------------------------- */

const registryReaders = [];
for (const file of learnerFiles) {
  const source = readFileSync(join(SRC, file), 'utf8');
  if (/from\s*['"][^'"]*providers\//.test(source)) {
    problems.push(`${file} imports a provider implementation — the registry is no longer the only door`);
  }
  if (/registry\.(get|entries)\(/.test(source)) registryReaders.push(file);
}

if (registryReaders.length === 0) {
  problems.push('no learner-path module reads the registry, so the "registry is the only seam" claim is untested');
}

/* ---- B. dynamic re-point ------------------------------------------------ */

function hashLearnerPath() {
  const hash = createHash('sha256');
  for (const file of learnerFiles) {
    hash.update(file);
    hash.update('\0');
    hash.update(readFileSync(join(SRC, file)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

const onekey = await import(pathToFileURL(join(DIST, 'index.js')).href);
const support = await import(pathToFileURL(join(DIST, 'testing', 'support.js')).href);
const { createOneKeyGateway, createTierZeroProvider } = onekey;
const { createContext, createMockAdapter, createPolicy, createRequest } = support;

const PROMPT = 'Explain photosynthesis in simple terms';

async function serveWith(providerId) {
  const gateway = createOneKeyGateway({ tierZero: createTierZeroProvider() });
  gateway.register(createMockAdapter({ id: providerId, tier: 1 }).adapter);
  const result = await gateway.complete(createPolicy(), createRequest({ prompt: PROMPT }), createContext());
  return { providerId: result.providerId, tier: result.meta.tier, bytes: result.text.length };
}

const before = hashLearnerPath();
const first = await serveWith('alpha');
const second = await serveWith('beta');
const after = hashLearnerPath();

if (first.providerId !== 'alpha') problems.push(`the first registry did not serve through alpha (served ${first.providerId})`);
if (second.providerId !== 'beta') problems.push(`the second registry did not serve through beta (served ${second.providerId})`);
if (first.providerId === second.providerId) problems.push('both registries served through the same provider — the re-point was not exercised');
if (first.tier !== 1 || second.tier !== 1) problems.push(`the re-point did not stay on tier 1 (got ${first.tier} and ${second.tier})`);
if (before !== after) {
  problems.push('the learner-path source hash changed across the re-point — a provider swap required a code edit');
}

/* ---- report ------------------------------------------------------------- */

const pad = (value, width) => String(value).padEnd(width);

process.stdout.write('EDUGENESIS OS — provider re-point gate\n\n');
process.stdout.write(`learner-path files scanned : ${learnerFiles.length}\n`);
process.stdout.write(`registry readers           : ${registryReaders.join(', ')}\n`);
process.stdout.write(`source hash before re-point: ${before}\n`);
process.stdout.write(`source hash after  re-point: ${after}\n\n`);

process.stdout.write(`${pad('registry', 12)}${pad('served by', 12)}${pad('tier', 6)}bytes\n`);
process.stdout.write(`${'-'.repeat(12 + 12 + 6 + 8)}\n`);
process.stdout.write(`${pad('alpha', 12)}${pad(first.providerId, 12)}${pad(first.tier, 6)}${first.bytes}\n`);
process.stdout.write(`${pad('beta', 12)}${pad(second.providerId, 12)}${pad(second.tier, 6)}${second.bytes}\n`);

if (problems.length > 0) {
  process.stdout.write('\nFAILURES\n');
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  process.stdout.write('\nRESULT: FAIL — the provider seam is not a pure registry change.\n');
  process.exit(1);
}

process.stdout.write('\nRESULT: PASS — swapping the provider is a registry entry, and no learner-path source changed.\n');
process.exit(0);
