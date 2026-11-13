/**
 * Gate: every Phase 0 / Phase 1 / Phase 5 exit criterion is either proven by
 * executable evidence or explicitly owner-blocked.
 *
 * WHY this gate exists: a phase that is declared "done" in prose is not done.
 * The register in `docs/exit-criteria.json` transcribes the criteria from the
 * architecture document, and each `met` row must point at something that RUNS:
 *
 *   file — a shipped file exists, is non-empty and contains the named markers
 *   test — `node --test <file>` exits 0 with at least `minTests` passing tests
 *   tool — `node tools/<tool>` exits 0
 *   gate — another registered gate runs and passes
 *
 * A `test` row also refuses a stale build: if the TypeScript source is newer
 * than the compiled test, the evidence is not evidence of the current tree.
 *
 * A row that needs a person (a signature, an appointment, a CI run on a remote)
 * is `owner-blocked` and MUST name the owner, the reason and the unblock path.
 * Blocked rows are reported as warnings. They never make the gate pass, and
 * they never make it fail either — they make the shortfall visible, which is
 * the honest outcome.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Gate, GateContext, GateResult } from '../types.js';
import { consentGate } from './consent-gate.js';
import { contractGate } from './contract-gate.js';
import { failoverGate } from './failover-gate.js';

const GATE_ID = 'exit-criteria';
const REGISTER_FILE = 'docs/exit-criteria.json';

/** Evidence that a `met` row must produce. */
export type EvidenceKind = 'file' | 'test' | 'tool' | 'gate';

export interface CriterionEvidence {
  kind: EvidenceKind;
  target: string;
  contains?: string[];
  minTests?: number;
}

export interface ExitCriterionRow {
  id: string;
  phase: 0 | 1 | 5;
  criterion: string;
  source: string;
  status: 'met' | 'owner-blocked';
  evidence?: CriterionEvidence[];
  owner?: string;
  reason?: string;
  unblock?: string;
}

export interface ExitCriteriaRegister {
  expectedRows: number;
  rows: ExitCriterionRow[];
}

/** The gates a `gate` row may cite. `exit-criteria` is deliberately absent. */
const GATE_RESOLVERS = {
  'accessibility-contract': contractGate,
  'consent-withdrawal': consentGate,
  'failover-drill': failoverGate,
} as const;

/** Parse and validate the register. Throws a TypeError on any defect. */
export function parseExitCriteria(raw: string): ExitCriteriaRegister {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TypeError('the exit-criteria register must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const expectedRows = record['expectedRows'];
  const rows = record['rows'];
  if (typeof expectedRows !== 'number' || !Number.isInteger(expectedRows) || expectedRows < 1) {
    throw new TypeError('the register must state expectedRows');
  }
  if (!Array.isArray(rows)) {
    throw new TypeError('the register must carry a rows array');
  }

  const seen = new Set<string>();
  const out: ExitCriterionRow[] = [];
  for (const item of rows) {
    if (typeof item !== 'object' || item === null) {
      throw new TypeError('every exit criterion must be an object');
    }
    const row = item as Record<string, unknown>;
    const id = row['id'];
    const phase = row['phase'];
    const criterion = row['criterion'];
    const source = row['source'];
    const status = row['status'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('every exit criterion must have an id');
    }
    if (seen.has(id)) {
      throw new TypeError(`duplicate exit criterion id ${id}`);
    }
    seen.add(id);
    if (phase !== 0 && phase !== 1 && phase !== 5) {
      throw new TypeError(`exit criterion ${id} must belong to phase 0, 1 or 5`);
    }
    if (typeof criterion !== 'string' || criterion.trim().length < 10) {
      throw new TypeError(`exit criterion ${id} must state the criterion`);
    }
    if (typeof source !== 'string' || source.trim().length === 0) {
      throw new TypeError(`exit criterion ${id} must cite its source`);
    }
    if (status !== 'met' && status !== 'owner-blocked') {
      throw new TypeError(`exit criterion ${id} must be met or owner-blocked`);
    }

    if (status === 'owner-blocked') {
      for (const field of ['owner', 'reason', 'unblock'] as const) {
        const value = row[field];
        if (typeof value !== 'string' || value.trim().length < 10) {
          throw new TypeError(`owner-blocked criterion ${id} must name its ${field}`);
        }
      }
      out.push({
        id,
        phase,
        criterion,
        source,
        status,
        owner: String(row['owner']),
        reason: String(row['reason']),
        unblock: String(row['unblock']),
      });
      continue;
    }

    const evidence = row['evidence'];
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new TypeError(`met criterion ${id} must carry executable evidence`);
    }
    const checked: CriterionEvidence[] = [];
    for (const entry of evidence) {
      if (typeof entry !== 'object' || entry === null) {
        throw new TypeError(`criterion ${id} has a malformed evidence entry`);
      }
      const ev = entry as Record<string, unknown>;
      const kind = ev['kind'];
      const target = ev['target'];
      if (kind !== 'file' && kind !== 'test' && kind !== 'tool' && kind !== 'gate') {
        throw new TypeError(`criterion ${id} has an unknown evidence kind`);
      }
      if (typeof target !== 'string' || target.length === 0) {
        throw new TypeError(`criterion ${id} evidence must name a target`);
      }
      if (kind === 'gate' && target === GATE_ID) {
        throw new TypeError(`criterion ${id} cites the exit-criteria gate: self-reference is not evidence`);
      }
      if (kind === 'gate' && !(target in GATE_RESOLVERS)) {
        throw new TypeError(`criterion ${id} cites an unregistered gate ${target}`);
      }
      const contains = ev['contains'];
      if (contains !== undefined) {
        if (!Array.isArray(contains) || contains.some((value) => typeof value !== 'string')) {
          throw new TypeError(`criterion ${id} evidence contains must be a string array`);
        }
      }
      const minTests = ev['minTests'];
      if (minTests !== undefined && (typeof minTests !== 'number' || !Number.isInteger(minTests))) {
        throw new TypeError(`criterion ${id} evidence minTests must be an integer`);
      }
      checked.push({
        kind,
        target,
        ...(contains ? { contains: contains as string[] } : {}),
        ...(typeof minTests === 'number' ? { minTests } : {}),
      });
    }
    out.push({ id, phase, criterion, source, status, evidence: checked });
  }

  if (out.length !== expectedRows) {
    throw new TypeError(
      `the register carries ${String(out.length)} rows but declares ${String(expectedRows)}`,
    );
  }
  return { expectedRows, rows: out };
}

/** Run a command and return its status, stdout and stderr. */
function run(command: string, args: readonly string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: result.error ? -1 : (result.status ?? -1),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
}

/** The compiled test's source sibling, so a stale build can be refused. */
export function sourceSibling(distRelPath: string): string | undefined {
  const marker = '/dist/';
  const index = distRelPath.lastIndexOf(marker);
  if (index < 0 || !distRelPath.endsWith('.js')) return undefined;
  return `${distRelPath.slice(0, index)}/src/${distRelPath.slice(index + marker.length, -3)}.ts`;
}

interface EvidenceOutcome {
  ok: boolean;
  detail: string;
}

/** Prove one evidence entry. */
async function proveEvidence(
  entry: CriterionEvidence,
  root: string,
  ctx: GateContext,
): Promise<EvidenceOutcome> {
  if (entry.kind === 'file') {
    const abs = join(root, entry.target);
    if (!existsSync(abs)) {
      return { ok: false, detail: `missing file ${entry.target}` };
    }
    let content = '';
    try {
      content = readFileSync(abs, 'utf8');
    } catch (error) {
      return { ok: false, detail: `unreadable file ${entry.target}: ${String(error)}` };
    }
    if (content.trim().length === 0) {
      return { ok: false, detail: `empty file ${entry.target}` };
    }
    const missing = (entry.contains ?? []).filter((needle) => !content.includes(needle));
    if (missing.length > 0) {
      return {
        ok: false,
        detail: `${entry.target} does not contain ${missing.map((value) => `"${value}"`).join(', ')}`,
      };
    }
    return { ok: true, detail: `${entry.target} present with ${String(entry.contains?.length ?? 0)} marker(s)` };
  }

  if (entry.kind === 'tool') {
    const abs = join(root, 'tools', entry.target);
    if (!existsSync(abs)) {
      return { ok: false, detail: `missing tool tools/${entry.target}` };
    }
    const outcome = run(process.execPath, [abs], root);
    if (outcome.status !== 0) {
      return {
        ok: false,
        detail: `tools/${entry.target} exited ${String(outcome.status)}: ${(outcome.stderr || outcome.stdout).trim().split(/\r?\n/).slice(-1)[0] ?? ''}`,
      };
    }
    return { ok: true, detail: `tools/${entry.target} exited 0` };
  }

  if (entry.kind === 'test') {
    const abs = join(root, entry.target);
    if (!existsSync(abs)) {
      return { ok: false, detail: `missing test ${entry.target}` };
    }
    const source = sourceSibling(entry.target);
    if (source !== undefined) {
      const sourceAbs = join(root, source);
      if (existsSync(sourceAbs)) {
        const distTime = statSync(abs).mtimeMs;
        const srcTime = statSync(sourceAbs).mtimeMs;
        if (srcTime > distTime) {
          return {
            ok: false,
            detail: `${entry.target} is older than ${source}: the build is stale, so the test is not evidence`,
          };
        }
      }
    }
    const outcome = run(process.execPath, ['--test', '--test-reporter=tap', abs], root);
    if (outcome.status !== 0) {
      return {
        ok: false,
        detail: `${entry.target} exited ${String(outcome.status)}: ${(outcome.stdout || outcome.stderr).trim().split(/\r?\n/).slice(-1)[0] ?? ''}`,
      };
    }
    const passed = /^# pass (\d+)$/m.exec(outcome.stdout);
    const count = passed?.[1] !== undefined ? Number(passed[1]) : 0;
    const minimum = entry.minTests ?? 1;
    if (count < minimum) {
      return {
        ok: false,
        detail: `${entry.target} passed ${String(count)} test(s), expected at least ${String(minimum)}`,
      };
    }
    return { ok: true, detail: `${entry.target}: ${String(count)} test(s) passed` };
  }

  const gate = GATE_RESOLVERS[entry.target as keyof typeof GATE_RESOLVERS];
  const result = await gate.run(ctx);
  if (!result.passed) {
    return {
      ok: false,
      detail: `gate ${entry.target} failed: ${result.detail}`,
    };
  }
  return { ok: true, detail: `gate ${entry.target} passed` };
}

export const exitCriteriaGate: Gate = {
  id: GATE_ID,
  title: 'Every Phase 0/1/5 exit criterion is proven or explicitly owner-blocked',
  severity: 'blocker',
  async run(ctx: GateContext): Promise<GateResult> {
    const registerPath = join(ctx.root, REGISTER_FILE);
    if (!existsSync(registerPath)) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the exit-criteria register is missing',
        evidence: [`expected ${REGISTER_FILE}`],
      };
    }

    let register: ExitCriteriaRegister;
    try {
      register = parseExitCriteria(readFileSync(registerPath, 'utf8'));
    } catch (error) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the exit-criteria register is malformed',
        evidence: [error instanceof Error ? error.message : String(error)],
      };
    }

    const evidence: string[] = [];
    const failures: string[] = [];
    const blocked: string[] = [];
    let metCount = 0;

    for (const row of register.rows) {
      if (row.status === 'owner-blocked') {
        blocked.push(`${row.id} owner-blocked: ${String(row.owner)} — ${String(row.reason)}`);
        evidence.push(`${row.id} owner-blocked → ${String(row.owner)}`);
        continue;
      }
      let rowOk = true;
      for (const entry of row.evidence ?? []) {
        const outcome = await proveEvidence(entry, ctx.root, ctx);
        evidence.push(`${row.id} ${entry.kind}:${entry.target} — ${outcome.ok ? 'ok' : 'FAILED'} (${outcome.detail})`);
        if (!outcome.ok) {
          rowOk = false;
          failures.push(`${row.id}: ${outcome.detail}`);
        }
      }
      if (rowOk) metCount += 1;
    }

    if (failures.length > 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: `${String(failures.length)} exit criterion evidence failure(s)`,
        evidence: [...evidence, ...failures.map((line) => `FAILED ${line}`)],
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: `${String(metCount)} met, ${String(blocked.length)} owner-blocked of ${String(register.rows.length)} exit criteria`,
      evidence: [...evidence, ...blocked.map((line) => `WARNING ${line}`)],
    };
  },
};
