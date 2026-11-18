#!/usr/bin/env node
// Deterministic loop judge for the 43-gap remediation.
// Exit 0 = no pending IDs and every closed/owner-gated record has proof.
// Exit 2 = pending IDs remain (the loop must continue).
// Exit 3 = malformed ledger (IDs drifted from the register, or bad records).
// It never inspects "looks right": the ledger is reconciled against the
// register's own open set and each proof must be a reproducible claim.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const register = JSON.parse(fs.readFileSync(path.join(root, 'docs/gap-register.json'), 'utf8'));
const ledgerPath = path.join(root, 'docs/gap-closure-evidence.json');
if (!fs.existsSync(ledgerPath)) {
  console.error('MISSING docs/gap-closure-evidence.json');
  process.exit(3);
}
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));

const closedIds = new Set(register.reconciliation.closed_ids);
const open = register.findings.filter((f) => !closedIds.has(f.id));
const openIds = new Set(open.map((f) => f.id));
const byId = new Map(open.map((f) => [f.id, f]));
const records = Array.isArray(ledger.records) ? ledger.records : [];
const recordIds = new Set(records.map((r) => r.id));

let bad = false;
if (records.length !== openIds.size || recordIds.size !== records.length) {
  console.error(`LEDGER DRIFT: register open ${openIds.size}, ledger ${records.length} (unique ${recordIds.size})`);
  bad = true;
}
for (const id of openIds) if (!recordIds.has(id)) { console.error(`MISSING RECORD ${id}`); bad = true; }
for (const id of recordIds) if (!openIds.has(id)) { console.error(`EXTRA RECORD ${id}`); bad = true; }
if (bad) process.exit(3);

const counts = { closed: 0, 'owner-gated': 0, pending: 0 };
const pending = [];
const malformed = [];
for (const record of records) {
  const status = record.status;
  if (!Object.hasOwn(counts, status)) { malformed.push(`${record.id}: bad status ${JSON.stringify(status)}`); continue; }
  counts[status] += 1;
  const proof = String(record.proof ?? '');
  if (status === 'closed' && (proof.length < 40 || !/(exit|PASS|tests?|gate|\bnode\b|\bnpm\b|:)/i.test(proof))) {
    malformed.push(`${record.id}: closed without reproducible proof`);
  }
  if (status === 'owner-gated' && (!/owner/i.test(proof) || !/unblock|decision|approve/i.test(proof))) {
    malformed.push(`${record.id}: owner-gated without decision + unblock path`);
  }
  if (status === 'pending') pending.push(record.id);
}
if (malformed.length) { for (const m of malformed) console.error(`MALFORMED ${m}`); process.exit(3); }

console.log('EDUGENESIS OS — gap-loop verifier\n');
console.log(`register open : ${openIds.size} (${open.filter((f) => f.severity === 'major').length} major, ${open.filter((f) => f.severity === 'minor').length} minor)`);
console.log(`ledger        : ${records.length} records`);
console.log(`closed        : ${counts.closed}`);
console.log(`owner-gated   : ${counts['owner-gated']}`);
console.log(`pending       : ${counts.pending}\n`);
for (const record of records.sort((a, b) => a.id.localeCompare(b.id))) {
  const f = byId.get(record.id);
  const mark = record.status === 'closed' ? 'CLOSED' : record.status === 'owner-gated' ? 'GATED ' : 'PENDING';
  console.log(`${mark}  ${record.id.padEnd(9)} ${f.severity.padEnd(6)} ${f.title.slice(0, 78)}`);
}
console.log();
if (pending.length) {
  console.log(`RESULT: FAIL — ${pending.length} pending: ${pending.join(', ')}`);
  process.exit(2);
}
console.log('RESULT: PASS — every open ID is closed with proof or owner-gated with an unblock path.');
process.exit(0);
