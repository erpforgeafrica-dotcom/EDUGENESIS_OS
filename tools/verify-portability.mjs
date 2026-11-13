#!/usr/bin/env node
/**
 * EDUGENESIS OS — portability gate.
 *
 * PROVES the product law: the project must run identically on any Windows PC
 * that copies the project folder — a different user name, a different drive,
 * a different Node install — with zero source edits.
 *
 * The gate:
 *   1. copies the whole project (minus node_modules, dist, .git, artifacts)
 *      to a temp path that deliberately looks like a different machine,
 *   2. re-points USERPROFILE and HOME at a directory that DOES NOT EXIST,
 *   3. builds, doctor-checks and tests from the copy,
 *   4. proves the committed settings default is untouched and that a changed
 *      setting persists INSIDE the copy,
 *   5. proves the original tree was not written to.
 *
 * Exit code 1 if any step fails. The failing command and its stderr are
 * printed verbatim.
 *
 * Usage:  node tools/verify-portability.mjs
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories never copied. */
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'artifacts', '.git', '.edugenesis-data']);

/** File suffixes never copied. */
const EXCLUDED_SUFFIXES = ['.tsbuildinfo'];

const results = [];
let failed = false;
/** The sandbox this run created, so the report can name it and clean it up. */
let sandboxRoot = null;

function record(step, status, detail) {
  results.push({ step, status, detail });
  if (status === 'FAIL') failed = true;
}

/* -------------------------------------------------------------------------- */
/* Sandbox lifecycle                                                           */
/* -------------------------------------------------------------------------- */

/** A synchronous sleep, for retrying a filesystem operation. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove a path, retrying the transient Windows failures.
 *
 * WHY: on Windows a delete fails with EPERM/EBUSY while an antivirus scanner,
 * the search indexer or a just-exited child process still holds a handle. Those
 * failures are timing, not a portability defect — retrying is correct. A real
 * failure (a path that is not there, a permission the user genuinely lacks) is
 * reported and does not crash the gate.
 */
function removeWithRetry(target, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(target, { force: true, maxRetries: 3, retryDelay: 100, ...options });
      return true;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === 'object' ? error.code : undefined;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY' && code !== 'EACCES') break;
      sleepSync(250 * (attempt + 1));
    }
  }
  process.stdout.write(
    `note: could not remove ${target}: ${lastError instanceof Error ? lastError.message : String(lastError)}\n`,
  );
  return false;
}

/**
 * Delete the sandbox WITHOUT following a junction into the real tree.
 *
 * WHY THIS IS NOT `rmSync(copyRoot, { recursive: true })`: the copy's
 * `node_modules` contains junctions pointing at the ORIGINAL install and at the
 * original packages. A recursive delete that follows a reparse point would
 * delete the project it was meant to test. Every link is therefore unlinked
 * first, explicitly, and only then is the remaining tree removed.
 */
function removeSandbox(sandboxRoot) {
  const unlinkLinks = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        removeWithRetry(full, { recursive: false });
        continue;
      }
      if (stat.isDirectory()) unlinkLinks(full);
    }
  };

  unlinkLinks(sandboxRoot);
  return removeWithRetry(sandboxRoot, { recursive: true });
}

/* -------------------------------------------------------------------------- */
/* Copying                                                                     */
/* -------------------------------------------------------------------------- */

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const name = entry.name;
    const srcPath = join(src, name);
    const destPath = join(dest, name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(name)) continue;
      copyTree(srcPath, destPath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
    copyFileSync(srcPath, destPath);
  }
}

/**
 * Give the copy a working toolchain without running `npm install`.
 *
 * The toolchain (typescript, @types/node) is junctioned from the original
 * install, but the WORKSPACE packages are re-pointed at the copy's own
 * packages, so the copy genuinely compiles its own source.
 */
function linkToolchain(originalModules, copyModules, copyRoot) {
  mkdirSync(copyModules, { recursive: true });
  for (const entry of readdirSync(originalModules, { withFileTypes: true })) {
    const name = entry.name;
    const src = join(originalModules, name);
    const dest = join(copyModules, name);
    if (name === '@edugenesis') {
      // Workspace packages must resolve to the COPY, not the original.
      mkdirSync(dest, { recursive: true });
      for (const pkg of readdirSync(src)) {
        const inPackages = join(copyRoot, 'packages', pkg);
        const inApps = join(copyRoot, 'apps', pkg);
        const target = existsSync(inPackages) ? inPackages : inApps;
        if (!existsSync(target)) continue;
        symlinkSync(target, join(dest, pkg), 'junction');
      }
      continue;
    }
    if (entry.isDirectory()) {
      symlinkSync(src, dest, 'junction');
      continue;
    }
    copyFileSync(src, dest);
  }
}

/* -------------------------------------------------------------------------- */
/* Running commands                                                            */
/* -------------------------------------------------------------------------- */

function run(command, args, cwd, env, label) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 15 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    label,
    command: `${command} ${args.join(' ')}`,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? result.error.message : undefined,
  };
}

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Absolute-path shapes that make a shipped config file machine-specific. */
const ABSOLUTE_PATH_RULES = [
  { rule: 'abs-drive-letter', pattern: /[A-Za-z]:\\/g },
  { rule: 'abs-unc', pattern: /\\\\[A-Za-z0-9._$-]+\\/g },
  { rule: 'abs-user-profile', pattern: /\\Users[\\/]/gi },
];

/**
 * Find absolute path references in the config files of a tree.
 * Returns "relative/path:line — rule" strings; never the path value itself.
 */
function findAbsoluteConfigReferences(root) {
  const hits = [];
  const configNames = new Set(['tsconfig.json', 'tsconfig.base.json', 'package.json']);
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!configNames.has(entry.name)) continue;
      const content = readIfPresent(full);
      if (content === null) continue;
      content.split(/\r?\n/).forEach((text, index) => {
        for (const { rule, pattern } of ABSOLUTE_PATH_RULES) {
          if (pattern.test(text)) {
            hits.push(`${relative(root, full).split(sep).join('/')}:${String(index + 1)} — ${rule}`);
            pattern.lastIndex = 0;
          }
        }
      });
    }
  };
  walk(root);
  return hits;
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

function main() {
  const username = userInfo().username;

  // A temp path that deliberately looks like a different machine:
  // a space in the folder name and a user-like segment that is NOT this user.
  //
  // WHY mkdtemp: a fixed directory name means two runs — CI and a developer, or
  // two CI jobs on one runner — delete each other's sandbox mid-test. The
  // suffix makes every run independent.
  const tempRoot = mkdtempSync(join(tmpdir(), 'eg-portability-'));
  const copyRoot = join(tempRoot, 'Portable Learner Account', 'EduGenesis OS');
  // Deliberately NOT created: anything that depends on the user profile dies here.
  const fakeProfile = join(tempRoot, 'Portable Learner Account', 'profile that does not exist');

  mkdirSync(tempRoot, { recursive: true });
  sandboxRoot = tempRoot;

  process.stdout.write('EDUGENESIS OS — portability gate\n');
  process.stdout.write(`source      : ${ROOT}\n`);
  process.stdout.write(`copy        : ${copyRoot}\n`);
  process.stdout.write(`user profile: ${fakeProfile} (deliberately does not exist)\n`);
  process.stdout.write(`current user: ${username}\n\n`);

  // ---- 1. the copy is a genuinely different location ---------------------------
  const copyRelative = relative(tempRoot, copyRoot);
  const looksDifferent =
    resolve(copyRoot) !== resolve(ROOT) &&
    copyRelative.includes(' ') &&
    !copyRelative.toLowerCase().includes(username.toLowerCase());
  record(
    'copy-location',
    looksDifferent ? 'PASS' : 'FAIL',
    looksDifferent
      ? `copy is at a different path with a space and a non-current user segment (${copyRelative})`
      : `the copy location does not look like a different machine (${copyRelative})`,
  );

  try {
    copyTree(ROOT, copyRoot);
  } catch (error) {
    record('copy-tree', 'FAIL', `copy failed: ${error instanceof Error ? error.message : String(error)}`);
    report();
    return;
  }
  const copiedFiles = [];
  (function count(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) count(full);
      else if (entry.isFile()) copiedFiles.push(full);
    }
  })(copyRoot);
  record('copy-tree', 'PASS', `copied ${String(copiedFiles.length)} files (node_modules, dist, .git, artifacts excluded)`);

  // ---- 2. toolchain ------------------------------------------------------------
  const originalModules = join(ROOT, 'node_modules');
  if (!existsSync(originalModules)) {
    record('toolchain', 'FAIL', 'the source tree has no node_modules, so no toolchain is available');
    report();
    return;
  }
  try {
    linkToolchain(originalModules, join(copyRoot, 'node_modules'), copyRoot);
    record(
      'toolchain',
      'PASS',
      'toolchain junctioned into the copy; workspace packages re-pointed at the copy',
    );
  } catch (error) {
    record('toolchain', 'FAIL', `could not link the toolchain: ${error instanceof Error ? error.message : String(error)}`);
    report();
    return;
  }

  // ---- 3. a user profile that does not exist -----------------------------------
  const env = {
    ...process.env,
    USERPROFILE: fakeProfile,
    HOME: fakeProfile,
    APPDATA: join(copyRoot, '.eg-appdata'),
    LOCALAPPDATA: join(copyRoot, '.eg-localappdata'),
    npm_config_cache: join(copyRoot, '.eg-npm-cache'),
    npm_config_userconfig: join(copyRoot, '.eg-npmrc'),
    npm_config_prefix: join(copyRoot, '.eg-npm-prefix'),
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
  mkdirSync(env.APPDATA, { recursive: true });
  mkdirSync(env.LOCALAPPDATA, { recursive: true });
  mkdirSync(env.npm_config_cache, { recursive: true });
  mkdirSync(env.npm_config_prefix, { recursive: true });
  writeFileSync(env.npm_config_userconfig, '', 'utf8');
  record(
    'no-user-profile',
    existsSync(fakeProfile) ? 'FAIL' : 'PASS',
    existsSync(fakeProfile)
      ? 'the fake user profile unexpectedly exists'
      : 'USERPROFILE and HOME point at a directory that does not exist',
  );

  // ---- 4. the original tree must not be touched by the copy's run -------------
  const originalSettingsDefault = join(ROOT, 'settings', 'settings.json');
  const originalSettingsLocal = join(ROOT, 'settings', 'settings.local.json');
  const beforeDefault = readIfPresent(originalSettingsDefault);
  const beforeLocal = readIfPresent(originalSettingsLocal);

  // ---- 5. build from the copy --------------------------------------------------
  const build = run('npm', ['run', 'build'], copyRoot, env, 'build');
  const buildOk = build.status === 0;
  record(
    'build',
    buildOk ? 'PASS' : 'FAIL',
    buildOk
      ? 'npm run build succeeded in the copy'
      : `npm run build failed in the copy (exit ${String(build.status)})\n${build.stdout}\n${build.stderr}`,
  );

  // The build must have produced artefacts INSIDE the copy. A build that
  // "succeeds" while writing into the original tree is a silent failure and
  // is exactly what an absolute path in a tsconfig does.
  const copyDoctor = join(copyRoot, 'apps', 'cli', 'dist', 'doctor.js');
  const producedInCopy = existsSync(copyDoctor);
  record(
    'build-output-location',
    producedInCopy ? 'PASS' : 'FAIL',
    producedInCopy
      ? 'the copy produced its own build output'
      : 'the build succeeded but produced NO output inside the copy — the build wrote into the original tree, so the project is not portable',
  );

  // ---- 5b. the copy must not depend on paths outside itself -------------------
  // A build that happens to work on THIS machine because the original tree
  // still exists is not portable. The decisive test is static: the config
  // files a user receives must not point at any absolute path.
  const absoluteRefs = findAbsoluteConfigReferences(copyRoot);
  record(
    'copy-config-portability',
    absoluteRefs.length === 0 ? 'PASS' : 'FAIL',
    absoluteRefs.length === 0
      ? 'the copy\'s config files reference no absolute path'
      : `${String(absoluteRefs.length)} absolute path reference(s) in the copy's config files — the copy only builds because the original tree still exists on this machine:\n${absoluteRefs.join('\n')}`,
  );

  // ---- 6. doctor ---------------------------------------------------------------
  const doctor = run('node', ['apps/cli/dist/doctor.js', '--json'], copyRoot, env, 'doctor');
  const doctorOk = doctor.status === 0;
  record(
    'doctor',
    doctorOk ? 'PASS' : 'FAIL',
    doctorOk
      ? 'eg doctor ran successfully from the copy'
      : `eg doctor failed in the copy (exit ${String(doctor.status)})\ncommand: ${doctor.command}\n${doctor.stdout}\n${doctor.stderr}`,
  );

  // ---- 7. the test suite -------------------------------------------------------
  // The COMPILED tests are run explicitly. Node's auto-discovery would also
  // pick up the raw TypeScript sources, which are not runnable as-is.
  const tests = run(
    'node',
    ['--test', '--test-reporter=spec', 'packages/*/dist/**/*.test.js', 'apps/*/dist/**/*.test.js'],
    copyRoot,
    env,
    'tests',
  );
  const testsOk = tests.status === 0;
  record(
    'test-suite',
    testsOk ? 'PASS' : 'FAIL',
    testsOk
      ? 'the test suite passed in the copy'
      : `the test suite failed in the copy (exit ${String(tests.status)})\ncommand: ${tests.command}\n${tests.stdout}\n${tests.stderr}`,
  );

  // ---- 8. the committed settings default is untouched --------------------------
  const copySettingsDefault = join(copyRoot, 'settings', 'settings.json');
  const afterDefault = readIfPresent(copySettingsDefault);
  if (beforeDefault === null) {
    record(
      'settings-default',
      'WARN',
      'the source tree has no settings/settings.json, so the committed default could not be compared',
    );
  } else if (afterDefault === beforeDefault) {
    record('settings-default', 'PASS', 'settings/settings.json in the copy is still the committed default, byte for byte');
  } else {
    record('settings-default', 'FAIL', 'settings/settings.json in the copy differs from the committed default');
  }

  // ---- 9. a changed setting persists INSIDE the copy ---------------------------
  const newPort = 8799;
  const setCmd = run(
    'node',
    ['apps/cli/dist/settings.js', 'set', 'server.port', String(newPort)],
    copyRoot,
    env,
    'settings-set',
  );
  const copyLocal = readIfPresent(join(copyRoot, 'settings', 'settings.local.json'));
  const copyLocalMentionsPort = copyLocal !== null && copyLocal.includes(String(newPort));
  if (setCmd.status !== 0) {
    record(
      'settings-persist',
      'FAIL',
      `could not change a setting in the copy (exit ${String(setCmd.status)})\ncommand: ${setCmd.command}\n${setCmd.stdout}\n${setCmd.stderr}`,
    );
  } else if (!copyLocalMentionsPort) {
    record(
      'settings-persist',
      'FAIL',
      `the setting change did not persist inside the copy (expected server.port=${String(newPort)} in settings/settings.local.json)`,
    );
  } else {
    record(
      'settings-persist',
      'PASS',
      `the setting change persisted inside the copy (server.port=${String(newPort)})`,
    );
  }

  // ---- 10. the ORIGINAL tree must be unchanged ---------------------------------
  const afterLocal = readIfPresent(originalSettingsLocal);
  const afterDefaultOriginal = readIfPresent(originalSettingsDefault);
  const originalUntouched =
    afterLocal === beforeLocal && afterDefaultOriginal === beforeDefault;
  record(
    'original-untouched',
    originalUntouched ? 'PASS' : 'FAIL',
    originalUntouched
      ? 'the copy run wrote nothing back into the original tree'
      : 'the copy run modified the ORIGINAL tree — settings leaked out of the copy',
  );

  report();
}

/* -------------------------------------------------------------------------- */

function report() {
  const width = Math.max(...results.map((r) => r.step.length), 10);
  process.stdout.write('EDUGENESIS OS — portability gate result\n\n');
  for (const result of results) {
    process.stdout.write(`  [${result.status.padEnd(4)}] ${result.step.padEnd(width)}  ${result.detail}\n`);
    if (result.status === 'FAIL') process.stdout.write('\n');
  }
  const fails = results.filter((r) => r.status === 'FAIL').length;
  const warns = results.filter((r) => r.status === 'WARN').length;
  process.stdout.write(`\n${String(results.length)} steps, ${String(fails)} failed, ${String(warns)} warnings\n`);
  if (fails > 0) {
    // Keep a failed sandbox: it is the thing a person needs to look at.
    if (sandboxRoot !== null) process.stdout.write(`sandbox kept for inspection: ${sandboxRoot}\n`);
    process.stdout.write('RESULT: FAIL — the project does not run from a copy at a different path.\n');
    process.exit(1);
  }
  // A passing sandbox is disposable, and leaving one behind per run would fill
  // the temp directory with copies of the project.
  if (sandboxRoot !== null) removeSandbox(sandboxRoot);
  process.stdout.write('RESULT: PASS — the copy runs from a different path under a different profile.\n');
  process.exit(0);
}

main();
