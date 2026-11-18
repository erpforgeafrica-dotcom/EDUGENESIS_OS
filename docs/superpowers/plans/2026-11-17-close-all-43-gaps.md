# Close the 43 Open Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive `docs/gap-register.json` open set (43 IDs: 0 blocker, 11 major, 32 minor) to zero pending items — each either **closed with reproducible proof** or **owner-gated with an exact unblock path** — without weakening a test, a gate, `checksPass`, or a security control.

**Architecture:** A bounded servo loop. Builders work in parallel on disjoint file sets; the orchestrator alone integrates, builds, tests and commits. Independent read-only judges re-check each closure against code and test output. The loop terminates on a deterministic verifier (`tools/verify-gap-loop.mjs`), a 3-retry cap per ID, or an owner gate. The owner flips final acceptance; the loop never self-certifies.

**Tech Stack:** TypeScript 5.9, Node 24, `node --test`, 18 repo gates, `npm run verify:repro`, Render web service, CDP browser probes.

**Spec:** `docs/gap-register.json` (each finding carries `intent`, `reality`, `evidence`, `failure_mode`, `fix`). `docs/AUDIT_ROUND5.md` (value-chain verdict). `docs/DESIGN-CONSTITUTION.md` (C1–C7 boundaries).

## Global Constraints

- Open set = `findings.filter(f => !reconciliation.closed_ids.includes(f.id))` — exactly 43 IDs. No other list is authoritative.
- Owner-gated, **no code action**: `F8-12` (hosted `GET /api/settings` visibility). Owner has chosen "escalate, never act". Also escalated, never claimed: NVDA/VoiceOver session, GitHub billing, Render workspace move, pilot region.
- Boundary / anti-Goodhart: no test deleted, weakened, skipped or renamed to pass; no gate relaxed; no `autoDeployTrigger` change; no secret printed; no false "screen-reader validated" claim; no doc edited after its evidence run.
- Builders NEVER run `npm run build`, `npm run verify`, or `npm test`: the worktree is shared and `dist/` is written by the orchestrator only. Builders write code + tests, then report exact files and lines.
- Evidence format per ID: `docs/gap-closure-evidence.json` record `{id, status: "closed"|"owner-gated"|"pending", proof: "<command + observed result + file:line>", verified_by: "<judge agent>", at: ISO}`. A `closed` record without a reproducible command is not evidence and is rejected by the judge.
- Retry cap 3 per ID; on the third failure the ID stays `pending` and the loop terminates with a terminal report, not an infinite retry.
- `verify-gap-loop.mjs` exit 0 = no `pending` IDs and every `closed` record has non-empty proof; exit 2 = pending remains; exit 3 = malformed evidence. Exit code is final.

---

## Task 1: Loop instrumentation (orchestrator, before the swarm)

**Files:** Create `tools/verify-gap-loop.mjs`, `docs/gap-closure-evidence.json`, this plan.

- [ ] **Step 1: Seed the evidence ledger.** For each of the 43 open IDs write a record with `status: "pending"` and empty `proof`; set `F8-12` to `owner-gated` with proof text naming the owner decision and the exact path to close it.
- [ ] **Step 2: Write the verifier.** It reads the register, computes the open set, asserts the ledger has exactly those 43 IDs, counts statuses, rejects `closed` records with empty/short proof, prints a table, and exits 0/2/3 as specified.
- [ ] **Step 3: Run it once by hand.** Expected: exit 2 with 42 pending + 1 owner-gated (F8-12). The verifier asserts that count against the register at run time; if the register has drifted, it fails rather than guessing.

## Task 2: Lane A — identity / consent (5 IDs)

**Files:** `packages/identity/src/enrolment.ts`, `packages/identity/src/enrolment.test.ts`.

| ID | Decidable end state |
|---|---|
| F0-05 | `issueGuardianConsentToken` refuses a caller without the guardian authoriser; test names the refusal, 2 tests. |
| F0-06 | Age band is written only from an age-assurance attestation; caller band recorded as `ageBandUnverified`; 3 tests. |
| F0-10 | Scope matching is order-insensitive; a reordered scope set is admitted; 1 test. |
| F0-08 | A guardian token can be revoked before expiry and a revoked token is refused; 2 tests. |
| F0-09 | `enrolmentMethod` is read by a named consumer or removed from the write path; 1 test pins the chosen behaviour. |

Before editing, check whether a later round already closed the ID in code; if so, report `already-closed` with `file:line` and no diff.

## Task 3: Lane B1 — gateway / redaction / circuit (10 IDs)

**Files:** `packages/onekey/src/gateway.ts`, `gateway.test.ts`, `redact.ts`, `redact.test.ts`, `circuit-breaker.ts`, `circuit-breaker.test.ts`.

| ID | Decidable end state |
|---|---|
| F3-07 | Core learning is never denied on credit exhaustion; no learner-facing credit message; 2 tests. |
| F3-15 | Provider error thrown to the learner contains no HTTP status, provider id or "credential"; 1 test. |
| F3-18 | The nine-element compliance emission is attached to the returned decision, not discarded; 1 test. |
| F3-21 | `riskTier` derives from the request safety tier; 1 test with two tiers. |
| F3-22 | ARC-I4 uncertainty note is reachable from at least one adapter's confidence; 1 test. |
| F3-25 | Per-request attempt trail is evicted by a bounded size/TTL; 1 test. |
| F3-36 | Gateway and policy engine share one breaker and kill-switch instance, or the constructor refuses a mismatch; 1 test. |
| F3-23 | Docstring says six rungs, matching the registry; 1 assertion in the existing ladder test. |
| F3-26 | Redaction covers non-string values on every error path in the package; 2 tests. |
| F3-28 | Half-open circuit admits exactly one probe and promotes on outcome, not on read; 2 tests. |

## Task 4: Lane B2 — policy / failover / conformance / registry (9 IDs)

**Files:** `packages/onekey/src/policy.ts`, `.test.ts`, `failover.ts`, `.test.ts`, `conformance.ts`, `.test.ts`, `registry.ts`, `.test.ts`, `index.ts`, `testing/support.ts`.

| ID | Decidable end state |
|---|---|
| F3-19 | A routing decision never promises a Tier 0 delivery when no Tier 0 provider is registered; 1 test. |
| F3-31 | Locale is an eligibility rule where declared, not only a tie-break; Tier 0 does not hard-filter it; 2 tests. |
| F3-32 | Capabilities are re-read from the adapter at decision time, not from a stale registration snapshot; 1 test. |
| F3-16 | One request walks all five tiers and `tiersExercised` records the double Tier 0 visit; 1 test. |
| F3-33 | The drill is offline for real (no injected gateway) or the claim is corrected; 1 test. |
| F3-09 | Conformance refuses to run without a real adapter and the registered adapter passes; 2 tests. |
| F3-34 | Public surface no longer re-exports the concrete Qwen adapter, and the guard exemption is removed; 1 gate/test. |
| F3-27 | Dead options/exports (`refuseOverBudget`, `timeoutMs`, `GatewayOptions.policyEngine`, `tryProjectEgressPayload`) are removed or given one real caller; 1 compile/test assertion. |
| F1-09 | Model card + lifecycle, signed Tier 0 bundle pipeline, adapter regions allowlist, Tier 2 adapter exist with one test each. Owner-gated decision inside this ID: if a signed bundle requires an external signing key, stop and mark `owner-gated` rather than fake a signature. |

## Task 5: Lane B3 — provider adapters (4 IDs)

**Files:** `packages/onekey/src/providers/qwen-adapter.ts`, `.test.ts`, `providers/local-echo.ts`, `.test.ts`.

| ID | Decidable end state |
|---|---|
| F3-29 | `statusText` is redacted before entering the audit trail; 1 test. |
| F3-30 | The 429 retry-after hint is acted on by an actual retry, or the hint is not advertised; 1 test. |
| F3-24 | `latencyMs` is measured; 1 test with a delayed adapter. |
| F3-35 | Input-token estimate includes request context; 1 test. |

## Task 6: Lane C — ledger (7 IDs)

**Files:** `packages/ledger/src/ledger-store.ts`, `.test.ts`, `pii-guard.ts`, `.test.ts`, `private-store.ts`, `.test.ts`, `reinvestment.ts`, `.test.ts`, `sponsor-report.ts`, `.test.ts`.

| ID | Decidable end state |
|---|---|
| F5-13 | Negative money at append is refused; homoglyph/ZWSP field evasions refused; sponsor-report key drift fails loudly; 3 tests. |
| F5-07 | Value scanning detects names/free-text PII under innocuous keys and obfuscated values; 3 tests. |
| F5-08 | Private store has durable, tested isolation at rest (no plaintext private records); 2 tests. |
| F5-10 | Semantically duplicated funding/allocation entries are detected; 2 tests. |
| F5-04 | `all()` returns defensive copies; in-process mutation cannot change an entry; 1 test. |
| F5-12 | Timestamps are strict ISO-8601 and the canonical preimage uses the normalised form; 2 tests. |
| F5-09 | Out-of-period allocations are handled explicitly in 60% compliance math; 2 tests. |

## Task 7: Lane D — docs / CI / evidence tooling (4 IDs + 1 gated)

**Files:** `docs/exit-criteria.json`, `README.md`, `.github/workflows/ci.yml`, `tools/secrets-scan.mjs`.

| ID | Decidable end state |
|---|---|
| F1-07 | Exit criterion cites evidence that actually proves "no learner-facing credit message"; 1 gate assertion. |
| F1-10 | CI file implements GL-01..GL-08 jobs; inability to *run* CI because of billing is recorded as owner-gated proof, not a fake green. |
| F1-12 | README documents env vars, PORT, health check and rollback with commands; 1 docs check. |
| F8-09 | History scan and artifacts coverage are proven by the secrets-scan canary self-test; 1 command output. |
| F8-12 | **Owner-gated, no code change.** Proof text names decision and unblock path. |

## Task 9: Reconciler continuation — three IDs the first plan missed

`node tools/verify-gap-loop.mjs` exited 2 after the six judge batches with exactly
three pending IDs: `F1-13`, `F8-07`, `F8-11`. The verifier's ID-set assertion is
what caught the omission; no ID was silently dropped.

| ID | Decidable end state | Owner |
|---|---|---|
| F1-13 | `docs/adr/ADR-0020-accessibility-emission-shape-deviation.md` records the frozen-contract deviation with its reason and the unimplemented Doc 7 preference rows; index row added; `contracts-baseline`, `accessibility-contract` and `adr-governance` all PASS. | Orchestrator (docs only) |
| F8-07 | Egress projection happens once in the gateway for EVERY adapter; a non-Qwen adapter receives no raw nested `req.context`; a grounded learner answer still works; Qwen still works. | Dedicated agent (gateway + egress) |
| F8-11 | Kill state persists through an injectable atomic sink and reloads on startup; kill and revive require an authorised actor + reason; a safety kill needs a different reviver; corrupt state is refused loudly. | Dedicated agent (kill-switch + gateway) |

These three are judged with the same independent-judge contract as Tasks 2–7.
Only when their records are merged does the verifier reach exit 0.

## Task 8: Orchestrator wire pass + judge (integration)

- [ ] **Step 1:** Build once (`npm run build`), fix compile errors with `build-error-resolver`, run the full test suite.
- [ ] **Step 2:** Run `npm run verify` — 18/18 gates required; any new failure returns to the owning lane (max 3 retries).
- [ ] **Step 3:** Dispatch fresh read-only judge agents per lane with `code-review` + `verification-before-completion`. Judges write evidence records only; builders cannot judge their own lane. Judges re-run the named commands against the integrated tree.
- [ ] **Step 4:** Run `node tools/verify-gap-loop.mjs`. Exit 0 required. Any `pending` ID goes back to its lane once; after 3 failures it is escalated in the terminal report.
- [ ] **Step 5:** Extend the live probe with assertions for every newly delivered runtime behaviour; refresh evidence (`npm run verify:repro`), commit, push, hand-trigger Render, poll live, run the probe.
- [ ] **Step 6:** Final report: proof matrix (ID → command → observed), owner gates, honest limitations. Owner flips acceptance.

## Self-Review

- Coverage: all 43 open IDs appear in Tasks 2–7; F8-12 is explicitly owner-gated; F1-09 has an in-task owner gate for external signing.
- Placeholder scan: no TBD/TODO; every task names exact files and test counts.
- Type consistency: lane file ownership is disjoint; shared types from `packages/contracts` are read-only for all lanes; the orchestrator owns `serve.ts`, audit docs, evidence and the probe.
