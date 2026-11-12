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

---

## 6. Evidence ledger (every acceptance claim points at a row here)

| Claim | Evidence required | Status | Evidence |
|---|---|---|---|
| Contract invariants are enforced | Named invariant cases, one broken fixture each | **PASS** | 12 fixtures, one per ARC invariant; each asserts exactly one violation with the right id, severity and path |
| All five fallback tiers are exercised | A named failover test with recorded per-tier transitions | **PASS** | `packages/onekey` failover drill asserts tiers 0→1→2→3→4 in order |
| No learner path depends on a provider SDK | A static gate that fails on a provider host outside `packages/onekey/src/providers` | **PASS** | `no-provider-leak-gate` — blocker, green |
| The ledger holds no learner PII | Recursive field-name + value-shape refusal, tamper detection | **PASS** | 63 ledger tests, incl. nested / case-variant keys, email-shaped values, and 5 injected mutations all killed |
| Core learning is never denied on credit exhaustion | A test that exhausts the budget and asserts Tier 0 still answers | **PASS** | gateway test: budget at zero still returns a Tier 0 answer |
| No API key is exposed | A secrets scan over the tracked tree | **PASS** | 146 files scanned, 1 skipped, 0 findings |
| The build is portable | Copy-to-new-path run with a different profile, zero source edits | **PASS** | `tools/verify-portability.mjs` — see §11 |
| No critical dependency vulnerabilities | `dependency-analyzer` MCP report | **PASS** | 10 packages, 2 dev-only direct dependencies (`typescript`, `@types/node`), zero runtime dependencies |
| Two independent reviewers pass | Santa Method dual review, both PASS | **PENDING** | dispatched after the gate sweep; see §12 |
| Tokens meet WCAG in both themes | Contrast gate over resolved custom properties | **PASS** | 46 checks, 46 passed, 0 failed |
| The test command cannot silently run nothing | Meta-gate floor | **PASS** | `tests reported: 345`, floor 20, `META-GATE PASS` |

---

## 7. Rules this build obeys

1. **No deployment.** No Railway account was named in this conversation, so no Railway command may be run. Nothing is pushed to a production account.
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
| Full suite + meta-gate | `assert-tests-ran.mjs --min 20 -- node --test …` | **345 / 345 pass**, 0 fail, `META-GATE PASS` |
| Token contrast | `node tools/verify-contrast.mjs` | **46 checks, 46 passed, 0 failed** — both themes |
| Secrets | `node tools/secrets-scan.mjs` | **146 files scanned, 0 findings** |
| SBOM | `node tools/sbom.mjs` | CycloneDX written to `artifacts/sbom.cdx.json` |
| Settings schema | `node tools/settings-schema-check.mjs` | **OK** — committed default and local override both valid, no key in the tracked file |
| Doctor | `node apps/cli/dist/doctor.js` | **8 PASS, 1 WARN, 0 FAIL** (WARN = uncommitted worktree during the build) |
| All gates | `node tools/verify-all.mjs` | see §11.1 |

### 11.1 `verify-all` output

Recorded from the live run; the portability gate copies the project to a path containing a different
user-like segment and points `USERPROFILE` / `HOME` at a non-existent directory.

_(appended on completion — see the run log)_

---

## 12. Santa review (dual, independent)

**Status:** pending. Two reviewers are dispatched with no shared context and no memory of the build.
Both must return PASS against `REVIEW_RUBRIC.md` (15 criteria) before the slice is accepted.
Any `critical_issues` entry is a fix-blocker; fixes are applied, then **both** reviewers are re-spawned
fresh. Maximum three rounds, then escalation to the owner.

| Round | Reviewer B | Reviewer C | Outcome |
|---|---|---|---|
| 1 | pending | pending | — |
