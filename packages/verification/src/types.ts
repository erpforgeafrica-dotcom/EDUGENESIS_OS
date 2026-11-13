/**
 * EduGenesis OS — verification harness public types.
 *
 * The harness answers one question: "is this build real, or is it merely
 * claimed to be?" A gate that cannot run must never report PASS.
 */

/**
 * How badly a gate failure matters.
 *  - `blocker` — the build is not shippable until this is fixed.
 *  - `warning` — the gate could not be evaluated (usually a dependency that
 *    another swarm unit has not finished yet). Never a false PASS, never a
 *    false blocker — but never a pass either. A warning-severity result is
 *    reported as UNVERIFIED, and the strict chain fails on it (owner decision
 *    D-5): "18/18 PASS" must mean eighteen gates actually ran and held.
 */
export type GateSeverity = 'blocker' | 'warning';

/**
 * The three outcomes a gate can produce.
 *  - `pass`       — the gate ran and every assertion held.
 *  - `fail`       — the gate ran, an assertion failed, and the gate is a
 *                   blocker for this run.
 *  - `unverified` — the gate could not evaluate its subject. It is never a
 *                   pass, and the strict chain refuses to go green on it.
 */
export type GateStatus = 'pass' | 'fail' | 'unverified';

/** The outcome of running one gate. */
export interface GateResult {
  /** Stable id of the gate that produced this result. */
  id: string;
  /** True only when the gate actually ran and every assertion held. */
  passed: boolean;
  /** Effective severity for THIS run (may be downgraded to `warning`). */
  severity: GateSeverity;
  /** One-line human summary. */
  detail: string;
  /** Supporting proof lines. Never contains secret or personal values. */
  evidence: string[];
}

/**
 * Derive the three-state status of a result.
 *
 * WHY DERIVED, NOT STORED: a gate that could not run used to report
 * `passed: true` with `severity: 'warning'`, so the table printed PASS and the
 * chain printed green; the warning was cosmetic and could not block anything.
 * One derivation, used by the summary, the report writer and the test suite,
 * means the three surfaces can never disagree.
 */
export function gateStatus(result: Pick<GateResult, 'passed' | 'severity'>): GateStatus {
  if (result.severity === 'warning') return 'unverified';
  return result.passed ? 'pass' : 'fail';
}

/** Everything a gate needs to know about where it is running. */
export interface GateContext {
  /** Absolute path to the project root. Derived at runtime, never hardcoded. */
  root: string;
}

/** One check in the registry. */
export interface Gate {
  /** Stable machine id, e.g. `accessibility-contract`. */
  id: string;
  /** Human title shown in the report table. */
  title: string;
  /** Severity when the gate runs and fails. */
  severity: GateSeverity;
  /** Run the gate. Must resolve (never reject) for ordinary failures. */
  run(ctx: GateContext): Promise<GateResult>;
}

/** Aggregate outcome of a gate run. */
export interface GateSummary {
  /** False when a blocker failed OR any gate could not be verified. */
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  /** Gates that could not evaluate their subject — never a pass. */
  unverifiedCount: number;
  blockerFailures: Array<{ id: string; detail: string }>;
  warningFailures: Array<{ id: string; detail: string }>;
}

/** One file that the static scanners look at. */
export interface SourceFile {
  /** Project-relative path, always POSIX separators. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Decoded text content. */
  content: string;
}

/** Which family of rule a violation belongs to. */
export type ViolationKind = 'pii' | 'hex' | 'absolute-path';

/**
 * A single static-analysis finding.
 * `detail` never contains the offending value — only a description of it —
 * so a violation report can never leak the personal data it found.
 */
export interface Violation {
  kind: ViolationKind;
  /** Project-relative path. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Stable machine-readable rule id. */
  rule: string;
  /** Value-free description. */
  detail: string;
}
