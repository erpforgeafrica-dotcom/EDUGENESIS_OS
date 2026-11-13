/**
 * Gate: raw colour literals never appear in source.
 *
 * Design-token governance (02_DESIGN_SYSTEM.md, RULE 2). The token
 * stylesheet is the only place a colour value may live; a component that
 * hard-codes a hex or a functional colour literal bypasses the theme switch,
 * the contrast ledger and the high-contrast mode all at once.
 */
import type { Gate, GateContext, GateResult } from '../types.js';
import { collectSourceFiles, listScannableDirs } from '../paths.js';
import { extractTokenColours, findHexViolations } from '../scan.js';

const GATE_ID = 'design-token-governance';

/** The token stylesheet. Its literals are the definitions, not findings. */
export const TOKEN_STYLESHEET = 'assets/edugenesis-tokens.css';

/**
 * Files whose format cannot reference a CSS custom property.
 *
 * Each one is here for a stated reason, and the exemption is CHECKED: a
 * literal in one of these files must equal a colour the token stylesheet
 * defines, so an asset colour can never drift away from the design system.
 *
 *   - the web app manifest takes a colour string; there is no variable syntax;
 *   - an SVG loaded as an image cannot inherit the page's custom properties;
 *   - the `theme-color` meta element takes a literal.
 */
export const TOKEN_VALUE_ASSET_FILES: readonly string[] = [
  'apps/cli/public/manifest.webmanifest',
  'apps/cli/public/icon.svg',
  'apps/cli/public/index.html',
];

export const hexTokenGate: Gate = {
  id: GATE_ID,
  title: 'No raw hex or functional colour literal in any source file',
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

    const stylesheet = files.find((file) => file.relPath === TOKEN_STYLESHEET);
    if (!stylesheet) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: `the token stylesheet ${TOKEN_STYLESHEET} was not found, so no colour can be checked against the design system`,
        evidence: [`scanned directories: ${dirs.join(', ')}`],
      };
    }

    const tokenColours = extractTokenColours(stylesheet.content);
    const violations = findHexViolations(files, {
      tokenStylesheet: TOKEN_STYLESHEET,
      tokenColours,
      valueAssetFiles: TOKEN_VALUE_ASSET_FILES,
    });
    const evidence = [
      `scanned ${String(files.length)} source file(s) in ${String(dirs.length)} directories`,
      `token stylesheet: ${TOKEN_STYLESHEET} (${String(tokenColours.size)} colour(s) defined)`,
      `value-carrying assets allowed to hold a token colour: ${TOKEN_VALUE_ASSET_FILES.join(', ')}`,
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
