#!/usr/bin/env node
/**
 * EDUGENESIS OS — design-token contrast gate.
 *
 * Reads `assets/edugenesis-tokens.css`, resolves the CSS custom properties
 * for BOTH themes (`:root` = dark, `[data-theme="light"]` = light) and checks
 * a hard-coded list of role pairs against WCAG 2.x contrast ratios computed
 * with the standard relative-luminance formula.
 *
 * Exit code 1 if ANY pair fails. A pair that fails is a blocker: a learner
 * with a low-contrast screen, in daylight, on a cheap LCD panel, is the
 * person who pays for it.
 *
 * Usage:  node tools/verify-contrast.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TOKEN_FILE = new URL('../assets/edugenesis-tokens.css', import.meta.url);

/* -------------------------------------------------------------------------- */
/* Pair list — the roles a learner actually reads.                            */
/* -------------------------------------------------------------------------- */

/**
 * min 4.5 => WCAG 2.x AA for body text.
 * min 3.0 => WCAG 2.x AA for non-text (focus indicator, functional border).
 */
const PAIRS = [
  // ---- body / secondary / tertiary text on canvas, surface, raised --------
  { id: 'text-primary/canvas', fg: '--eg-text-primary', bg: '--eg-canvas', min: 4.5 },
  { id: 'text-primary/surface', fg: '--eg-text-primary', bg: '--eg-surface', min: 4.5 },
  { id: 'text-primary/raised', fg: '--eg-text-primary', bg: '--eg-raised', min: 4.5 },
  { id: 'text-secondary/canvas', fg: '--eg-text-secondary', bg: '--eg-canvas', min: 4.5 },
  { id: 'text-secondary/surface', fg: '--eg-text-secondary', bg: '--eg-surface', min: 4.5 },
  { id: 'text-secondary/raised', fg: '--eg-text-secondary', bg: '--eg-raised', min: 4.5 },
  { id: 'text-tertiary/canvas', fg: '--eg-text-tertiary', bg: '--eg-canvas', min: 4.5 },
  { id: 'text-tertiary/surface', fg: '--eg-text-tertiary', bg: '--eg-surface', min: 4.5 },
  { id: 'text-tertiary/raised', fg: '--eg-text-tertiary', bg: '--eg-raised', min: 4.5 },

  // ---- accent text roles on canvas and surface ----------------------------
  { id: 'gold-as-text/canvas', fg: '--eg-accent-text', bg: '--eg-canvas', min: 4.5 },
  { id: 'gold-as-text/surface', fg: '--eg-accent-text', bg: '--eg-surface', min: 4.5 },
  { id: 'teal-as-text/canvas', fg: '--eg-accent-2-text', bg: '--eg-canvas', min: 4.5 },
  { id: 'teal-as-text/surface', fg: '--eg-accent-2-text', bg: '--eg-surface', min: 4.5 },
  { id: 'link/canvas', fg: '--eg-link-text', bg: '--eg-canvas', min: 4.5 },
  { id: 'link/surface', fg: '--eg-link-text', bg: '--eg-surface', min: 4.5 },

  // ---- ink on a gold fill --------------------------------------------------
  { id: 'ink/gold-fill', fg: '--eg-ink', bg: '--eg-gold', min: 4.5 },

  // ---- focus ring (non-text, 3:1) -----------------------------------------
  { id: 'focus-ring/canvas', fg: '--eg-focus-ring', bg: '--eg-canvas', min: 3 },
  { id: 'focus-ring/surface', fg: '--eg-focus-ring', bg: '--eg-surface', min: 3 },

  // ---- functional border (non-text, 3:1) ----------------------------------
  { id: 'functional-border/surface', fg: '--eg-border-strong', bg: '--eg-surface', min: 3 },

  // ---- status text on canvas ----------------------------------------------
  { id: 'success/canvas', fg: '--eg-success', bg: '--eg-canvas', min: 4.5 },
  { id: 'warning/canvas', fg: '--eg-warning', bg: '--eg-canvas', min: 4.5 },
  { id: 'danger/canvas', fg: '--eg-danger', bg: '--eg-canvas', min: 4.5 },
  { id: 'info/canvas', fg: '--eg-info', bg: '--eg-canvas', min: 4.5 },

  // ---- interactive states the settings page actually renders --------------
  // .btn--quiet:hover paints text-primary on --eg-overlay. Omitting this pair
  // is how the 1.26:1 light-theme hover shipped while the gate reported PASS.
  { id: 'text-primary/overlay', fg: '--eg-text-primary', bg: '--eg-overlay', min: 4.5 },
  // a:hover uses --eg-accent-text, which must stay readable on both canvases.
  { id: 'link-hover/canvas', fg: '--eg-accent-text', bg: '--eg-canvas', min: 4.5 },
  { id: 'link-hover/surface', fg: '--eg-accent-text', bg: '--eg-surface', min: 4.5 },
];

/* -------------------------------------------------------------------------- */
/* CSS parsing                                                                 */
/* -------------------------------------------------------------------------- */

/** Remove CSS comments so a selector inside a comment cannot be matched. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Extract the declaration block of the first occurrence of a selector. */
function extractBlock(css, selector) {
  const start = css.indexOf(selector);
  if (start < 0) return null;
  const open = css.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/** Parse `--name: value;` declarations out of a block. */
function parseDeclarations(block) {
  const map = new Map();
  if (!block) return map;
  const withoutStrings = block.replace(/;(?![^(]*\))/g, ';');
  for (const part of withoutStrings.split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name.startsWith('--')) continue;
    if (value === '') continue;
    map.set(name, value);
  }
  return map;
}

/** Resolve a token, following `var(--x)` references inside the same theme. */
function resolveToken(name, scope, seen = new Set()) {
  if (seen.has(name)) return undefined;
  seen.add(name);
  const raw = scope.get(name);
  if (raw === undefined) return undefined;
  const varMatch = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*\)$/.exec(raw);
  if (varMatch) return resolveToken(varMatch[1], scope, seen);
  return raw;
}

/** Parse a resolved colour value into [r,g,b]. */
function parseColour(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const hexMatch = /^#([0-9a-f]{3,8})$/i.exec(trimmed);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    }
    if (hex.length !== 6 && hex.length !== 8) return null;
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  const rgbMatch = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(trimmed);
  if (rgbMatch) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Contrast maths — WCAG 2.x relative luminance                               */
/* -------------------------------------------------------------------------- */

function channelToLinear(value) {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb) {
  return (
    0.2126 * channelToLinear(rgb[0]) +
    0.7152 * channelToLinear(rgb[1]) +
    0.0722 * channelToLinear(rgb[2])
  );
}

function contrastRatio(a, b) {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG grade for a ratio, given the required minimum for the pair. */
function grade(ratio, min) {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return min <= 3 ? 'AA(non-text)' : 'AA-large-only';
  return 'FAIL';
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padLeft(value, width) {
  const text = String(value);
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function main() {
  const tokenPath = fileURLToPath(TOKEN_FILE);
  if (!existsSync(tokenPath)) {
    process.stdout.write(`FAIL  token file not found: assets/edugenesis-tokens.css\n`);
    process.stdout.write('      the contrast gate cannot run without the token stylesheet\n');
    process.exit(1);
  }

  const css = stripComments(readFileSync(tokenPath, 'utf8'));
  const rootScope = parseDeclarations(extractBlock(css, ':root'));
  const lightScope = parseDeclarations(extractBlock(css, '[data-theme="light"]'));

  if (rootScope.size === 0) {
    process.stdout.write('FAIL  no :root token block found in the token stylesheet\n');
    process.exit(1);
  }
  if (lightScope.size === 0) {
    process.stdout.write('FAIL  no [data-theme="light"] token block found in the token stylesheet\n');
    process.exit(1);
  }

  const themes = [
    { name: 'dark', scope: rootScope },
    { name: 'light', scope: new Map([...rootScope, ...lightScope]) },
  ];

  const lines = [];
  const failures = [];
  let checked = 0;

  lines.push('EDUGENESIS OS — token contrast gate');
  lines.push('token file : assets/edugenesis-tokens.css');
  lines.push(`tokens     : ${String(rootScope.size)} root, ${String(lightScope.size)} light overrides`);
  lines.push('method     : WCAG 2.x relative luminance, (L1+0.05)/(L2+0.05)');
  lines.push('');

  for (const theme of themes) {
    lines.push(`THEME ${theme.name.toUpperCase()}`);
    lines.push(
      `  ${pad('pair', 26)}${pad('foreground', 22)}${pad('background', 20)}${padLeft('ratio', 9)}${padLeft('min', 6)}  ${pad('grade', 14)}result`,
    );
    lines.push(`  ${'-'.repeat(26 + 22 + 20 + 9 + 6 + 2 + 14 + 6)}`);

    for (const pair of PAIRS) {
      checked += 1;
      const fgRaw = resolveToken(pair.fg, theme.scope);
      const bgRaw = resolveToken(pair.bg, theme.scope);
      const fg = fgRaw === undefined ? null : parseColour(fgRaw);
      const bg = bgRaw === undefined ? null : parseColour(bgRaw);

      if (fg === null || bg === null) {
        const missing = fg === null ? pair.fg : pair.bg;
        failures.push(`${theme.name}: ${pair.id} — token ${missing} is missing or not a colour`);
        lines.push(
          `  ${pad(pair.id, 26)}${pad(pair.fg, 22)}${pad(pair.bg, 20)}${padLeft('n/a', 9)}${padLeft(pair.min, 6)}  ${pad('UNRESOLVED', 14)}FAIL`,
        );
        continue;
      }

      const ratio = contrastRatio(fg, bg);
      const ok = ratio >= pair.min;
      const ratioText = `${ratio.toFixed(2)}:1`;
      lines.push(
        `  ${pad(pair.id, 26)}${pad(pair.fg, 22)}${pad(pair.bg, 20)}${padLeft(ratioText, 9)}${padLeft(
          `${pair.min.toFixed(1)}`,
          6,
        )}  ${pad(grade(ratio, pair.min), 14)}${ok ? 'PASS' : 'FAIL'}`,
      );
      if (!ok) {
        failures.push(
          `${theme.name}: ${pair.id} — ${ratioText} is below the required ${pair.min.toFixed(1)}:1`,
        );
      }
    }
    lines.push('');
  }

  lines.push(`checks: ${String(checked)}   passed: ${String(checked - failures.length)}   failed: ${String(failures.length)}`);

  if (failures.length > 0) {
    lines.push('');
    lines.push('FAILURES');
    for (const failure of failures) lines.push(`  - ${failure}`);
    lines.push('');
    lines.push('RESULT: FAIL — a contrast pair below its required ratio is a blocker.');
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exit(1);
  }

  lines.push('');
  lines.push('RESULT: PASS — every role pair meets its WCAG 2.x requirement in both themes.');
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

main();
