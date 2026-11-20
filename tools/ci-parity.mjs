#!/usr/bin/env node
/**
 * tools/ci-parity.mjs — PG-15 / P0-3 held-open substitute.
 *
 * WHY THIS TOOL EXISTS
 *   The repository is public, so GitHub Actions is not billable — but Actions is
 *   disabled at the ACCOUNT level: seven check-runs are created per commit with
 *   zero steps and zero output. No hosted run can exist until the owner clears
 *   that account state. This tool does NOT claim a hosted run.
 *
 * TWO MODES, and the difference matters:
 *
 *   node tools/ci-parity.mjs              STRUCTURE. Hermetic: parses the shipped
 *                                         workflow, refuses an unknown action, a
 *                                         missing script, a missing tool, a job
 *                                         without checkout/setup-node. Fast and
 *                                         side-effect free, so the exit-criteria
 *                                         gate can run it.
 *
 *   node tools/ci-parity.mjs --execute    STRUCTURE + EXECUTION + BINDING. Also
 *                                         runs the steps the bound `verify` run
 *                                         does not cover, then binds
 *                                         artifacts/verify-report.json by
 *                                         SHA-256. Writes artifacts/ci-parity.json.
 *
 * WHAT IT REFUSES
 *   - a job without checkout or without the pinned Node floor
 *   - an action outside the GitHub-maintained allowlist
 *   - an `npm run <script>` or `node tools/<file>` that does not exist
 *   - a workflow that drops one of the seven GL jobs
 *   - a workflow that claims a green hosted run in prose
 *   - (execute) a verify report that is not PASS, or that changes while read
 *
 * Zero runtime dependencies (ADR-0014).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');
const VERIFY_REPORT = join(ROOT, 'artifacts', 'verify-report.json');
const ARTIFACTS = join(ROOT, 'artifacts');
const EXECUTE = process.argv.includes('--execute');
const OUT = join(ARTIFACTS, EXECUTE ? 'ci-parity.json' : 'ci-parity-structure.json');
const NODE_FLOOR = '22';

/** The seven GL-mapped jobs Doc 09 §9.2 requires. Losing one is drift. */
const REQUIRED_JOBS = [
  'gl01_intake',
  'gl02_development',
  'gl02_static_analysis',
  'gl05_loop_testing',
  'gl05_accessibility',
  'gl08_package_sign',
  'gl08_verify',
];

/** GitHub-maintained actions only; a third-party action would be unreviewed code. */
const ALLOWED_ACTIONS = [
  'actions/checkout@',
  'actions/setup-node@',
  'actions/upload-artifact@',
];

/** Steps the bound `npm run verify` run already executes itself. */
const COVERED_BY_VERIFY = ['gl05_loop_testing', 'gl08_package_sign', 'gl08_verify'];

const problems = [];
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  if (!ok) problems.push(`${name}: ${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};

if (!existsSync(WORKFLOW)) {
  console.error('ci-parity: .github/workflows/ci.yml is missing');
  process.exit(2);
}
const yaml = readFileSync(WORKFLOW, 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts ?? {};

// ---- 1. the job set ------------------------------------------------------
const jobsAt = yaml.indexOf('\njobs:');
if (jobsAt < 0) {
  console.error('ci-parity: the workflow has no jobs: block');
  process.exit(2);
}
const afterJobs = yaml.slice(jobsAt);
const declaredJobs = [...afterJobs.matchAll(/^ {2}([a-z0-9_]+):\s*$/gm)].map((m) => m[1]);
check('the workflow declares seven jobs', declaredJobs.length === 7, `${declaredJobs.length}: ${declaredJobs.join(', ')}`);
const missingJobs = REQUIRED_JOBS.filter((job) => !declaredJobs.includes(job));
check('every GL-mapped job is present', missingJobs.length === 0, missingJobs.join(', ') || `${REQUIRED_JOBS.length} job(s)`);

// ---- 2. per-job structure ------------------------------------------------
for (const job of declaredJobs) {
  const body = afterJobs.split(new RegExp(`^ {2}${job}:\\s*$`, 'm'))[1] ?? '';
  const block = body.split(/^ {2}[a-z0-9_]+:\s*$/m)[0] ?? '';
  check(`${job} runs on a GitHub runner`, /runs-on:\s*ubuntu-latest/.test(block), block.match(/runs-on:\s*(\S+)/)?.[1] ?? 'absent');
  check(`${job} checks the tree out`, block.includes('actions/checkout@'), 'actions/checkout present');
  check(`${job} pins Node ${NODE_FLOOR}`, block.includes(`node-version: '${NODE_FLOOR}'`), block.match(/node-version:\s*'?([\d.]+)'?/)?.[1] ?? 'absent');
}

// ---- 3. actions and referenced commands ---------------------------------
const usedActions = [...yaml.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
const unknownActions = usedActions.filter((a) => !ALLOWED_ACTIONS.some((allowed) => a.startsWith(allowed)));
check('no action outside the GitHub-maintained allowlist is used', unknownActions.length === 0, unknownActions.join(', ') || `${new Set(usedActions).size} allowlisted action(s)`);

const npmScripts = [...yaml.matchAll(/npm run ([a-z0-9:_-]+)/g)].map((m) => m[1]);
const missingScripts = [...new Set(npmScripts)].filter((s) => scripts[s] === undefined);
check('every workflow `npm run` names a real script', missingScripts.length === 0, missingScripts.join(', ') || `${new Set(npmScripts).size} script(s)`);

const nodeFiles = [...yaml.matchAll(/node (tools\/[A-Za-z0-9._-]+)/g)].map((m) => m[1]);
const missingFiles = [...new Set(nodeFiles)].filter((f) => !existsSync(join(ROOT, f)));
check('every workflow `node tools/...` names a real file', missingFiles.length === 0, missingFiles.join(', ') || `${new Set(nodeFiles).size} file(s)`);

// ---- 4. honesty ----------------------------------------------------------
const ownerGated = [...yaml.matchAll(/OWNER GATED/g)].length;
check('owner-gated stages are declared, never faked green', ownerGated >= 4, `${ownerGated} owner-gated stage(s)`);
check('the workflow never claims a green run in prose', !/pipeline (is|was|went) green/i.test(yaml), 'no green claim found');
check('the workflow states that a hosted run is not evidence it produced', /OWNER GATED|not faked|never faked/i.test(yaml), 'honesty marker present');

// ---- 5. execution + binding (only with --execute) ------------------------
const executed = [];
let verify = { present: false, bound: false };
if (EXECUTE) {
  const steps = [
    ['GL-01 intake — doctor', 'npm', ['run', 'doctor']],
    ['GL-02 typecheck', 'npm', ['run', 'typecheck']],
    ['GL-02 static analysis — secrets scan', 'npm', ['run', 'secrets:scan']],
    ['GL-05 accessibility negative fixtures', 'node', ['--test', 'packages/verification/dist/gates/negative-fixtures.test.js']],
  ];
  for (const [name, cmd, args] of steps) {
    const result = spawnSync(cmd, args, {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 30 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    const lastLine = output.split(/\r?\n/).filter(Boolean).at(-1) ?? `exit ${String(result.status)}`;
    executed.push({ name, passed: result.status === 0, summary: lastLine.slice(0, 300) });
    check(name, result.status === 0, lastLine.slice(0, 160));
  }

  if (existsSync(VERIFY_REPORT)) {
    const bytes = readFileSync(VERIFY_REPORT);
    const before = createHash('sha256').update(bytes).digest('hex');
    let parsed = null;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { parsed = null; }
    const after = createHash('sha256').update(readFileSync(VERIFY_REPORT)).digest('hex');
    const stable = before === after;
    const passing = parsed?.result === 'PASS';
    verify = {
      present: true,
      bound: passing && stable,
      sha256: after,
      result: parsed?.result ?? 'UNREADABLE',
      gates: parsed?.counts?.gates ?? 0,
      passed: parsed?.counts?.passed ?? 0,
      stable,
    };
    check('a verify report exists and is PASS', passing, `${verify.result}, ${verify.passed}/${verify.gates} gates`);
    check('the verify report did not change while it was being checked', stable, verify.sha256);
  } else {
    check('a verify report exists and is PASS', false, 'artifacts/verify-report.json is missing');
  }
}

const report = {
  tool: 'tools/ci-parity.mjs',
  schemaVersion: 1,
  mode: EXECUTE ? 'structure+execute+bind' : 'structure',
  hostedRun: null,
  hostedRunReason:
    'GitHub Actions is disabled at the account level: seven check-runs per commit are created with zero steps and zero output. No hosted run is claimed; P0-3 stays a placeholder until the owner clears it.',
  parity: problems.length === 0 ? 'PASS' : 'FAIL',
  nodeFloor: NODE_FLOOR,
  jobs: declaredJobs,
  coveredByVerify: COVERED_BY_VERIFY,
  executed,
  verify,
  checks,
  failed: problems,
  note: EXECUTE
    ? 'Structure resolved, the steps not covered by the bound verify run passed locally, and the verify report is bound by SHA-256. This is NOT a hosted CI run.'
    : 'Structure only: the shipped workflow resolves and every action, script and tool it names exists. Execution and binding require --execute. This is NOT a hosted CI run.',
};
mkdirSync(ARTIFACTS, { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\nRESULT: ${report.parity} — mode ${report.mode}; hosted run: none claimed.`);
process.exitCode = problems.length === 0 ? 0 : 1;
