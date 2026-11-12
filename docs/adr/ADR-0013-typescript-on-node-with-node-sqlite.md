# ADR-0013 — TypeScript on Node 24 with `node:sqlite` behind a repository interface

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-12
- **Governed by:** Product law — the project must run identically on any Windows PC it is copied to (GLOBAL.md §9, portability law).

## Context

Document 2 §5 specifies a Python/FastAPI service layer backed by PostgreSQL,
Redis and Qdrant. That stack is a reasonable default for a hosted platform and
it was the right answer for the architecture as written.

Two facts changed the answer:

1. **The build host has neither Python nor Docker.** A decision that requires a
   runtime the team cannot execute is a decision the team cannot verify. Every
   exit criterion in Document 2 §12 has to be provable by a command that runs.
2. **The portability law forbids depending on the developer machine's state.**
   The product is a folder that a non-technical owner copies to an unknown
   Windows PC — different user name, different drive letter, different Node
   install. A stack that needs a database server, a cache daemon and a vector
   database installed system-wide is not a folder; it is an installation
   procedure. That procedure is exactly what the law forbids.

Node's own answer to ACID storage is `node:sqlite`: the SQLite engine is
compiled into the runtime from Node 22.5.0 onward. It needs no install, no
daemon, no service account and no network port, and it gives real transactions
rather than "write a JSON file and hope".

## Decision

The platform is written in **TypeScript on Node 24**, with **Node 22.5.0 as the
supported floor** (the version at which `node:sqlite` became available).

Persistence goes through a **repository interface**. The interface is defined in
`packages/contracts`; the `node:sqlite` implementation is an adapter behind it.
No learner-path code may import the database driver directly.

**PostgreSQL remains reachable** by implementing the same repository interface
against a PostgreSQL client and changing which adapter is composed at start-up.
The repository seam is the migration path; it is not speculative — it is the
one seam the portability law forces.

## Consequences

**Positive**

- One language across the CLI, the services and the tests. No polyglot build.
- `node:sqlite` is ACID, needs no installation and stores its file inside the
  project folder, which is what the portability law requires of every artefact.
- The whole product is one folder plus a Node runtime — a bootstrap, not an
  installation manual.
- The repository interface means the storage engine is a configuration choice,
  not an architectural commitment, and it can be changed one adapter at a time.
- Tests run against a real database engine with no mocking of persistence.

**Negative**

- `node:sqlite` is Node-native. It is not reachable from another process over
  a socket, so a future web tier in a different runtime would need the
  PostgreSQL adapter rather than the SQLite one.
- The SQLite SQL dialect is narrower than PostgreSQL's. Analytical queries that
  PostgreSQL would answer well are the first thing that will push the decision.
- The `node:sqlite` API is comparatively new. Its surface has changed between
  Node minor releases, so the floor (22.5.0) and the verified version (24) both
  matter, and both are pinned in `package.json` and in `eg doctor`.
- A single-writer engine limits the concurrency the pilot can absorb before
  the PostgreSQL adapter becomes necessary rather than optional.

## Alternatives considered

1. **Python / FastAPI + PostgreSQL + Redis + Qdrant (Document 2 §5).**
   Rejected. It cannot be executed or verified on the build host, and it makes
   the product an installation rather than a folder. The document's intent —
   a clean service layering with a real relational store — is preserved; the
   technology is not.
2. **Node with a pure-JavaScript SQLite/WASM driver.** Rejected. It is an
   external dependency (ADR-0014), it adds a WASM supply-chain surface, and it
   is slower for the same work.
3. **Node with an embedded PostgreSQL (pg-embedded).** Rejected. It downloads
   and launches a native PostgreSQL binary per platform, which is the
   installation procedure the portability law forbids.
4. **JSON or JSONL files as the store.** Rejected. No transactions, no
   concurrent-write safety, and no path to the ACID guarantees the ledger and
   consent records require.
5. **SQLite through the OS `sqlite3` CLI.** Rejected. It moves the database out
   of the runtime, requires the binary to be present, and cannot participate in
   a transaction with the process that owns the data.

## Revisit trigger

Reopen this decision when any one of the following becomes true:

- the pilot needs concurrent writers from more than one process;
- the data must be shared between machines rather than living in one folder;
- an analytical workload requires PostgreSQL-specific SQL;
- the base image can no longer provide Node 22.5.0 or newer.

Adopting PostgreSQL is a **new ADR that supersedes this one** and implements
the same repository interface. It is not an edit to this record.
