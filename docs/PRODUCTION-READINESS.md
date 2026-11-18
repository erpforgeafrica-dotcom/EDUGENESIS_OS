# EduGenesis OS — Production Readiness (single source of truth)

This document and `production-ledger.json` are the one authority for the
20-item production backlog. `tools/verify-production-loop.mjs` reconciles the
ledger and the plan (`production-plan.json`) against the fixed PG-01..PG-20 ID
set: a missing ID, an extra ID, a closed record without reproducible proof, or a
plan that omits an ID fails. No status may be changed without proof.

Authority: one fact, one place. Details live in the ledger record, not here.
This file carries the method, the wave order and the honest verdicts.

## Baseline (Phase 0, re-verified this session — do not inherit)

- HEAD `f939585`, clean tree, branch `main` (verified 2026-11-17 17:10 local).
- `npm ci`: exit 0, 0 vulnerabilities.
- `npm run verify`: see `docs/verify-baseline.log` reference in session compact.
- `npm run verify:repro`: baseline from handover = 687 tests, 18/18 gates,
  4/4 byte-identical; re-run over the final tree at each wave release.
- Live probe: 38/38 PASS on `f939585` (see `\`%TEMP%\opencode\eg-live-probe-baseline.log\``).

## Immutable law (never weakened)

1. Zero runtime dependencies (Node 24, TypeScript, ESM, node:test, node:sqlite, node:crypto).
2. Frozen contracts stay frozen — a change needs a numbered ADR.
3. Core learning is never denied; no personal data in the public ledger;
   guardian coverage stays 100%; nine-element accessibility emission stays enforced.
4. No gate, test, checksum, scanner or evidence rule is weakened to pass. No fake green.
5. Evidence law: every claim VERIFIED / UNVERIFIED / OWNER-BLOCKED with a command,
   URL, file:line or screenshot. A builder never certifies its own work.
6. No secret, key or token printed, logged, committed or pasted.
7. No touching owner accounts, billing or Render secrets beyond hand-triggered deploy.

## Waves

- W1 Access & safety: PG-01, PG-02, PG-03, PG-13, PG-17 (first pass).
- W2 Value chain: PG-04, PG-05, PG-06 + end-to-end scenario + live probe.
- W3 Intelligence & content: PG-08, PG-09.
- W4 Surfaces: PG-07, PG-14.
- W5 Durability & ops: PG-10, PG-11, PG-12, PG-16.
- W6 Release: PG-15, PG-18, PG-19, PG-17 (final), santa-method pass.
- W7 Close-out: PG-20, final scoring, final report.

## Method

Each wave: Plan (exact files) -> TDD builders in disjoint territories -> fresh
read-only judges re-run named commands -> integrate -> `npm run verify` ->
`verify:repro` -> small descriptive commits -> push `main` (confirm via GitHub
API) -> `npm run release` (hand-triggered Render) -> live probe -> update ledger,
register, evidence and session compact. Never batch a wave into one unverified
commit. Build before judging (stale `dist` causes false failures). Root-cause a
failed gate with `systematic-debugging`; never edit the gate.

## Honest ratings at handover (unchanged until re-scored with evidence)

learner slice 84/100; programme value chain 42/100; overall 45/100 blocked.

## Judge independence

All judges are same-harness agents, not an independent human audit. No external
audit is claimed. Screen-reader behaviour is UNVERIFIED until a real NVDA/Narrator
session is captured. CI run (P0-3) stays OWNER-BLOCKED while GitHub Actions billing
is locked.
