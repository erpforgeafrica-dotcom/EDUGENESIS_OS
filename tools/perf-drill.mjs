#!/usr/bin/env node
/**
 * tools/perf-drill.mjs — PG-16 performance and resilience drill.
 *
 * WHY IT EXISTS: "it renders" is not "it holds". This drill drives the REAL
 * server over a REAL socket (no mocks, no in-process shortcuts) and records
 * latency, error rate, memory growth, rate-limit behaviour and restart
 * durability. Budgets are deliberately generous because this runs on a laptop
 * as well as in CI; a failure means something is wrong, not that a laptop is
 * slow.
 *
 * TWO SERVERS, because two policies are both true:
 *   - a LOCAL instance exempts loopback callers from the question throttle
 *     (`exemptLoopback` default true: a learner's own machine is never
 *     throttled). Latency, memory and restart are measured there.
 *   - a HOSTED instance never takes that exemption, because a platform proxy
 *     reaches the service over loopback and would exempt the whole internet.
 *     The rate-limit check therefore runs against a hosted-mode server.
 *   Measuring the limiter locally and calling it absent would be a false
 *   defect; measuring it only in hosted mode and calling the local path tested
 *   would be a false pass. Both are measured.
 *
 * Zero runtime dependencies (ADR-0014). Writes artifacts/perf-drill.json.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(process.cwd());
const OUT = join(ROOT, 'artifacts', 'perf-drill.json');

const SEQUENTIAL = Number(process.env['EG_PERF_SEQUENTIAL'] ?? 120);
const CONCURRENCY = Number(process.env['EG_PERF_CONCURRENCY'] ?? 40);
const BURST = Number(process.env['EG_PERF_BURST'] ?? 12);
const P95_BUDGET_MS = Number(process.env['EG_PERF_P95_MS'] ?? 1500);
const MAX_BUDGET_MS = Number(process.env['EG_PERF_MAX_MS'] ?? 6000);
const RSS_GROWTH_BUDGET_MB = Number(process.env['EG_PERF_RSS_MB'] ?? 160);

const problems = [];
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  if (!ok) problems.push(`${name}: ${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};

/** Linear-interpolated percentile; deterministic for a given sample. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

const { startServer } = await import(pathToFileURL(join(ROOT, 'apps', 'cli', 'dist', 'serve.js')).href);

/**
 * One timed request. The body is read ONCE and parsed once: reading it twice
 * is how a previous version of this drill reported a healthy ledger as broken.
 */
async function timed(base, path, init) {
  const started = process.hrtime.bigint();
  const res = await fetch(base + path, init);
  const text = await res.text();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { ms, status: res.status, headers: res.headers, data, text };
}

/** A reset once after an intentionally destroyed socket is transport, not product. */
async function withResetRetry(run, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      if (!/ECONNRESET|socket hang up|fetch failed/i.test(String(error))) throw error;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw last;
}

const dataDir = mkdtempSync(join(tmpdir(), 'eg-perf-'));
let server;
let hosted;
let base;
let hostedBase;
try {
  server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dataDir, 'local') });
  base = server.url;

  const lessonBody = JSON.stringify({ prompt: 'Solve the linear equation x = 4 and explain the step.' });
  const JSON_POST = { 'content-type': 'application/json' };

  // Warm-up: the first request pays module and store initialisation.
  for (let i = 0; i < 8; i += 1) {
    await timed(base, '/api/learn', { method: 'POST', headers: JSON_POST, body: lessonBody });
  }

  // ---- 1. sequential latency -------------------------------------------
  const sequential = [];
  let sequentialErrors = 0;
  for (let i = 0; i < SEQUENTIAL; i += 1) {
    const { ms, status } = await timed(base, '/api/learn', { method: 'POST', headers: JSON_POST, body: lessonBody });
    sequential.push(ms);
    if (status !== 200) sequentialErrors += 1;
  }
  sequential.sort((a, b) => a - b);
  const p50 = percentile(sequential, 50);
  const p95 = percentile(sequential, 95);
  const max = sequential.at(-1) ?? 0;
  check('the lesson path answers every sequential request', sequentialErrors === 0, `${sequentialErrors} error(s) of ${SEQUENTIAL}`);
  check(`lesson p95 is within ${P95_BUDGET_MS} ms`, p95 <= P95_BUDGET_MS, `p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`);
  check(`lesson max is within ${MAX_BUDGET_MS} ms`, max <= MAX_BUDGET_MS, `${max.toFixed(0)} ms`);
  console.log(`      latency over ${SEQUENTIAL} requests: p50 ${p50.toFixed(0)} ms / p95 ${p95.toFixed(0)} ms / max ${max.toFixed(0)} ms`);

  // ---- 2. concurrent burst ---------------------------------------------
  const burstStarted = process.hrtime.bigint();
  const burst = await Promise.all(Array.from({ length: CONCURRENCY }, () => timed(base, '/api/health')));
  const burstMs = Number(process.hrtime.bigint() - burstStarted) / 1e6;
  const burstErrors = burst.filter((r) => r.status !== 200).length;
  check('a concurrent burst of health reads never errors', burstErrors === 0, `${burstErrors} error(s) of ${CONCURRENCY}`);
  check('the burst completes within 20 s', burstMs <= 20000, `${burstMs.toFixed(0)} ms total`);

  // ---- 3. public ledger stays readable and verifiable under load --------
  const ledger = await timed(base, '/api/ledger');
  check('the public ledger answers after the load', ledger.status === 200 && ledger.data?.ok === true, `${ledger.status}`);
  check('the public ledger verifies its chain after the load', ledger.data?.verification?.ok === true,
    String(ledger.data?.verification?.ok));

  // ---- 4. the rate limiter actually limits (HOSTED mode) ----------------
  hosted = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: join(dataDir, 'hosted'),
    hosted: true,
    sessionSecret: randomBytes(32).toString('hex'),
    rateLimit: { burst: 4, perMinute: 1, exemptLoopback: true },
  });
  hostedBase = hosted.url;
  let limited = 0;
  let retryAfter = '';
  let allowed = 0;
  for (let i = 0; i < BURST; i += 1) {
    const res = await timed(hostedBase, '/api/learn', { method: 'POST', headers: JSON_POST, body: lessonBody });
    if (res.status === 429) {
      limited += 1;
      retryAfter = retryAfter || (res.headers.get('retry-after') ?? '');
    } else if (res.status === 200) {
      allowed += 1;
    }
  }
  check('a hosted question burst is rate-limited, not absorbed', limited > 0, `${limited} of ${BURST} refused with 429, ${allowed} allowed`);
  check('a rate-limited response states when to retry', retryAfter !== '', `Retry-After: ${retryAfter || 'absent'}`);

  // ---- 5. an oversized body is refused ---------------------------------
  const oversized = await withResetRetry(() => timed(base, '/api/learn', {
    method: 'POST',
    // `connection: close` keeps the deliberately destroyed socket out of the
    // keep-alive pool, so the refusal cannot masquerade as a later failure.
    headers: { ...JSON_POST, connection: 'close' },
    body: JSON.stringify({ prompt: 'x'.repeat(1024 * 1024) }),
  }));
  check('an oversized prompt is refused, not buffered', [400, 413, 429].includes(oversized.status), String(oversized.status));

  // ---- 6. memory growth -------------------------------------------------
  const before = process.memoryUsage().rss;
  for (let i = 0; i < 150; i += 1) {
    await withResetRetry(() => timed(base, '/api/health'));
  }
  const after = process.memoryUsage().rss;
  const growthMb = (after - before) / (1024 * 1024);
  check(`resident memory growth stays under ${RSS_GROWTH_BUDGET_MB} MB over 150 reads`, growthMb <= RSS_GROWTH_BUDGET_MB,
    `${growthMb.toFixed(1)} MB`);

  // ---- 7. restart durability -------------------------------------------
  await server.close();
  server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dataDir, 'local') });
  base = server.url;
  const revived = await timed(base, '/api/health');
  check('the server restarts over the same durable stores', revived.status === 200 && revived.data?.ok === true, String(revived.status));
  const revivedLedger = await timed(base, '/api/ledger');
  check('the ledger chain still verifies after the restart',
    revivedLedger.status === 200 && revivedLedger.data?.verification?.ok === true,
    String(revivedLedger.data?.verification?.ok));
} finally {
  if (server) await server.close().catch(() => {});
  if (hosted) await hosted.close().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
}

const report = {
  tool: 'tools/perf-drill.mjs',
  schemaVersion: 1,
  budget: { p95Ms: P95_BUDGET_MS, maxMs: MAX_BUDGET_MS, rssGrowthMb: RSS_GROWTH_BUDGET_MB, sequential: SEQUENTIAL, concurrency: CONCURRENCY },
  rateLimitProbe: 'hosted-mode server: the loopback exemption is applied only to a local (non-hosted) instance by design',
  result: problems.length === 0 ? 'PASS' : 'FAIL',
  checks,
  failed: problems,
  note: 'Measured locally against the real server on an ephemeral port. Absolute numbers are machine-dependent; the budgets are the contract.',
};
mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\nRESULT: ${report.result} — ${checks.filter((c) => c.ok).length}/${checks.length} drill checks.`);
process.exitCode = problems.length === 0 ? 0 : 1;
