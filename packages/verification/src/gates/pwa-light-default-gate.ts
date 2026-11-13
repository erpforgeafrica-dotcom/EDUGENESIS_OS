/**
 * Gate: the PWA renders the LIGHT theme by default, and every colour the page
 * DECLARES agrees with the colour it actually renders.
 *
 * WHY this gate exists (it caught a real defect):
 *   09 §12.3 exit criterion 5 (register row P1-4) — "The PWA renders the light
 *   theme by default with a verified contrast ledger." The register recorded
 *   that row as MET on the strength of the web-app manifest and the contrast
 *   tool. Neither proves it. The page shipped a `<meta name="color-scheme"
 *   content="light">` and a manifest whose `theme_color` was the light canvas,
 *   while the STYLESHEET's base `:root` block defined the DARK canvas and the
 *   light tokens were reachable only through an opt-in `[data-theme="light"]`
 *   attribute that the document never set. The page therefore rendered dark
 *   with light browser form controls painted on top of it.
 *
 * WHAT THIS GATE PROVES:
 *   1. The theme the document actually selects resolves to the LIGHT canvas
 *      token. (Computed from the document and the stylesheet, not asserted.)
 *   2. `<meta name="color-scheme">` agrees with the theme that is rendered.
 *   3. The manifest's `theme_color` and `background_color` agree with it too,
 *      so the browser chrome does not fight the page.
 *
 * The values are compared to each other; no colour literal appears in this
 * file, so the design-token gate has nothing to report here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Gate, GateContext, GateResult } from '../types.js';

const GATE_ID = 'pwa-light-default';

/** The document that ships the PWA shell. */
export const INDEX_HTML = 'apps/cli/public/index.html';
/** The token stylesheet — the single source of the theme. */
export const TOKEN_STYLESHEET = 'assets/edugenesis-tokens.css';
/** The web app manifest — the colours the browser chrome uses. */
export const MANIFEST = 'apps/cli/public/manifest.webmanifest';

interface CssBlock {
  readonly selector: string;
  readonly declarations: Map<string, string>;
}

/** Strip CSS comments so a commented-out declaration is never read as live. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Read `--name: value;` pairs out of a declaration body. */
function parseDeclarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of body.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) out.set(name, value.trim());
  }
  return out;
}

/** Every top-level block of the stylesheet, with its selector and declarations. */
function parseTopLevelBlocks(css: string): CssBlock[] {
  const source = stripCssComments(css);
  const blocks: CssBlock[] = [];
  let depth = 0;
  let selector = '';
  let bodyStart = -1;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      if (depth === 0) {
        selector = source.slice(0, i);
        bodyStart = i + 1;
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && bodyStart >= 0) {
        blocks.push({ selector: selector.trim(), declarations: parseDeclarations(source.slice(bodyStart, i)) });
        bodyStart = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return blocks;
}

/** Follow a single `var(--name)` indirection through the root declarations. */
function resolveVar(value: string, root: Map<string, string>): string {
  const match = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(value);
  if (!match) return value;
  const name = match[1];
  const resolved = name === undefined ? undefined : root.get(name);
  return resolved === undefined ? value : resolved.trim();
}

/** The `data-theme` the document selects, or null when it selects none. */
export function selectedTheme(html: string): string | null {
  const tag = /<html\b[^>]*>/i.exec(html);
  if (!tag) return null;
  const attr = /\bdata-theme\s*=\s*"([^"]*)"/i.exec(tag[0]);
  return attr?.[1] ?? null;
}

/** The value of `<meta name="color-scheme" content="...">`, or null. */
export function declaredColorScheme(html: string): string | null {
  const meta = /<meta\b[^>]*name\s*=\s*"color-scheme"[^>]*>/i.exec(html);
  if (!meta) return null;
  const content = /content\s*=\s*"([^"]*)"/i.exec(meta[0]);
  return content?.[1] ?? null;
}

function readIfPresent(root: string, relPath: string): string | null {
  const abs = join(root, relPath);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

export const pwaLightDefaultGate: Gate = {
  id: GATE_ID,
  title: 'The PWA renders the light theme by default and every declared colour agrees with it',
  severity: 'blocker',
  async run(ctx: GateContext): Promise<GateResult> {
    const html = readIfPresent(ctx.root, INDEX_HTML);
    const css = readIfPresent(ctx.root, TOKEN_STYLESHEET);
    const manifestRaw = readIfPresent(ctx.root, MANIFEST);

    if (html === null || css === null || manifestRaw === null) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the PWA shell, the token stylesheet or the manifest is missing, so the rendered theme cannot be determined',
        evidence: [
          `${INDEX_HTML}: ${html === null ? 'MISSING' : 'present'}`,
          `${TOKEN_STYLESHEET}: ${css === null ? 'MISSING' : 'present'}`,
          `${MANIFEST}: ${manifestRaw === null ? 'MISSING' : 'present'}`,
        ],
      };
    }

    const blocks = parseTopLevelBlocks(css);
    const root = blocks.find((b) => b.selector === ':root')?.declarations ?? new Map<string, string>();
    const lightBlock = blocks.find((b) => b.selector.includes('[data-theme="light"]'));
    const darkBlock = blocks.find((b) => b.selector.includes('[data-theme="dark"]'));

    const baseCanvas = root.get('--eg-canvas') ?? '';
    const lightCanvas = resolveVar(lightBlock?.declarations.get('--eg-canvas') ?? '', root);
    const darkCanvas = resolveVar(darkBlock?.declarations.get('--eg-canvas') ?? baseCanvas, root);

    const theme = selectedTheme(html);
    const effectiveCanvas = theme === 'light' ? lightCanvas : theme === 'dark' ? darkCanvas : baseCanvas;
    const scheme = declaredColorScheme(html);

    let manifestTheme = '';
    let manifestBackground = '';
    try {
      const manifest = JSON.parse(manifestRaw) as { theme_color?: string; background_color?: string };
      manifestTheme = manifest.theme_color ?? '';
      manifestBackground = manifest.background_color ?? '';
    } catch {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the web app manifest is not valid JSON, so its declared colours cannot be checked',
        evidence: [`${MANIFEST}: unparseable`],
      };
    }

    const evidence = [
      `document theme attribute: ${theme ?? '(none — the base :root tokens apply)'}`,
      `base canvas token: ${baseCanvas || '(undefined)'}`,
      `light canvas token: ${lightCanvas || '(undefined)'}`,
      `effective canvas: ${effectiveCanvas || '(undefined)'}`,
      `declared color-scheme: ${scheme ?? '(none)'}`,
      `manifest theme_color: ${manifestTheme || '(none)'}`,
      `manifest background_color: ${manifestBackground || '(none)'}`,
    ];

    const failures: string[] = [];

    const expectedScheme = effectiveCanvas.toUpperCase() === lightCanvas.toUpperCase() ? 'light' : 'dark';
    if (effectiveCanvas.toUpperCase() !== lightCanvas.toUpperCase()) {
      failures.push(
        `the page renders the DARK canvas by default; the criterion (P1-4) and ADR-0011 require the LIGHT theme`,
      );
    }
    if (scheme === null) {
      failures.push('the document declares no <meta name="color-scheme">, so the browser form controls may not match the canvas');
    } else if (scheme.toLowerCase() !== expectedScheme) {
      failures.push(
        `the document declares color-scheme "${scheme}" while the rendered theme is "${expectedScheme}" — the browser would paint ${scheme === 'light' ? 'light' : 'dark'} form controls on the ${expectedScheme} canvas`,
      );
    }
    if (manifestTheme.toUpperCase() !== effectiveCanvas.toUpperCase()) {
      failures.push(`the manifest theme_color does not match the canvas the page actually renders`);
    }
    if (manifestBackground.toUpperCase() !== effectiveCanvas.toUpperCase()) {
      failures.push(`the manifest background_color does not match the canvas the page actually renders`);
    }

    if (failures.length > 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: `${String(failures.length)} theme declaration(s) disagree with the theme the page renders`,
        evidence: [...evidence, ...failures.map((f) => `FAIL: ${f}`)],
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: `the PWA renders the light theme by default and every declared colour agrees with it`,
      evidence,
    };
  },
};
