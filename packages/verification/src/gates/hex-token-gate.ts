/**
 * Gate: raw colour literals never appear in source.
 *
 * Design-token governance (02_DESIGN_SYSTEM.md, RULE 2). The token
 * stylesheet is the only place a colour value may live; a component that
 * hard-codes a hex or a functional colour literal bypasses the theme switch,
 * the contrast ledger and the high-contrast mode all at once.
 */
import type { Gate, GateContext, GateResult } from '../types.js';
import { collectSourceFiles, listWorkspaceSrcDirs } from '../paths.js';
import { findHexViolations } from '../scan.js';

const GATE_ID = 'design-token-governance';

export const hexTokenGate: Gate = {
  id: GATE_ID,
  title: 'No raw hex or functional colour literal in any source file',
  severity: 'blocker',
  async run(ctx: GateContext): Promise<GateResult> {
    const dirs = listWorkspaceSrcDirs(ctx.root);
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

    const violations = findHexViolations(files);
    const evidence = [
      `scanned ${String(files.length)} source file(s) in ${String(dirs.length)} directories`,
      ...violations.map((v) => `${v.file}:${String(v.line)} — ${v.detail} (${v.rule})`),
    ];

    if (violations.length > 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: `${String(violations.length)} raw colour literal(s) outside the token stylesheet`,
        evidence,
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: `no raw colour literal in ${String(files.length)} source file(s)`,
      evidence,
    };
  },
};
