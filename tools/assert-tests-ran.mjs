/**
 * Meta-gate: a test command that runs ZERO (or implausibly few) tests must fail.
 *
 * WHY THIS EXISTS
 * ---------------
 * On Node 24, `node --test <directory>` resolves the path as a single module and
 * reports "tests 1, pass 1, fail 0" with exit code 0 — a FALSE GREEN that would
 * have shipped a CI pipeline which verifies nothing. The correct form is a glob:
 *
 *     node --test "packages/*\/dist/**/*.test.js"
 *
 * This wrapper makes that class of bug impossible to reintroduce: it runs the
 * test command, parses the reporter output, and fails if the number of tests
 * that actually ran is below a floor. A command that silently tests nothing is
 * a build failure, not a pass.
 *
 *   node tools/assert-tests-ran.mjs --min 1 -- node --test "packages/*/dist/**/*.test.js"
 */
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
let min = 1;
let cmd = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--min') {
    min = Number(argv[i + 1]);
    i++;
  } else if (argv[i] === '--') {
    cmd = argv.slice(i + 1);
    break;
  }
}

if (cmd.length === 0) {
  console.error('usage: assert-tests-ran.mjs --min <n> -- <command> [args...]');
  process.exit(2);
}

/** Count the tests the reporter says it ran. Handles both spec and tap output. */
function parseCounts(text) {
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : 0;
  };
  return {
    tests: num(/^\s*(?:info\s*)?[ℹ#]\s*tests\s+(\d+)/m),
    pass: num(/^\s*(?:info\s*)?[ℹ#]\s*pass\s+(\d+)/m),
    fail: num(/^\s*(?:info\s*)?[ℹ#]\s*fail\s+(\d+)/m),
    cancelled: num(/^\s*(?:info\s*)?[ℹ#]\s*cancelled\s+(\d+)/m),
    skipped: num(/^\s*(?:info\s*)?[ℹ#]\s*skipped\s+(\d+)/m),
  };
}

const started = Date.now();
const result = spawnSync(cmd[0], cmd.slice(1), {
  stdio: ['inherit', 'pipe', 'pipe'],
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');

const counts = parseCounts(output);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log('');
console.log('--- test-run meta-gate ------------------------------------------');
console.log(`  command        : ${cmd.join(' ')}`);
console.log(`  tests reported : ${counts.tests}`);
console.log(`  passed         : ${counts.pass}`);
console.log(`  failed         : ${counts.fail}`);
console.log(`  cancelled      : ${counts.cancelled}`);
console.log(`  skipped        : ${counts.skipped}`);
console.log(`  duration       : ${seconds}s`);
console.log(`  process exit   : ${result.status}`);
console.log('-----------------------------------------------------------------');

let gateFailed = false;

if (result.status !== 0) {
  console.error('META-GATE FAIL: the test command itself exited non-zero.');
  gateFailed = true;
}
if (counts.tests < min) {
  console.error(
    `META-GATE FAIL: only ${counts.tests} test(s) ran, floor is ${min}. ` +
      'A command that runs almost nothing is a false green, not a pass. ' +
      'On Node 24 use a GLOB (e.g. "packages/*/dist/**/*.test.js"), never a bare directory path.',
  );
  gateFailed = true;
}
if (counts.tests > 0 && counts.tests < 10) {
  console.warn(`META-GATE WARN: only ${counts.tests} tests ran. Verify the glob pattern is correct.`);
}
if (counts.tests > 0 && counts.pass + counts.fail + counts.cancelled + counts.skipped !== counts.tests) {
  console.warn('META-GATE WARN: the reported totals do not add up to the test count.');
}

if (gateFailed) process.exit(1);
console.log('META-GATE PASS');
process.exit(0);
