# EduGenesis OS — Build Session Process Log

**Session ID:** ses_e30099b68ffeUK5CTfRjiDKHe8
**Date:** 2026-11-12
**Objective:** Plan, orchestrate, build, test, verify and adversarially review the EduGenesis OS platform against the controlled baseline, looping until every exit criterion is met.
**Build root:** `C:\Users\pc\Desktop\new Global edu project\EDUGENESIS_OS_BUILD` (git repo, branch `main`)
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

Two skills govern the loop, and they are complementary rather than redundant:

| Skill | Role in this build | Rule applied |
|---|---|---|
| `goal-loop-execution` | Makes the loop **finite**. Every task has a machine-checkable end state; every attempt is numbered and logged with its exact error; the loop terminates with a terminal verdict rather than spinning. | No task without a decidable end state. No retry without a changed parameter. Terminal report if paths are exhausted. |
| `santa-method` | Makes the loop **adversarial**. Two independent reviewers with no shared context must BOTH pass before a build is accepted. | Fresh reviewers each round. Max 3 rounds, then escalate. Rubric criteria must have objective pass/fail conditions. |
| `dispatching-parallel-agents` | Makes the swarm **safe**. One agent per independent domain, no shared state, contracts agreed up front. | Agents get exactly the context they need, one domain each, and never edit each other's files. |

**Acceptance rule for this build.** A phase is accepted only when **all** of the following hold:
1. Its exit criteria are met and each has a named machine-checkable assertion.
2. The full test suite passes from a clean checkout.
3. `dependency-analyzer` (MCP) reports no critical vulnerabilities.
4. Two independent Santa reviewers both return PASS against the phase rubric.
5. The portability gate passes: the build runs from a **copy** at a different path with a different user profile, with zero source edits — first-run, settings change, and normal use.

---

## 3. Swarm decomposition (non-overlapping ownership)

Each agent owns exactly one package directory. Interfaces are fixed by contract **before** dispatch, so no two agents write the same file and integration is mechanical.

| Swarm ID | Owns | Builds | Cannot touch |
|---|---|---|---|
| **S0** | repo root, `packages/contracts`, `apps/cli`, `tools/` | Monorepo, portable bootstrap, settings store + Settings UI, `eg` CLI (`doctor`/`serve`/`settings`/`selftest`), CI workflow, SBOM, secrets scan, seeds, ADRs 13–16 | — (runs first; everything depends on it) |
| **S1** | `packages/accessibility` | The nine-element emission contract, validator, ARC-I1…I12 invariants, Accessibility Guardian interception, per-surface acceptance checks, equivalence matrix engine | other packages |
| **S2** | `packages/onekey` | Policy engine, budget/quota enforcement, circuit breaker, kill switch, `ProviderAdapter` interface + conformance suite, all five fallback tiers, documented failover test | other packages |
| **S3** | `packages/ledger` | Append-only hash chain, proofs, corrections, tamper detection, private store with a provable no-PII boundary, 60 % reinvestment engine | other packages |
| **S4** | `packages/identity` | Local identity service, RBAC + ABAC policy bundles, consent service with atomic withdrawal, age assurance, session risk | other packages |
| **S5** | `packages/verification` + `tools/` | The verification harness: token/contrast lint, a11y static gates, portability gate (copy-to-new-path run), full-suite runner, the attempt log and evidence ledger | other packages |

**Sequencing.** S0 first (it defines the contracts). Then S1–S5 dispatched **in parallel** against the frozen contracts. Then integration, full verification, dual Santa review, fix cycle.

---

## 4. Engineering decisions taken (each will be recorded as an ADR)

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
| A-05 | Check the build host capability | **PASS** | node v24.19.0, npm 11.17.0, git 2.55.0, rg present; **docker MISSING**, **python MISSING**; 320 GB free; target ports 3000/3001/5173/8080/5432/6379/27017 all free |
| A-06 | Create the build repo | **PASS** | `git init -b main` in `EDUGENESIS_OS_BUILD`; no pre-existing repo in `Desktop` to conflict with |

---

## 6. Evidence ledger (living — every acceptance claim must point at a row here)

| Claim | Evidence required | Status |
|---|---|---|
| Contract invariants are enforced | `eg selftest` exit code 0 with named invariant cases | pending |
| All five fallback tiers are exercised | A named failover test with recorded per-tier transitions | pending |
| No learner path depends on a provider SDK | A static check that fails if a provider import appears outside `packages/onekey/providers` | pending |
| The ledger holds no learner PII | A test that scans every ledger entry against the PII field list | pending |
| Core learning is never denied on credit exhaustion | A test that exhausts the budget and asserts learning continues at Tier 0 | pending |
| No API key is exposed | A secrets scan over the tree and over a rendered provider config | pending |
| The build is portable | A copy-to-new-path run with a different user profile, zero source edits | pending |
| No critical dependency vulnerabilities | `dependency-analyzer` MCP report | pending |
| Two independent reviewers pass | Santa Method dual review, both PASS | pending |

---

## 7. Rules this build obeys

1. **No deployment.** The Railway account has not been named in this conversation, so no Railway command may be run. Nothing is pushed to a production account.
2. **No learner data.** Synthetic data only until a data processing agreement exists (ADR-0012).
3. **No secrets in the repo.** API keys are read from the settings file, which is gitignored, and are never logged.
4. **Every claim is evidenced.** A green status is not a deployed artifact; a passing test is not a working product.
5. **Independent review only.** The build is never certified by the agent that produced it.
