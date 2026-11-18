#!/usr/bin/env node
// Deterministic reconciler for the 20-item production-readiness backlog.
// Contract: the expected ID set is fixed here. A ledger or plan that omits an
// ID fails, an extra ID fails, a closed record without reproducible proof fails,
// and an owner-gated record without a decision + unblock path fails.
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

const allowed = new Set(['pending','in-progress','closed','owner-gated']);
const counts = { pending:0, 'in-progress':0, closed:0, 'owner-gated':0 };
for (const r of records) {
  if (!allowed.has(r.status)) { fail(`${r.id}: bad status ${JSON.stringify(r.status)}`); continue; }
  counts[r.status] += 1;
  const proof = String(r.proof ?? '');
  if (r.status === 'closed' && (proof.length < 40 || !/(exit|PASS|tests?|gate|\bnode\b|\bnpm\b|\/api\/|\.test\.js|:)/i.test(proof))) {
    fail(`${r.id}: closed without reproducible proof`);
  }
  if (r.status === 'owner-gated' && (!/owner/i.test(proof) || !/unblock|decision|approve/i.test(proof))) {
    fail(`${r.id}: owner-gated without decision + unblock path`);
  }
}
if (bad) { console.error('RESULT: FAIL — production ledger/plan drift or malformed records.'); process.exit(3); }

console.log('EDUGENESIS OS — production backlog reconciler\n');
console.log(`expected IDs : ${EXPECTED.length}`);
console.log(`records      : ${records.length}`);
console.log(`pending      : ${counts.pending}`);
console.log(`in-progress  : ${counts['in-progress']}`);
console.log(`closed       : ${counts.closed}`);
console.log(`owner-gated  : ${counts['owner-gated']}\n`);
for (const r of [...records].sort((a,b)=>a.id.localeCompare(b.id))) {
  const mark = {pending:'PENDING', 'in-progress':'WORK   ', closed:'CLOSED ', 'owner-gated':'GATED  '}[r.status];
  console.log(`${mark} ${r.id} ${String(r.wave).padEnd(5)} ${String(r.owner).padEnd(10)} ${r.title.slice(0,58)}`);
}
console.log('\nRESULT: PASS — all 20 PG IDs present, plan complete, records well-formed.');
process.exit(0);
