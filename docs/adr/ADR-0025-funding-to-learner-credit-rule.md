# ADR-0025 — Funding-to-learner-credit rule: from 60 % reinvestment to a pseudonymous learner pool

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-17
- **Supersedes:** nothing; closes the W2 value-chain gap between ADR-0019 (durable public ledger) and the shipped `reinvestment.ts` / `sponsor-report.ts`
- **Governed by:** REVIEW_RUBRIC.md C13 — *an ADR that contradicts the code is a FAIL*; Doc 1 v1.2 §6 and Doc 16 §3.5 (the 60 % promise); Doc 2 §2.5 (no personal data on the public ledger); GLOBAL.md §9 (portability)
- **Decided by:** the owner, 2026-11-17 — the missing hop is an APPLICATION seam (`apps/cli/src/sponsor.ts`), not a new package and not a contract change.

## Context

The platform already records and publishes the 60 % reinvestment promise. `reinvestment.ts` computes, in integer minor units, that at least 60 % of eligible funding (`sponsor_pledge`, `sponsor_deposit`, `grant_awarded`) must be allocated to delivery capacity, and `sponsor-report.ts` publishes that figure to the Anchor Sponsor. ADR-0019 made the public ledger durable behind the store's existing seams.

What was missing was the **hop between the money and a learner**. The chain ran:

```
sponsor money -> sponsor_pledge entry -> 60% reinvestment_allocation entry -> sponsor report
```

…and stopped. There was no rule that turned a reinvested amount into a countable unit of learner access, no place to hold that unit, and no accounting discipline that prevented a duplicate funding event from minting credits twice. The gap left three questions unanswered:

1. How many learner-access units does a reinvested amount buy, exactly?
2. Where do those units live, without putting a person's identity into the public ledger?
3. What honest limit applies when the pool is empty — does a zero balance stop a learner learning?

## Decision

**A funding event deterministically mints integer credit units from the 60 % reinvestment, and those units live in a pseudonymous pool. No frozen contract changes.**

### 1. The conversion rule (integer, reproducible)

For a funding event of `amountCents` (a positive safe integer) at rate `rateBps` (default `6000` = 60 %):

```
reinvestmentCents = floor(amountCents * rateBps / 10_000)   // BigInt intermediate
creditsGranted    = floor(reinvestmentCents / creditUnitCents)
```

`creditUnitCents` defaults to **10**: one unit pays for one paid-tier lesson. The division is integer throughout, so the same event always mints the same number of units on any machine (GLOBAL.md §9). Example: 1000 cents → 600 cents reinvested → **60 credits** at 10 cents per unit. The `reinvestment_allocation` entry is appended **only when the reinvested amount is positive**, so a zero rate produces no allocation and no credits.

### 2. The pool (pseudonymous, private backing)

Credits are held in a runtime SQLite table keyed by `sponsor:<sponsorId>` — the sponsor's **pseudonymous** reference (`sponsor-<sha256(ref).slice(0,12)>`). The human-readable ref is stored **only** in the private store; the public ledger carries `sponsor_ref` (the pseudonym), `amount_cents`, `currency`, `funding_id` and the allocation fields — flat scalars, no personal data. A same-named learner key is seeded in the same transaction so the first pseudonymous session can draw a unit without a separate transfer step. No key in either table identifies a person.

### 3. Idempotency (atomic, crash-safe)

The idempotency key is checked **first**. A seen key returns the original sequence with `duplicate: true`, `creditsGranted: 0`, and appends nothing. For a new key, the pledge is appended (file-first, durable), the optional allocation is appended, and **the key insert plus both balance upserts commit in one synchronous SQLite transaction**. A crash therefore cannot leave a funded pledge without its key, which would double-credit on replay. Ledger appends and the runtime commit are all synchronous, so there is no interleaving window.

### 4. The honest limit — a zero balance NEVER blocks core learning

`consumeCredit()` decrements with a conditional `UPDATE ... WHERE balance >= 1` and appends a `credit_consumed` entry **only on success**. With a zero balance it returns `false` and writes **nothing** to the ledger. That `false` means only *"this paid-tier pool has no unit to spend"*. **Tier 0 / core learning — deterministic, offline, no model provider (contract `TierZeroProvider`, fallback tier 0) — is always available and is never denied by a false return.** Credits buy an enhanced paid tier; they are not a gate on the platform's promise to educate. The credit consumption entry records `fallback_tier: 0` / `served_offline: true` to make that boundary visible in the public record.

## Consequences

### Positive

- The sponsor's 60 % promise now has an unbroken, auditable line from pledge → allocation → countable learner-access units → a pseudonymous pool, all in integer arithmetic.
- Duplicate funding cannot inflate the pool; the idempotency key check precedes every append and write.
- The public ledger stays personal-data-free (enforced by the shipped PII guard); sponsor identity never crosses into it.
- The report refuses a broken chain (`F5-11`) and only a clearly marked, non-publishable draft may be built over one.
- No new runtime dependency and no change to the frozen `@edugenesis/contracts` surface.

### Boundaries / accepted limitations

- A credit balance is a **paid-tier** entitlement, not an access right. A zero balance is a normal state, not an error, and must never be rendered to a learner as a denial of core learning.
- `SponsorReportError` is not re-exported from the ledger package root, so the application recognises it by its stable `error.name`; no deep import is introduced.
- The backing pool is pseudonymous, not anonymous: `sponsorId` is a SHA-256-derived handle. It is still private data and stays out of the published chain.
- The `reason` supplied to `consumeCredit()` is retained in the private runtime table only; free text is never written to the public ledger.
- `publicLedger()` returns `exportPublic()` / `merkleRoot()` on a healthy chain. On a broken chain it reports via `verify()` and keeps the evidence readable through the safe `all()` accessor; the auditor-only `rawEntries()` is never exposed through the application surface.
