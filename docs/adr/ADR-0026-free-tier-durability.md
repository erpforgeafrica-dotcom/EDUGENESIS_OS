# ADR-0026 — Free-tier durability: sealed snapshots now, persistent disk is an owner-only paid upgrade

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-17

## Context

ADR-0018 made the private store and the consent/enrolment audit trail durable
across a crash and a restart with `node:sqlite`. ADR-0019 did the same for the
public sponsor ledger journal. Both ADRs stated the same honest limit: on the
Render **free** plan the filesystem is ephemeral, so an instance's files do not
outlive a redeploy or a 15-minute-idle spin-down. Durability inside a container
is not custody of the data.

The remaining gaps (PG-10/PG-11/PG-12) were operational, not storage-engine
questions: how to take a copy off the instance, how to prove the copy was not
altered, and how to put it back. The owner's constraint is **zero new spend**.
A hosted database or a paid disk cannot be introduced by this decision; the
upgrade path must stay an owner-only choice, and no code change may be required
when the owner later attaches a persistent disk.

## Decision

**Ship sealed export/restore and a manual snapshot schedule now. Treat a paid
persistent disk as an owner-only upgrade, and prepare — but do not enable — the
 hosting switch for a later wave.**

1. **`apps/cli/src/backup.ts`** is the zero-runtime-dependency service
   (`node:crypto`, `node:fs`, `node:path` only). `exportBackup(outDir)` reads
   every `*.sqlite` under the data directory recursively (ignoring `-shm` and
   `-wal` sidecars), base64-encodes the bytes into one deterministic JSON
   document sorted by file name, records each file's size and SHA-256, and
   seals the document with a SHA-256 checksum over its canonical form with the
   `checksum` field excluded. It writes exactly one sealed `.json` and returns
   only the metadata envelope; it never logs contents. Empty or missing data
   directories are refused.
2. **`verifyBackup(file)`** re-checks the schema version, the `sealed` flag, the
   safe-file-name rule (no `..`, no separators, no drive letter), every decoded
   file's SHA-256 and byte count, and the envelope checksum — the digests are
   compared with `timingSafeEqual`. Any mismatch returns `ok: false` with a
   specific error; verification never throws and never writes.
3. **`restoreBackup(file)`** verifies first and writes second: each entry is
   staged to a temp file and renamed into place **only inside the data
   directory**, and a failure rolls back every file already committed, so a
   rejected restore writes nothing. The named `restore drill` test deletes the
   whole data directory, restores, reopens the SQLite file and reads the row
   back.
4. **Snapshot cadence is manual and owner-controlled** (`RUNBOOK-BACKUP-RESTORE.md`):
   before every deploy, after consent/enrolment changes, and at least daily
   while learner data is accepted. The snapshot is moved to a location the
   owner already controls, using existing scheduling and storage — **no new
   spend, no new service**. The honest recovery point is the last snapshot
   taken off the instance; the envelope is tamper-evident, **not encrypted**.
5. **The durable-disk upgrade is owner-only.** True continuous durability on a
   hosted instance requires a paid persistent disk mounted at the data
   directory. No purchase, plan change or service declaration is made here;
   `render.yaml` keeps one free web service and no database. Because the data
   path is already a runtime-supplied directory, attaching a disk later needs
   **zero code change** — the same claim ADR-0018 and ADR-0019 already make.
6. **The hosting switch is prepared, not enabled.** A commented block is
   recorded for a later wave, to be uncommented only on the owner's paid-plan
   decision:

   ```yaml
   # Paid-plan upgrade only — owner decision required. Uncomment when a
   # persistent disk is purchased; no source change is needed.
   # disk:
   #   name: edugenesis-data
   #   mountPath: /opt/render/project/src/.edugenesis-data
   ```

   It lives in this ADR now so the intent is on record without altering the
   live `render.yaml` during verification.

## Consequences

- **Recoverability, not continuity.** A sealed snapshot lets an operator rebuild
  a deleted instance into a fresh directory. It does not protect the window
  between snapshots, and it does not survive being left on the ephemeral disk.
  This limit is stated in the runbook rather than buried.
- **Tamper evidence at two layers.** A per-file hash catches a changed byte; the
  envelope checksum catches a changed name, timestamp, ordering or any other
  structural edit — even when an attacker recomputes a file hash. `timingSafeEqual`
  closes the comparison side channel.
- **No leakage through the backup path.** The metadata envelope carries no
  base64 payload; the sealed file is written to an operator-chosen directory,
  never committed to a public repository, and never printed to a log.
- **Operations are documented, not improvised.** `RUNBOOK-BACKUP-RESTORE.md`
  (export, cadence, drill, failure messages) and `RUNBOOK-INCIDENT.md`
  (kill-switch drill, provider failure, corrupted journal, sleep/wake, abuse,
  learner-data deletion, **VACANT** escalation contacts) give the operator a
  script without inventing commitments. `PRIVACY-DPIA-DATA-FLOW.md` maps the
  data flows and records the legal-review banner.
- **No contract, hash preimage or plan changes.** The frozen contracts, the
  ledger hash preimage and the free `render.yaml` service are untouched.

## Alternatives

- **Hosted Postgres / paid disk now.** Rejected: new spend and an owner decision
  that has not been made; a hosted credential would also break the portability
  law (GLOBAL.md §9) and ADR-0014 (zero runtime dependencies).
- **Copy the raw `*.sqlite` files without a seal.** Rejected: a raw copy cannot
  prove it was not edited, and a torn mid-write copy would be silently accepted.
- **Rely on the free instance's filesystem.** Rejected: ADR-0018 and ADR-0019
  already record that it is ephemeral; treating it as custody-durable would
  contradict those ADRs and REVIEW_RUBRIC.md C13.

## Verification

`apps/cli/src/backup.test.ts` — hermetic temp dirs and real `DatabaseSync`
SQLite files: sorted recursive snapshot with sidecars ignored; deterministic
envelope; refusal of empty/missing data dirs; export→restore byte-identical into
a fresh directory; a named **restore drill** that deletes the data dir and reads
the row back; a flipped base64 character and a changed checksum both refused;
traversal names refused even with a recomputed checksum; schema/seal rejection;
unreadable and non-JSON files reported; and a restore failure that writes
nothing. Verification is executed by the integrating wave's build/test gate; no
test result is claimed here until that gate reports it.
