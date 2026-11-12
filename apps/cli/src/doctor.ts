/**
 * `eg doctor` — the environment check.
 *
 * Exit code 0 when there is no FAIL row. WARN rows never fail the command.
 * `--json` prints a machine-readable payload instead of the table.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { flagBoolean, parseArgs, type ParsedArgs } from './args.js';
import { countByStatus, renderChecks, type CheckRow } from './format.js';
import {
  CONTRACTS_ENTRY,
  DEFAULT_SETTINGS_PATH,
  LOCAL_SETTINGS_PATH,
  PROJECT_ROOT,
  TOKENS_PATH,
  displayPath,
  isMainModule,
} from './paths.js';
import { loadSettings } from './settings-store.js';

/** Minimum Node version the platform supports. Mirrors root package.json engines. */
export const REQUIRED_NODE_VERSION = '22.5.0';

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersion(raw: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left: Version, right: Version): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (
    typeof left === 'object' &&
    typeof right === 'object' &&
    left !== null &&
    right !== null &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => jsonEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return false;
}

function checkNodeVersion(): CheckRow {
  const current = parseVersion(process.version);
  const required = parseVersion(REQUIRED_NODE_VERSION);
  if (!current) {
    return {
      id: 'node.version',
      label: 'Node runtime',
      status: 'FAIL',
      detail: `Could not parse the running Node version (${process.version}).`,
    };
  }
  if (!required) {
    return {
      id: 'node.version',
      label: 'Node runtime',
      status: 'FAIL',
      detail: `Invalid required version constant (${REQUIRED_NODE_VERSION}).`,
    };
  }
  const ok = compareVersions(current, required) >= 0;
  return {
    id: 'node.version',
    label: 'Node runtime',
    status: ok ? 'PASS' : 'FAIL',
    detail: ok
      ? `Node ${process.version.replace(/^v/, '')} satisfies >= ${REQUIRED_NODE_VERSION}.`
      : `Node ${process.version.replace(/^v/, '')} is older than the required ${REQUIRED_NODE_VERSION}.`,
  };
}

function checkContractsBuild(): CheckRow {
  const exists = existsSync(CONTRACTS_ENTRY);
  return {
    id: 'contracts.build',
    label: 'Shared contracts',
    status: exists ? 'PASS' : 'FAIL',
    detail: exists
      ? `Compiled contracts found at ${displayPath(CONTRACTS_ENTRY)}.`
      : `Compiled contracts missing at ${displayPath(CONTRACTS_ENTRY)} — run "npm run build".`,
  };
}

function checkSettings(): CheckRow[] {
  const rows: CheckRow[] = [];
  let loaded;
  try {
    loaded = loadSettings();
  } catch (error) {
    rows.push({
      id: 'settings.file',
      label: 'Settings file',
      status: 'FAIL',
      detail: `Could not read the settings file: ${(error as Error).message}`,
    });
    return rows;
  }

  rows.push({
    id: 'settings.file',
    label: 'Settings file',
    status: 'PASS',
    detail: `${displayPath(loaded.activePath)} is in use${loaded.usedOverride ? ' (local override over the committed default)' : ' (committed default)'}.`,
  });

  const issues = loaded.issues;
  rows.push({
    id: 'settings.schema',
    label: 'Settings schema',
    status: issues.length === 0 ? 'PASS' : 'FAIL',
    detail:
      issues.length === 0
        ? 'The settings file validates against settings/settings.schema.json.'
        : `${issues.length} schema violation(s): ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
  });

  if (loaded.warnings.length > 0) {
    rows.push({
      id: 'settings.migration',
      label: 'Settings migration',
      status: 'WARN',
      detail: loaded.warnings.join(' | '),
    });
  }

  // A secret may live in the untracked local override. It may NEVER live in a
  // tracked settings file, because a tracked file is a published file.
  const trackedDefault = DEFAULT_SETTINGS_PATH;
  let defaultHasKeys = false;
  try {
    const raw = JSON.parse(readFileSync(trackedDefault, 'utf8')) as Record<string, unknown>;
    const providers = raw['providers'];
    if (typeof providers === 'object' && providers !== null) {
      const apiKeys = (providers as Record<string, unknown>)['apiKeys'];
      if (typeof apiKeys === 'object' && apiKeys !== null) {
        defaultHasKeys = Object.values(apiKeys as Record<string, unknown>).some(
          (value) => typeof value === 'string' && value.length > 0,
        );
      }
    }
  } catch {
    defaultHasKeys = false;
  }

  const localHasKeys = existsSync(LOCAL_SETTINGS_PATH);
  rows.push({
    id: 'settings.secrets',
    label: 'Plaintext API keys',
    status: defaultHasKeys ? 'FAIL' : 'PASS',
    detail: defaultHasKeys
      ? 'The tracked settings file contains a non-empty apiKeys value. Move it to settings/settings.local.json and remove it from the tracked file.'
      : localHasKeys
        ? 'No API key in the tracked settings file. Keys may exist in the untracked settings/settings.local.json.'
        : 'No API key in the tracked settings file.',
  });

  return rows;
}

function checkDataDir(): CheckRow {
  let dataDirRelative = './.edugenesis-data';
  try {
    const loaded = loadSettings();
    const configured = loaded.settings.paths.dataDir;
    if (typeof configured === 'string' && configured.length > 0) dataDirRelative = configured;
  } catch {
    // fall back to the default
  }

  if (isAbsolute(dataDirRelative)) {
    return {
      id: 'data.dir',
      label: 'Data folder',
      status: 'FAIL',
      detail: `paths.dataDir must be relative to the project folder but is "${dataDirRelative}".`,
    };
  }

  const target = resolve(PROJECT_ROOT, dataDirRelative);
  try {
    mkdirSync(target, { recursive: true });
  } catch (error) {
    return {
      id: 'data.dir',
      label: 'Data folder',
      status: 'FAIL',
      detail: `Could not create the data folder: ${(error as Error).message}`,
    };
  }

  const probe = join(target, `.eg-write-probe-${process.pid}`);
  try {
    writeFileSync(probe, 'ok', 'utf8');
    rmSync(probe, { force: true });
  } catch (error) {
    return {
      id: 'data.dir',
      label: 'Data folder',
      status: 'FAIL',
      detail: `The data folder is not writable: ${(error as Error).message}`,
    };
  }

  return {
    id: 'data.dir',
    label: 'Data folder',
    status: 'PASS',
    detail: `${dataDirRelative} is writable (resolved inside the project folder).`,
  };
}

function checkTokens(): CheckRow {
  const exists = existsSync(TOKENS_PATH);
  return {
    id: 'tokens.stylesheet',
    label: 'Aurora design tokens',
    status: exists ? 'PASS' : 'FAIL',
    detail: exists
      ? `Token stylesheet found at ${displayPath(TOKENS_PATH)}.`
      : `Token stylesheet missing at ${displayPath(TOKENS_PATH)}.`,
  };
}

function checkGitWorktree(): CheckRow {
  let output: string;
  try {
    output = execFileSync('git', ['status', '--porcelain'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return {
      id: 'git.worktree',
      label: 'Git worktree',
      status: 'WARN',
      detail: `Could not read the git worktree state: ${(error as Error).message}`,
    };
  }
  const lines = output.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return {
      id: 'git.worktree',
      label: 'Git worktree',
      status: 'PASS',
      detail: 'The git worktree is clean.',
    };
  }
  return {
    id: 'git.worktree',
    label: 'Git worktree',
    status: 'WARN',
    detail: `${lines.length} uncommitted change(s) in the worktree. This is normal while building.`,
  };
}

async function checkDefaultsMatchContract(): Promise<CheckRow> {
  let contractDefaults: unknown;
  try {
    const module = (await import('@edugenesis/contracts')) as { DEFAULT_SETTINGS?: unknown };
    contractDefaults = module.DEFAULT_SETTINGS;
  } catch (error) {
    return {
      id: 'settings.defaults',
      label: 'Committed default matches the contract',
      status: 'WARN',
      detail: `The contracts package could not be imported: ${(error as Error).message}`,
    };
  }
  if (contractDefaults === undefined) {
    return {
      id: 'settings.defaults',
      label: 'Committed default matches the contract',
      status: 'WARN',
      detail: 'The contracts package does not export DEFAULT_SETTINGS.',
    };
  }
  try {
    const committed = JSON.parse(readFileSync(DEFAULT_SETTINGS_PATH, 'utf8')) as unknown;
    const same = jsonEqual(committed, contractDefaults);
    return {
      id: 'settings.defaults',
      label: 'Committed default matches the contract',
      status: same ? 'PASS' : 'FAIL',
      detail: same
        ? 'settings/settings.json matches DEFAULT_SETTINGS from packages/contracts.'
        : 'settings/settings.json has drifted from DEFAULT_SETTINGS in packages/contracts.',
    };
  } catch (error) {
    return {
      id: 'settings.defaults',
      label: 'Committed default matches the contract',
      status: 'FAIL',
      detail: `Could not compare the committed default with the contract: ${(error as Error).message}`,
    };
  }
}

/** Run every doctor check. */
export async function runDoctorChecks(): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  rows.push(checkNodeVersion());
  rows.push(checkContractsBuild());
  rows.push(...checkSettings());
  rows.push(checkDataDir());
  rows.push(checkTokens());
  rows.push(checkGitWorktree());
  rows.push(await checkDefaultsMatchContract());
  return rows;
}

/** The `doctor` command. Returns the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const args: ParsedArgs = parseArgs(argv);
  const rows = await runDoctorChecks();
  const counts = countByStatus(rows);

  if (flagBoolean(args, 'json')) {
    const payload = {
      ok: counts.FAIL === 0,
      root: displayPath(PROJECT_ROOT),
      node: process.version,
      counts,
      checks: rows.map((row) => ({
        id: row.id,
        label: row.label,
        status: row.status,
        detail: row.detail,
      })),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write('EduGenesis OS — environment doctor\n');
    process.stdout.write(`Project root: ${displayPath(PROJECT_ROOT)}\n\n`);
    process.stdout.write(`${renderChecks(rows)}\n\n`);
    process.stdout.write(
      `Summary: ${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL. ` +
        `${counts.FAIL === 0 ? 'No failures.' : 'Failures must be resolved before the platform is usable.'}\n`,
    );
  }

  return counts.FAIL === 0 ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`eg doctor failed: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
