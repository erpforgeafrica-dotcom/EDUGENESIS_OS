#!/usr/bin/env node
/**
 * Live end-to-end probe against the deployed EduGenesis OS instance.
 *
 * Proves the value chain the owner directive names:
 *   login -> sponsor registration -> funding -> public ledger -> sponsor report
 *   -> role separation -> learner lesson -> operator dashboard
 *
 * Credentials come from the environment (EG_LIVE_OPERATOR_ID / _PASSWORD,
 * EG_LIVE_SPONSOR_ID / _PASSWORD). They are never printed: every assertion
 * prints a status, a count or a boolean, never a secret.
 *
 * Usage: node tools/live-e2e.mjs https://edugenesis-web-yju6.onrender.com
 *
 * It writes artifacts/live-e2e.json (override with EG_LIVE_ARTIFACT), which is
 * the evidence the placeholder closure register cites.
 */
const BASE = (process.argv[2] ?? 'https://edugenesis-web-yju6.onrender.com').replace(/\/$/, '');
const OP_ID = process.env.EG_LIVE_OPERATOR_ID ?? '';
const OP_PW = process.env.EG_LIVE_OPERATOR_PASSWORD ?? '';
const SP_ID = process.env.EG_LIVE_SPONSOR_ID ?? '';
const SP_PW = process.env.EG_LIVE_SPONSOR_PASSWORD ?? '';
const SPONSOR_REF = process.env.EG_LIVE_SPONSOR_REF ?? 'KEEP-Rotation-Engine';
const AMOUNT_CENTS = Number(process.env.EG_LIVE_AMOUNT_CENTS ?? 100000);
const IDEMPOTENCY_KEY = process.env.EG_LIVE_IDEMPOTENCY_KEY ?? `keep-round-${Array.from({ length: 12 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('')}`;

const problems = [];
const rows = [];
const record = (name, ok, detail) => {
  rows.push({ name, ok, detail });
  if (!ok) problems.push(`${name}: ${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};

if (OP_ID === '' || OP_PW === '' || SP_ID === '' || SP_PW === '') {
  console.error('missing EG_LIVE_* credentials in the environment');
  process.exit(2);
}

/** Turn a Set-Cookie array into a Cookie header and pull the CSRF value. */
function absorb(response, jar) {
  const raw = response.headers.getSetCookie?.() ?? [];
  let csrf = jar.csrf ?? '';
  for (const line of raw) {
    const pair = line.split(';')[0];
    const at = pair.indexOf('=');
    if (at < 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (name === 'eg_csrf') csrf = value;
    if (name === 'eg_session' && value !== '') jar.session = value;
  }
  jar.csrf = csrf;
  return jar;
}
function cookieHeader(jar) {
  const parts = [];
  if (jar.session) parts.push(`eg_session=${jar.session}`);
  if (jar.csrf) parts.push(`eg_csrf=${jar.csrf}`);
  return parts.join('; ');
}
async function call(jar, path, init = {}) {
  const headers = { accept: 'application/json', ...(init.headers ?? {}) };
  if (jar && cookieHeader(jar)) headers.cookie = cookieHeader(jar);
  const res = await fetch(BASE + path, { ...init, headers, redirect: 'manual' });
  if (jar) absorb(res, jar);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: res.status, data, text, headers: res.headers };
}
async function login(id, password) {
  const jar = { session: '', csrf: '' };
  const res = await call(jar, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, password }),
  });
  return { res, jar };
}

// ---- 0. health -----------------------------------------------------------
const health = await call(null, '/api/health');
record('the deployed instance answers /api/health', health.status === 200 && health.data?.ok === true, `HTTP ${health.status}`);

// ---- 1. operator login ---------------------------------------------------
const op = await login(OP_ID, OP_PW);
record('the pilot operator can log in', op.res.status === 200 && op.res.data?.ok === true, `HTTP ${op.res.status}`);
if (op.res.status !== 200) {
  console.error('\nCannot continue without an operator session.');
  console.log(`\nRESULT: FAIL — ${problems.length} problem(s).`);
  process.exit(1);
}
record('login issues a session cookie and a CSRF token', op.jar.session !== '' && op.jar.csrf !== '', 'both cookies present');

const me = await call(op.jar, '/api/auth/me');
record('the session identifies the operator', me.status === 200 && me.data?.principal?.id === OP_ID, `HTTP ${me.status}, id matches: ${me.data?.principal?.id === OP_ID}`);

// ---- 2. role separation: anon is refused --------------------------------
const anonSettings = await call(null, '/api/settings');
record('anonymous GET /api/settings is refused', anonSettings.status === 403, `HTTP ${anonSettings.status}`);
const anonOperator = await call(null, '/api/dashboard/operator');
record('anonymous GET /api/dashboard/operator is refused', anonOperator.status === 403, `HTTP ${anonOperator.status}`);

// ---- 3. register the first sponsor --------------------------------------
const register = await call(op.jar, '/api/sponsor/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-csrf-token': op.jar.csrf },
  body: JSON.stringify({ ref: SPONSOR_REF }),
});
record('the first sponsor registers with a pseudonymous reference', register.status === 200 && typeof register.data?.sponsorId === 'string', `HTTP ${register.status}, sponsorId present: ${typeof register.data?.sponsorId === 'string'}`);
const sponsorId = register.data?.sponsorId ?? '';

// ---- 4. fund the round --------------------------------------------------
const funding = await call(op.jar, '/api/sponsor/funding', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-csrf-token': op.jar.csrf },
  body: JSON.stringify({ sponsorId, amountCents: AMOUNT_CENTS, idempotencyKey: IDEMPOTENCY_KEY }),
});
record('the funding round commits and grants credits', funding.status === 200 && funding.data?.ok === true && Number(funding.data?.creditsGranted) > 0, `HTTP ${funding.status}, credits granted: ${String(funding.data?.creditsGranted)}`);

// ---- 5. idempotency ------------------------------------------------------
const repeat = await call(op.jar, '/api/sponsor/funding', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-csrf-token': op.jar.csrf },
  body: JSON.stringify({ sponsorId, amountCents: AMOUNT_CENTS, idempotencyKey: IDEMPOTENCY_KEY }),
});
record('replaying the same funding key is a no-op, not a double credit', repeat.status === 200 && repeat.data?.duplicate === true && Number(repeat.data?.creditsGranted) === 0, `duplicate=${String(repeat.data?.duplicate)}, credits=${String(repeat.data?.creditsGranted)}`);

// ---- 6. public ledger ---------------------------------------------------
const ledger = await call(null, '/api/ledger');
const entries = Array.isArray(ledger.data?.entries) ? ledger.data.entries.length : -1;
record('the public ledger is readable without a session', ledger.status === 200 && ledger.data?.ok === true, `HTTP ${ledger.status}`);
record('the public ledger carries the funding entry', entries >= 1, `${entries} entries`);
record('the public ledger verifies its own hash chain', ledger.data?.verification?.ok === true, `chain ok: ${String(ledger.data?.verification?.ok)}`);
record('the public ledger exposes a merkle root', typeof ledger.data?.merkleRoot === 'string' && ledger.data.merkleRoot.length > 0, 'merkleRoot present');

// ---- 7. the ledger leaks nothing personal -------------------------------
const ledgerText = ledger.text ?? '';
record('the public ledger carries no email address', !ledgerText.includes('@'), 'no @ in the payload');
record('the public ledger does not reveal account identifiers', !ledgerText.includes(`"${OP_ID}"`) && !ledgerText.includes(`"${SP_ID}"`), 'no account id in the payload');

// ---- 8. sponsor report (operator) --------------------------------------
const report = await call(op.jar, `/api/sponsor/report?sponsorId=${encodeURIComponent(sponsorId)}`);
record('the sponsor report renders from the real ledger', report.status === 200 && report.data?.ok === true, `HTTP ${report.status}`);

// ---- 9. role separation: sponsor can read, cannot fund ------------------
const sp = await login(SP_ID, SP_PW);
record('the sponsor account can log in', sp.res.status === 200, `HTTP ${sp.res.status}`);
if (sp.res.status === 200) {
  const spReport = await call(sp.jar, `/api/sponsor/report?sponsorId=${encodeURIComponent(sponsorId)}`);
  record('a sponsor session can read the sponsor report', spReport.status === 200, `HTTP ${spReport.status}`);
  const spFunding = await call(sp.jar, '/api/sponsor/funding', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': sp.jar.csrf },
    body: JSON.stringify({ sponsorId, amountCents: 5000, idempotencyKey: `${IDEMPOTENCY_KEY}-sponsor` }),
  });
  record('a sponsor session cannot write funding (operator-only)', spFunding.status === 403, `HTTP ${spFunding.status}`);
  const spSettings = await call(sp.jar, '/api/settings');
  record('a sponsor session is refused the settings surface', spSettings.status === 403, `HTTP ${spSettings.status}`);
}

// ---- 10. learner lesson -------------------------------------------------
const lesson = await call(null, '/api/learn', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: 'Solve the linear equation x = 4 and explain the step.' }),
});
record('core learning answers without a session or a credit', lesson.status === 200 && lesson.data?.ok === true, `HTTP ${lesson.status}`);
record('the lesson carries an answer and its tier', typeof lesson.data?.text === 'string' && lesson.data.text.length > 0 && lesson.data?.tier !== undefined, `tier ${String(lesson.data?.tier)}, answer length ${String(lesson.data?.text?.length ?? 0)}`);

// ---- 11. operator dashboard and settings --------------------------------
const opDash = await call(op.jar, '/api/dashboard/operator');
record('the operator dashboard renders for the operator', opDash.status === 200 && opDash.data?.ok === true, `HTTP ${opDash.status}`);
const settings = await call(op.jar, '/api/settings');
record('the operator can read settings', settings.status === 200, `HTTP ${settings.status}`);
record('the settings view echoes no credential', !(settings.text ?? '').includes(OP_PW) && !(settings.text ?? '').includes(SP_PW), 'no password in the payload');

// ---- 12. pages ----------------------------------------------------------
for (const page of ['/', '/learn', '/dashboard', '/sponsor', '/operator']) {
  const res = await fetch(BASE + page, { redirect: 'manual' });
  record(`the page ${page} is served`, res.status === 200, `HTTP ${res.status}`);
}

console.log(`\nRESULT: ${problems.length === 0 ? 'PASS' : 'FAIL'} — ${rows.filter((r) => r.ok).length}/${rows.length} live checks.`);
console.log(`sponsorRef: ${SPONSOR_REF}  amountCents: ${AMOUNT_CENTS}  ledgerEntries: ${entries}`);
if (problems.length > 0) { console.log('failed:'); for (const p of problems) console.log(`  - ${p}`); }

// ---- artifact: the evidence the closure register cites -------------------
if (process.env.EG_LIVE_ARTIFACT !== '') {
  const { writeFileSync } = await import('node:fs');
  const target = process.env.EG_LIVE_ARTIFACT || 'artifacts/live-e2e.json';
  const artifact = {
    schemaVersion: 1,
    tool: 'tools/live-e2e.mjs',
    base: BASE,
    ranAt: new Date().toISOString(),
    result: problems.length === 0 ? 'PASS' : 'FAIL',
    passed: rows.filter((r) => r.ok).length,
    total: rows.length,
    sponsorRef: SPONSOR_REF,
    amountCents: AMOUNT_CENTS,
    ledgerEntries: entries,
    checks: rows,
  };
  writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`artifact written: ${target}`);
}

process.exitCode = problems.length === 0 ? 0 : 1;
