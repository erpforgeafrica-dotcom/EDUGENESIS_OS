# Round 6 — closing the 43 open gaps

**Goal (decidable):** drive `docs/gap-register.json`'s open set to zero *pending*
IDs — every ID either closed with a reproducible command and observed result, or
owner-gated with a named decision and unblock path. Boundary: no test, gate,
security control or `checksPass` weakened; no secret printed; no false
screen-reader or CI claim. Retry cap: 3 per ID; human keeps acceptance.

**Result:** `node tools/verify-gap-loop.mjs` → **exit 0**, 40 closed, 3
owner-gated, 0 pending, over exactly 43 reconciled IDs.

## Method (skills actually used)

`goal-loop-execution` (decidable goal, attempt log, no-spin terminal),
`loop-design-check` (servo vs regulator, boundary vs done-criterion, independent
judge, 3-retry damping), `writing-plans` (the plan at
`docs/superpowers/plans/2026-11-17-close-all-43-gaps.md`),
`parallel-agent-swarm` (six builders, disjoint file ownership, orchestrator wire
pass), `test-driven-development`, `systematic-debugging`, `code-review`,
`verification-before-completion`, and `edugenesis-ship-verify` (evidence hash
rule, commit/deploy order, live contract probe).

Builders wrote code and tests but never ran `npm build`, `verify` or `test` in
the shared worktree; the orchestrator compiled and ran everything. Six fresh
read-only judge agents re-ran the named commands and wrote the per-ID verdicts
into `docs/gap-closure-evidence.json`. Builders never judged their own lanes.

## Proof of work — per ID

The authoritative, machine-checked proof matrix is
`docs/gap-closure-evidence.json` (43 records: status, exact command, observed
PASS/gate detail, implementation `file:line`, judge, timestamp). It is inside
the checksum manifest, so a later edit to a claim is detectable.
`tools/verify-gap-loop.mjs` reconciles it against the register and rejects
drift, short proofs, or a missing unblock path. Summary by lane:

| Lane | IDs | Verdict | Representative judge command |
|---|---|---|---|
| Identity / consent | F0-05, F0-06, F0-10, F0-08, F0-09 | 5 closed | `node --test packages/identity/dist/enrolment.test.js --test-name-pattern="revok\|reordered scope set\|band"` |
| Gateway / redaction / circuit | F3-07, F3-15, F3-18, F3-21, F3-22, F3-25, F3-36, F3-23, F3-26, F3-28 | 10 closed | `node --test packages/onekey/dist/gateway.test.js --test-name-pattern="F3-07\|F3-15\|F3-18"` |
| Policy / failover / conformance / registry | F3-19, F3-31, F3-32, F3-16, F3-33, F3-09, F3-34, F3-27 | 8 closed | `node --test packages/onekey/dist/policy.test.js packages/onekey/dist/failover.test.js packages/onekey/dist/conformance.test.js` |
| F1-09 | model card, regions, Tier-2 adapter | 4/4 tests closed; signed bundle **owner-gated** | `node --test packages/onekey/dist/registry/*.test.js` |
| Provider adapters | F3-29, F3-30, F3-24, F3-35 | 4 closed | `node --test packages/onekey/dist/providers/qwen-adapter.test.js packages/onekey/dist/providers/local-echo.test.js` |
| Ledger | F5-13, F5-07, F5-08, F5-10, F5-04, F5-12, F5-09 | 7 closed | `node --test packages/ledger/dist/ledger-store.test.js packages/ledger/dist/pii-guard.test.js packages/ledger/dist/private-store.test.js packages/ledger/dist/reinvestment.test.js` |
| Docs / CI / evidence | F1-07, F1-12, F8-09 | 3 closed | `node tools/verify-all.mjs`, `node tools/secrets-scan.mjs` |
| F1-10 | CI GL-01..GL-08 written, run impossible | **owner-gated** | workflow structure read at `.github/workflows/ci.yml:1-35` |
| F8-12 | hosted settings visibility | **owner-gated** | no code change; decision recorded in the ledger |
| Reconciler continuation | F8-07, F8-11, F1-13 | 3 closed | `node --test packages/onekey/dist/egress.test.js packages/onekey/dist/gateway.test.js packages/onekey/dist/kill-switch.test.js apps/cli/dist/kill-switch-store.test.js`; ADR gate |

## Errors found and fixed during integration (each with proof)

| Symptom | Root cause | Fix and verification |
|---|---|---|
| `TS2305 FetchLike` missing from `@edugenesis/onekey` | F3-34 removed the whole Qwen module export, including a TYPE the CLI needs | type-only re-export added; compiler PASS; registry guard refined to reject value re-exports only |
| `TS2704 delete` on readonly property in new model-card test | test typed a `Partial<ModelCard>` that inherits `readonly` | typed as `Record<string,string>`; build PASS |
| PII guard test expected 1 violation, got 2 | F5-07 value scanning legitimately adds a name-in-value finding | assertion strengthened to name both violations; 5/5 judge PASS |
| `describeRedacted({token:...})` leaked its value | redaction matched value shapes but not sensitive KEY names | key-aware masking added; 2/2 judge PASS |
| Registry F3-34 guard failed on a type-only line | guard conflated `export type` with a value re-export | value surface isolated; type-only seam preserved; judge PASS |
| `exit-criteria` blocker FAIL on `secrets-scan.mjs` | two tests embedded literal `sk-...` keys — the scanner was right | keys built at runtime; scan PASS on 219 files + 469 history blobs, 0 findings, canary live |
| `ledger-integrity` UNVERIFIED | F5-04 defensive copies made the gate's in-place mutation probe impossible | gate uses the facade's `rawEntries()` auditor seam; gate PASS |
| F5-08 sealed-store test flaked | a 2-character id appeared by chance in random base64 ciphertext | structural key assertion + exact plaintext JSON check; 2/2 judge PASS |
| Reconciler exited 2 with 3 pending IDs | the first plan omitted F8-07, F8-11, F1-13 | verifier caught it; dedicated agent + ADR closed all three; verifier exit 0 |
| F8-07 grounded test expected paid tier, got Tier 0 | Tier 0 legitimately answers photosynthesis, short-circuiting the paid ladder | test disables Tier 0 so it actually exercises the egress seam; assertions intact; judge confirmed honest |
| F8-11 governance lost through the CLI store | onekey persisted actor/classification, CLI SQLite store projected them away | `governanceOf()` copies and validates both on load and save; round-trip test PASS |

## Owner-gated (escalated, never acted on)

1. **F1-10 — CI run.** The GL-01..GL-08 workflow is written, but GitHub Actions
   billing on `erpforgeafrica-dotcom` is locked, so there is no run to open.
   Unblock: owner enables billing, pushes `main`, records the run URL against
   P0-3. No fake green was claimed.
2. **F8-12 — hosted `GET /api/settings` visibility.** Owner decision 2026-11-17:
   escalate, never act. Unblock: owner decides whether the public read stays;
   then implement auth/redaction in `apps/cli/src/serve.ts` and extend the live
   probe. No code was changed.
3. **F1-09 — signed Tier-0 bundle.** Model card, regions allowlist and Tier-2
   adapter are closed and tested. The real signature needs a KMS/HSM key and a
   `BundleSignatureVerifier`; the code refuses unsigned bundles and delegates
   crypto, and a labelled test placeholder is never accepted as authentic.
   Unblock: owner supplies the key and verifier, then re-verify.

## Honest limits

- This remains **first-party engineering** with independent subagent judges, not
  an independent human audit. The four planned external audit waves failed on
  transport error (`ENOTFOUND opencode.ai`).
- No NVDA/VoiceOver session was run: screen-reader behaviour is **UNVERIFIED**.
- No GitHub Actions run and no remote signing key exist in this session.
- The learner-surface audit's programme verdict (ledger never written by a
  runtime route, no sponsor intake, no operator dashboard) is unchanged by this
  wave: closing register findings closes *documented defects*, not the missing
  product capability. That remains the owner's build decision.
