#!/usr/bin/env node
/**
 * tools/security-pass.mjs — PG-17 final security pass (same-harness, labelled).
 *
 * WHY IT EXISTS: a role matrix in a document is not a control. This pass starts
 * the REAL server in HOSTED mode with a real session secret and real accounts,
 * then drives the authorization matrix over HTTP: anonymous, learner, operator.
 * It also checks the headers a learner's browser receives, that a password is
 * never echoed back, and that privileged writes refuse a request without a CSRF
 * token.
 *
 * WHAT IT IS NOT: an independent human audit. The judge is the same harness
 * that wrote the code, and the report says so. It cannot substitute for a
 * penetration test and never claims to.
 *
 * Zero runtime dependencies (ADR-0014). Writes artifacts/security-pass.json.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(process.cwd());
const OUT = join(ROOT, 'artifacts', 'security-pass.json');

const problems = [];
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  if (!ok) problems.push(`${name}: ${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};

const { startServer } = await import(pathToFileURL(join(ROOT, 'apps', 'cli', 'dist', 'serve.js')).href);

const dataDir = mkdtempSync(join(tmpdir(), 'eg-sec-'));
const sessionSecret = randomBytes(32).toString('hex');
const operatorPassword = randomBytes(18).toString('base64url');
const learnerPassword = randomBytes(18).toString('base64url');
const operatorId = 'operator-security-pass';
const learnerId = 'learner-security-pass';

let server;
try {
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    hosted: true,
    sessionSecret,
    hostedEnrol: false,
    hostedAudit: false,
    authBootstrap: [
      { id: operatorId, password: operatorPassword, roles: ['operator', 'auditor'] },
      { id: learnerId, password: learnerPassword, roles: ['learner'] },
    ],
  });
  const base = server.url;
  const get = (path, cookie) => fetch(base + path, { headers: cookie ? { cookie } : {} });

  async function login(id, password) {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, password }),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    const body = await res.json().catch(() => ({}));
    return { status: res.status, cookie, body };
  }

  // ---- 1. anonymous must be denied everywhere privileged ---------------
  const anon = [
    ['GET', '/api/settings', 403],
    ['GET', '/api/dashboard/sponsor', 403],
    ['GET', '/api/dashboard/operator', 403],
    ['GET', '/api/auth/me', 401],
  ];
  for (const [method, path, expected] of anon) {
    const res = await fetch(base + path, { method });
    check(`anonymous ${method} ${path} is ${expected}`, res.status === expected, String(res.status));
  }
  const anonFunding = await fetch(base + '/api/sponsor/funding', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sponsorRef: 'probe-ref', amountCents: 1000, idempotencyKey: 'probe-1' }),
  });
  check('anonymous sponsor funding is refused', anonFunding.status === 403, String(anonFunding.status));
  const anonControl = await fetch(base + '/api/dashboard/operator/control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'kill' }),
  });
  check('anonymous operator control is refused', anonControl.status === 403, String(anonControl.status));

  // ---- 2. hosted enrolment and audit stay refused by default (ADR-0021)
  const anonEnrol = await fetch(base + '/api/enrol', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ learnerId: 'x' }),
  });
  check('hosted enrolment is refused while its flag is off', [403, 404].includes(anonEnrol.status), String(anonEnrol.status));
  const anonAudit = await get('/api/audit');
  check('hosted audit is refused while its flag is off', [403, 404].includes(anonAudit.status), String(anonAudit.status));

  // ---- 3. the operator can log in, and the value is redacted ----------
  const operator = await login(operatorId, operatorPassword);
  check('an operator can establish a session', operator.status === 200 && operator.cookie !== '', `${operator.status}`);
  if (operator.cookie !== '') {
    const settings = await get('/api/settings', operator.cookie);
    const text = await settings.text();
    check('an operator reads settings', settings.status === 200, String(settings.status));
    check('the settings view carries no password or session secret', !text.includes(operatorPassword) && !text.includes(sessionSecret),
      'no credential echoed');
    const control = await fetch(base + '/api/dashboard/operator/control', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: operator.cookie },
      body: JSON.stringify({ action: 'kill', providerId: 'probe' }),
    });
    check('an operator write without a CSRF token is refused', control.status === 403 || control.status === 400, String(control.status));
  }

  // ---- 4. a learner session cannot reach privileged surfaces ----------
  const learner = await login(learnerId, learnerPassword);
  check('a learner can establish a session', learner.status === 200, `${learner.status}`);
  if (learner.cookie !== '') {
    const settings = await get('/api/settings', learner.cookie);
    check('a learner is refused the settings surface', settings.status === 403, String(settings.status));
    const operatorPanel = await get('/api/dashboard/operator', learner.cookie);
    check('a learner is refused the operator panel', operatorPanel.status === 403, String(operatorPanel.status));
  }

  // ---- 5. a wrong password is refused and never echoed ----------------
  const wrong = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: operatorId, password: `${operatorPassword}-wrong` }),
  });
  const wrongText = await wrong.text();
  check('a wrong password is refused', wrong.status === 401, String(wrong.status));
  check('the refusal does not echo the attempted credential', !wrongText.includes(operatorPassword), 'no credential echoed');
  check('the refusal does not disclose whether the account exists',
    !/unknown user|no such user|account not found/i.test(wrongText), 'neutral refusal');

  // ---- 6. browser-facing headers --------------------------------------
  const page = await get('/learn');
  const html = await page.text();
  const csp = page.headers.get('content-security-policy') ?? '';
  check('the learner page carries a content-security policy', csp.includes("default-src 'self'"), csp.slice(0, 60) || 'absent');
  check('the learner page refuses MIME sniffing', (page.headers.get('x-content-type-options') ?? '') === 'nosniff',
    page.headers.get('x-content-type-options') ?? 'absent');
  check('the learner page does not inline a script', !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]{12,}?<\/script>/i.test(html),
    'no inline script body');
  check('the learner page declares a language', /<html[^>]+lang="/i.test(html), 'lang attribute present');

  // ---- 7. tenant/PII hygiene in the public ledger ---------------------
  const ledger = await get('/api/ledger');
  const ledgerText = await ledger.text();
  check('the public ledger publishes no personal name shape', !/\b[A-Z][a-z]{1,24}\s+[A-Z][a-z]{1,24}\b/.test(ledgerText),
    'no two-word proper name');
  check('the public ledger publishes no absolute path', !ledgerText.includes(dataDir), 'no data path');
} finally {
  if (server) await server.close();
  rmSync(dataDir, { recursive: true, force: true });
}

const report = {
  tool: 'tools/security-pass.mjs',
  schemaVersion: 1,
  mode: 'hosted',
  judge: 'same-harness agent (NOT an independent human audit)',
  result: problems.length === 0 ? 'PASS' : 'FAIL',
  checks,
  failed: problems,
  limits: [
    'The judge wrote the code it is judging: this is not an independent audit.',
    'No penetration test, fuzzing campaign or third-party scanner was run.',
    'Secrets scanning is a separate tool (tools/secrets-scan.mjs) and covers tree and history.',
  ],
};
mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\nRESULT: ${report.result} — ${checks.filter((c) => c.ok).length}/${checks.length} security checks (same-harness judge).`);
// Do NOT force process.exit(): the server was closed just above, and a forced
// exit can trip a libuv handle assertion on Windows.
process.exitCode = problems.length === 0 ? 0 : 1;
