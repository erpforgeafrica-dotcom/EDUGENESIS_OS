# ADR-0019 — Durable public sponsor ledger behind the existing store seams

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-16
- **Supersedes:** nothing; closes the named open point of ADR-0018's durability story (gap-register F8-04 and F5-01, both `PARTIAL`)
- **Governed by:** REVIEW_RUBRIC.md C13 — *an ADR that contradicts the code is a FAIL*; GLOBAL.md §9 (portability); ADR-0014 (zero runtime dependencies)
- **Decided by:** the owner, 2026-11-16 — **Option A** of the 2026-11-16 design brief (`%TEMP%\opencode\eg-ledger-design-brief.md`), after a fresh-context Goldfish review returned **APPROVE-WITH-CHANGES**. All of its blocking and major findings are folded into this ADR and the implementation.

## Context

ADR-0018 made the private store and the consent/enrolment audit trails durable. The
**public sponsor ledger** — the append-only, hash-chained record behind the promise
"anyone can check that we did" — remained `const entries: LedgerEntry[] = []` in
memory: a restart erased the published record with no residue. Gap-register F8-04
and F5-01 were left explicitly PARTIAL on this one point and routed to the owner as
a design decision, because a hosted ledger service would break ADR-0014 (a
Postgres driver is a runtime dependency), the portability law (a copied folder
would need a hosted credential), and Render's free-tier rules (free Postgres is
deleted after 30 days; external-DB traffic can suspend a free web service).

The owner chose **Option A**: a file-backed INSERT-only SQLite journal, using the
same `node:sqlite` built-in and the ADR-0018 precedent, with zero new dependencies
and no contract changes.

## Decision

**The public ledger becomes durable behind the store's existing seams. The frozen
contracts, the hash preimage, the PII guard and the correction discipline do not
change.**

1. **`packages/ledger/src/sqlite-ledger-journal.ts`** is an INSERT-only journal at
   `${dataDir}/ledger.sqlite`. One table, `seq INTEGER PRIMARY KEY` (uniqueness by
   construction), canonical payload TEXT as the stored evidence, verify-on-open
   against `computeEntryHash` — the same recompute an external auditor runs —
   plus a byte-level check (the canonical form of a stored payload must equal its
   stored text, so a key-reorder edit is detected). `load()` supplies verified
   rows; `persist()` is the file-first sink; `verify()` reports and never throws;
   `pragma()` makes the recorded crash defaults observable; `close()` releases
   the file handle for quiescent backups.
2. **`createLedgerStore` gains exactly two OPTIONAL fields**
   (`LedgerStoreOptions.persist` and `.initialEntries`). The store keeps owning
   its seq, head, hash preimage, PII guard and correction discipline; the journal
   owns only the bytes. Absent either option, the store behaves exactly as it did
   before. No contract type changed.
3. **THE RESTORE CONTRACT (Goldfish blocker, finding 1):** `initialEntries`
   rebuilds the live view, the store's own record, the head and the sequence
   counter from verified rows, **without re-firing the persist hook** — a restart
   that booted empty and reissued seq 1 would collide with the file forever.
   Restored rows are not re-checked by the PII guard (rules can evolve after
   publication), everything appended afterwards is guarded as always, and a
   broken restored chain is not fatal to boot: it is reported by `verify()`, the
   evidence stays readable via `all()`, and every trust boundary refuses.
4. **THE HOOK CONTRACT (Goldfish major, finding 2):** the persist hook is
   synchronous, non-reentrant and atomic commit-or-nothing; a throwing hook
   aborts the append with nothing in memory, no seq consumed, the head unmoved.
   It is construction-time application infrastructure (its own journal), not
   per-request caller code — the explicit exemption to the critical section's
   no-caller-code rule is documented at the call site. The shipped journal wraps
   SQLite failures in the package-local typed `LedgerPersistenceError`, so no
   raw driver error reaches a caller.
5. **`apps/cli/src/learner.ts` wires one journal** at
   `${dataDir}/ledger.sqlite`, along the other durable stores, and closes it in
   `LearnerServices.close()`. `publicLedger()` exposes the row count and the
   verification report; a broken chain at boot does not stop the runtime serving.
6. **NO WAL (Goldfish major, finding 4):** the F5-01 fix text named WAL mode. This
   is a deliberate departure: this is a single-writer journal (one web service),
   and WAL is a concurrency/performance mode, not a stronger crash guarantee.
   The node:sqlite defaults are kept — rollback journal (`journal_mode = delete`)
   and `synchronous = FULL` — so a returned append is committed. A test asserts
   both pragmas, so this ADR and the file cannot silently drift.

## Consequences

- **Durability horizon, stated plainly:** committed rows survive a crash or a
  process restart and the file is portable with the project. On the Render free
  tier the filesystem is ephemeral, so a hosted instance's ledger is
  *demonstration-durable*, not custody-durable: a redeploy or spin-down erases it.
  This is the same caveat ADR-0018 already accepted for the audit trail; it is
  not new and not buried. The upgrade is infrastructure-only — attach a
  persistent disk on a paid plan at the same path, with **zero code change**.
- **Tamper evidence has two layers:** the store's chain check (the auditor's
  recompute) and the journal's byte-level canonical-text check. A broken chain
  refuses `append`, `exportPublic()` and `merkleRoot()` with the contract's
  `LedgerTamperError`, stays readable through `all()` and never blocks boot.
- **Crash story without overclaim (Goldfish major, finding 5):** a kill mid-write
  loses only the in-flight append, for which the caller saw no return. SQLite
  recovers a hot journal on the next open; a *copy taken mid-write*, or a
  sidecar-less copy after a crash, can be torn. Back up only when quiescent (the
  journal's `close()` exists for this) or use `VACUUM INTO`. There is no
  hand-rolled file format to truncate.
- **`render.yaml` was corrected, not appended to (Goldfish major, finding 3):**
  its Genesis-Slice-0 comment claimed "every store is in-memory (ADR-0017)",
  which ADR-0018 and the durable runtime had already made false. The comment is
  rewritten to describe the actual durable stores and the free-tier caveat —
  the same ADR/code drift class (F0-02, F1-05) this ADR exists to avoid.
- **Nothing was half-built:** the public ledger's open point is closed at the
  code level; hosting durability depends on the plan, as recorded above. The
  Merkle root already exists for sponsor pinning, with no code change needed.
- **F5-11 remains separate:** the sponsor report still publishes with
  `chainOk=false`; its strict path (`assertChainIntact`) is its own finding with
  its own negative test.

## Verification

12 journal tests (reopen byte-for-byte; no double insert; tamper at seq; broken
chain refuses every trust boundary; key-reorder edit; throwing hook leaves no
memory; typed persistence failure; same-tick seq uniqueness; pragma defaults;
restore skips the guard; no-option behaviour unchanged), the pre-existing 103
ledger tests, and the full monorepo chain. Every claim above is anchored to a
named test, not to prose.
