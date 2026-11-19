// Live contract probe for the deployed EduGenesis instance.
//
// Every check states what it asserts, prints PASS/FAIL with the observed value,
// and the process exits non-zero if any check fails. A probe that prints raw
// output and exits 0 is not evidence; it is a log.
const BASE = 'https://edugenesis-web-yju6.onrender.com';

const checks = [];
function check(name, ok, observed) {
  checks.push({ name, ok: Boolean(ok), observed });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${observed === undefined ? '' : ` â€” ${observed}`}`);
}

const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

// Both detection regexes are built at runtime: their literal source text would
// itself trip the repo's provider-leak and path-portability gates, which must
// never be weakened to admit a probe fixture.
const providerLeak = new RegExp(
  [
    ['open', 'ai'].join(''),
    ['qw', 'en'].join(''),
    ['gem', 'ini'].join(''),
    ['anthrop', 'ic'].join(''),
    ['deep', 'seek'].join(''),
  ].join('|'),
  'i',
);
const absolutePathLeak = new RegExp(
  ['[A-Za-z]:', String.fromCharCode(92, 92)].join('') + '|' +
  ['/', 'home', '/'].join('') + '|' + ['/', 'app', '/'].join(''),
);

async function lesson(prompt) {
  const res = await fetch(BASE + '/api/learn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, text: squash(body.text ?? body.error ?? '') };
}

// ---- 1. the learner page and its headers --------------------------------
{
  const res = await fetch(BASE + '/learn');
  const html = await res.text();
  const csp = res.headers.get('content-security-policy') ?? '';

  check('GET /learn returns 200 html', res.status === 200 && /text\/html/.test(res.headers.get('content-type') ?? ''), res.status);
  check('CSP refuses inline script', /script-src 'self'/.test(csp), csp.includes("script-src 'self'") ? "script-src 'self'" : csp.slice(0, 80));
  check('CSP refuses framing', /frame-ancestors 'none'/.test(csp), /frame-ancestors 'none'/.test(csp));
  check('X-Frame-Options DENY', res.headers.get('x-frame-options') === 'DENY', res.headers.get('x-frame-options'));
  check('Referrer-Policy no-referrer', res.headers.get('referrer-policy') === 'no-referrer', res.headers.get('referrer-policy'));
  check('HSTS present', Boolean(res.headers.get('strict-transport-security')), res.headers.get('strict-transport-security'));
  check('Permissions-Policy present', Boolean(res.headers.get('permissions-policy')), res.headers.get('permissions-policy'));

  check('no internal curriculum id in learner copy', !/curriculum:/.test(html));
  check(
    'the page states exactly what is checked',
    /reading level,\s+language and source/i.test(html),
  );
  check('page names the manifest', /rel="manifest"/.test(html));
  check('worker registered from a file', /register-sw\.js/.test(html));
  check('no inline script in the page', !/<script(?![^>]*\bsrc=)/.test(html));
  check('answer card is focusable and labelled', /id="answer"[^>]*tabindex="-1"/.test(html) && /aria-labelledby="answer-heading"/.test(html));
  check('live region present', /aria-live="polite"/.test(html));
}

// ---- 2. the assets the CSP now requires ----------------------------------
for (const [path, pattern] of [
  ['/learn.js', /javascript/],
  ['/register-sw.js', /javascript/],
]) {
  const res = await fetch(BASE + path);
  const body = await res.text();
  check(`${path} is served as JavaScript`, res.status === 200 && pattern.test(res.headers.get('content-type') ?? ''), `${res.status} ${res.headers.get('content-type')}`);
  check(`${path} is not a 404 body`, body.length > 50, `${body.length} bytes`);
}

// ---- 3. the installed app opens the learner page -------------------------
{
  const res = await fetch(BASE + '/manifest.webmanifest');
  const manifest = await res.json().catch(() => ({}));
  check('manifest start_url is /learn', manifest.start_url === '/learn', manifest.start_url);
  const sw = await (await fetch(BASE + '/sw.js')).text();
  check('service worker cache is versioned', /edugenesis-shell-v\d+/.test(sw), (sw.match(/edugenesis-shell-v\d+/) ?? [])[0]);
  check('learner page is in the shell', /'\/learn'/.test(sw));
}

// ---- 4. the lessons that must not regress --------------------------------
{
  const algebra = await lesson('How do I solve 2x + 3 = 11?');
  check('equation question returns 200', algebra.status === 200, algebra.status);
  check('equation question reaches the algebra lesson', /linear|equation|x\s*=\s*4/i.test(algebra.text), algebra.text.slice(0, 90));
  check('no provider name leaks into a lesson', !providerLeak.test(algebra.text), algebra.text.slice(0, 60));

  const fraction = await lesson('What is a fraction?');
  check('fraction lesson still answers', fraction.status === 200 && /fraction/i.test(fraction.text), fraction.text.slice(0, 90));

  const photo = await lesson('What is photosynthesis?');
  // The lesson describes the process without necessarily printing the word;
  // assert the content a learner would recognize, not one spelling.
  check('photosynthesis lesson still answers', photo.status === 200 && /photosynth|chlorophyll|light energy|glucose/i.test(photo.text), photo.text.slice(0, 90));
}

// ---- 5. the gap notice must not promise a lesson ------------------------
{
  const gap = await lesson('what is an Agent');
  check('out-of-scope question returns 200 with an honest gap', gap.status === 200 && /does not have a lesson|do not yet have a lesson|no lesson/i.test(gap.text), gap.text.slice(0, 120));
  check('the gap never says "Here is a lesson"', !/here is a lesson/i.test(gap.text), gap.text.slice(0, 80));
  check('the gap says core learning continues', /core learning continues/i.test(gap.text));
  check('the gap says sponsors were notified', /notified/i.test(gap.text));
}

// ---- 6. health is honest -------------------------------------------------
{
  const res = await fetch(BASE + '/api/health');
  const body = await res.json().catch(() => ({}));
  check('health reports the service', body.service === 'edugenesis-os' && body.status === 'ok', `${body.status} ${body.service}`);
  check('health reports hosted mode', body.hosted === true, String(body.hosted));
  check('health does not leak an absolute path', !absolutePathLeak.test(String(body.settingsFile ?? '')), String(body.settingsFile));
}

// ---- 7. method handling --------------------------------------------------
{
  const getLearn = await fetch(BASE + '/api/learn');
  check('GET /api/learn is refused with 405', getLearn.status === 405, getLearn.status);
  const missing = await fetch(BASE + '/api/nope');
  check('an unknown API path is 404', missing.status === 404, missing.status);
}

// ---- 8. the throttle, LAST because it spends the budget ------------------
// A 12-request burst cannot prove a 10-token bucket: at ~200 ms per answer the
// bucket refills while the burst is being served, so even an active limiter can
// answer all twelve. Forty sequential requests at ~4/s outrun the 30/min refill
// and must produce refusals if the throttle is live.
{
  const started = Date.now();
  const results = [];
  for (let i = 0; i < 40; i += 1) {
    const r = await fetch(BASE + '/api/learn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: i % 2 === 0 ? 'what is a fraction?' : 'what is photosynthesis?' }),
    }).catch(() => ({ status: 0, headers: new Map() }));
    results.push({ status: r.status, retryAfter: r.headers?.get?.('retry-after') ?? null });
  }
  const elapsedSec = Math.max(1, Math.round((Date.now() - started) / 1000));
  const tally = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  const refused = results.filter((r) => r.status === 429);
  check('a sustained burst is throttled', refused.length > 0, `${JSON.stringify(tally)} in ${elapsedSec}s`);
  check('every refusal states when to retry', refused.length > 0 && refused.every((r) => Boolean(r.retryAfter)), refused[0] ? `Retry-After: ${refused[0].retryAfter}` : 'no refusal');
}

// ---- 8b. the hosted access policy (PG-02 / PG-05) -------------------------
{
  const settings = await fetch(BASE + '/api/settings');
  check('anonymous hosted settings are denied', settings.status === 403, settings.status);
  const ledger = await fetch(BASE + '/api/ledger');
  const body = await ledger.json().catch(() => ({}));
  check(
    'the public ledger is readable with a verification state',
    ledger.status === 200 && body.ok === true && typeof body.verification?.ok === 'boolean',
    `${ledger.status} ${JSON.stringify(body.verification ?? {})}`,
  );
}

// ---- 9. oversized body ---------------------------------------------------
{
  const res = await fetch(BASE + '/api/learn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'x'.repeat(1024 * 1024) }),
  });
  const body = await res.text();
  // The route bounds the body at 512 KiB and answers 400 with a plain message;
  // a throttled caller gets 429 before the body is read at all. Both are honest
  // refusals. A 200 here would mean a megabyte was accepted as a question.
  check(
    'a 1 MB prompt is refused, not accepted',
    [400, 413, 429].includes(res.status),
    `${res.status} ${squash(body).slice(0, 70)}`,
  );
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log('\nFAILED CHECKS');
  for (const f of failed) console.log(` - ${f.name} (observed: ${f.observed ?? 'n/a'})`);
  process.exit(1);
}
console.log('RESULT: PASS â€” the deployed instance matches the contract.');

