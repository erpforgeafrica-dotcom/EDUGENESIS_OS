/**
 * Gate: the ADR index and the ADR records agree, and every ADR has a named,
 * registered owner.
 *
 * WHY this gate exists (it caught two real defects):
 *   - The index's Owner column contradicted the Owner line inside the ADR
 *     records themselves for four of the local ADRs (ADR-0013 to ADR-0016 all
 *     name "Chief Systems Architect"; the index named three different roles).
 *   - The index's Status column said "Accepted" for an ADR whose record said
 *     it was superseded.
 *   - The accountable role "Chief Systems Architect" had no row at all in the
 *     appointment register, so no person could ever be appointed to it and the
 *     P0-6 criterion could never close.
 *
 *   The Phase 0 criterion P0-2 — "Every ADR in §11 shows a named Owner and a
 *   recorded Status; none reads unassigned" — was proved by a string-contains
 *   check on this index, which cannot detect a MISSING owner. This gate parses
 *   the index instead, and cross-checks it against the records.
 *
 * WHAT THIS GATE PROVES:
 *   1. Every index row has an ADR id, a non-empty title, a recognised status
 *      and a non-empty owner that is not a placeholder.
 *   2. Every owner's role is a role that exists in the appointment register.
 *   3. For every ADR record in this directory, the index's status and owner
 *      match the record's own status and owner lines, and the id in the
 *      filename matches the id in the index.
 *   4. No ADR id appears twice in the index.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Gate, GateContext, GateResult } from '../types.js';

const GATE_ID = 'adr-governance';

export const ADR_INDEX = 'docs/adr/README.md';
export const OFFICERS_REGISTER = 'docs/OFFICERS.md';
export const ADR_DIRECTORY = 'docs/adr';

/** The statuses an ADR may carry. A superseded record also names its successor. */
const STATUSES = ['Accepted', 'Proposed', 'Superseded'];

interface IndexRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly owner: string;
}

/** Split a markdown table row into its cells. */
function cells(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** Parse the ADR index table. */
export function parseAdrIndex(markdown: string): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const line of markdown.split('\n')) {
    if (!/^\s*\|\s*\[?ADR-\d{4}\]?/.test(line)) continue;
    const parts = cells(line);
    if (parts.length < 4) continue;
    // The first cell is either `ADR-0013` or a markdown link to the record:
    // `[ADR-0013](ADR-0013-....md)`. The id is the token either way.
    const raw = parts[0] ?? '';
    const id = (/\b(ADR-\d{4})\b/.exec(raw)?.[1] ?? raw).trim();
    rows.push({ id, title: parts[1] ?? '', status: parts[2] ?? '', owner: parts[3] ?? '' });
  }
  return rows;
}

/** Every role named in the appointment register's first column. */
export function parseOfficerRoles(markdown: string): Set<string> {
  const roles = new Set<string>();
  for (const line of markdown.split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const parts = cells(line);
    const role = parts[0] ?? '';
    if (role.length === 0 || role === 'Role' || /^-+$/.test(role)) continue;
    roles.add(role);
  }
  return roles;
}

/** The `- **Owner:** …` line of an ADR record. */
function ownerOf(record: string): string {
  return /^- \*\*Owner:\*\*\s*(.+)$/m.exec(record)?.[1]?.trim() ?? '';
}

/** The `- **Status:** …` line of an ADR record. */
function statusOf(record: string): string {
  return /^- \*\*Status:\*\*\s*(.+)$/m.exec(record)?.[1]?.trim() ?? '';
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

export const adrGovernanceGate: Gate = {
  id: GATE_ID,
  title: 'The ADR index and the ADR records agree, and every ADR has a named, registered owner',
  severity: 'blocker',
  async run(ctx: GateContext): Promise<GateResult> {
    const indexMarkdown = readIfPresent(ctx.root, ADR_INDEX);
    const officersMarkdown = readIfPresent(ctx.root, OFFICERS_REGISTER);
    if (indexMarkdown === null || officersMarkdown === null) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the ADR index or the appointment register is missing, so ADR governance cannot be checked',
        evidence: [
          `${ADR_INDEX}: ${indexMarkdown === null ? 'MISSING' : 'present'}`,
          `${OFFICERS_REGISTER}: ${officersMarkdown === null ? 'MISSING' : 'present'}`,
        ],
      };
    }

    const rows = parseAdrIndex(indexMarkdown);
    const roles = parseOfficerRoles(officersMarkdown);
    const failures: string[] = [];
    const evidence: string[] = [`index rows parsed: ${rows.length}`, `registered roles: ${roles.size}`];

    if (rows.length === 0) {
      failures.push('the ADR index contains no parsable rows');
    }

    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) failures.push(`${row.id} appears more than once in the index`);
      seen.add(row.id);

      if (row.title.length === 0) failures.push(`${row.id} has no title in the index`);
      if (!STATUSES.some((s) => row.status === s || row.status.startsWith(`${s} by `))) {
        failures.push(`${row.id} has an unrecognised status "${row.status}"`);
      }
      if (row.owner.length === 0) {
        failures.push(`${row.id} has no owner in the index`);
        continue;
      }
      if (/^(unassigned|tbd|none|-|vacant|unknown)$/i.test(row.owner)) {
        failures.push(`${row.id} has a placeholder owner ("${row.owner}")`);
        continue;
      }
      const primaryRole = (row.owner.split(',')[0] ?? '').trim();
      if (!roles.has(primaryRole)) {
        failures.push(`${row.id} is owned by "${primaryRole}", which is not a role in the appointment register`);
      }
    }

    // Cross-check the index against every ADR record in this directory.
    const dir = join(ctx.root, ADR_DIRECTORY);
    let records: string[] = [];
    try {
      records = readdirSync(dir).filter((name) => /^ADR-\d{4}.*\.md$/.test(name));
    } catch {
      failures.push('the ADR directory could not be read');
    }
    evidence.push(`ADR records found: ${records.length}`);

    for (const name of records) {
      const fileId = /^ADR-\d{4}/.exec(name)?.[0] ?? '';
      const record = readIfPresent(ctx.root, `${ADR_DIRECTORY}/${name}`);
      if (record === null) continue;
      const row = rows.find((r) => r.id === fileId);
      if (!row) {
        failures.push(`${fileId} has a record in this directory but no row in the index`);
        continue;
      }
      const recordStatus = statusOf(record);
      const recordOwner = ownerOf(record);
      if (recordStatus.length === 0) {
        failures.push(`${fileId} has no status line in its record`);
      } else if (recordStatus !== row.status) {
        failures.push(`${fileId}: the index says status "${row.status}" but the record says "${recordStatus}"`);
      }
      if (recordOwner.length === 0) {
        failures.push(`${fileId} has no owner line in its record`);
      } else if (recordOwner !== row.owner) {
        failures.push(`${fileId}: the index names owner "${row.owner}" but the record names "${recordOwner}"`);
      }
    }

    if (failures.length > 0) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: `${String(failures.length)} ADR governance defect(s)`,
        evidence: [...evidence, ...failures.map((f) => `FAIL: ${f}`)],
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: `${String(rows.length)} ADR index rows agree with their records, and every owner is a registered role`,
      evidence,
    };
  },
};
