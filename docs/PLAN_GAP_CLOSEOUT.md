# Gap close-out plan — the named findings, in waves

**Started:** 2026-11-15 · **Owner:** Founder & CEO (also the Chief Systems Architect)
**Goal:** close the findings named by the owner, in order, with every closure proved by
executable evidence and a clean, reproducible chain.

This plan is the contract between the orchestrating agent and the dispatched agents. Where it
names a seam, the seam is FIXED HERE — an agent implements it, it does not redesign it.

## The goals, in the owner's order

| # | Goal | Findings | Done when |
|---|---|---|---|
| 0 | **Make the audit truthful again** | F0-04, F1-14 closed; F8-04 and F5-01 marked partial | The register, the counts and the audit doc agree with the code, and the numbers are re-derived |
| 1 | **The demo answers anything** | provider wiring | The learner route registers the configured provider; a question outside the offline bundle is answered by the model; the provider being down still yields a lesson |
| 2 | **The provider cluster is honest** | F3-14, F3-13, F3-20, F3-11, F5-02, F5-03 | Each finding has a negative test that fails without the fix, and a green tree |
| 3 | **The learner message reads like a lesson** | F3-17 | The fallback message satisfies §6.6 and no longer apologises for itself |

## The schedule

```
Wave 0   parent      register reconciliation (goal 0)          — no code, docs only
Wave 1   parallel    LEDGER agent + ONEKEY agent               — different packages, no build collision
Wave 2   parallel    CLI agent (provider wiring + kill store)   — depends on wave 1's seams
Wave 3   parent      integration: chain, commit, push, deploy, live verification
```

**Why waves, not one swarm:** two agents must never build the same package at the same time
(`tsc -b` writes `dist/` and the buildinfo), and Wave 2 depends on seams that only exist after
Wave 1. Waves 1's two agents touch different packages, so they cannot collide.

**THE CHAIN DISCIPLINE (every wave):** source commit → `npm run verify` → `npm run verify:repro`
→ evidence commit. An agent NEVER commits and NEVER regenerates the artifacts; the orchestrator
does that, once, per wave.

## The fixed seams

### Seam 1 — the kill switch becomes shareable (F3-11)

Today the kill switch is a `Map` in one process: a kill issued on one replica does not stop
another. The fix is a persistence seam, NOT a new package dependency.

```ts
// packages/onekey/src/kill-switch.ts
export interface KillSwitchState {
  readonly killed: ReadonlyArray<{ providerId: string; reason: string }>;
  readonly records: readonly KillSwitchRecord[];
}

/** The durable store behind the kill switch. */
export interface KillSwitchStore {
  /** The persisted state, or undefined when nothing has ever been recorded. */
  load(): KillSwitchState | undefined;
  /** Persist the state. Called on every kill and every revive. */
  save(state: KillSwitchState): void;
}

export function createKillSwitch(opts: { now?: () => number; store?: KillSwitchStore } = {}): KillSwitch;
```

Rules: with a store present, the switch **hydrates from it at construction** (so a kill made
elsewhere is visible here) and **writes through on every change**. Without a store, the current
in-memory behaviour is unchanged — no existing caller changes.

The store's IMPLEMENTATION lives in the application (`apps/cli`), because the application owns
the durable stores. It is implemented over the existing SQLite private store — no new table, no
new package dependency.

### Seam 2 — the learner route registers the configured provider (goal 1)

The settings already carry `providers.primary`, `providers.secondary` and `providers.apiKeys`.
The `qwen` adapter already exists and is exported from `@edugenesis/onekey`. The route simply
never registered one.

- The learner service reads the settings ONCE at start, resolves the key for the primary
  provider id, and registers `createQwenAdapter({ apiKey, modelId })` on the gateway.
- **A missing key is not an error**: the route runs on tier 0 alone (today's behaviour).
- **A provider failure must not reach the learner**: the ladder falls through to tier 0, and the
  learner's message carries no provider name, quota, credit or outage (Doc 16 §6.6).
- **The key must never be logged, echoed in a response, or written to a record.**

### Seam 3 — provider error classification (F3-13, F3-14)

Both live in the provider adapter's error handling, and both need a shared distinction between
"this provider is sick" and "this request was refused":

- **A 401 or 403 is a CREDENTIAL failure.** The credential is revoked (marked dead, never
  retried) and the provider is skipped. It is NOT a health failure that should merely count
  towards a circuit breaker.
- **A 429 is a RATE LIMIT on a HEALTHY provider.** It must not open the health circuit.
- A 5xx / transport failure IS a health failure and counts towards the circuit.

## Wave 1 briefs

### Agent LEDGER — `packages/ledger` only

**skill:test-driven-development** (write the failing test first, watch it fail, then implement).

- **F5-02 — the sequence belongs to the store.** Concurrent appends must produce two DISTINCT
  `seq` values and one unbroken chain. Today `append` is not serialised, so two appends can
  claim the same `seq`.
- **F5-03 — the chain is verified on read and write.** A tampered entry must make a READ throw,
  not only an explicit `verify()` call. (The repo's own correction discipline: a compensating
  entry, never an edit.)
- Do NOT touch `packages/contracts`, `packages/onekey` or `apps/cli`.
- Report: the commands you ran, their real output, and the test names that lock each fix.

### Agent ONEKEY — `packages/onekey` only

**skill:test-driven-development** + **skill:root-cause-analysis** (these are behavioural defects:
find the mechanism, then prove the fix).

- **F3-14** — a 401/403 revokes the credential and is never retried (the adapter marks it dead;
  the gateway skips the provider and surfaces a governance-typed failure).
- **F3-13** — a 429 does not trip the health circuit.
- **F3-20** — the audit trail says "deferred to human support" only when a Tier 4 handler
  actually existed and accepted the work; otherwise it says `failed`.
- **F3-11** — implement Seam 1 exactly as written above.
- **F3-17** — the Tier-0 fallback message must satisfy Doc 16 §6.6 step 6 and must not frame
  the offline answer as a degraded maybe-wrong guess. It must read as a lesson a learner can use.
  The wording is yours, but the rules are not: no operations terms, no apology, no claim that the
  answer covers a topic it does not.
- Do NOT touch `packages/contracts`, `packages/ledger` or `apps/cli`. If a finding seems to need a
  contract change, REPORT it instead of making it.

## Wave 2 brief

### Agent CLI — `apps/cli` only

**skill:test-driven-development** + **skill:security-testing** (this wave handles credentials).

- Implement the provider wiring (Seam 2) and the kill-switch store (Seam 1's implementation, over
  the existing SQLite private store), and wire one shared kill switch into the gateway.
- A hosted instance still refuses enrolment (the policy decided in this session).
- The learner route's failure path must never leak a provider name, a key, a quota or a status
  code into a learner-facing message.

## Wave 3 — the orchestrator

1. Re-derive the register's counts from the code and update `docs/gap-register.json` +
   `docs/AUDIT_ROUND4.md` for everything closed in waves 1-2.
2. `npm run verify` → `npm run verify:repro` → commit source → commit evidence → push.
3. Trigger the Render deploy (CI is billing-locked, so the deploy is triggered by hand) and
   verify from OUTSIDE: health, `/learn`, `/api/learn`, `/api/enrol` → 403, `/api/audit` → 403.
4. Run the real-browser check against the DEPLOYED page (Chrome over CDP) and record it.

## The two findings this plan does NOT close, and why

- **F8-04 (partial) and F5-01 (partial)** — the consent and enrolment audit trails are durable
  now, and the private store is durable. The PUBLIC ledger is still an in-memory structure: a
  published, append-only record that dies with the process. Making it durable is a design
  decision (a file-backed journal vs. the platform's own ledger service), not a patch, so it is
  reported to the owner rather than half-built.
- **The screen-reader claim** — still UNVERIFIED. It needs a human with NVDA, JAWS, VoiceOver or
  Orca, and the `browse` relay on this machine does not start.

## Owner decisions this plan is waiting on

| Decision | Why it is the owner's | Effect if unanswered |
|---|---|---|
| GitHub billing lock | It is the account's billing, not the code | No CI job can run; the `checksPass` deploy guardrail stays inert and every deploy is manual |
| Render workspace | Render's MCP cannot create one; the two existing teams hold other products | The service lives in the KORA team |
| Pilot region (Frankfurt vs Singapore) | `render.yaml` says the region must be confirmed against the pilot | The service runs in Frankfurt |
| Repository visibility | The owner's repository | It stays public |
| Public-ledger durability | A design decision with a cost and a hosting shape | F8-04 and F5-01 stay partially open |
