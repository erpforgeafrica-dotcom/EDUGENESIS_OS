#!/usr/bin/env node
/**
 * tools/docs-drift.mjs — PG-18 "docs as one source of truth".
 *
 * WHY IT EXISTS: documentation drifts silently. A README that promises a script
 * that no longer exists, an ADR record with no index row, a route table naming a
 * path the router does not serve — each is a false claim a reader cannot detect.
 * This tool treats every such promise as a testable assertion.
 *
 * It refuses on drift and writes artifacts/docs-drift.json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const OUT = join(ROOT, 'artifacts', 'docs-drift.json');
const problems = [];
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  if (!ok) problems.push(`${name}: ${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const scripts = pkg.scripts ?? {};

// ---- 1. ADR records and the index agree -------------------------------
const adrDir = join(ROOT, 'docs', 'adr');
const adrFiles = readdirSync(adrDir).filter((f) => /^ADR-\d{4}-.+\.md$/.test(f)).sort();
const adrIndex = read('docs/adr/README.md');
const missingRows = adrFiles.filter((f) => !adrIndex.includes(f));
check('every ADR record has an index row', missingRows.length === 0, missingRows.join(', ') || `${adrFiles.length} record(s)`);

const indexRows = [...adrIndex.matchAll(/\]\((ADR-\d{4}-[^)]+\.md)\)/g)].map((m) => m[1]);
const orphanRows = indexRows.filter((f) => !existsSync(join(adrDir, f)));
check('every ADR index row points at a real record', orphanRows.length === 0, orphanRows.join(', ') || `${indexRows.length} row(s)`);

// ---- 2. every script the docs promise exists --------------------------
const docFiles = ['README.md', 'docs/RUNBOOK-INCIDENT.md', 'docs/RUNBOOK-BACKUP-RESTORE.md', 'docs/OWNER-PACKETS.md', 'docs/DASHBOARD-SPEC.md'];
const promised = new Set();
for (const file of docFiles) {
  if (!existsSync(join(ROOT, file))) continue;
  for (const m of read(file).matchAll(/npm run ([a-z0-9:_-]+)/g)) promised.add(m[1]);
}
const broken = [...promised].filter((s) => scripts[s] === undefined);
check('every `npm run` a doc promises is a real script', broken.length === 0, broken.join(', ') || `${promised.size} script(s)`);

// ---- 3. every tool a doc promises exists ----------------------------
const promisedTools = new Set();
for (const file of docFiles) {
  if (!existsSync(join(ROOT, file))) continue;
  for (const m of read(file).matchAll(/node (tools\/[A-Za-z0-9._-]+)/g)) promisedTools.add(m[1]);
}
const missingTools = [...promisedTools].filter((t) => !existsSync(join(ROOT, t)));
check('every `node tools/...` a doc promises is a real file', missingTools.length === 0, missingTools.join(', ') || `${promisedTools.size} tool(s)`);

// ---- 4. every API route a doc promises is served --------------------
const serve = read('apps/cli/src/serve.ts');
const documentedRoutes = new Set();
for (const file of docFiles) {
  if (!existsSync(join(ROOT, file))) continue;
  for (const m of read(file).matchAll(/(?:GET|POST|PUT|PATCH|DELETE) (\/api\/[A-Za-z0-9/_{}-]+)/g)) documentedRoutes.add(m[1]);
}
const unserved = [...documentedRoutes].filter((route) => {
  const literal = route.replace(/\{[^}]+\}/g, '');
  return !serve.includes(`'${literal}'`) && !serve.includes(`"${literal}"`);
});
check('every documented API route is served', unserved.length === 0, unserved.join(', ') || `${documentedRoutes.size} route(s)`);

// ---- 5. the officer register covers every ADR owner -----------------
const officers = read('docs/OFFICERS.md');
const owners = new Set([...adrIndex.matchAll(/\|\s*(ADR-\d{4})[^|]*\|[^|]*\|[^|]*\|\s*([^|]+?)\s*\|/g)].map((m) => m[2]));
const missingOfficers = [...owners].filter((owner) => owner !== '' && !officers.includes(owner));
check('every ADR owner has an officer-register row', missingOfficers.length === 0, missingOfficers.join(', ') || `${owners.size} owner(s)`);

// ---- 6. the backlog documents agree with the ledger -----------------
const ledger = JSON.parse(read('docs/production-ledger.json'));
const plan = JSON.parse(read('docs/production-plan.json'));
const ledgerIds = ledger.records.map((r) => r.id).sort();
const planIds = [...plan.ids].sort();
check('the plan and the ledger name the same backlog', JSON.stringify(ledgerIds) === JSON.stringify(planIds),
  `${ledgerIds.length} vs ${planIds.length}`);
check('the owner packets cover every placeholder or owner item',
  (() => {
    const packets = read('docs/OWNER-PACKETS.md');
    const flagged = ledger.records.filter((r) => r.status === 'placeholder' || r.status === 'owner-gated');
    return flagged.every((r) => packets.includes(r.id) || packets.includes(r.title.slice(0, 18)));
  })(),
  'every non-closed record is named in docs/OWNER-PACKETS.md');

// ---- 7. no document claims a green CI run that does not exist ------
const claimsGreen = [...read('README.md').matchAll(/.{0,60}(?:CI|pipeline).{0,60}(?:green|passing).{0,40}/gi)]
  .map((m) => m[0].trim());
check('README makes no unqualified green-CI claim', claimsGreen.every((line) => /owner|blocked|local|no hosted|disabled/i.test(line)),
  claimsGreen.length === 0 ? 'no such claim' : claimsGreen[0].slice(0, 100));

const report = {
  tool: 'tools/docs-drift.mjs',
  schemaVersion: 1,
  result: problems.length === 0 ? 'PASS' : 'FAIL',
  counts: {
    adrRecords: adrFiles.length,
    adrRows: indexRows.length,
    promisedScripts: promised.size,
    promisedTools: promisedTools.size,
    documentedRoutes: documentedRoutes.size,
    adrOwners: owners.size,
  },
  checks,
  failed: problems,
};
mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\nRESULT: ${report.result} — ${checks.filter((c) => c.ok).length}/${checks.length} documentation assertions.`);
process.exitCode = problems.length === 0 ? 0 : 1;
