# Runbook — Backup and Restore (PG-10 / PG-11 / PG-12)

**Scope.** The durable SQLite files in `./.edugenesis-data` — `private.sqlite`
(identity, consent, safeguarding, kill-switch state), `audit.sqlite` (the
append-only, hash-chained consent/enrolment trail) and `ledger.sqlite` (the
public sponsor ledger journal). A sealed snapshot is one JSON file holding a
base64 copy of every `*.sqlite` under that directory, sorted by name, each with
a SHA-256, all covered by an envelope checksum.

**Owner-only facts, stated first.** The Render **free** web service has an
**ephemeral filesystem**: a redeploy, a spin-down (15 minutes idle) or a new
instance erases these files. A sealed snapshot makes the data *recoverable*; it
does not make the running instance *custody-durable*. True continuous durability
requires a **paid persistent disk**, which is an **owner-only paid upgrade** and
is not enabled here (ADR-0026). No uptime, RPO or RTO commitment is made by this
runbook.

## Commands (the contract to wire)

```bash
# Export one sealed snapshot into ./.edugenesis-backups/
npm run backup:export

# Verify and restore a named snapshot into the data directory
npm run backup:restore -- .edugenesis-backups/backup-2026-01-02T03-04-05.000Z.json
```

`backup:export` writes exactly one `backup-<createdAt>.json` (colons replaced by
hyphens) and prints only metadata — never file contents. `backup:restore`
verifies the whole seal **before** writing anything; on any mismatch it reports
the reason and leaves the target untouched. The underlying service is
`createBackupServices({ dataDir })` in `apps/cli/src/backup.ts`; the two npm
scripts above are the thin CLI wiring the integrating wave adds around it.

**Quiesce before export.** Stop the web service (or close every store handle)
first. A copy taken mid-write can be torn; the stores deliberately do not enable
WAL, so there is no sidecar to carry with the copy. The service's `close()` seam
exists for this.

## Snapshot cadence on the free tier

| Moment | Action | Why |
|---|---|---|
| Before every deploy | `npm run backup:export`, move the file out | Redeploy erases the container |
| After any consent grant / withdrawal or enrolment | `npm run backup:export` | Safeguarding evidence must not be lost |
| At least daily while the service accepts learner data | scheduled `npm run backup:export` | Bounds the loss window to one day |
| Immediately before any manual intervention in the data dir | `npm run backup:export` | Cheap insurance |

The recovery point is the time of the **last successful snapshot taken off the
instance**. Nothing else on the free tier extends it.

## Scheduling to an owner-controlled location with no new spend

The free instance cannot hold a snapshot safely — its disk dies with the
container. Use infrastructure the owner already pays for:

1. On the **owner-controlled machine**, schedule a job (Windows Task Scheduler
   or cron) that runs `npm run backup:export` against a copy of the project, or
   calls the service with the instance's data directory mounted read-only.
2. Move the sealed `.json` to a location the owner controls (their own computer,
   an existing private drive, or a private repository). **Never commit a
   snapshot to a public repository**: it contains learner and guardian data.
3. Keep the snapshot encrypted at rest by the owner's existing storage controls.
   The envelope is tamper-evident, **not encrypted** — anyone with the file can
   read the base64 payload.
4. Verify on a schedule with `verifyBackup(file)` (or a restore drill below) and
   alert the operator on failure. Retain only what the retention schedule
   permits; delete expired snapshots explicitly.

No new paid service, database or hosted bucket is introduced by this procedure.

## Restore drill (run at least once before relying on any snapshot)

1. Stop the service and quiesce all store handles.
2. Copy the sealed `.json` to a safe place; do not edit it.
3. Point the service at a **fresh, empty** data directory and run
   `npm run backup:restore -- <file>`.
4. Confirm the reported restored names match `private.sqlite`, `audit.sqlite`,
   `ledger.sqlite`.
5. Reopen the stores and read a known row back from each; run the journal and
   audit-log `verify()` checks and confirm they report intact chains.
6. Record the date, the snapshot fingerprint (checksum) and the result in the
   incident log. If the drill fails, treat the snapshot as unusable and escalate.

## Failure messages you may see

| Message | Meaning | Action |
|---|---|---|
| `no *.sqlite files found` | Empty or wrong data dir | Point at the real data dir; re-export |
| `unsafe file name` | Traversal / separator / drive letter in the seal | Do not restore; escalate as tampering |
| `per-file hash check` | A stored byte changed | Do not restore; use an older snapshot |
| `checksum mismatch` | The envelope was altered | Do not restore; use an older snapshot |
| `Restore failed ... no files were written` | Write failed and was rolled back | Check disk space and permissions, retry |
