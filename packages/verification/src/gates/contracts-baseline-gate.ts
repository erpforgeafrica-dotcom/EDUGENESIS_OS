/**
 * Gate: the contracts package still matches its frozen baseline.
 *
 * ADR-0013..0016 freeze `packages/contracts/src`. A contract change made
 * quietly while a build is being repaired is the most expensive kind of drift:
 * every package compiles against the new shape and the proposal no longer
 * describes the product.
 *
 * TWO CHECKS, BOTH MACHINE-READABLE:
 *   1. `git diff --quiet <baseline> -- packages/contracts/src` must be clean.
 *      A single changed byte in the frozen surface is a blocker.
 *   2. Any other file under `packages/contracts/` that differs from the
 *      baseline must be enumerated in `docs/contracts-baseline-amendments.json`
 *      with a reason and an ADR. An unlisted change is a blocker; a listed
 *      path that no longer differs is a stale amendment and also a blocker,
 *      because a stale allowlist is how an allowlist stops meaning anything.
 *
 * If git is unavailable (an exported copy of the tree, a shallow clone without
 * the baseline commit), the gate reports a WARNING with `passed: false`. It
 * never reports PASS on evidence it could not read.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Gate, GateContext, GateResult } from '../types.js';

const GATE_ID = 'contracts-baseline';
const CONTRACTS_DIR = 'packages/contracts';
const FROZEN_PATH = 'packages/contracts/src';
const AMENDMENTS_FILE = 'docs/contracts-baseline-amendments.json';

/** One enumerated packaging amendment. */
export interface ContractsAmendment {
  path: string;
  reason: string;
  adr: string;
  /** The commit that introduced the change. It must be an ancestor of HEAD. */
  commit: string;
}

/** The parsed amendment register. */
export interface AmendmentsRegister {
  baseline: string;
  frozenPath: string;
  amendments: ContractsAmendment[];
}

interface GitOutcome {
  available: boolean;
  status: number;
  stdout: string;
  stderr: string;
}

/** Run git with no shell, so a path with spaces is never re-split. */
function git(root: string, args: readonly string[]): GitOutcome {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error) {
    return { available: false, status: -1, stdout: '', stderr: result.error.message };
  }
  return {
    available: true,
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** True when `path` is inside the frozen surface. */
export function isFrozenPath(path: string): boolean {
  return path === FROZEN_PATH || path.startsWith(`${FROZEN_PATH}/`);
}

/** Parse and validate the amendment register. Throws on a malformed file. */
export function parseAmendments(raw: string): AmendmentsRegister {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TypeError('the amendment register must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const baseline = record['baseline'];
  const frozenPath = record['frozenPath'];
  const amendments = record['amendments'];
  if (typeof baseline !== 'string' || !/^[0-9a-f]{7,40}$/.test(baseline)) {
    throw new TypeError('the amendment register must name a git baseline commit');
  }
  if (typeof frozenPath !== 'string' || frozenPath.length === 0) {
    throw new TypeError('the amendment register must name the frozen path');
  }
  if (!Array.isArray(amendments)) {
    throw new TypeError('the amendment register must carry an amendments array');
  }
  const rows: ContractsAmendment[] = [];
  for (const item of amendments) {
    if (typeof item !== 'object' || item === null) {
      throw new TypeError('every amendment must be an object');
    }
    const row = item as Record<string, unknown>;
    const path = row['path'];
    const reason = row['reason'];
    const adr = row['adr'];
    const commit = row['commit'];
    if (typeof path !== 'string' || path.length === 0) {
      throw new TypeError('every amendment must name a path');
    }
    if (typeof reason !== 'string' || reason.trim().length < 20) {
      throw new TypeError(`amendment ${path} must carry a substantive reason`);
    }
    if (typeof adr !== 'string' || !/^ADR-\d{4}$/.test(adr)) {
      throw new TypeError(`amendment ${path} must cite an ADR`);
    }
    // WHY THE COMMIT IS REQUIRED: an enumeration that names a path and a
    // reason but not the commit that made the change cannot be checked. With
    // the commit, the gate can prove the amendment is real history rather
    // than a line written to silence the gate.
    if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(commit)) {
      throw new TypeError(`amendment ${path} must name the commit that introduced it`);
    }
    if (isFrozenPath(path)) {
      throw new TypeError(
        `amendment ${path} is inside the frozen surface: a contract change cannot be allowlisted`,
      );
    }
    rows.push({ path, reason, adr, commit });
  }
  return { baseline, frozenPath, amendments: rows };
}

export const contractsBaselineGate: Gate = {
  id: GATE_ID,
  title: 'The frozen contracts surface still matches its baseline (ADR-0013..0016)',
  severity: 'blocker',
  async run(ctx: GateContext): Promise<GateResult> {
    const registerPath = join(ctx.root, AMENDMENTS_FILE);
    if (!existsSync(registerPath)) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the contracts baseline register is missing',
        evidence: [`expected ${AMENDMENTS_FILE}`],
      };
    }

    let register: AmendmentsRegister;
    try {
      register = parseAmendments(readFileSync(registerPath, 'utf8'));
    } catch (error) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the contracts baseline register is malformed',
        evidence: [error instanceof Error ? error.message : String(error)],
      };
    }

    const inside = git(ctx.root, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.available || inside.status !== 0 || inside.stdout.trim() !== 'true') {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: 'git is unavailable: the frozen-contract baseline could not be verified',
        evidence: [
          `baseline ${register.baseline}`,
          inside.stderr.trim() || 'not a git work tree',
          'run this gate inside the repository, or the contracts freeze is UNVERIFIED',
        ],
      };
    }

    const known = git(ctx.root, ['cat-file', '-e', `${register.baseline}^{commit}`]);
    if (known.status !== 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: `the baseline commit ${register.baseline} is not present in this clone`,
        evidence: [
          'a shallow clone cannot prove the freeze; fetch the full history',
          known.stderr.trim() || `git cat-file exited ${String(known.status)}`,
        ],
      };
    }

    // Untracked files under the contracts package count as changes.
    //
    // WHY: `git diff` compares commits to the WORKING TREE but it does not
    // report a file that was never tracked. A brand-new file inside the
    // frozen surface would therefore be invisible to the diff, and every
    // package would compile against it. The freeze must see untracked files.
    const untracked = git(ctx.root, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      CONTRACTS_DIR,
    ]);
    const untrackedPaths = untracked.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const frozen = git(ctx.root, ['diff', '--quiet', register.baseline, '--', register.frozenPath]);
    const untrackedInFrozen = untrackedPaths.filter((path) => isFrozenPath(path));
    if (frozen.status === 1 || untrackedInFrozen.length > 0) {
      const names = git(ctx.root, ['diff', '--name-only', register.baseline, '--', register.frozenPath]);
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the frozen contracts surface changed since the baseline',
        evidence: [
          `baseline ${register.baseline}`,
          ...names.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((path) => `changed: ${path}`),
          ...untrackedInFrozen.map((path) => `untracked inside the frozen surface: ${path}`),
          'a contract change is a decision: record it in an ADR and re-baseline deliberately',
        ],
      };
    }
    if (frozen.status !== 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: 'git could not diff the frozen surface',
        evidence: [frozen.stderr.trim() || `git diff exited ${String(frozen.status)}`],
      };
    }

    const changed = git(ctx.root, ['diff', '--name-only', register.baseline, '--', CONTRACTS_DIR]);
    const changedPaths = [
      ...changed.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      ...untrackedPaths,
    ];
    const listed = new Set(register.amendments.map((amendment) => amendment.path));
    const unlisted = changedPaths.filter((path) => !listed.has(path));
    const stale = [...listed].filter((path) => !changedPaths.includes(path));

    // Every enumerated amendment must name a commit that EXISTS in this
    // history and that is an ancestor of HEAD. A commit that does not exist,
    // or that is not in this branch's past, is an enumeration written to
    // silence the gate rather than a record of a real change.
    const badCommits: string[] = [];
    for (const amendment of register.amendments) {
      const present = git(ctx.root, ['cat-file', '-e', `${amendment.commit}^{commit}`]);
      if (present.status !== 0) {
        badCommits.push(`${amendment.path}: commit ${amendment.commit} is not in this clone`);
        continue;
      }
      const ancestor = git(ctx.root, ['merge-base', '--is-ancestor', amendment.commit, 'HEAD']);
      if (ancestor.status !== 0) {
        badCommits.push(`${amendment.path}: commit ${amendment.commit} is not an ancestor of HEAD`);
      }
    }

    const evidence = [
      `baseline ${register.baseline}`,
      `frozen surface ${register.frozenPath}: unchanged`,
      `enumerated amendment(s): ${register.amendments.map((a) => `${a.path} (${a.adr}, ${a.commit})`).join(', ') || '(none)'}`,
    ];

    if (unlisted.length > 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: `${String(unlisted.length)} contracts change(s) are not enumerated`,
        evidence: [...evidence, ...unlisted.map((path) => `unlisted: ${path}`)],
      };
    }
    if (stale.length > 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: `${String(stale.length)} enumerated amendment(s) no longer differ from the baseline`,
        evidence: [...evidence, ...stale.map((path) => `stale: ${path}`)],
      };
    }
    if (badCommits.length > 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: `${String(badCommits.length)} enumerated amendment(s) name a commit that is not in this history`,
        evidence: [...evidence, ...badCommits.map((line) => `bad commit: ${line}`)],
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: `frozen contracts unchanged; ${String(changedPaths.length)} enumerated packaging change(s)`,
      evidence,
    };
  },
};
