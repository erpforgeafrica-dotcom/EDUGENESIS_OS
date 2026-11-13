/**
 * Gate: every form control carries an accessible name, and every hint that is
 * authored next to a control is actually announced with it.
 *
 * WHY this gate exists (it closes the gate half of F2-02 / batch item E2):
 *   The settings page had hints rendered directly under each control, but the
 *   controls did not reference them, so a screen reader read "Port, edit text"
 *   and never read "A port change takes effect the next time the server
 *   starts". The markup was fixed; nothing stopped it regressing. This gate
 *   makes the convention machine-checkable:
 *
 *     hint id  `hint-<control id>`  ->  the control must name it in
 *     `aria-describedby`.
 *
 * WHAT THIS GATE PROVES (from the served HTML, no browser, no screen reader):
 *   1. Every element id in the document is unique.
 *   2. Every `aria-describedby` / `aria-labelledby` token resolves to an id.
 *   3. Every input, select and textarea has an accessible name: `aria-label`,
 *      a resolvable `aria-labelledby`, or a `<label for>` that points at it.
 *   4. Every control that owns a `hint-<id>` node references that node.
 *   5. Every hint node is referenced by at least one element, so a hint can
 *      never be orphaned decoration.
 *   6. The page exposes a live region for status and error feedback.
 *
 * The runtime claim (a screen reader reads the hint) stays UNVERIFIED by this
 * gate; the audit records that separately.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Gate, GateContext, GateResult } from '../types.js';

const GATE_ID = 'form-semantics';

/** The settings page that ships with the local server. */
export const SETTINGS_PAGE = 'apps/cli/public/index.html';

export interface FormSemanticsAssessment {
  readonly passed: boolean;
  readonly findings: string[];
  readonly evidence: string[];
}

/** Read `name="value"` pairs out of a start tag. */
export function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? '';
    if (name !== undefined) attributes.set(name.toLowerCase(), value);
  }
  return attributes;
}

/** Every control start tag in a fragment. */
function controlTags(fragment: string): Array<{ tag: string; attributes: Map<string, string> }> {
  const out: Array<{ tag: string; attributes: Map<string, string> }> = [];
  for (const match of fragment.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    out.push({ tag: match[0], attributes: parseAttributes(match[0]) });
  }
  return out;
}

/**
 * Split the document into `.field` / `.switch` containers.
 *
 * WHY a hand-written scan: the settings page is a fixed, small document and
 * the verification package deliberately ships no HTML parser dependency. The
 * scan counts nested `<div>` tags, which is sufficient for the markup this
 * gate governs; the container count is printed as evidence so a structural
 * change is visible rather than silently unparsed.
 */
function containerSlices(html: string): string[] {
  const slices: string[] = [];
  const openPattern = /<div\b[^>]*class\s*=\s*"[^"]*\b(field|switch)\b[^"]*"[^>]*>/gi;
  for (const match of html.matchAll(openPattern)) {
    const start = match.index ?? 0;
    let depth = 0;
    let index = start;
    while (index < html.length) {
      const nextOpen = html.indexOf('<div', index);
      const nextClose = html.indexOf('</div>', index);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        index = nextOpen + 4;
      } else {
        depth -= 1;
        index = nextClose + 6;
        if (depth === 0) {
          slices.push(html.slice(start, index));
          break;
        }
      }
    }
  }
  return slices;
}

/** Ids of every hint node in a fragment. */
function hintIds(fragment: string): string[] {
  const ids: string[] = [];
  for (const match of fragment.matchAll(/<p\b[^>]*class\s*=\s*"[^"]*\bhint\b[^"]*"[^>]*>/gi)) {
    const id = parseAttributes(match[0]).get('id');
    if (id !== undefined && id.length > 0) ids.push(id);
  }
  return ids;
}

/** Token list from a space-separated idref attribute. */
function idrefTokens(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(/\s+/).map((token) => token.trim()).filter((token) => token.length > 0);
}

/**
 * Assess a page. Exported so a negative fixture can prove the gate refuses
 * broken markup without building a whole project tree.
 */
export function assessFormSemantics(html: string): FormSemanticsAssessment {
  const findings: string[] = [];
  const evidence: string[] = [];

  /* 1. Unique ids. */
  const idCounts = new Map<string, number>();
  for (const match of html.matchAll(/\bid\s*=\s*"([^"]*)"/g)) {
    const id = match[1] ?? '';
    if (id.length === 0) continue;
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) findings.push(`the id "${id}" appears ${String(count)} times, so a reference to it is ambiguous`);
  }

  /* 2. Every idref resolves. */
  const references = new Map<string, string[]>();
  for (const match of html.matchAll(/aria-(describedby|labelledby)\s*=\s*"([^"]*)"/gi)) {
    const attribute = `aria-${match[1] ?? ''}`.toLowerCase();
    for (const token of idrefTokens(match[2])) {
      const owners = references.get(token) ?? [];
      owners.push(attribute);
      references.set(token, owners);
      if (!idCounts.has(token)) {
        findings.push(`${attribute} references "${token}", which no element defines`);
      }
    }
  }

  /* 3. Accessible names. */
  const labelTargets = new Set<string>();
  for (const match of html.matchAll(/<label\b[^>]*\bfor\s*=\s*"([^"]*)"/gi)) {
    const target = match[1];
    if (target !== undefined && target.length > 0) labelTargets.add(target);
  }
  const controls = controlTags(html);
  for (const control of controls) {
    const type = (control.attributes.get('type') ?? '').toLowerCase();
    if (type === 'hidden') continue;
    const id = control.attributes.get('id') ?? '';
    const hasAriaLabel = (control.attributes.get('aria-label') ?? '').trim().length > 0;
    const labelledBy = idrefTokens(control.attributes.get('aria-labelledby')).some((token) => idCounts.has(token));
    const hasLabel = id.length > 0 && labelTargets.has(id);
    if (!hasAriaLabel && !labelledBy && !hasLabel) {
      findings.push(`the ${control.attributes.get('type') ?? 'text'} control${id ? ` "#${id}"` : ' without an id'} has no accessible name`);
    }
  }

  /* 4/5. Hint wiring, per container and globally. */
  const slices = containerSlices(html);
  let wiredHints = 0;
  for (const slice of slices) {
    const hints = hintIds(slice);
    if (hints.length === 0) continue;
    const sliceControls = controlTags(slice);
    for (const control of sliceControls) {
      const id = control.attributes.get('id') ?? '';
      if (id.length === 0) continue;
      const ownHint = `hint-${id}`;
      if (!hints.includes(ownHint)) continue;
      const describedBy = idrefTokens(control.attributes.get('aria-describedby'));
      if (!describedBy.includes(ownHint)) {
        findings.push(`"#${id}" has a hint (${ownHint}) but does not reference it with aria-describedby`);
      } else {
        wiredHints += 1;
      }
    }
    for (const hint of hints) {
      const referenced = hints.length > 0 && references.has(hint);
      if (!referenced) findings.push(`the hint "${hint}" is rendered but no element references it, so it is announced to nobody`);
    }
  }

  const allHints = hintIds(html);
  for (const hint of allHints) {
    if (!references.has(hint)) findings.push(`the hint "${hint}" is referenced by nothing`);
  }

  /* 6. Status and error feedback must be announced. */
  const liveRegion = /<(p|div|span|section)\b[^>]*\brole\s*=\s*"(status|alert)"[^>]*>/i.test(html);
  if (!liveRegion) findings.push('no element with role="status" or role="alert" exists, so save and error feedback is silent');

  evidence.push(`controls: ${String(controls.length)}`);
  evidence.push(`labels bound by for=: ${String(labelTargets.size)}`);
  evidence.push(`field/switch containers: ${String(slices.length)}`);
  evidence.push(`hint nodes: ${String(allHints.length)} (wired by an owning control: ${String(wiredHints)})`);
  evidence.push(`idref attributes resolved: ${String(references.size)} distinct target(s)`);

  return { passed: findings.length === 0, findings, evidence };
}

export const formSemanticsGate: Gate = {
  id: GATE_ID,
  title: 'Every settings control is named, and every hint is announced with its control',
  severity: 'blocker',
  async run(ctx: GateContext): Promise<GateResult> {
    const abs = join(ctx.root, SETTINGS_PAGE);
    if (!existsSync(abs)) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: `the settings page ${SETTINGS_PAGE} was not found, so form semantics cannot be evaluated`,
        evidence: [`${SETTINGS_PAGE}: MISSING`],
      };
    }

    const html = readFileSync(abs, 'utf8');
    const assessment = assessFormSemantics(html);

    if (!assessment.passed) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: `${String(assessment.findings.length)} form-semantics requirement(s) are not met`,
        evidence: [...assessment.evidence, ...assessment.findings.map((finding) => `FAIL: ${finding}`)],
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: 'every control is named, every hint is referenced, and status feedback is announced',
      evidence: assessment.evidence,
    };
  },
};
