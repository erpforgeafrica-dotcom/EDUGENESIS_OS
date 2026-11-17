# Audit — Round 5

**Date:** 2026-11-17
**Head:** `aa7457f` — the learner-surface wave plus the throttle correction; the live probe in this document ran against that commit.
**Standard:** `docs/DESIGN-CONSTITUTION.md` (ratified with this round)
**Method:** `production-audit` skill — local evidence only, no external scanner,
no upload of source.

---

## 1. Verdict

**Production audit: 45/100 — blocked. The learner product is real; the programme
economics are not connected to it.**

Stated plainly: a learner can ask a question today and receive a correct,
accessible lesson that survives a provider outage. That path is built, tested
and measured in a real browser. But the proposed value — sponsor pays, cost is
recorded, 60 % is reinvested, the sponsor receives a privacy-safe report, the
public can verify the ledger, an operator can see the whole thing — **exists as
libraries and stops at the library boundary.** Five of the seven value-chain
hops have no runtime surface at all, and a sixth is a per-request guard that
records nothing. Nothing in the running server ever writes a row to the public
ledger, and nothing ever reads it.

Two scores, because they answer different questions:

| Scope | Score | Band |
|---|---|---|
| Learner delivery slice (ask → lesson → resilient fallback) | **84 / 100** | Launchable with caveats |
| Programme value chain (fund → record → reinvest → report → prove → show) | **42 / 100** | Blocked |
| **The question asked** (is the backend + engine + lifecycle + dashboard *connected* to deliver the proposed value?) | **45 / 100** | **Blocked** |

The learner slice is capped at 84, not because a defect was found, but because
this round has no independent second audit and no screen-reader run. The
constitution forbids claiming what was not measured (C4), so the cap is honest.

---

## 2. The value chain, hop by hop

This is the decisive table. "Runtime" means reachable from a running server or a
shipped page — not present in a package that nothing imports.

| # | Hop | Implementation | Reached at runtime? | Status |
|---|---|---|---|---|
| 1 | A sponsor funds the programme | none | **no** | **MISSING** — no sponsor route, no intake surface, no agreement record |
| 2 | The money is recorded in an append-only ledger | `packages/ledger/src/ledger-store.ts`, `sqlite-ledger-journal.ts` | **no** | **LIBRARY ONLY** — `.append(` appears at runtime only in `consent.ts:289` and `enrolment.ts:279`, and both write the *audit sink*, not the public ledger |
| 3 | A learner receives a lesson | `/api/learn` → gateway tiers → Tier 0 | **yes** | **WORKING** — verified live and in a real browser |
| 4 | The cost of that lesson is measured | `createBudgetLedger(LEARNER_POOL_ID, REQUEST_TOKEN_BUDGET, 'token')` at `apps/cli/src/learner.ts:259` | partially | **PER-REQUEST GUARD ONLY** — the ledger is constructed fresh for each request from a constant budget, so it enforces a ceiling but accumulates nothing; no route reports spend |
| 5 | 60 % is reinvested | `packages/ledger/src/reinvestment.ts` | **no** | **LIBRARY ONLY** — no importer in any `apps/*/src` file |
| 6 | The sponsor receives a privacy-safe report | `packages/ledger/src/sponsor-report.ts` | **no** | **LIBRARY ONLY** — no importer in any `apps/*/src` file |
| 7 | The public can verify the ledger | `publicLedger()` at `learner.ts:132`, `:310` | **no** | **DEAD END** — the only caller is `learner.test.ts:327`; no route reads it |
| 8 | An operator sees the whole thing | none | **no** | **NOT BUILT** — specified below |

### The single most important finding

`apps/cli/src/learner.ts:310` exposes:

```ts
publicLedger() {
  return { entries: publicLedger.all().length, verification: publicLedger.verify() };
}
```

Its only caller in the entire repository is a test. The live data directory
contains `ledger.sqlite` at **8 192 bytes** — an empty SQLite database (two
4 KiB pages, no rows). So the public ledger is not "partially populated"; it is
**empty in the running product**, and no code path can populate it.

The README-level claim that EduGenesis keeps a verifiable public ledger is
therefore **UNVERIFIED as a product behaviour** and **VERIFIED as a library
capability**. Those are different things, and the difference is the whole audit.

---

## 3. Backend: what is actually exposed

Six API routes exist, and no others (`apps/cli/src/serve.ts`):

| Route | Line | Guard | Notes |
|---|---|---|---|
| `GET /api/health` | 521 | none | `hosted`, version, node, uptime, settings path (project-relative), schema version |
| `POST /api/learn` | 551 | rate limit (token bucket, 10 burst / 30 per minute); a hosted instance never exempts the platform proxy peer | the one route that can cause paid work |
| `POST /api/enrol` | 627 | guardian consent token | honest 403 when hosted without a store |
| `POST /api/audit` | 714 | same posture | honest 403 when hosted |
| `GET/PUT /api/settings` | 737 | loopback + JSON content-type + origin checks; hosted refuses writes | keys are write-only |
| `GET /assets/edugenesis-tokens.css` | 818 | none | allow-listed asset route |

Backend findings:

- **Security headers are now on every response** — CSP with `script-src 'self'`,
  `frame-ancestors 'none'`, HSTS, `Referrer-Policy: no-referrer`,
  `Permissions-Policy`, `X-Frame-Options: DENY`. Verified by test and by a live
  probe. This is new this round; before it, a learner page could be framed by a
  third party.
- **The question route is throttled** — 10 burst / 30 per minute per address,
  429 with `Retry-After`, checked **before** the body is read. A hosted instance
  never takes the loopback exemption: the platform proxy can reach the service
  over loopback, so exempting that peer would exempt every learner. The local
  exemption remains, because a learner running the project on their own machine
  should never be throttled by their own software. This distinction was missing
  from the first version of the fix, and the deployed service answered a
  40-request run with 40 successes (§8, defect 4). After the correction the live
  run answered **10** and refused **30**, each refusal carrying `Retry-After`.
- **The deployed instance runs Tier 0 only.** A live `GET /api/settings` returns
  the shipped defaults: `primary`, `secondary` and `local` are all `local-echo`
  and `apiKeys` is empty. No hosted model credential exists in production, so
  tier 1 is not in play and every answer a learner receives is a Tier 0 lesson.
  That is honest, and it is a limit on the value chain, not a defect in it.
- **Nothing writes the public ledger, nothing reads it.** See §2.
- **No route exposes spend, audit verification, sponsor data, or reinvestment.**
- **`/api/health` discloses a project-relative settings path.** Not an absolute
  path (`paths.ts:121-124`), so it does not leak the deploy directory, but it
  does tell a stranger which settings file is active. Minor.

---

## 4. Brain and engine

| Component | Where | Status |
|---|---|---|
| Five-tier ladder (paid providers → offline → cached → delegation → Tier 0) | `packages/onekey/src/gateway.ts` | VERIFIED by failover drills; all five tiers exercised in tests |
| Tier 0 (offline answer) | `packages/onekey/src/providers/tier-zero.ts` | VERIFIED — keyword and prompt-pattern scoring; bare "solve" deliberately excluded (overreach guard) |
| Gap honesty | same, corrected this round | VERIFIED — "Core learning continues. The sponsors of this programme have been notified." No longer promises a lesson it does not have |
| Guardian / consent | `packages/identity/src/consent.ts`, `enrolment.ts` | VERIFIED — withdrawal locks dependent scopes, never core learning |
| Kill switch | `apps/cli/src/kill-switch-store.ts` | VERIFIED — durable, persisted in the private store, fails loudly on corrupt state |
| Circuit breaker | gateway | VERIFIED — a 429 leaves the circuit closed; a revoked credential is a governance failure, not a health failure |
| Budget ledger | `learner.ts:259`, per request | GUARDS A REQUEST, DOES NOT ACCUMULATE |

The engine is the strongest part of the build. The drills are real: "every model
fails and Tier 0 serves a learner" passes, and the emitted lesson carries no
provider evidence.

---

## 5. Key and token lifecycle

| Stage | Implementation | Status |
|---|---|---|
| Storage | `settings/settings.json` (committed default), `settings.local.json` (gitignored), environment | VERIFIED |
| Read exposure over HTTP | `describeApiKeys` → `{ set: boolean, length: number }` (`settings-store.ts:402-410`); `maskSettingsForDisplay` | VERIFIED — the value never crosses the wire |
| Write | loopback only; JSON content-type; origin and fetch-metadata checks; hosted refuses writes | VERIFIED — 10 CSRF tests, including the attack shape (`text/plain`) |
| Revocation at the provider | gateway classifies a revoked credential as governance, never health | VERIFIED by test |
| Provider kill | durable kill-switch store, applied to every replica (single process here) | VERIFIED |
| **Rotation** | none | **MISSING** — no scheduled rotation, no expiry field, no rotation event |
| **Age / expiry tracking** | none | **MISSING** — a key can sit unchanged for years with no signal |
| **Per-key spend cap** | budget ledger exists, no cap enforced per key | **MISSING** |

Verdict on lifecycle: **write-only, masked, and revocable — but not rotatable and
not age-aware.** For a programme that expects to hold sponsor and provider
credentials for years, the absence of rotation and expiry is a real operational
risk, not a nice-to-have. It is also a small, well-bounded piece of work.

---

## 6. The dashboard: specification, not construction

The owner's instruction was to specify now and build later. This is the
specification, and it is deliberately hostile to the dashboard that would be
easiest to build.

### What it must show (operator view)

1. **Money in** — sponsor commitments, per sponsor, with the agreement date.
2. **Money out** — cost per lesson, per provider, per day; the paid-tier share
   versus Tier 0 share. This is the number that proves resilience is cheap.
3. **Reinvestment** — 60 % computed from recorded events, with the arithmetic
   visible, not asserted.
4. **Learning** — lessons served, gaps served, gap rate by topic. A gap is a
   curriculum order, not an error.
5. **Proof** — ledger length, chain verification result, last verified
   timestamp, and the hash of the latest entry.
6. **Health** — provider circuit states, kill-switch states, key age (once
   lifecycle work lands).

### Anti-specification (what it must never be)

- **Not** the learner page with numbers bolted on. C7 forbids it.
- **Not** a table of learners. No names, no identifiers, no per-learner rows.
  Money questions are answered by aggregate, and cohorts below the suppression
  threshold are not shown at all.
- **Not** a green tick that is not backed by a fresh check. If the chain has not
  been verified in the last hour, the panel says "not verified recently" — it
  does not show the last green result as if it were current.
- **Not** a provider-key viewer. Keys are masked everywhere, including here.
- **Not** a chart with no query behind it.

Implementation note: the dashboard must read the same append-only record the
public proof reads, or C7 is violated. That means the ledger writes have to be
built first. **The dashboard cannot be built honestly before hop 2 exists.**

---

## 7. Constitution scorecard

| Principle | Score | Evidence |
|---|---|---|
| **C1 Calm** | 9/10 | No countdown, streak or badge in the shipped learner page. The only motion is one token-timed background transition on hover and a 1 px press offset, both removed by the reduced-motion block. |
| **C2 Dignified** | 10/10 | Zero matches for `sponsor`, `upgrade`, `free`, `premium`, `unlock`, `donate`, `subscribe` across `learn.html` and `learn.js`. No upsell, no branding on the lesson. |
| **C3 Unhurried** | 9/10 | The answer persists until the next explicit submission. No timer in `learn.js`. Requests never open a modal. |
| **C4 Precise** | 9/10 | Internal `curriculum:` IDs removed from learner copy; the claim is now "reading level, language and source", which is exactly what is checked; the gap no longer says "here is a lesson". One deliberate omission: no `theme-color` meta on the learner page, because adding a colour literal would require widening the token gate. |
| **C5 Generous** | 9/10 | Measured in a real browser at 390 px: chips **152 × 44 px** after this round's fix (they were 29 px), input **342 × 47**, Ask button **77 × 47**; body 16 px / 25.6 px; prose measure 58 ch light theme. Contrast pairs pass the token gate numerically in both themes. |
| **C6 Equitable luxury** | 9/10 | One page, one token set, one rendering path at 360, 390 and 1280 px. Tier 0 produces the same lesson shape as a paid provider. No feature gate on core learning. |
| **C7 One surface, two truths** | **2/10** | The learner truth exists and is honest. The operator truth does not exist: no ledger writes, no read route, no dashboard. This is the principle the product currently fails. |

**Weighted reading:** the learner-facing constitution is largely honoured. The
operator-facing principle — the one that makes the programme auditable — is
essentially unimplemented. That is why the overall score is in the blocked band
while the learner slice scores 84. The learner score remains capped by
first-party evidence, and defect 4 shows exactly why: a green suite became a
green deployment only after a live re-run.

### Browser measurements (independent of the code)

Headless Chrome over CDP, storage cleared before each measurement so the
service-worker shell cache could not serve the previous build:

| Viewport | Horizontal overflow | Chip | Input | Ask | Console errors |
|---|---|---|---|---|---|
| 390 × 844 | none (`scrollWidth` 390) | 152 × 44 | 342 × 47 | 77 × 47 | 0 |
| 360 × 800 | none | 152 × 44 | 312 × 47 | 77 × 47 | 0 |
| 1280 × 900 | none | 152 × 44 | 586 × 47 | 77 × 47 | 0 |

Keyboard path: Tab reaches skip link → input → Ask → three chips; every one
reports `:focus-visible = true` with a 3 px solid outline plus a 5 px ring. The
earlier "outline: none" reading was programmatic focus, not a defect — the
keyboard path is sound.

Interaction: tapping the fraction chip under the new CSP produces
`status = "Your lesson is ready."`, `activeElement = answer`, zero console
errors, and the service worker active at scope `/`.

---

## 8. Defects found and fixed this round

| # | Defect | Evidence it was real | Fix |
|---|---|---|---|
| 1 | Chip touch targets 29 px | CDP measurement | `min-height: var(--eg-touch-target)` → 44 px, re-measured |
| 2 | Empty state declared `class="hint"` but no control referenced it | `form-semantics` gate: "the hint `answer-empty` is referenced by nothing" | Reclassified as `.eg-empty` — it describes the region, not the input; faking an `aria-describedby` would have been worse |
| 3 | Viewer could frame the learner page | no `frame-ancestors` before this round | CSP + `X-Frame-Options: DENY`, verified by test and live probe |
| 4 | The deployed question route did not throttle at all | live run on `1ab1be7`: 40 sequential requests at ~4/s, **40 × 200**, no `Retry-After`. Every throttle test had passed `exemptLoopback: false`, so the hosted default was never exercised — and the platform proxy reaches the service over loopback, which the default exempted | hosted never exempts a loopback peer; two tests now pin the proxy case and the surviving local exemption. Live re-run on `aa7457f`: **10 × 200, 30 × 429**, every refusal with `Retry-After` |
| 5 | Internal `curriculum:` ID in learner copy | page source | removed; test asserts absence |
| 6 | Gap notice promised a lesson it did not have | live probe | corrected notice; Tier 0 test asserts the wording |
| 7 | A hosted throttle would have keyed on the platform proxy | design review before ship, later confirmed live: `socket.remoteAddress` is the platform proxy, and that proxy arrives over loopback — so a bucket keyed on it would have been one bucket (or no bucket) for the whole internet | `clientIdentity()` keys on the first forwarded hop **only when hosted**, with a bounded address shape; two tests prove per-caller buckets behind a proxy and that a local instance ignores a forged header |

Defect 2 is worth naming explicitly: the gate caught **my own** regression,
introduced during this round, and it was fixed by making the markup honest
rather than by weakening the gate.

Defect 4 is the more important lesson, and it is the reason this round now ends
with a live contract probe rather than a suite result. The bucket existed, its
tests passed, and §8 had already called the finding fixed — while production
answered every one of forty requests. A test that always disables the exemption
cannot see the exemption. Code-level green is not deployment-level green; only
the deployed run could establish this, and it did.

---

## 9. Open defects

| Severity | Defect | Path to close |
|---|---|---|
| Blocker (programme) | Public ledger never written | Append on lesson delivery + on spend; then expose a verify route |
| Blocker (programme) | No sponsor intake | A recorded commitment is the first hop; needs an owner decision on the agreement shape |
| Major | No reinvestment or sponsor-report runtime | Both are libraries; wire to the ledger once hop 2 exists |
| Major | No key rotation or expiry | Add `issuedAt`/`rotatedAt`, a rotation CLI, and surface key age on the dashboard |
| Major | No operator dashboard | Blocked by hop 2, not by UI work |
| Minor | `/api/health` names the active settings file | Redact or drop the field |
| Minor | No documented rollback procedure in-repo | Write it against Render's redeploy-previous |

---

## 10. What this audit cannot prove

Stated because C4 requires it:

- **No screen-reader run.** NVDA and VoiceOver behaviour is **UNVERIFIED**. The
  accessibility evidence here is structural (roles, labels, live region, focus
  move) and measured (targets, focus rings, overflow). That is not the same as
  a screen-reader session, and no claim is made that it is.
- **No independent second audit.** The browser and test evidence in this round
  was produced by the same agent that made the fixes. The four planned
  independent audit waves failed on a transport error
  (`getaddrinfo ENOTFOUND opencode.ai`). Self-certification is exactly what the
  standing orders forbid, so this document is labelled **first-party evidence**,
  not an independent verdict.
- **Reproducibility is recorded, not assumed.** An earlier `verify:repro`
  second pass failed two blockers because source was edited during its
  12-hour, sleep-interrupted run. Both gates were then run standalone
  (`form-semantics` PASS on 2 pages; `path-portability-runtime` PASS, 12/12
  steps), and the cause was identified as the orphan hint in §8. Over the
  frozen source, `npm run verify:repro` ran the full chain twice and produced
  **626 tests, 0 failed, 18/18 gates, 0 unverified, exit 0**, and **4/4
  byte-identical evidence files**. Because this document is itself part of the
  checksum manifest, the digests are not quoted here; they are the `same` lines
  in the reproducibility transcript.
- **Hosted settings visibility** is an owner decision, not a defect. The live
  `GET /api/settings` returns the shipped defaults with `apiKeys: {}` — there is
  no hosted key to expose today — and when keys are set the payload reports only
  `{set, length}` per key. Whether a stranger may read the provider names,
  feature flags and limits at all is the owner's call.

---

## 11. Owner-gated items

1. **GitHub billing** on `erpforgeafrica-dotcom` — Render auto-deploy stays inert
   until it is settled. Deploys are hand-triggered meanwhile.
2. **Screen-reader session** — 30 minutes with NVDA on the live page would close
   the largest evidence gap in this document.
3. **Render workspace placement** — service currently sits in the KORA workspace.
4. **Pilot region** — recommendation: keep Frankfurt. The learner population
   argued for is not yet measured; Frankfurt is the closest honest default and
   moving later is a redeploy, not a migration.

---

## 12. Next action

Build hop 2: **append to the public ledger when a lesson is delivered and when a
lesson is paid for.** Until that exists, the dashboard has nothing honest to
display, the sponsor report has nothing to aggregate, and the reinvestment
engine has nothing to compute.

Everything downstream of that one write is already written and tested. The
missing piece is one call site and the route that reads it back.
