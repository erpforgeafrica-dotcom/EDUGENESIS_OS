/**
 * Gate: no hardcoded absolute path anywhere in the shipped tree.
 *
 * GLOBAL.md §9 (portability law) — the product must run identically on any
 * Windows PC that copies the project folder, under any user name, from any
 * drive. A hardcoded drive-letter path in source OR in a shipped config
 * file breaks that law, so config files are scanned too: a `tsconfig.json`
 * that points at an absolute `extends` path fails to compile on the second
 * machine, which is the same defect wearing a different hat.
 */
import type { Gate, GateContext, GateResult } from '../types.js';
import {
  collectSourceFiles,
  listAssetsDir,
  listConfigFiles,
  listDocumentationFiles,
  listToolsDir,
  listWorkspaceSrcDirs,
  readSourceFiles,
} from '../paths.js';
import { findAbsolutePathViolations } from '../scan.js';

const GATE_ID = 'path-portability';

export const pathPortabilityGate: Gate = {
  id: GATE_ID,
  title: 'No hardcoded absolute path in any shipped source, config or doc file',
  severity: 'blocker',
  async run(ctx: GateContext): Promise<GateResult> {
    const sourceDirs = [
      ...listWorkspaceSrcDirs(ctx.root),
      ...listToolsDir(ctx.root),
      ...listAssetsDir(ctx.root),
    ];
    const sourceFiles = collectSourceFiles(ctx.root, sourceDirs);
    // Named files need a named-file reader: `collectSourceFiles` walks
    // directories, and handing it a file path made the config scan empty.
    const configFiles = readSourceFiles(ctx.root, listConfigFiles(ctx.root));
    // Documentation ships with the product, so a machine path in a setup guide
    // breaks the same law. `.md`/`.csv` were never read before the round-4 fix.
    const docFiles = readSourceFiles(ctx.root, listDocumentationFiles(ctx.root));

    if (sourceFiles.length === 0 && configFiles.length === 0 && docFiles.length === 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: 'no source, config or doc files were found to scan',
        evidence: [`scanned directories: ${sourceDirs.join(', ') || '(none)'}`],
      };
    }

    const sourceViolations = findAbsolutePathViolations(sourceFiles);
    const configViolations = findAbsolutePathViolations(configFiles);
    const docViolations = findAbsolutePathViolations(docFiles);

    const evidence = [
      `scanned ${String(sourceFiles.length)} source file(s), ${String(configFiles.length)} config file(s) and ${String(docFiles.length)} doc file(s)`,
      ...sourceViolations.map((v) => `${v.file}:${String(v.line)} — ${v.detail} (${v.rule})`),
      ...configViolations.map(
        (v) => `${v.file}:${String(v.line)} — ${v.detail} in a shipped config file (${v.rule})`,
      ),
      ...docViolations.map(
        (v) => `${v.file}:${String(v.line)} — ${v.detail} in a shipped doc file (${v.rule})`,
      ),
    ];

    const total = sourceViolations.length + configViolations.length + docViolations.length;
    if (total > 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: `${String(total)} hardcoded absolute path(s) break the portability law`,
        evidence,
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: `no absolute path in ${String(sourceFiles.length + configFiles.length + docFiles.length)} shipped file(s)`,
      evidence,
    };
  },
};
