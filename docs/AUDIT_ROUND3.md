# Forensic audit — round 3 (Genesis Slice 0)

**Date:** 2026-11-13 · **Session:** `ses_e2bb0ca64ffe4EEm8SB3P5Wz0h` · **Build root:** `EDUGENESIS_OS_BUILD`

This is the audit that the round-1 and round-2 Santa reviews did not do. Those reviews
tested the build against its own rubric. This one asked a different question: **for every
function in the tree, does it do what the code, the contracts, the docs and the ADR set say
it does — and does the running system actually do the thing the proposal sells?**

---

## 1. Method

Eight surfaces were audited in parallel by independent reviewers, each on a frozen snapshot
(`eg-audit-snapshot`, 180 files) so the findings could not drift while they were being read.
Three swarm surfaces completed, one was completed by Solo directly, and **four were lost to
infrastructure restarts** (see §6 — this is a disclosed gap in the evidence, not a clean bill
of health).

| Surface | Scope | Result |
|---|---|---|
| F1 | Traceability — every claim in the corpus vs the code (09 §12, the proposal, the ADRs, the exit-criteria register, CI, Render) | 2 blockers / 7 major / 5 minor |
| F3 | `packages/onekey` — learner path, five-tier ladder, budget, breaker, kill switch, egress, redaction, providers, conformance | 5 blockers / 15 major / 16 minor |
| F5 | `packages/ledger` — append-only chain, integrity, money, PII guard, 60 % engine, sponsor report, private store | 0 blockers / 6 major / 7 minor |
| F0 | Solo's own first-hand review of the live tree, every finding re-verified against the code | 3 blockers / 4 major / 3 minor |
| F2, F4, F6, F7, F8 | accessibility, identity, verification+tools, runtime reality, security | **lost to server restarts — not audited** |

**Merged register: 73 findings — 10 blockers, 31 majors, 32 minors. Every one PROVEN by
execution or by a file:line anchor.** Machine-readable: `docs/gap-register.json`.
Human-readable: `docs/GAP-REGISTER.md`.

Every finding was re-verified by Solo before it was accepted. Three suspicions were
**refuted** by that check and are therefore *not* in the register: the suspected
UTF-8 corruption in `package.json` and `index.html` (0 U+FFFD in tracked files), the
suspected missing `PORT` env-var handling in `eg serve` (it honours `process.env['PORT']`
in hosted mode), and the suspected placeholder credential hashing (it is real scrypt with a
salted verifier and `timingSafeEqual`).

---

## 2. The headline finding

**Genesis Slice 0 is a library of contracts and invariants plus the gate suite that proves
them. It is not a running learner product, and three documents claimed it was.**

- The served API has exactly three routes: `/api/health`, `/api/settings`,
  `/assets/edugenesis-tokens.css`. `apps/` imports the platform packages in **one** file —
  `apps/cli/src/selftest.ts`. The gateway, guardian, ledger, consent and enrolment services
  are reachable from the library and the test suite, and from nowhere else.
- The enrolment service (`packages/identity/src/enrolment.ts`) has **zero runtime callers**.
  Its implementation is sound; nothing calls it.
- No store is durable. ADR-0013 promised a `node:sqlite` adapter behind a repository
  interface; **no source file imports `node:sqlite`**, and the private store says in its own
  doc comment that it is in-memory by design. The consent and enrolment audit trails are
  in-memory Maps.

This is now stated plainly in the README and in ADR-0017, and the Render Blueprint no longer
claims a SQLite-backed store.

---

## 3. Repairs applied in this round

Each repair is backed by a named executable check. No gate was weakened; two gates were
**added**, and both were proven able to fail by negative fixtures.

| # | Defect | Repair | Evidence |
|---|---|---|---|
| R1 | A provider reporting **zero usage** made the budget ledger throw a plain `Error`, which escaped `complete()` and bypassed the entire fallback ladder (`budget.ts:78` refuses a zero-unit charge; `gateway.ts:302` re-threw anything that was not `BudgetExceededError`) | The gateway now treats an empty answer and an uncostable answer as **provider failures** and walks to the next tier. A non-budget refusal from the ledger is recorded, not re-thrown | 2 new gateway tests; 425/425 pass |
| R2 | A provider answering **HTTP 200 with empty content** delivered an empty lesson to the learner and recorded the attempt as *served* | Same guard: an answer with no text is a failed provider, never a delivered lesson | Covered by the new empty-answer test |
| R3 | The **kill-switch reason** was not redacted, so a reason quoting a key reached `meta.policyReason` — a field on the **delivered result** — and the attempt trail (`gateway.ts:253`, `policy.ts:173`) | `redactSecret` applied at both sinks | New gateway test asserts the credential appears in neither the trail nor the delivered result |
| R4 | **P1-4 was mislabelled.** The criterion says "The PWA renders the light theme by default". The stylesheet's base `:root` defined the DARK canvas and the light tokens were reachable only through an opt-in `[data-theme="light"]` attribute the document never set — so the page rendered dark, with **light browser form controls painted on a dark canvas**, while the manifest and the meta tag both declared light | `<html data-theme="light">`; **new blocker gate `pwa-light-default`** computes the theme the document actually renders and checks that the meta tag and the manifest agree with it; P1-4's evidence now cites that gate | New gate PASSES on the real tree; 4 negative fixtures prove it can fail |
| R5 | **ADR-0013 recorded a decision the code does not implement** (rubric C13's explicit FAIL signal), and the ledger README claimed a `node:sqlite` dependency the build does not have | **ADR-0017 supersedes ADR-0013** and records the truth: in-memory behind a repository seam, adapter deferred to Slice 1. ADR-0013's decision text is preserved unchanged. The ledger README and `render.yaml` were corrected | `adr-governance` gate cross-checks every record against its index row |
| R6 | The **ADR index contradicted the ADR records** for ADR-0013 to ADR-0016 (all four name *Chief Systems Architect*; the index named three different roles), and the accountable role had **no row in the appointment register at all**, so no person could ever be appointed to it | The index now mirrors the records; the role is registered **VACANT**; **new blocker gate `adr-governance`** parses the index, requires a non-placeholder owner that is a registered role, and cross-checks each record against its row. P0-2 now cites the gate — its old string-contains check could not detect a missing owner | New gate PASSES; 4 negative fixtures prove it can fail |
| R7 | The **committed attestation named a different commit than the tree it shipped in** (`gitHead 7889041` while HEAD was `99563c9`) | The evidence chain is regenerated after the code commit and committed in a follow-up commit | Regenerated artifacts |

**Net effect:** gates 14 → **16**, tests 414 → **425**, secrets scan 171 files / 0 findings with
a live canary, `npm run build` exit 0, `npm run test:only` **425/425 META-GATE PASS**,
`node tools/verify-all.mjs` **16/16 PASS, 0 blockers failed, 0 warnings**.

### Second repair batch — the six `packages/onekey` blockers

| # | Defect | Repair | Evidence |
|---|---|---|---|
| R8 | **The egress boundary was dead code.** The only real provider adapter never called `projectEgressPayload` and shipped raw grounded context — the locator and the text — to the third party. The contract had already said *"grounded context needs its own projector before it may be sent; until then it is refused"*; no such projector existed | `projectGroundedContext` was written and the adapter now projects the request **and** its context before a byte is built. A locator that names a filesystem path or a URL is refused; only `locator` and `text` travel; the rest of the lineage record stays inside the process | 10 new tests: the projector refuses drive-letter, UNC, POSIX-absolute and URL locators; the adapter refuses a filesystem locator and a `sensitive` data class **before anything is sent**; the context that does travel carries only a locator and its text |
| R9 | **The hard cap did not bound real spend.** The budget was tested against the usage reported *after* the provider had answered — the money was already gone | The adapter now tests the pool against the worst case the request can cost, **before** the call. A refusal is not a denial: the gateway treats a budget refusal as a fall-through to the next tier and Tier 0 still answers | New test: a request the pool cannot pay for never reaches the provider |
| R10 | **Routing trusted the client's own classification.** `req.dataClass` and `req.safetyTier` were used while `policy.dataClass` and `policy.safetyTier` were **dead inputs** — a client could claim `public` to reach a provider cleared for more | The effective classification is now the **stricter** of the request's claim and the server-side policy's. A request may only ever make the routing stricter. The policy trace records the effective values | New gateway test: a provider cleared only for `public` is not called for a `learner_scoped` task, the learner is still served, and the trace names `learner_scoped` |
| R11 | **Tier 0's last resort lied about relevance.** It served the closest cached lesson while asserting *"covers this topic"* even when the lesson shared no word with the question | The notice is now score-aware. A lesson with no topical overlap says the library has no lesson on this topic and that this is the closest one it has | New test |
| R12 | **The conformance suite destroyed the adapter it was testing.** It called `dispose()` before the behavioural rules, so the credential was gone and rule 7 passed **vacuously** on the resulting refusal | `dispose()` is now the **last** rule, where it can affect nothing | The suite's own rule order changed; the behavioural rules now measure the adapter |
| R13 | **The provider base URL was unvalidated**, so a credential could be attached to a plaintext, `file:` or link-local metadata endpoint | `assertSafeBaseUrl` runs at construction: HTTPS, or HTTP on loopback; no credentials in the URL. A bad configuration is a startup failure | New test |
| R14 | **The build could leave a STALE `dist` silently — and it did.** `tsc -b` decides a project is up to date by comparing timestamps. A source file edited while a build was running was skipped by every later build, because the compiled output was newer than the source. A test was present in the source, absent from the compiled output, and the suite passed without it | The published `build` and `typecheck` commands now run `tsc -b --force`, so the command the README publishes and CI runs always recompiles from the current sources. **Residual:** the staleness is detected by *absence of the defect*, not by a content check — a machine check that detects staleness by content rather than by timestamp is a Slice 1 item | Reproduced: the test count went 437 → 438 the moment the forced rebuild took effect |

---

## 4. Open findings — not repaired in this round

These are recorded, not hidden. Full detail in `docs/GAP-REGISTER.md`.

**Blockers still open (all in `packages/onekey`, all closable in code):**

- **No adapter is required to run the conformance suite.** The suite exists and the
  rules are objective, but nothing in the build makes a registered adapter pass it,
  and the real Qwen adapter does not run it at all. A rule that nothing enforces is
  a rule that measures nothing. *Owner: engineering — bind the suite to the
  registry at start-up.*
- **The kill switch and the circuit breaker are per-process.** A kill issued on one
  gateway instance does not stop traffic on another, and a tripped circuit is
  invisible to every other instance. For a product whose emergency-disablement
  promise is governance-grade, that is a real gap. It needs a shared store — the
  same repository seam ADR-0017 defers. *Owner: engineering, after the durable
  adapter lands.*

**Majors still open:** a 429 trips the health circuit on a healthy provider; the
deferred-to-human path records a deferral even when no Tier 4 handler exists; the
sponsor report silently defaults missing producer keys to zero, hiding contract
drift; negative monetary values can be appended to the ledger; the ledger has no
concurrency control and no verification on read or write; the 60 % engine cannot
detect a semantic double count.

**Also open:** Phase 5 work items recorded as done but unimplemented (13-item model card and
lifecycle, signed Tier 0 bundle pipeline, adapter regions allowlist, Tier 2 adapter — F1-09);
P0-5 claims an accessibility CI job with a red build, and `ci.yml` has no such job (F1-06).

---

## 5. Owner decisions required

These are not code defects and cannot be closed by a build:

1. **Build the learner runtime now, or hold it for Slice 1?** The single highest-value
   question. Until a route exists, every learner-facing guarantee in this repository is a
   property of a library no learner can reach. *Recommendation: hold the runtime for Slice 1
   and keep the README disclosure, so the slice stays honestly bounded — but make the wiring
   the first Slice 1 exit criterion, not a later task.*
2. **Durability.** Implement the `node:sqlite` adapter in Slice 1, or accept in-memory
   storage for the pilot? It changes the frozen contracts, so it needs an owner decision
   before it starts.
3. **A durable audit log** for consent and enrolment. For a product sold on child
   safeguarding, an in-process array is not an audit trail. *Owner: Child Safeguarding
   Officer + Legal.*
4. **Registering `Chief Systems Architect`** — the role the ADRs name as accountable has no
   person and is now recorded VACANT. *Owner: Founder & CEO.*

---

## 6. What is NOT verified

- **Four of the eight audit surfaces never completed** (F2 accessibility, F4 identity, F6
  verification-and-tools, F7 runtime reality, F8 security). Their reviewer sessions were
  killed by repeated OpenCode server restarts during the audit, not by a defect in the
  build. **The accessibility, identity, gate-soundness, runtime and security surfaces are
  therefore NOT audited to completion**, and this document must not be read as clearing them.
- The 5 lost surfaces were partially covered by the repairs above, which were first-hand
  verified against the live tree — but coverage of those surfaces is partial, not complete.
- No deployment was performed. No Render workspace was named in the conversation, so no
  state-changing Render command was run.
- No vendor SLA, price, quota or certification is asserted anywhere in this audit.
- The build remains uncommitted to any remote; there is no remote configured.
