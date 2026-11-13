# EduGenesis OS — Build Session Process Log

**Session ID:** ses_e30099b68ffeUK5CTfRjiDKHe8
**Date:** 2026-11-12
**Objective:** Plan, orchestrate, build, test, verify and adversarially review the EduGenesis OS platform against the controlled baseline, looping until every exit criterion is met.
**Build root:** `EDUGENESIS_OS_BUILD` (git repo, branch `main`)
**Authority:** Document 1 v1.2 (single source of truth) → Document 2 (architecture) → Document 6 (AI safety) → Document 7 (pilot evaluation) → Document 15 (AI Main Tutor) → Document 16 (sponsorship) → `09` build sequence → `07` disability plan → `08` UX plan → `02` design system.

---

## 1. Scope decision (recorded before any code was written)

The build sequence in `09` §12 defines ten phases. The instruction was to build, test, verify and review *each complete build* and loop until success — which requires a decidable unit of completion, not an unbounded platform build.

**Selected slice — "Genesis Slice 0": Phases 0, 1 and 5.**

| Phase | Why selected | Why deferred |
|---|---|---|
| **0 — Governance and approval** | Its exit criteria are machine-checkable (CI green, clean secrets scan, published SBOM, tokens committed with a contrast ledger). It is the foundation every other phase depends on. | — |
| **1 — Platform foundation** | The accessibility runtime contract and its ARC invariants are the *constitutional heart* of the platform. "An accessibility emission blocked by ARC-I1 cannot reach a learner" is a decidable statement that a test can prove forever. | Identity hardening (WebAuthn ceremony, real key storage) needs a browser + HSM-grade key handling; deferred to Slice 1 with a local-key adapter behind the same interface. |
| **5 — OneKey routing, provider adapter and fallback tiers** | Model sovereignty is the promise made to the Anchor Sponsor. "A provider change is a registry change with no learner-path code change" and "all five tiers exercised in a documented failover test" are decidable and are exactly what the Alibaba proposal sells. | Real provider wiring (Qwen, DeepSeek, Zhipu) needs credentials and live endpoints; the adapter seam is built and a live adapter is a config change. |

**Deferred to later slices, with reasons:** Phase 2 (needs curriculum content and SME reviewers), Phase 3 (needs Phase 2 atoms), Phase 4 (needs a sandboxed runtime and Phase 3), Phase 6 (needs a sponsor and a real 60 % quarter), Phases 7–9 (need learners, employers and an audit body).

**This is a scope boundary, not a completion claim.** Nothing in this slice is deployed, and no learner is served by it.

---

## 2. The loop mechanics

Three skills govern the loop. They are complementary rather than redundant.

| Skill | Role in this build | Rule applied |
|---|---|---|
| `goal-loop-execution` | Makes the loop **finite**. Every task has a machine-checkable end state; every attempt is numbered and logged with its exact error; the loop terminates with a terminal verdict rather than spinning. | No task without a decidable end state. No retry without a changed parameter. Terminal report if paths are exhausted. |
| `santa-method` | Makes the loop **adversarial**. Two independent reviewers with no shared context must BOTH pass before a build is accepted. | Fresh reviewers each round. Max 3 rounds, then escalate. Rubric criteria must have objective pass/fail conditions. |
| `dispatching-parallel-agents` | Makes the swarm **safe**. One agent per independent domain, no shared state, contracts agreed up front. | Agents get exactly the context they need, one domain each, and never edit each other's files. |

Per-unit build skills: `test-driven-development` (S1), `verification-before-completion` + `mutation-testing-analysis` (S3).

**Acceptance rule for this build.** A phase is accepted only when **all** of the following hold:

1. Its exit criteria are met and each has a named machine-checkable assertion.
2. The full test suite passes from a clean checkout, through the zero-test meta-gate.
3. `dependency-analyzer` (MCP) reports no critical vulnerabilities.
4. Two independent Santa reviewers both return PASS against the phase rubric.
5. The portability gate passes: the build runs from a **copy** at a different path with a different user profile, with zero source edits — first-run, settings change, and normal use.

---

## 3. Swarm decomposition (non-overlapping ownership)

Each agent owns exactly one package directory. Interfaces are fixed by contract **before** dispatch, so no two agents write the same file and integration is mechanical.

| Swarm ID | Owns | Builds | Cannot touch |
|---|---|---|---|
| **S0** | repo root, `packages/contracts`, `apps/cli`, `tools/` | Monorepo, portable bootstrap, settings store + Settings UI, `eg` CLI (`doctor`/`serve`/`settings`/`selftest`), CI workflow, SBOM, secrets scan, ADRs 13–16 | — (runs first; everything depends on it) |
| **S1** | `packages/accessibility` | The nine-element emission contract, validator, ARC-I1…I12 invariants, Accessibility Guardian interception, per-surface acceptance checks, equivalence matrix engine | other packages |
| **S2** | `packages/onekey` | Policy engine, budget/quota enforcement, circuit breaker, kill switch, `ProviderAdapter` interface + conformance suite, all five fallback tiers, documented failover test | other packages |
| **S3** | `packages/ledger` | Append-only hash chain, proofs, corrections, tamper detection, private store with a provable no-PII boundary, 60 % reinvestment engine | other packages |
| **S4** | `packages/identity` | Local identity service, RBAC + ABAC policy bundles, consent service with atomic withdrawal, age assurance, session risk | other packages |
| **S5** | `packages/verification` + `tools/` | The verification harness: token/contrast lint, a11y static gates, portability gate (copy-to-new-path run), full-suite runner, the attempt log and evidence ledger | other packages |

**Sequencing.** S0 first (it defines the contracts). Then S1–S5 dispatched **in parallel** against the frozen contracts. Then integration, full verification, dual Santa review, fix cycle.

---

## 4. Engineering decisions taken (recorded as ADRs)

| # | Decision | Reason | ADR |
|---|---|---|---|
| D-01 | TypeScript on Node 24; `node:sqlite` as the relational substrate behind a repository interface | **Python is not installed and Docker is not available on this machine**, and the governing portability law (GLOBAL.md §9) forbids depending on a developer machine's state. `node:sqlite` is built into Node 22+ — zero install, zero supply chain, ACID. PostgreSQL is reachable by swapping the repository implementation behind the same interface. | ADR-0013 |
| D-02 | Zero runtime dependencies; dev dependencies limited to `typescript` + `@types/node` | No dependency can be exploited in a product built for untrusted networks and constrained devices. | ADR-0014 |
| D-03 | `node:test` as the test runner | Built in, zero install, deterministic, works on any Node ≥ 18 — satisfies the portability gate. | ADR-0015 |
| D-04 | Settings persisted as versioned JSON inside the project, edited by a local Settings UI served by `eg serve` | Required by the portability law: server port, data folder, API keys and feature toggles editable by a non-technical user, stored inside the project, never in the user profile. | ADR-0016 |
| D-05 | Local-key identity adapter behind the WebAuthn interface | Slice 0 must be testable without a browser or an authenticator; the ceremony is deferred, the seam is not. | — |

---

## 5. Attempt log (living — one numbered line per attempted path)

| # | Attempt | Result | Evidence |
|---|---|---|---|
| A-01 | Read the controlled corpus | **PASS** | Document 16 read in full (540 lines); Documents 2, 6, 7, 15 recovered from the DOCX extracts |
| A-02 | Parse Document 1 v1.2 PDF directly | **FAIL** | This model cannot read PDF input. Worked around via the DOCX extracts. Recorded as an open reconciliation item, not silently ignored. |
| A-03 | Run the `ui-ux-pro-max` search script | **FAIL** | Python is not installed (`WindowsApps\python.exe` is the Store alias stub). Worked around by reading the skill's `data/*.csv` and `references/*.md` directly. |
| A-04 | Verify the `compact-law` enforcer | **PASS** | `compact-law/index.js` present; log shows `LOADED compact-law V2 … threshold=30%, auto=true`; `opencode.json` has `compaction.auto=true`, `buffer=39320` |
| A-05 | Check the build host capability | **PASS** | node v24.19.0, npm 11.17.0, git 2.55.0, rg present; **docker MISSING**, **python MISSING**; 320 GB free; target ports all free |
| A-06 | Create the build repo | **PASS** | `git init -b main` in `EDUGENESIS_OS_BUILD`; no pre-existing repo in `Desktop` to conflict with |
| A-07 | Run the test suite via a directory argument | **FAIL** | False green. `node --test <dir>` on Node 24 resolves the path as one module and reports `tests 1 / pass 1 / fail 0`, exit 0, running nothing. Repaired by the meta-gate (see §9). |
| A-08 | Scaffold the workspace | **FAIL (repaired)** | `tools/scaffold.mjs` wrote the build host's absolute path into every tsconfig `extends` / `path`. Repaired to relative paths; the portability gate now owns the regression. |
| A-09 | Run six swarm units in parallel | **PARTIAL** | S1, S3 and S4 completed and committed. S2, S0a and S5 wrote their full file sets but their agent sessions hit the provider's free-usage ceiling before they could report. Their output was integrated and verified by Solo, not taken on trust. |
| A-10 | Full workspace typecheck | **PASS** | `tsc -b` over contracts, accessibility, onekey, ledger, identity, verification, cli — exit 0 |
| A-11 | Full test suite through the meta-gate | **PASS** | 345 tests reported, 345 passed, 0 failed, 0 cancelled, 0 skipped; `META-GATE PASS` |
| A-12 | First full gate sweep (`verify-all`) | **FAIL (5 blockers)** | accessibility-contract, failover-drill, no-pii-in-source, no-provider-leak, path-portability — each triaged in §9.1 |
| A-13 | Re-run the two repaired gates | **PASS** | contract gate now resolves `hashCanonicalContent`; failover gate resolves `runFailoverDrill` — both PASS with evidence lines |
| A-14 | Repair the three hygiene findings | **PASS** | PII fixtures allowlisted; provider boundary corrected; drive-letter regex bounded — 2 new regression tests |
| A-15 | Full suite after repairs | **PASS** | 347 tests reported, 347 passed, 0 failed; `META-GATE PASS` |
| A-16 | Second full gate sweep (`verify-all`) | **PASS** | 10 gates, 10 passed, 0 blockers failed, exit 0 |
| A-17 | Round-1 Santa review (Reviewer B and Reviewer C, both independent) | **FAIL (both)** | Both reviewers returned FAIL. 11 merged critical issues, deduplicated and repaired — see §12.1 |
| A-18 | Repair: Tier 0 served before the paid ladder | **PASS** | Two-phase Tier 0: an exact `serve()` first, `serveFallback()` last (§6.6 `2 → 3 → 0 → 4`); the fallback is NOT gated on `paidAttempted`. `gateway.test.ts` asserts the order `0:no-offline-content → 1:failed → 2:failed → 3:failed → 0:served` |
| A-19 | Repair: the real learner path must not block every emission | **PASS** | The learner path now uses the real guardian with a valid ARC-I1 fixture; the delivery succeeds and is intercepted exactly once — `tools/verify-coverage.mjs`, 6/6 paths |
| A-20 | Repair: the provider gate excluded the contracts package | **PASS** | The boundary is the package, not a path prefix: a provider reference anywhere outside `packages/onekey` fails the gate (73 source files scanned) |
| A-21 | Repair: the contracts package was modified since the baseline | **PASS** | `packages/contracts/src` is byte-identical to `e7a5e3f`. The one change outside it (a `tsconfig.json` `extends` path made relative) is enumerated in `docs/contracts-baseline-amendments.json`; the gate verifies both halves |
| A-22 | Repair: the exit criteria were unproven | **PASS** | `docs/exit-criteria.json` — 16 rows, 13 met and proven by a named check, 3 owner-blocked with the blocking authority and the unblock path named. The rubric forbids counting an owner-blocked row as a pass |
| A-23 | Repair: tests passed without exercising behaviour | **PASS** | `tools/verify-coverage.mjs` (counting guardian wrapper + operator negative control) and `tools/verify-repoint.mjs` (static seam + dynamic re-point + non-vacuity + build-freshness) added as blockers |
| A-24 | Repair: the README and the log contradicted the build | **PASS** | README verify scope, tool list, ADR range, layout and deployment section corrected; log §6, §11 and §11.1 counts reconciled to the live run |
| A-25 | Repair: `npm run verify` omitted `verify-all` | **PASS** | `verify` = build → test:only → verify-all → secrets:scan → sbom → checksums → attest. The command the README publishes is the command CI runs |
| A-26 | Repair: six runtime exports were dead code | **PASS** | 8 dead exports found by a cross-package scan (6 named by the reviewers, 2 found by the repair scan). Each is now exercised: `FALLBACK_TIER_ROLE`, `FORBIDDEN_LEDGER_FIELDS`, `DEFAULT_SETTINGS`, `QWEN_MAINLAND_BASE_URL`, `createSource`, `localOverridePath`, `isCommittedDefault`, `snapshotEmission`. `LedgerStoreOptions.valueScan` is now tested for both halves — the escape hatch works and the field-name rule still fires. Zero dead runtime exports remain |
| A-27 | Repair: the portability gate was not idempotent | **PASS** | Unique sandbox per run (`mkdtemp`), a sandbox that is removed on success and kept on failure, junction-safe deletion that cannot follow a link into the real tree, and an EPERM/EBUSY retry for transient Windows delete failures |
| A-28 | Render correction (owner: "NEVER SAID RAILWAY, USE RENDER") | **PASS** | The Railway framing came from the assistant's own harness policy, not from the source documents (which contain 0 Railway mentions). It had contaminated proposal §9.4 and ADR-0009. Both rewritten; `remaining "Railway": 0`, `remaining "Hobby": 0` across the proposal |
| A-29 | Evidence chain: deterministic SBOM, machine-readable report, checksums, attestation | **PASS** | SBOM is byte-identical across two runs (content-derived v5 serial; `SOURCE_DATE_EPOCH` → git commit date → now). `verify-all` writes `artifacts/verify-report.json`; `tools/checksums.mjs` hashes 173 files; `tools/attest.mjs` binds all three and **refuses** a red build — proved by injecting a red report and a tampered report, both refused, exit 1, with the stale attestation removed |
| A-30 | Batch 5 suite after the repairs | **PASS** | 394 tests reported, 394 passed, 0 failed, 0 cancelled, 0 skipped; `META-GATE PASS` |
| A-31 | Third full gate sweep (`verify-all`) | **PASS** | 14 gates, 14 passed, 0 blockers failed, 0 warnings, exit 0 |
| A-32 | Recover the round-2 Santa verdicts, which the previous session never read | **PASS (verdicts FAIL)** | Reviewer B: FAIL on C10 — raw hex literals live in `apps/cli/public` and the design-token gate could not see them; the amendments register has no `commit` field. Reviewer C: FAIL on C1 — P1-1 was recorded `met` while neither enrolment branch existed. Both verdicts were exported from the reviewer sessions and parsed. |
| A-33 | Run the suite against the tree the previous session left behind | **FAIL (2 tests)** | 413 reported, 411 passed: the widened scan scope began seeing the gates' own negative fixtures. Triaged as a **gate defect**, not a product defect. The concurrent session then committed `99563c9` with the suite green at 414/414. |
| A-34 | Dispatch an 8-surface forensic audit swarm (intent vs reality, per package) | **PARTIAL** | 4 of 8 surfaces completed — F1 traceability, F3 OneKey, F5 ledger, plus Solo's own first-hand review of the live tree. F2 accessibility, F4 identity, F6 verification+tools, F7 runtime reality and F8 security were **killed by repeated OpenCode server restarts**, not by a defect in the build. Disclosed in `docs/AUDIT_ROUND3.md` §6; those surfaces are NOT audited to completion. |
| A-35 | Repair: a provider reporting ZERO usage threw an untyped `Error` out of `complete()` | **PASS** | `budget.ts:78` refuses a zero-unit charge and `gateway.ts:302` re-threw anything that was not `BudgetExceededError`, so the whole fallback ladder was bypassed. The gateway now treats an empty answer and an uncostable answer as provider failures and walks to the next tier. 2 new gateway tests. |
| A-36 | Repair: the kill-switch reason reached the DELIVERED result unredacted | **PASS** | `gateway.ts:253` and `policy.ts:173` interpolated the raw reason, and `decision.reason` becomes `meta.policyReason` on the delivered result. `redactSecret` is now applied at both sinks; a new test asserts the credential appears in neither the attempt trail nor the result. |
| A-37 | Repair: P1-4 was MISLABELLED — the PWA rendered the DARK theme by default | **PASS** | The stylesheet's base `:root` defined the dark canvas and the light tokens were reachable only through an opt-in `[data-theme="light"]` attribute the document never set, so the page rendered dark with light browser form controls painted over it. `<html data-theme="light">`; **new blocker gate `pwa-light-default`** with 4 negative fixtures; P1-4's evidence now cites that gate. |
| A-38 | Repair: ADR-0013 recorded a `node:sqlite` repository interface and adapter that exist nowhere | **PASS** | No source file imports `node:sqlite`; `private-store.ts` says it is in-memory by design. **ADR-0017 supersedes ADR-0013** and records the truth (in-memory behind a repository seam; the adapter is deferred to Slice 1). ADR-0013's decision text is preserved unchanged. The ledger README and `render.yaml` no longer claim a SQLite-backed store. |
| A-39 | Repair: the ADR index contradicted the ADR records, and the accountable role was unregistered | **PASS** | All four local ADRs name *Chief Systems Architect*; the index named three different roles; and that role had no row in the appointment register, so nobody could ever be appointed to it. The index now mirrors the records, the role is registered **VACANT**, and the **new blocker gate `adr-governance`** parses the index, requires a non-placeholder owner that is a registered role, and cross-checks each record against its row. P0-2 now cites the gate — its old string-contains check could not detect a missing owner. 4 negative fixtures. |
| A-40 | Regenerate the evidence chain at the release commit | **PASS** | The committed attestation had named `gitHead 7889041` while the tree shipped in `99563c9`. The SBOM, the checksum manifest and the attestation are regenerated after the code commit and committed in a follow-up commit. |
| A-41 | Full gate sweep after the round-3 repairs | **PASS** | **16 gates, 16 passed, 0 blockers failed, 0 warnings, exit 0**; 425/425 tests through the meta-gate; secrets scan 171 files / 0 findings with a live canary. |
| A-42 | Repair: the **egress boundary had no production caller** — the only real provider adapter shipped raw grounded context to the third party | **PASS** | `projectGroundedContext` was written — the projector the contract itself demanded (*"grounded context needs its own projector before it may be sent; until then it is refused"*) — and the adapter now projects the request and its context before a byte is built. A locator that names a filesystem path or a URL is refused; only `locator` and `text` travel; the rest of the lineage record stays in the process. 10 new tests. |
| A-43 | Repair: the budget was tested **after** the provider had already been paid | **PASS** | The adapter now tests the pool against the WORST case the request can cost, before the call. A refusal is not a denial: the gateway treats a budget refusal as a fall-through to the next tier, and Tier 0 still answers. |
| A-44 | Repair: routing trusted the **client-declared** data class and safety tier; `policy.dataClass` and `policy.safetyTier` were dead inputs | **PASS** | The effective classification is now the stricter of the request's own claim and the server-side policy's — a request may only ever make the routing stricter, never looser. The policy trace records the effective values, not the request's claim. |
| A-45 | Repair: Tier 0's last resort asserted topical coverage unconditionally | **PASS** | The notice is now score-aware. A lesson that shares no word with the task says so instead of claiming to cover the topic. The learner still receives a lesson — the promise that a learner is never denied is unchanged. |
| A-46 | Repair: the conformance suite called `dispose()` before the behavioural rules, so rule 7 passed **vacuously** on the resulting refusal | **PASS** | `dispose()` is now the LAST rule, where it can affect nothing. |
| A-47 | Repair: the provider base URL was unvalidated, so a credential could be attached to a plaintext, file or link-local endpoint | **PASS** | `assertSafeBaseUrl` runs at construction: HTTPS, or HTTP on loopback; no credentials in the URL. A bad configuration is a startup failure, not a runtime surprise. |
| A-48 | Repair: the build could leave a **STALE `dist` silently** — and it did | **PASS** | `tsc -b` decides a project is up to date by comparing TIMESTAMPS, so a source file edited while a build was running was skipped by every later build: the output was newer than the input. A test was in the source, absent from the compiled output, and the suite passed without it. `build` and `typecheck` now run `tsc -b --force`, so the published command always recompiles. Reproduced: the test count moved 437 → 438 the moment the forced rebuild took effect. The deeper fix — detecting staleness by content, not by timestamp — is a Slice 1 item. |
| A-49 | Repair: the sponsor report **silently defaulted** the producer keys it depends on | **PASS** | A `credit_consumed` entry missing `fallback_tier` read as "no fallbacks", missing `served_offline` as "not offline", and missing `requested_units` made availability read 100 %. A producer that renamed a key therefore produced a clean number that meant nothing, presented to a sponsor as accountability. The keys the report depends on are now REQUIRED and a missing one is refused with the entry and the key named. `cost_cents` and `latency_ms` stay optional — an absent figure is not a false figure. |
| A-50 | Repair: the sponsor report **published over a broken chain** (`chainOk=false` as a field) | **PASS** | The chain is verified before any figure is produced and the report refuses to publish over a broken chain. A report computed over a tampered chain is a decoration, not accountability. |
| A-51 | Repair: the ledger **accepted negative money** | **PASS** | Every money field records something that WAS spent, allocated or received, and each of those is non-negative; a negative amount is a sign, not an amount. Negative money is refused, and a refund must be its own entry type so the public chain never needs a negative number to express it. |
| A-52 | Full verification after the third repair batch | **PASS** | **16 gates, 16 passed, 0 blockers failed, 0 warnings, exit 0**; **441/441** tests through the meta-gate; secrets scan clean with a live canary. The test fixture was itself carrying the drift — two of its three `credit_consumed` entries omitted `served_offline` — so the convention is now explicit in the fixture rather than assumed. |
| A-53 | Repair: P0‑5 claimed an accessibility CI job and a red build that did not exist | **PASS** | A dedicated `accessibility` CI job now runs the ARC‑I1 negative fixtures — each builds the smallest tree that must fail and asserts the gate refuses it — so the job is red whenever the gate would let a violating emission through, and then requires the accessibility-contract gate to be green on the real tree so the first step cannot be vacuous. P0‑5's evidence cites the workflow, the gate and the fixture test. |
| A-54 | Security surface audit (F8) — **12 findings, 3 of which narrow repairs this session made** | **PARTIAL** | The reviewer was stopped by the account's free-usage ceiling, so the surface is partially reviewed. Findings recorded in `docs/AUDIT_ROUND3.md` §4.1. Three are corrections to this session's own work: `assertSafeBaseUrl` constrains the scheme but not the destination (R13 narrowed, not closed); the egress boundary lives in one adapter rather than in the gateway (R8 narrowed, not closed); and the consent service performs no authorisation at all. Recorded rather than buried. |
| A-55 | Full verification at the release commit | **PASS** | `npm run verify` → **16 gates, 16 passed, 0 blockers, 0 warnings**; **441/441** tests; secrets scan clean with a live canary; the attestation's `gitHead` names the code commit it ships with. Working tree clean. |
| A-32 | Round-2 Santa review (Reviewer B and Reviewer C, both fresh) | **FAIL (both)** | B: 2 critical issues (C10 ×2). C: 1 critical issue (C1). 3 merged blockers plus 3 defects the repair itself uncovered — see §12.2 |
| A-33 | Repair: the enrolment path the Phase 1 criterion names did not exist | **PASS** | `packages/identity/src/enrolment.ts`: a guardian consent token, verified against the identity service's own verifier, bound to one learner, single-use, expiring; the learner enrols provisionally; the scopes the guardian authorised become ordinary consent grants; the path taken is written to the enrolment audit log. The passkey seam refuses with a typed error naming the deferred ceremony (D-05). 13 tests. **A defect in my own first implementation was caught by my own test**: the presented token's claims were trusted, so a caller could widen the scopes — the token is now a handle to server-side claims and a mismatch is refused |
| A-34 | Repair: the design-token gate could not see the shipped browser assets | **PASS** | One shared scan root (`listScannableDirs`): `packages/*/src`, `apps/*/src`, `apps/*/public`, `tools/`, `assets/`; `.svg` and `.webmanifest` added to the scanned extensions. Widening it immediately exposed 5 findings the narrow scope had hidden. A literal in a format that cannot express a CSS variable (the manifest, the icon, the theme-color meta) is allowed **only** when the value is one the token stylesheet defines — a checked exemption, not a hole. Two of the five findings were false positives of my own making and were fixed at the cause: SVG path geometry is not personal data, and a scanner must not name a provider |
| A-35 | Repair: the contract amendments recorded no introducing commit | **PASS** | `commit` is now a required field of an amendment, it must exist in the clone, and it must be an ancestor of HEAD. The one amendment records `05d3a79` |
| A-36 | Repair found while writing the negative fixtures: the frozen-contract gate ignored untracked files | **PASS** | `git diff` cannot see a file that was never tracked, so a new file inside the frozen surface would have passed unnoticed. The gate now lists untracked files under `packages/contracts/` and treats them as changes. 6 new negative fixtures: a raw colour in source FAILS, an asset may hold a token colour, an asset colour that is not a token FAILS, an amendment without a commit is rejected, a change inside the frozen surface can never be allowlisted, an unlisted contracts change FAILS |
| A-37 | Repair: the secrets scan had no proof that it detects anything | **PASS** | `tools/secrets-scan.mjs` now plants a canary token in a throwaway directory and runs the SAME detection code over it; it refuses to pass unless the canary is found. This is the verification method the P5-5 criterion names, which nothing had implemented |
| A-38 | Repair: the `onAttempt` audit hook had no caller | **PASS** | A test proves the hook receives every rung of the ladder, in order, with the outcome recorded |
| A-39 | Repair: the officer register recorded one name where the architecture document names three | **PASS** | `docs/OFFICERS.md` now records the Chief AI & Model Orchestrator (Marcus Thorne) and the Chief Learning Scientist (Nelly / Dr. Elena Rostova) exactly as 09 names them. Ten roles remain vacant, so P0-6 stays owner-blocked |
| A-40 | Repair: four exports had no caller outside their own module | **PASS** | `createFailingProvider`, `buildFailoverDrillGateway`, `buildExhaustionDrillGateway` and `entryHashPreimage` are module-internal now. The public seam matches what callers actually need |
| A-41 | Repair: the README stated the Render free-tier limits as though this build had measured them | **PASS** | They are now labelled TARGET LIMITS quoted from the vendor's published documentation, not achieved results. The README also names `npm audit` as the dependency advisory check of record and states that a tool resolving a different working directory is not evidence about this project |
| A-42 | Round-2 suite after the repairs | **PASS** | 414 tests reported, 414 passed, 0 failed, 0 cancelled, 0 skipped; `META-GATE PASS` |
| A-43 | Round-2 gate sweep (`verify-all`) | **PASS** | 14 gates, 14 passed, 0 blockers failed, 0 warnings, exit 0 — over 126 scanned files (102 before the scope repair) |

---

## 6. Evidence ledger (every acceptance claim points at a row here)

| Claim | Evidence required | Status | Evidence |
|---|---|---|---|
| Contract invariants are enforced | Named invariant cases, one broken fixture each | **PASS** | 12 fixtures, one per ARC invariant; each asserts exactly one violation with the right id, severity and path |
| All five fallback tiers are exercised | A named failover drill whose recorded transitions cover every tier across its scenarios | **PASS** | `packages/onekey` failover drill: a 3-scenario report (`offline-rescue`, `human-deferral`, `exhausted`); tiers 0→1→2→3→4 are reached across the report — not in one ladder, because the drill's whole point is that the ladder is walked and abandoned, then resumed at Tier 0 |
| No learner path depends on a provider SDK | A static gate that fails on a provider host outside `packages/onekey` | **PASS** | `no-provider-leak-gate` — blocker, green. The boundary is the PACKAGE, not `packages/onekey/src/providers`: the rule is that nothing outside the OneKey package may name a provider at all, so a provider reference in `apps/` or `packages/ledger/` fails the build |
| The ledger holds no learner PII | Recursive field-name + value-shape refusal, tamper detection | **PASS** | 63 ledger tests, incl. nested / case-variant keys, email-shaped values, and 5 injected mutations all killed |
| Core learning is never denied on credit exhaustion | A test that exhausts the budget and asserts Tier 0 still answers | **PASS** | gateway test: budget at zero still returns a Tier 0 answer |
| No API key is exposed | A secrets scan over the tracked tree, plus a canary proving the scan detects one | **PASS** | 168 files scanned, 4 skipped, 0 findings — and the scan's own canary self-test passes, so "0 findings" is a measurement, not an inert scanner |
| The build is portable | Copy-to-new-path run with a different profile, zero source edits | **PASS** | `tools/verify-portability.mjs` — see §11 |
| No critical dependency vulnerabilities | `npm audit` in the build repo (the MCP analyzer resolved the wrong root — §11.2) | **PASS** | 0 critical / 0 high / 0 moderate / 0 low / 0 total; `dependencies: {}`; dev deps are `typescript` + `@types/node` only |
| Two independent reviewers pass | Santa Method dual review, both PASS | **PENDING** | dispatched after the gate sweep; see §12 |
| Tokens meet WCAG in both themes | Contrast gate over resolved custom properties | **PASS** | 46 checks, 46 passed, 0 failed |
| The test command cannot silently run nothing | Meta-gate floor | **PASS** | `tests reported: 414`, floor 20, `META-GATE PASS`. History: 345 at A-11, 347 at A-15, 378 after the Batch 1–4 repairs, 394 after the Batch 5 contract-fidelity and export-coverage tests, 414 after the round-2 repairs (enrolment, scan scope, negative fixtures) |

---

## 7. Rules this build obeys

1. **No deployment.** The platform is **Render** (owner correction, 2026-11-12). The Render account and its two workspaces were read live; no EduGenesis workspace exists and no state-changing Render command was run. Nothing is pushed to a production account.
2. **No learner data.** Synthetic data only until a data processing agreement exists (ADR-0012).
3. **No secrets in the repo.** API keys are read from the settings file, which is gitignored, and are never logged.
4. **Every claim is evidenced.** A green status is not a deployed artifact; a passing test is not a working product.
5. **Independent review only.** The build is never certified by the agent that produced it.

---

## 8. Swarm dispatch record

| Swarm unit | Package | Session | Status |
|---|---|---|---|
| S1 — accessibility contract engine | `packages/accessibility` | `ses_e2f96e1bbffeycO2cC9errOcBo` | **complete**, committed `550e540` |
| S2 — OneKey gateway + 5 fallback tiers | `packages/onekey` | `ses_e2f96e1b2ffe2yBL7os27uvxDX` | files complete; session hit usage ceiling; integrated + verified by Solo |
| S3 — ledger + private store + 60 % engine | `packages/ledger` | `ses_e2f96e1b0ffe4WR2BJtW2cdb6y` | **complete**, committed `a91f8da` |
| S4 — identity, RBAC/ABAC, consent, age, risk | `packages/identity` | `ses_e2f96af41ffeGHGCjkGc5xqNPw` | **complete**, committed `7b2cf58` |
| S0a — CLI, settings UI, bootstrap, CI, SBOM, secrets scan, ADRs 13–16 | `apps/cli`, `tools/`, `settings/`, `.github/`, `docs/adr/` | `ses_e2f960e9dffeTZmaB4za6UV520` | files complete; session hit usage ceiling; integrated + verified by Solo |
| S5 — verification harness + contrast gate + portability gate | `packages/verification`, `tools/verify-*` | `ses_e2f960e9affe8US1QYK0Mw8HmX` | files complete; session hit usage ceiling; integrated + verified by Solo |

**Contract freeze.** `packages/contracts/src/index.ts` was compiled clean and smoke-imported before any implementation agent was dispatched (`tsc -b packages/contracts` exit 0; 8 runtime exports; 21 forbidden ledger field names; 5 fallback tiers; default settings load). The workspace links resolve: `@edugenesis/contracts` imports cleanly from the repo root.

**Baseline commit:** `e7a5e3f` — foundation, frozen contracts, workspace scaffold. The rubric's C10 requires `packages/contracts` to be unmodified since this commit.

**Review rubric:** `REVIEW_RUBRIC.md` — 15 criteria, each with an objective pass condition. Two independent reviewers must both PASS for the slice to be accepted.

**Attribution note.** Work produced by a unit whose session ended before it could commit is committed by Solo with the unit named in the commit body. No unit's output was accepted on trust: every package was rebuilt and re-tested by Solo before its commit.

---

## 9. Integration findings and repairs

| # | Finding | Detected by | Repair | Evidence |
|---|---|---|---|---|
| A-07 | **False green in the test harness.** `node --test <directory>` on Node 24 resolves the path as one module: reports `tests 1 / pass 1 / fail 0`, exit 0, and runs **no** tests. A CI pipeline built on that form would have verified nothing while reporting success. | S1 and S3 independently; S3 proved it by injecting a deliberately failing probe into `dist/` — the glob form failed, the directory form still reported pass | `tools/assert-tests-ran.mjs` — a meta-gate that parses the reporter counts and fails the build when fewer than the floor ran. Every script now uses the glob form. | Solo reproduced: glob `tests 74 / pass 74`; directory `tests 1 / pass 1`. |
| A-07b | **The meta-gate itself would not parse.** Its own doc comment contained a glob (`**/`) which terminates a block comment, so the file was a syntax error and every `npm run test:only` would have failed. | Solo, on first run of the gate | Comment rewritten without a literal glob; `node --check` exit 0. | `node --check tools/assert-tests-ran.mjs` → exit 0; then 345/345. |
| A-08 | **Absolute-path leak in the scaffolder.** `tools/scaffold.mjs` wrote the build host's absolute path (drive letter + user name) into every tsconfig `extends` and project `path`. Breaks the portability law on any other machine. | Solo (S1 flagged it after repairing its own package) | Scaffolder writes relative paths; `tools/fix-tsconfig-paths.mjs` repairs and verifies; the portability gate owns the regression. | `tsconfig paths repaired: 2 file(s) changed of 7 inspected`; `verification: no absolute paths remain in any tsconfig` |
| I-01 | **Cross-unit payload convention seam.** The ledger's sponsor report reads the keys `units`, `requested_units`, `cost_cents`, `latency_ms`, `fallback_tier`, `served_offline`, `amount_cents`, `category`. These are S3's definition. If another unit writes different key names, sponsor metrics read empty. | S3 (raised, not silently assumed) | Named integration task: freeze the key set in `packages/contracts` before any sponsor-report consumer is built. Slice 0 has no such consumer, so nothing is currently misreported. | open, scoped to Slice 1 |
| P-01 | **Policy question raised by S3.** The 60 % engine counts an allocation once (allocation side only) when the same amount is also recorded as a `device_purchase`. | S3 | Requires an explicit Finance Lead ruling rather than an implicit one. | open, owner decision |

### 9.1 Gate-sweep findings (first `verify-all` run, commit `05d3a79`)

Five blocker FAILs. Each was classified **before** any edit. The classification rule: if the product
behaves correctly and the gate misreads it, the gate is repaired; if the product is wrong, the product
is repaired. A gate is never relaxed to manufacture a pass.

| # | Gate | Classification | Root cause | Repair | Direction |
|---|---|---|---|---|---|
| A-12a | `accessibility-contract` | **Gate defect** | The fixture hashed the raw body string; ARC-I9 hashes the canonical **content object**. A valid emission therefore failed with a spurious `ARC-I9`. | Gate borrows the package's own `hashCanonicalContent`; a third fixture asserts a tampered digest **is** caught. | **stricter** (new assertion) |
| A-12b | `failover-drill` | **Gate defect** | `findDrill` matched `buildFailoverDrillGateway` and called a *builder*; it returned a gateway object, so "tiers observed: none". | Builders (`build|create|make|new`) are excluded from drill resolution; `runFailoverDrill` is resolved. | unchanged (correct semantics) |
| A-12c | `no-pii-in-source` | **Real defect** | Doc comments carried literal email/phone examples; two fixtures used a real-looking name and a real-looking phone number. | Comments rephrased without literals; fixtures use documented synthetic markers (`Synthetic Learner`, `+000 000 0000`, `learner@example.org`); `synthetic` added to the documented allowlist. | unchanged (fixtures are still refused by the ledger guard) |
| A-12d | `no-provider-leak` | **Gate defect + real defect** | The gate excluded only `onekey/src/providers/`, contradicting its own title, C10 and ADR-0001, so the registry flagged itself. Separately, `apps/cli` doc examples named a provider. | Exclusion corrected to `packages/onekey/` (the ADR boundary); CLI examples now say `<providerId>`. Rubric C5 wording corrected to match C10/ADR-0001 **before** review. | unchanged outside the boundary |
| A-12e | `path-portability` | **Gate defect** | `/[A-Za-z]:\\/` matched the last letter of English words in template strings (`settings:\n`, `schema:\n`, `machine:\n`) — three false blockers. | Boundary lookbehind: a drive letter must be a standalone token. Two regression tests added (escape sequence ignored; lowercase drive letter still caught). | **stricter** (regression tests) |

**Residual risk documented, not hidden.** A string that begins a line with a single lowercase letter,
a colon and a newline escape (`s:\n`) would still be read as a drive letter. No such string exists in
the tree, and the positive lowercase test proves real lowercase paths are still caught.

---

## 10. Swarm unit completion record

| Unit | Package | Commit | Evidence reported | Solo verification |
|---|---|---|---|---|
| S1 | `packages/accessibility` | `550e540` | 74 tests / 74 pass; one broken fixture per ARC invariant, each asserting exactly one violation with the right id, severity and path; RED evidence captured per module | `tsc -b` exit 0; glob run 74/74 |
| S3 | `packages/ledger` | `a91f8da` | 63 tests / 63 pass; **5 injected mutations, all killed** (revert-must-fail-restore); ledger hash independently reproduced with Windows `Get-FileHash -Algorithm SHA256` — an auditor can verify any entry with a stock tool | `tsc -b` exit 0 |
| S4 | `packages/identity` | `7b2cf58` | Local-key identity, RBAC+ABAC policy, atomic consent withdrawal, age assurance, session risk | `tsc -b` exit 0 |
| S2 | `packages/onekey` | Solo-integrated | Policy router, budget, circuit breaker, kill switch, 5 tiers, conformance suite, failover drill | `tsc -b` exit 0; failover + budget tests green |
| S0a | `apps/cli` + tooling | Solo-integrated | CLI, Settings UI, bootstrap, CI, SBOM, secrets scan, ADRs 13–16 | `doctor` 8 PASS / 1 WARN / 0 FAIL; schema check OK; secrets 0 findings |
| S5 | `packages/verification` + gates | Solo-integrated | 9 executable gates, contrast gate, portability gate | contrast 46/46; `verify-all` report in §11 |

**TDD ordering deviation disclosed by S3:** implementation was written before the tests for the frozen-contract package; the red-green property was instead proven per behaviour by the 5-kill mutation run. Disclosed rather than hidden.

**False-green caveat carried forward:** any unit that reported its own test count using a directory argument reported a vacuous result. Every count in this table was re-run by Solo with the glob form through the meta-gate.

---

## 11. Gate sweep (Solo-run, final)

| Gate | Command | Result |
|---|---|---|
| Typecheck, all packages | `tsc -b … --pretty false` | **exit 0** |
| Full suite + meta-gate | `assert-tests-ran.mjs --min 20 -- node --test …` | **414 / 414 pass**, 0 fail, `META-GATE PASS` |
| Token contrast | `node tools/verify-contrast.mjs` | **46 checks, 46 passed, 0 failed** — both themes |
| Secrets | `node tools/secrets-scan.mjs` | **168 files scanned, 0 findings**, plus the canary self-test proving the scan detects a planted token |
| SBOM | `node tools/sbom.mjs` | CycloneDX written to `artifacts/sbom.cdx.json` — byte-identical across two runs (content-derived serial, commit-date timestamp) |
| Checksums | `node tools/checksums.mjs` | **173 files** hashed into `artifacts/checksums.sha256`, sorted by relative path |
| Attestation | `node tools/attest.mjs` | `artifacts/attestation.json` written; **refuses** a red report and refuses a tree that no longer matches the manifest |
| Settings schema | `node tools/settings-schema-check.mjs` | **OK** — committed default and local override both valid, no key in the tracked file |
| Doctor | `node apps/cli/dist/doctor.js` | **8 PASS, 1 WARN, 0 FAIL** (WARN = uncommitted worktree during the build) |
| All gates | `node tools/verify-all.mjs` | see §11.1 |

### 11.1 `verify-all` output

Recorded from the live run at commit `ca26c4f` plus the Batch 1–5 repairs; the portability gate copies the
project to a path containing a different user-like segment and points `USERPROFILE` / `HOME` at a
non-existent directory.

| Gate | Severity | Result | Detail |
|---|---|---|---|
| accessibility-contract | blocker | **PASS** | broken emission blocked, complete emission accepted, tampered hash caught |
| failover-drill | blocker | **PASS** | all three scenarios hold, all five tiers were reached, and Tier 0 rescued the learner |
| ledger-integrity | blocker | **PASS** | clean chain verifies, tampering is detected, personal data is refused |
| consent-withdrawal | blocker | **PASS** | sharing blocked by withdrawal, core learning still permitted |
| no-pii-in-source | blocker | **PASS** | no personal data found in 126 source files |
| no-provider-leak | blocker | **PASS** | no provider reference outside `packages/onekey` in 97 source files |
| path-portability | blocker | **PASS** | no absolute path in 120 shipped files |
| design-token-governance | blocker | **PASS** | no raw colour literal in 126 source files |
| contracts-baseline | blocker | **PASS** | frozen contracts unchanged; 1 enumerated packaging change |
| exit-criteria | blocker | **PASS** | 13 met, 3 owner-blocked of 16 exit criteria |
| token-contrast | blocker | **PASS** | every role pair meets its WCAG requirement in both themes |
| path-portability-runtime | blocker | **PASS** | the copy runs from a different path under a different profile |
| guardian-coverage | blocker | **PASS** | every learner-facing delivery path is guarded exactly once (6/6, with an operator negative control) |
| provider-repoint | blocker | **PASS** | swapping the provider is a registry entry, and no learner-path source changed |

```
gates: 14   passed: 14   blockers failed: 0   warnings: 0
RESULT: PASS — no blocker failed.
exit 0
```

The first sweep was **5 blocker FAILs** (`accessibility-contract`, `failover-drill`, `no-pii-in-source`,
`no-provider-leak`, `path-portability`). Each was triaged as a gate defect or a real defect before any
edit — see §9.1. No gate was weakened to produce this pass; two gates were made stricter (a tampered
content hash must now be caught, and the path scanner has a positive lowercase-drive regression test).

Four gates were **added** in Batch 4–5, because the claims they prove were previously made in prose:
`guardian-coverage` (every learner-facing emission is intercepted exactly once), `provider-repoint` (a
provider swap is a registry entry, proved by a dynamic re-point with an unchanged source hash), plus the
static `contracts-baseline` and `exit-criteria` gates. The gate count moved 10 → 14.

**The scan scope moved too, in round 2.** The static gates used to read `packages/*/src` and
`apps/*/src` only, so they reported PASS over files they had never opened — including the shipped
browser assets, where raw colour literals had accumulated. Every static gate now reads one shared
root (`listScannableDirs`): the sources, the app public folders, `tools/` and `assets/`. The scan
grew from 102 files to 126, and the suite moved 347 → 414 tests.

### 11.2 Dependency evidence (scope note)

`npm audit` in the build repo: **0 info, 0 low, 0 moderate, 0 high, 0 critical**. Direct dependencies:
`typescript` and `@types/node` only; `dependencies` is `{}`. The seven runtime roots `npm ls` reports are
the workspace packages themselves.

The `dependency-analyzer` MCP tool was invoked, but it resolves the **session working directory**
(`C:\Users\pc`), not the build repo — it reported `exceljs`, `pg`, `xlsx`, `mammoth`, which are not this
project's dependencies. That report is therefore **not** evidence for this build and is not used as such.
`npm audit` inside the build repo is the evidence of record.

---

## 12. Santa review (dual, independent)

**Method.** Two reviewers, identical rubric, no shared context, no memory of the build, neither is the
agent that wrote the code. Both must return PASS against `REVIEW_RUBRIC.md` (15 criteria) before the
slice is accepted. Any `critical_issues` entry is a fix-blocker; the fixes are applied, then **both**
reviewers are re-spawned fresh. Maximum three rounds, then escalation to the owner.

| Round | Reviewer B | Reviewer C | Outcome |
|---|---|---|---|
| 1 | **FAIL** | **FAIL** | 11 merged critical issues; all repaired, then both re-spawned fresh for round 2 |
| 2 | **FAIL** | **FAIL** | 3 merged critical issues, plus 3 defects the repair itself uncovered; all repaired, then both re-spawned fresh for round 3 |
| 3 | pending | pending | — |

**Dispatch failures in round 2 (infrastructure, not review).** The first two dispatch attempts did not
run: the `code-reviewer` agent's default model (`anthropic/claude-opus-4-5`) is not available on this
provider, and the paid fallbacks (`opencode/claude-opus-5-5`, `opencode/gpt-6.1-sol`) are refused by
the account's balance. The round-2 reviewers were therefore run on free models from two different
families — `opencode/deepseek-v4.1-flash-free` and `opencode/glm-5.3-flash-free` — which keeps the
context isolation the method requires. The failures are recorded here rather than hidden, because a
review round that did not happen is not a passed review.

### 12.1 Round 1 — verdicts and repairs

Both reviewers returned **FAIL**. The two sets of `critical_issues` were merged and deduplicated: where
the reviewers agreed, the finding was counted once; where they disagreed, the union was kept, because a
finding one reviewer made and the other missed is still a finding. Eleven issues survived deduplication.

| # | Merged critical issue | Reviewer anchor | Repair | Evidence the repair holds |
|---|---|---|---|---|
| 1 | The real learner path blocks every emission, so nothing can be delivered | `gateway.ts:478`, `failover.test.ts:17-20` | The learner path now runs the REAL guardian against a valid ARC-I1 fixture; a delivery that the guardian accepts reaches the caller | `tools/verify-coverage.mjs`: 6/6 learner-facing deliveries, guarded exactly once, with an operator negative control at 0 interceptions |
| 2 | Tier 0 never serves | `gateway.ts:443` | Two-phase Tier 0: an exact `serve()` first, `serveFallback()` as the last resort after the paid ladder (§6.6 `2 → 3 → 0 → 4`). The fallback is **not** gated on `paidAttempted` | `gateway.test.ts` asserts `0:no-offline-content → 1:failed → 2:failed → 3:failed → 0:served` |
| 3 | The provider gate excluded the contracts package | `no-provider-leak-gate.ts:37-40` | The boundary is the PACKAGE: any provider reference outside `packages/onekey` fails | gate green over 73 source files |
| 4 | The contracts package was modified since the baseline | `packages/contracts/tsconfig.json` vs `e7a5e3f` | `packages/contracts/src` restored to byte-identical with the baseline. The one change outside `src/` (a relative `extends` path) is enumerated as a **packaging-only** amendment | `docs/contracts-baseline-amendments.json` + the `contracts-baseline` gate, which verifies both halves |
| 5 | The exit criteria were asserted, not proven | `docs/exit-criteria.json` | A 16-row register: 13 met and each mapped to a named passing check; 3 owner-blocked with the blocking authority and the unblock path named | the `exit-criteria` gate: `13 met, 3 owner-blocked of 16` |
| 6 | Tests could pass without exercising behaviour | `gateway.test.ts:61-80`, `:99-116` | Two new blocker gates that count rather than assert: a counting guardian wrapper over every delivery path, and a dynamic provider re-point with a source-hash comparison | `tools/verify-coverage.mjs`, `tools/verify-repoint.mjs` |
| 7 | The README contradicted the build | `README.md:19/35/49/59/87` | Verify scope, tool list, ADR range, repository layout and the deployment section rewritten against the live tree | `README.md` now matches `package.json` script by script |
| 8 | The process log contradicted the build | `SESSION_PROCESS_LOG.md:98 vs :117`, `:109` | The stale provider boundary (`packages/onekey/src/providers` → `packages/onekey`), the tier claim (one ladder → the 3-scenario report), and every test count reconciled to the live run | §6, §11, §11.1 of this log |
| 9 | `npm run verify` omitted the gates, so the published command proved less than the claim | `package.json` `scripts.verify` | `verify` = build → test:only → verify-all → secrets → sbom → checksums → attest | `npm run verify` runs the full chain; CI runs the same command |
| 10 | Six runtime exports were dead code | dead-export scan | Each is now exercised by a test that asserts something true about it; `LedgerStoreOptions.valueScan` is tested on both halves (the escape hatch works, the field-name rule still fires) | A-26; zero dead runtime exports remain |
| 11 | The portability gate was not idempotent and could delete the tree it was testing | `tools/verify-portability.mjs` | Unique sandbox per run, removed on success and kept on failure, junction-safe deletion, EPERM/EBUSY retry | A-27; the gate passes twice in a row and leaves no sandbox behind |

**Round 1 outcome:** both reviewers FAIL, so the slice is **not** accepted. Repairs were applied to the
merged list only; no criterion was relaxed and no gate was weakened to force a pass. Round 2 is
dispatched against the identical, corrected rubric, with both reviewers re-spawned fresh.

### 12.2 Round 2 — verdicts and repairs

Both reviewers returned **FAIL** again, on three critical issues. Reviewer C audited the exit-criteria
register row by row and found one row whose evidence proved a different behaviour from its criterion.
Reviewer B audited the gates against their own scope and found one that was reporting PASS over files
it had never read.

| # | Merged critical issue | Raised by | Repair | Evidence the repair holds |
|---|---|---|---|---|
| 1 | **P1-1 was recorded as `met` but the enrolment criterion was not implemented.** The Phase 1 criterion 1 reads "a learner can enrol via passkey, or via provisional identity plus guardian consent token; the path taken is recorded in the audit log". The frozen `IdentityService` has only `register`/`authenticate`/`get`/`assignRole`; there was no provisional identity, no guardian consent token, no enrolment audit log, and the cited evidence (`identity.test.js`) proved credential-verifier security instead. A criterion the builder could have satisfied in pure code was mislabelled as met | Reviewer C (C1) | `packages/identity/src/enrolment.ts` — the guardian-consent path, implemented end to end: a token bound to one learner, verified through the identity service's own verifier, single-use, expiring; the scopes the guardian authorised become ordinary consent grants, so a later withdrawal locks them like any other; the path taken is written to the enrolment audit log. The passkey seam refuses with a typed error naming the deferred ceremony (D-05) | 13 tests in `packages/identity/dist/enrolment.test.js`; the register row now points at them. **A defect in my own first implementation was caught by my own test**: the presented token's claims were trusted, so a caller could widen the scopes. The token is now a handle to server-side claims, and a mismatch is refused |
| 2 | **The design-token gate was reporting PASS over files it never read.** Raw colour literals sat in `apps/cli/public` (`index.html`, `manifest.webmanifest`, `icon.svg`), and the gate scanned only `packages/*/src` and `apps/*/src` with no `.svg` or `.webmanifest` extension. The rule was unenforced exactly where the shipped assets live | Reviewer B (C10) | One shared scan root for every static gate — `listScannableDirs` = `packages/*/src` + `apps/*/src` + `apps/*/public` + `tools/` + `assets/`, with `.svg` and `.webmanifest` added. A literal in a format that cannot express a CSS variable is allowed **only** when the value is one the token stylesheet defines: a checked exemption, not a hole. Widening the scope immediately exposed 5 findings the narrow scope had hidden | 126 files scanned (was 102); the gate passes over the wider tree; 3 new negative fixtures prove it can still fail |
| 3 | **The contract amendments recorded no introducing commit.** The rubric requires the file, the reason and the commit; the schema had no commit field, so the requirement could not be enforced | Reviewer B (C10) | `commit` is a required field of an amendment, it must exist in the clone, and it must be an ancestor of HEAD | `docs/contracts-baseline-amendments.json` records `05d3a79`; the gate refuses an amendment whose commit is unknown or not in this history |

**Three further defects the repair itself uncovered** — these were not raised by either reviewer, and
they are recorded because they are the reason the round-2 sweep was not simply a patch:

| # | Defect | How it was found | Repair |
|---|---|---|---|
| 4 | **The secrets scan had no proof that it detects anything.** The P5-5 criterion says "verifiable by the canary-token sweep" and nothing implemented a canary sweep. "0 findings" is also what an inert scanner reports | Auditing the criterion against its own stated verification method while repairing it | `tools/secrets-scan.mjs` plants a canary in a throwaway directory and runs the SAME detection code over it; it refuses to pass unless the canary is found. The canary is assembled from fragments so the scanner does not find it in its own source |
| 5 | **The frozen-contract gate ignored untracked files.** `git diff` compares commits to the working tree but does not report a file that was never tracked — so a brand-new file inside `packages/contracts/src` would have been invisible to the freeze | Writing the negative fixture for issue 3 | The gate now lists untracked files under `packages/contracts/` and treats them as changes |
| 6 | **The `onAttempt` audit hook had no caller** — API surface that looked live and was not | Reviewer C (suggestion) | A test proves the hook receives every rung of the ladder, in order, with the outcome recorded |

**Suggestions taken from both reviewers** (none of them relax a criterion): the officer register now
records the three roles the architecture document names (ten remain vacant, so P0-6 stays
owner-blocked; §13 adds an eleventh — the role the ADRs name as accountable had no row at
all — so eleven now remain); four exports with no caller outside their own module are now module-internal; the
README labels the Render free-tier limits as TARGET LIMITS quoted from vendor documentation rather
than measurements this build made; and the README names `npm audit` as the dependency advisory check
of record, stating that a tool resolving a different working directory is not evidence about this
project.

**Round 2 outcome:** both reviewers FAIL, so the slice is **not** accepted. Every merged issue is
repaired. Round 3 is the last round the method allows; if it does not produce two PASS verdicts, the
decision escalates to the owner rather than continuing.

---

## 13. Round 3 — the forensic audit (a different question from the rubric)

Round 1 and round 2 asked *does the build satisfy its own rubric?* Round 3 asked a different
question: **for every function in the tree, does it do what the code, the contracts, the docs
and the ADR set say it does — and does the running system actually do the thing the
proposal sells?**

**Method.** Eight surfaces were audited in parallel against a frozen snapshot
(`eg-audit-snapshot`, 180 files) so a finding could not drift while it was being read. Four
surfaces completed; four were killed by repeated OpenCode server restarts and are **not**
audited to completion — disclosed in `docs/AUDIT_ROUND3.md` §6 rather than hidden.

**Result.** 73 findings — **10 blockers, 31 majors, 32 minors, every one PROVEN**. Machine
register: `docs/gap-register.json`. Report: `docs/AUDIT_ROUND3.md`.

**The headline.** Genesis Slice 0 is a **library plus a gate suite**, not a running learner
product, and three documents said otherwise. The served API exposes `/api/health` and
`/api/settings` and nothing else; `apps/` imports the platform packages in one file
(`apps/cli/src/selftest.ts`); the enrolment service has **zero runtime callers**; and no store
is durable — no source file imports `node:sqlite`, although ADR-0013 promised an adapter
behind a repository interface. ADR-0017 now records the truth, the README states the slice
boundary, and `render.yaml` no longer claims a SQLite-backed store.

**Repairs in this round** are in the attempt log at A-35 … A-41. Two **new blocker gates**
were added, each proven able to fail by negative fixtures: `pwa-light-default` and
`adr-governance`. No gate was weakened; P0-2 and P1-4 were made *stronger* by replacing
evidence that could not fail with gates that can.

**Three suspicions were refuted** before they entered the register, and are therefore not
findings: the suspected UTF-8 corruption in `package.json`/`index.html` (0 U+FFFD in tracked
files), the suspected missing `PORT` handling in `eg serve` (it honours `process.env['PORT']`
in hosted mode), and the suspected placeholder credential hashing (real scrypt, salted
verifier, `timingSafeEqual`).

**Still open.** Six blockers in `packages/onekey` — the egress allowlist has no production
caller while the only real adapter ships raw grounded context to the provider; routing trusts
client-declared `dataClass`/`safetyTier`; Tier 0's last resort serves an unrelated lesson
while claiming it covers the topic; the hard cap does not bound real spend; the conformance
suite destroys a live adapter's credential and then fails its own budget rule because of it;
and no adapter is required to run that suite. All are closable in code. Four **owner
decisions** are listed in `docs/AUDIT_ROUND3.md` §5.

**The Santa round-3 verdict is still outstanding.** The rubric method is unchanged: two
fresh, independent reviewers must both PASS. This audit does not substitute for it.
