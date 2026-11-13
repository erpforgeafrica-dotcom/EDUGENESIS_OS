# ADR-0017 — Storage is in-memory behind a repository seam in Slice 0; the `node:sqlite` adapter is deferred to Slice 1

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-13
- **Governed by:** Product law — the project must run identically on any Windows PC it is copied to (GLOBAL.md §9, portability law); and REVIEW_RUBRIC.md C13 — *an ADR that contradicts the code is a FAIL*.
- **Supersedes:** ADR-0013 (TypeScript on Node 24 with `node:sqlite` behind a repository interface).

## Context

ADR-0013 decided that persistence would go through a repository interface defined in
`packages/contracts`, with a `node:sqlite` implementation behind it.

**Slice 0 did not implement that decision.** This was found by the round-3 forensic
audit and is recorded here rather than papered over:

- No source file imports `node:sqlite`. The string appears only in ADR prose, the
  package README and the session process log — never in an `import`.
- `packages/ledger/src/private-store.ts` states in its own doc comment: *"The store
  is in-memory by design."*
- The public ledger store, the private store, the consent service's audit trail and
  the enrolment service's audit trail are all in-memory structures. No state survives
  a process restart.
- `packages/ledger/README.md` claimed the package depends on "`node:crypto` and
  `node:sqlite` only" — a dependency the code does not have.

The review rubric makes this a FAIL, not a nit: C13 requires the ADR set and the code
to agree, and C1 requires every claim to be backed by something executable. An ADR
that records a decision the code does not implement, plus a README that claims a
dependency the code does not have, is exactly the "value preparation" that does not
survive contact with the system.

Two repairs were possible: implement the adapter, or record the truth. The adapter
was rejected for this slice (see Alternatives). This ADR records the truth and keeps
the decision honest.

## Decision

**In Slice 0, every store is an in-memory implementation behind a repository-shaped
interface.** The driver is never imported by learner-path code, and the repository
seam is preserved so that a durable adapter can be substituted without touching a
caller. The `node:sqlite` adapter is **deferred to Slice 1** and is a tracked,
named item — not a claim, and not a README promise.

**Consequence that must be stated wherever this build is described:** Slice 0 has
**no durability**. The ledger, the private store and the enrolment and consent audit
trails are lost when the process exits. Nothing in this build may be described as
auditable across restarts, and the consent and enrolment audit trails must be read as
in-process records.

The seam is not speculative. It is the one place the portability law forces: a durable
adapter must be substitutable, and no learner-path module may name a storage driver.

## Consequences

**Positive**

- Zero install, no daemon, no service account, no port: the copy-and-run property
  the portability law demands is preserved exactly.
- Every store is deterministic, so the ledger's hash chain and the 60 % engine are
  reproducible in a test with no fixture files.
- The decision to defer is recorded before it is expensive, not discovered later.

**Negative — and these are real**

- Nothing survives a restart. The consent audit trail, the enrolment audit trail and
  the public ledger are process-scoped.
- The "append-only" guarantee of the ledger is an API-level convention inside one
  process, not a durability property.
- Any claim of auditability to a sponsor, an auditor or a regulator is unsupported
  until Slice 1 lands. Slice 0 must not make that claim.

**Neutral**

- `packages/contracts` stays frozen. The repository interface is expressed by the
  options objects the packages already expose (`LedgerStoreOptions`, the private
  store's options, the identity and consent service options), not by a new contract
  type, so no contract amendment is required.

## Alternatives considered

1. **Implement the `node:sqlite` adapter now.** Rejected for Slice 0. A repository
   interface belongs in `packages/contracts`, which is the frozen surface: changing
   it is a contract amendment, not a packaging amendment, and C10 forbids that
   path. The slice's exit criteria are the accessibility contract, the fallback
   ladder and the ledger's integrity properties — none of them require persistence.
   Persistence is a Slice-1 requirement with its own exit criteria.
2. **Keep ADR-0013 exactly as written and fix the code later.** Rejected. The ADR
   would still contradict the code, the README would still claim a dependency the
   build does not have, and C13 would still fail. The disagreement is the defect.
3. **Delete ADR-0013.** Rejected. A decision record that is deleted is a decision
   record that cannot be audited; the convention in `docs/adr/README.md` is that a
   wrong decision is superseded, not edited or removed.

## Revisit trigger

The first slice that needs state to survive a process restart — learner accounts
that outlive a session, or the public ledger on disk — implements the `node:sqlite`
adapter behind the same interface and **supersedes this ADR**. Until then, the
deferral stands and no document may claim durability.
