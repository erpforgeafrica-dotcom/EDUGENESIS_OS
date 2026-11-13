/**
 * Gate: no provider SDK or provider host appears outside packages/onekey.
 *
 * ADR-0001 — "a provider change is a registry change". This static gate is
 * the machine-checkable proof of that promise: if a provider SDK or a
 * provider host name ever appears in learner-path code, the build fails.
 *
 * The needle strings below are assembled from fragments so that this file
 * does not itself contain a literal the scanner would find.
 */
import type { Gate, GateContext, GateResult } from '../types.js';
import { collectSourceFiles, listWorkspaceSrcDirs } from '../paths.js';
import { stripComments } from '../scan.js';

const GATE_ID = 'no-provider-leak';

/** Provider identifiers and hosts that must not leak into learner-path code. */
export const PROVIDER_NEEDLES: readonly string[] = [
  'ali' + 'baba' + 'cloud',
  'dash' + 'scope',
  'open' + 'ai',
  'anthro' + 'pic',
  'generative' + 'language',
  'api.' + 'anthro' + 'pic',
  'q' + 'wen',
];

/**
 * Directories excluded from the scan.
 *
 * `packages/onekey/` is the provider boundary named in ADR-0001: the registry,
 * the adapters and the redaction list are the ONE place a provider may be
 * named. Everything outside it — the accessibility engine, the ledger, the
 * identity service, the CLI, the contracts and the verification harness — is
 * learner path and must stay provider-neutral.
 *
 * WHY `packages/contracts/` is NOT excluded any more: the earlier exclusion
 * existed only because the contracts header cites the sponsor document by
 * name in a doc comment. Excluding a whole package to accommodate a comment
 * weakened the gate. Comments are stripped before the scan instead, so a
 * provider HOST in executable contract code is still caught.
 */
export const PROVIDER_LEAK_EXCLUSIONS: readonly string[] = ['packages/onekey/'];

/**
 * An import that reaches into a provider implementation folder.
 *
 * The needle scan below catches provider NAMES. This catches the other half
 * of ADR-0001: a module outside packages/onekey must not reach into a
 * provider implementation at all, however it names it.
 */
const PROVIDER_IMPORT_PATTERN =
  /(?:from|import|require)\s*\(?\s*['"][^'"]*(?:\/|^)providers\/[^'"]*['"]/g;

/** True when a project-relative path is excluded from the scan. */
export function isExcludedPath(relPath: string): boolean {
  return PROVIDER_LEAK_EXCLUSIONS.some((prefix) => relPath.startsWith(prefix));
}

export const noProviderLeakGate: Gate = {
  id: GATE_ID,
  title: 'No provider SDK or provider host appears outside packages/onekey (ADR-0001)',
  severity: 'blocker',
  async run(ctx: GateContext): Promise<GateResult> {
    const dirs = listWorkspaceSrcDirs(ctx.root);
    const all = collectSourceFiles(ctx.root, dirs);
    const files = all.filter((file) => !isExcludedPath(file.relPath));

    if (files.length === 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: 'no source files were found to scan',
        evidence: [`scanned directories: ${dirs.join(', ') || '(none)'}`],
      };
    }

    const hits: string[] = [];
    for (const file of files) {
      // Comments are stripped, not skipped: a provider name in a citation is
      // not a dependency, but a provider host in code is. String literals are
      // preserved, so a host inside a string is still executable and still a
      // leak. Line structure is preserved, so reported numbers stay true.
      const scanned = stripComments(file.content);
      scanned.split(/\r?\n/).forEach((text, index) => {
        const lowered = text.toLowerCase();
        for (const needle of PROVIDER_NEEDLES) {
          if (lowered.includes(needle)) {
            hits.push(
              `${file.relPath}:${String(index + 1)} — provider identifier "${needle}" appears in learner-path code`,
            );
          }
        }
        // Outside packages/onekey nothing may import a provider implementation.
        if (!file.relPath.startsWith('packages/onekey/')) {
          PROVIDER_IMPORT_PATTERN.lastIndex = 0;
          if (PROVIDER_IMPORT_PATTERN.test(text)) {
            hits.push(
              `${file.relPath}:${String(index + 1)} — imports a provider implementation outside packages/onekey`,
            );
          }
        }
      });
    }

    const evidence = [
      `scanned ${String(files.length)} source file(s) with comments stripped; excluded ${PROVIDER_LEAK_EXCLUSIONS.join(', ')}`,
      ...hits,
    ];

    if (hits.length > 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: `${String(hits.length)} provider reference(s) found outside packages/onekey`,
        evidence,
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: `no provider reference outside packages/onekey in ${String(files.length)} source file(s)`,
      evidence,
    };
  },
};
