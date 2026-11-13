/**
 * Gate: no personal data is hardcoded in the source tree.
 *
 * Doc 2 §2.5 — the public artefacts hold no personal data, ever. Synthetic
 * fixtures are allowed, but only when they are recognisably synthetic
 * (documented allowlist patterns in `scan.ts`).
 */
import type { Gate, GateContext, GateResult } from '../types.js';
import { collectSourceFiles, listScannableDirs } from '../paths.js';
import { findPiiViolations } from '../scan.js';

const GATE_ID = 'no-pii-in-source';

export const piiGate: Gate = {
  id: GATE_ID,
  title: 'No personal data is hardcoded in the source tree',
  severity: 'blocker',
  async run(ctx: GateContext): Promise<GateResult> {
    const dirs = listScannableDirs(ctx.root);
    const files = collectSourceFiles(ctx.root, dirs);
    if (files.length === 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: 'no source files were found to scan',
        evidence: [`scanned directories: ${dirs.join(', ') || '(none)'}`],
      };
    }

    const violations = findPiiViolations(files);
    const evidence = violations.map(
      (v) => `${v.file}:${String(v.line)} — ${v.detail} (${v.rule})`,
    );
    evidence.unshift(`scanned ${String(files.length)} source file(s) in ${String(dirs.length)} directories`);

    if (violations.length > 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: `${String(violations.length)} personal-data literal(s) hardcoded in source`,
        evidence,
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: `no personal data found in ${String(files.length)} source file(s)`,
      evidence,
    };
  },
};
