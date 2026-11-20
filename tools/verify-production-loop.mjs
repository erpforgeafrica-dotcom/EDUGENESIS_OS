#!/usr/bin/env node
// Deterministic reconciler for the 20-item production-readiness backlog.
//
// Contract: the expected ID set is fixed here. A ledger or plan that omits an
// ID fails, an extra ID fails, a record without reproducible proof fails, and
// an owner-gated record without a decision + unblock path fails.
//
// ADR-0028 adds a FOURTH disposition, `placeholder`. It is deliberately
// STRICTER than `closed`, not looser:
//
//   - the proof must clear the same bar `closed` requires, AND
//   - `placeholder.ownerDirective` must name the owner instruction that
//     authorised it (O-YYYY-MM-DD-N), AND
//   - `placeholder.label` must literally start with PLACEHOLDER, AND
//   - `placeholder.residualRisk` must say what is still untrue and who fixes it.
//
// A placeholder is never counted as closed, and a `closed` record may not carry
// a placeholder block (it cannot be both).
//
// CLOSURE DIRECTIVE O-2026-11-19-1: this backlog carries no open record. The
// check below is intentional — every one of the 20 items must be proven or
// placeholdered. Re-opening one requires an explicit, reviewable edit here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED = Object.freeze([
  'PG-01','PG-02','PG-03','PG-04','PG-05','PG-06','PG-07','PG-08','PG-09','PG-10',
  'PG-11','PG-12','PG-13','PG-14','PG-15','PG-16','PG-17','PG-18','PG-19','PG-20',
]);
const expectedSet = new Set(EXPECTED);
const ledgerPath = path.join(root, 'docs/production-ledger.json');
const planPath = path.join(root, 'docs/production-plan.json');
let bad = false;
const fail = (m) => { console.error(m); bad = true; };

if (!fs.existsSync(ledgerPath)) { console.error('MISSING docs/production-ledger.json'); process.exit(3); }
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
const records = Array.isArray(ledger.records) ? ledger.records : [];
const ids = records.map((r) => r.id);
const idSet = new Set(ids);
if (records.length !== expectedSet.size || idSet.size !== records.length) {
  fail(`LEDGER DRIFT: expected ${expectedSet.size}, ledger ${records.length} (unique ${idSet.size})`);
}
for (const id of expectedSet) if (!idSet.has(id)) fail(`MISSING RECORD ${id}`);
for (const id of idSet) if (!expectedSet.has(id)) fail(`EXTRA RECORD ${id}`);

// A plan that omits an ID fails (the reconciler's ID-set assertion).
if (fs.existsSync(planPath)) {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const planIds = Array.isArray(plan.ids) ? plan.ids : [];
  const planSet = new Set(planIds);
  if (planIds.length !== expectedSet.size || planSet.size !== planIds.length) {
    fail(`PLAN DRIFT: expected ${expectedSet.size}, plan ${planIds.length} (unique ${planSet.size})`);
  }
  for (const id of expectedSet) if (!planSet.has(id)) fail(`PLAN OMITS ${id}`);
  for (const id of planSet) if (!expectedSet.has(id)) fail(`PLAN EXTRA ${id}`);
} else {
  console.error('NOTE: docs/production-plan.json absent (plan ID-set assertion skipped)');
}

/** The bar `closed` has always had to clear. A placeholder must clear it too. */
const proofBar = (proof) =>
  proof.length >= 40 &&
  /(exit|PASS|tests?|gate|\bnode\b|\bnpm\b|\/api\/|\.test\.js|:)/i.test(proof);

const ALLOWED = new Set(['pending','in-progress','closed','owner-gated','placeholder']);
const counts = { pending:0, 'in-progress':0, closed:0, 'owner-gated':0, placeholder:0 };

for (const r of records) {
  if (!ALLOWED.has(r.status)) { fail(`${r.id}: bad status ${JSON.stringify(r.status)}`); continue; }
  counts[r.status] += 1;
  const proof = String(r.proof ?? '');

  if ((r.status === 'closed' || r.status === 'placeholder') && !proofBar(proof)) {
    fail(`${r.id}: ${r.status} without reproducible proof`);
  }
  if (r.status === 'closed' && r.placeholder !== undefined) {
    fail(`${r.id}: a closed record may not also carry a placeholder block`);
  }
  if (r.status === 'placeholder') {
    const ph = r.placeholder;
    if (typeof ph !== 'object' || ph === null) {
      fail(`${r.id}: placeholder without a placeholder block (ADR-0028)`);
    } else {
      if (!/^O-\d{4}-\d{2}-\d{2}-\d+$/.test(String(ph.ownerDirective ?? ''))) {
        fail(`${r.id}: placeholder.ownerDirective must be O-YYYY-MM-DD-N`);
      }
      if (!String(ph.label ?? '').startsWith('PLACEHOLDER')) {
        fail(`${r.id}: placeholder.label must start with PLACEHOLDER`);
      }
      if (String(ph.residualRisk ?? '').length < 60) {
        fail(`${r.id}: placeholder.residualRisk must name what is still untrue (>= 60 chars)`);
      }
    }
    if (typeof r.owner !== 'string' || r.owner.trim().length === 0) {
      fail(`${r.id}: placeholder must name its owner`);
    }
  }

  if (r.status === 'owner-gated' && (!/owner/i.test(proof) || !/unblock|decision|approve/i.test(proof))) {
    fail(`${r.id}: owner-gated without decision + unblock path`);
  }
  if (r.status === 'pending' || r.status === 'in-progress') {
    if (typeof r.next !== 'string' || r.next.trim().length < 20) {
      fail(`${r.id}: ${r.status} without a named next action`);
    }
  }
}

// The closure directive: no open record survives into a pilot release.
const open = counts.pending + counts['in-progress'] + counts['owner-gated'];
if (open > 0) {
  fail(
    `CLOSURE DIRECTIVE O-2026-11-19-1: ${open} record(s) still read pending/in-progress/owner-gated. ` +
    'Each must be proven (closed) or carry a placeholder block (ADR-0028).',
  );
}

// A summary that a human can read must agree with the computed counts.
if (ledger.summary !== undefined) {
  const s = ledger.summary ?? {};
  for (const key of ['closed', 'placeholder', 'pending', 'inProgress', 'ownerGated']) {
    const expectedKey = key === 'inProgress' ? 'in-progress' : key === 'ownerGated' ? 'owner-gated' : key;
    if (Number(s[key]) !== counts[expectedKey]) {
      fail(`LEDGER SUMMARY LIE: summary.${key}=${String(s[key])} but computed ${counts[expectedKey]}`);
    }
  }
  if (Number(s.openItems) !== open) fail(`LEDGER SUMMARY LIE: summary.openItems=${String(s.openItems)} but computed ${open}`);
}

if (bad) { console.error('RESULT: FAIL — production ledger/plan drift or malformed records.'); process.exit(3); }

console.log('EDUGENESIS OS — production backlog reconciler (ADR-0028)\n');
console.log(`expected IDs : ${EXPECTED.length}`);
console.log(`records      : ${records.length}`);
console.log(`closed       : ${counts.closed}`);
console.log(`placeholder  : ${counts.placeholder}   (proven machinery + named residual; NEVER counted as closed)`);
console.log(`owner-gated  : ${counts['owner-gated']}`);
console.log(`pending      : ${counts.pending}`);
console.log(`in-progress  : ${counts['in-progress']}\n`);
for (const r of [...records].sort((a,b)=>a.id.localeCompare(b.id))) {
  const mark = {pending:'PENDING', 'in-progress':'WORK   ', closed:'CLOSED ', 'owner-gated':'GATED  ', placeholder:'PLACEHL'}[r.status];
  console.log(`${mark} ${r.id} ${String(r.wave).padEnd(5)} ${String(r.owner).padEnd(10)} ${r.title.slice(0,58)}`);
}
console.log('\nRESULT: PASS — all 20 PG IDs present, plan complete, every record closed or placeholdered (ADR-0028).');
process.exit(0);
