# ADR-0018 — SQLite durability behind the existing seams, and a durable hash-chained audit trail

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-15
- **Supersedes:** ADR-0017 — *Storage is in-memory behind a repository seam in Slice 0; the `node:sqlite` adapter is deferred to Slice 1* (2026-11-13).
- **Governed by:** Product law — the project must run identically on any Windows PC it is copied to (GLOBAL.md §9, portability law); and REVIEW_RUBRIC.md C13 — *an ADR that contradicts the code is a FAIL*.
- **Decided by:** owner decisions D-2 (durability) and D-3 (durable audit trail), 2026-11-15.

## Context

ADR-0013 decided that persistence would go through a repository interface with a
`node:sqlite` implementation behind it. ADR-0017 recorded that this was **not
implemented**: no source file imported `node:sqlite`, and the private store, the
consent audit trail and the enrolment audit trail were in-memory structures that
died with the process.

Two things changed the answer.

1. **The learner runtime now exists** (owner decision D-1: build it now). A
   learner question is answered through the gateway, a learner is enrolled
   through the consent path, and both write an audit trail. An audit trail that
   evaporates on restart is not evidence — and for consent and enrolment it is
   safeguarding evidence, not a convenience.
2. **The owner chose durability.** D-2 selected the `node:sqlite` adapter over
   an in-memory pilot, and D-3 selected a durable, tamper-evident audit trail
   for consent and enrolment (child safeguarding and legal defensibility).

The portability law shaped the implementation, not just the decision. A data
directory under the user's profile would break the law: a copy of this folder
must run on another machine under another user name. So the data lives in
`.edugenesis-data/` **inside the project** — gitignored, portable, and wiped
with the folder.

## Decision

**Persistence goes through `node:sqlite`, behind the existing seams, and the
frozen contracts do not change.**

- `packages/ledger/src/sqlite-private-store.ts` implements the EXISTING
  `PrivateStore` interface from `@edugenesis/contracts`. The contract is
  untouched: a durable store that replaced the seam would have frozen a storage
  technology into the public contract, and no contract change was needed to
  obtain the durability.
- `packages/ledger/src/durable-audit-log.ts` is an append-only, hash-chained
  log. Every event commits to its predecessor, so editing one invalidates the
  rest; `verify()` recomputes the chain and reports the broken sequence rather
  than throwing, because an auditor must be able to READ a broken chain and see
  where it broke. There is no update and no delete operation: a mistake is
  answered with a compensating entry, exactly as the public ledger does.
- `packages/identity/src/audit-sink.ts` describes the sink **structurally** — a
  local interface, not an import — so the identity package keeps depending only
  on the contracts, and the durable log satisfies the sink by shape.

**The private store and the public ledger stay separate.** The private store
holds identity, consent and safeguarding records; the public ledger holds
hashes, counters and proofs, and never personal data. Neither module imports
the other, and no code path writes private data into the public ledger.

## Consequences

- **A record survives a restart.** A close-and-reopen test proves it for both
  the private store and the audit log.
- **The durable audit trail mirrors the in-memory trail exactly.** A guardian
  grant refused for lack of authority leaves **no** trace, durable or not: the
  service authorises before it records, so a refusal can never be read as
  consent — and a hash-chained log is easier to read as evidence than an
  in-memory array, so mirroring is the safer rule. The withdrawal **cascade** is
  durable too: every dependent scope that got locked is part of the evidence.
- **The data directory is part of the product.** `.edugenesis-data/` is created
  on demand and gitignored. It holds learner records, so it never leaves the
  machine unencrypted, and it is wiped with the folder.
- **The hosted demonstration still persists nothing that matters.** The Render
  free plan's filesystem is ephemeral, so a hosted instance's data does not
  outlive its container. That is stated in `render.yaml` and it is why the
  deployed service is a demonstration surface, not a system of record.

## Alternatives

- **Keep the in-memory seam (ADR-0017 unchanged).** Rejected: the audit trail
  would not survive a restart, and the consent and enrolment decisions it
  records are the ones a safeguarding or legal review would ask about.
- **Change the frozen contract to name a storage technology.** Rejected: the
  seam exists precisely so the storage technology can change without the
  contract moving. Nothing in the decision needed the contract to change.
- **A database server (Postgres).** Rejected for this stage: it would break the
  portability law (a copy of the folder would need a running server), and the
  free deployment tier would need a paid instance.

## Verification

- `packages/ledger/src/sqlite-private-store.test.ts` — a record survives a close
  and a reopen; a missing parent directory is created; `close()` twice is safe.
- `packages/ledger/src/durable-audit-log.test.ts` — a changed hash in the
  persisted file is DETECTED at its seq; the broken chain is still readable and
  `verify()` never throws; a broken chain still accepts a compensating append;
  events survive a close and a reopen.
- `packages/identity/src/audit-sink.test.ts` — a consent grant, a withdrawal, an
  explicit refusal, a completed enrolment and a refused enrolment all reach the
  sink; a guardian grant refused for lack of authority reaches **nothing**; and
  the guardian's credential secret never reaches the sink.
