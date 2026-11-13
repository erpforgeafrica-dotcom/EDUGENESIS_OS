/**
 * Gate: the keyboard focus indicator is authored once, is visible on every
 * fill, and survives forced-colors mode.
 *
 * WHY this gate exists (it closes the gate half of F2-01 / batch item E1):
 *   The stylesheet authors a dual-ring `:focus-visible`, but nothing checked
 *   that it stays there. A later change could delete the rule, replace the
 *   token with `outline: none` for a cosmetic reason, or drop the forced-colors
 *   override, and every other gate would stay green while the product became
 *   unusable from a keyboard.
 *
 * WHAT THIS GATE PROVES (all from the stylesheet text, no browser):
 *   1. A `:focus-visible` rule exists and declares an outline that is not
 *      `none`/`0`, and the outline resolves through a design token.
 *   2. The ring is positioned with an offset, so it is not clipped by the
 *      control's own border.
 *   3. A second ring (box-shadow) exists, so the indicator survives being
 *      drawn on a filled control where the outline alone loses contrast.
 *   4. A filled-control override exists (`.btn--gold`-class fills), because a
 *      single ring colour cannot clear 3:1 on both the canvas and the fill.
 *   5. `@media (forced-colors: active)` re-authors the ring with a system
 *      colour.
 *   6. No `:focus` rule suppresses the indicator.
 *   7. Every token the focus rules reference is actually defined.
 *
 * The runtime claim (a person tabs through the page and sees the ring) stays
 * UNVERIFIED by this gate; the audit records that separately.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Gate, GateContext, GateResult } from '../types.js';

const GATE_ID = 'keyboard-focus';

/** The token stylesheet - the single place the focus system is authored. */
export const TOKEN_STYLESHEET = 'assets/edugenesis-tokens.css';

/** One rule, with the media condition it sits inside (or null at top level). */
interface CssRule {
  readonly selector: string;
  readonly body: string;
  readonly media: string | null;
}

export interface FocusAssessment {
  readonly passed: boolean;
  readonly findings: string[];
  readonly evidence: string[];
}

/** Remove comments so a commented-out rule is never read as live. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Flatten the stylesheet into rules, remembering the enclosing media query.
 *
 * WHY recursive: the focus system is authored at top level AND inside
 * `@media (forced-colors: active)`. A depth-only scan that pushed a rule when
 * the brace depth returned to zero would silently drop every nested rule, and
 * the forced-colors requirement would then be judged against nothing.
 *
 * The parser is still deliberately small: it reads a block prelude, then the
 * balanced body, and recurses into at-rule bodies. A selector-list prelude is
 * kept as one string, which is what the assertions need.
 */
export function collectCssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  parseRules(stripCssComments(css), null, rules);
  return rules;
}

function parseRules(source: string, media: string | null, out: CssRule[]): void {
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('{', index);
    if (open === -1) break;
    const prelude = source.slice(index, open).trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < source.length && depth > 0) {
      const ch = source[cursor];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      cursor += 1;
    }
    const body = source.slice(open + 1, Math.max(open + 1, cursor - 1));
    if (prelude.startsWith('@media')) {
      parseRules(body, prelude, out);
    } else if (prelude.startsWith('@')) {
      // `@supports` and friends wrap rules too; keep the outer media context.
      parseRules(body, media, out);
    } else if (prelude.length > 0) {
      out.push({ selector: prelude, body, media });
    }
    index = cursor;
  }
}

/**
 * True when a declaration body sets `property` to a value that hides the ring.
 *
 * WHY the last declaration wins: CSS applies the last matching declaration in
 * a block, so `outline: none; outline: 2px solid ...` is visible while the
 * reverse order is not. Reading the first match would judge the wrong one.
 */
export function hidesIndicator(body: string, property: string): boolean {
  const pattern = new RegExp(`${property}\\s*:\\s*([^;]+)`, 'gi');
  let last = '';
  for (const match of body.matchAll(pattern)) {
    last = (match[1] ?? '').trim().toLowerCase();
  }
  if (last.length === 0) return false;
  return last === 'none' || last === '0' || last === '0px' || last === 'transparent';
}

/** True when the body declares the property at all. */
function declares(body: string, property: string): boolean {
  return new RegExp(`(^|[;{\\s])${property}\\s*:`, 'i').test(body);
}

/** Every `var(--x)` token reference in a body. */
function tokenRefs(body: string): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

/** A selector that targets the focus indicator without matching `:focus-visible`. */
function isPlainFocusSelector(selector: string): boolean {
  return /:focus(?!-)/.test(selector);
}

/**
 * Assess a stylesheet. Exported so a negative fixture can prove the gate
 * refuses a broken ring without building a whole project tree.
 */
export function assessFocusVisibility(css: string): FocusAssessment {
  const rules = collectCssRules(css);
  const focusRules = rules.filter((rule) => rule.selector.includes(':focus-visible'));
  const findings: string[] = [];
  const evidence: string[] = [`rules parsed: ${String(rules.length)}`, `focus-visible rules: ${String(focusRules.length)}`];

  if (focusRules.length === 0) {
    findings.push('no `:focus-visible` rule exists, so a keyboard user has no focus indicator');
    return { passed: false, findings, evidence };
  }

  const standalone = focusRules.find((rule) => /(^|,)\s*:focus-visible\s*(,|$)/.test(rule.selector));
  const baseRule = standalone ?? focusRules[0];
  const allFocusBodies = focusRules.map((rule) => rule.body).join('\n');

  if (standalone === undefined) {
    findings.push('no standalone `:focus-visible` rule exists, so the indicator is only ever authored as a special case');
  }
  if (baseRule === undefined) {
    findings.push('no `:focus-visible` rule body could be read');
  } else {
    if (!declares(baseRule.body, 'outline')) {
      findings.push('the base `:focus-visible` rule declares no outline');
    } else if (hidesIndicator(baseRule.body, 'outline')) {
      findings.push('the base `:focus-visible` rule sets the outline to a value that hides the indicator');
    } else if (!/var\(\s*--/.test(baseRule.body)) {
      findings.push('the base `:focus-visible` outline is a literal, not a design token');
    }
    if (!declares(baseRule.body, 'outline-offset')) {
      findings.push('the base `:focus-visible` rule declares no outline-offset, so the ring can sit under the control border');
    }
  }

  if (!/box-shadow\s*:/i.test(allFocusBodies)) {
    findings.push('no `:focus-visible` rule declares a second ring (box-shadow), so the indicator is a single ring on a filled control');
  }

  const fillOverride = focusRules.some(
    (rule) => /gold|primary|accent/i.test(rule.selector) && declares(rule.body, 'outline-color'),
  );
  if (!fillOverride) {
    findings.push('no filled-control `:focus-visible` override sets outline-color, so the ring cannot clear 3:1 on both canvas and fill');
  }

  const forced = rules.filter((rule) => (rule.media ?? '').toLowerCase().includes('forced-colors'));
  if (forced.length === 0) {
    findings.push('no `@media (forced-colors: active)` block exists, so the ring disappears when the OS forces system colours');
  } else if (!forced.some((rule) => rule.selector.includes(':focus-visible') && declares(rule.body, 'outline'))) {
    findings.push('the forced-colors block does not re-author an outline for `:focus-visible`');
  }

  for (const rule of rules) {
    if (!isPlainFocusSelector(rule.selector)) continue;
    if (hidesIndicator(rule.body, 'outline')) {
      findings.push(`\`${rule.selector}\` suppresses the outline with a none/zero value`);
    }
  }

  const defined = new Set<string>();
  for (const match of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) {
    const name = match[1];
    if (name !== undefined) defined.add(name);
  }
  for (const rule of focusRules) {
    for (const name of tokenRefs(rule.body)) {
      if (!defined.has(name)) findings.push(`the focus rules reference ${name}, which the stylesheet never defines`);
    }
  }

  evidence.push(`token references resolved: ${String(focusRules.flatMap((rule) => tokenRefs(rule.body)).length)}`);
  evidence.push(`forced-colors rules: ${String(forced.length)}`);
  for (const rule of focusRules) {
    evidence.push(`rule: ${rule.selector}${rule.media ? ` [${rule.media}]` : ''}`);
  }

  return { passed: findings.length === 0, findings, evidence };
}

export const keyboardFocusGate: Gate = {
  id: GATE_ID,
  title: 'The keyboard focus indicator is authored, dual-ring, and survives forced colors',
  severity: 'blocker',
  async run(ctx: GateContext): Promise<GateResult> {
    const abs = join(ctx.root, TOKEN_STYLESHEET);
    if (!existsSync(abs)) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: `the token stylesheet ${TOKEN_STYLESHEET} was not found, so the focus system cannot be evaluated`,
        evidence: [`${TOKEN_STYLESHEET}: MISSING`],
      };
    }

    const css = readFileSync(abs, 'utf8');
    const assessment = assessFocusVisibility(css);

    if (!assessment.passed) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: `${String(assessment.findings.length)} focus-indicator requirement(s) are not met`,
        evidence: [...assessment.evidence, ...assessment.findings.map((finding) => `FAIL: ${finding}`)],
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: 'the focus indicator is tokenised, dual-ring, overridden on fills, and re-authored for forced colors',
      evidence: assessment.evidence,
    };
  },
};
