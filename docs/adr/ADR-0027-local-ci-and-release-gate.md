# ADR-0027 — Local CI equivalents and a release gate that refuses an unverified build

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-18
- **Governed by:** the immutable law (no weakened gate), P0-3 (owner-blocked real CI), ADR-0014 (zero runtime dependencies)

## Context

GitHub Actions billing is locked on `erpforgeafrica-dotcom`, so the shipped
`.github/workflows/ci.yml` cannot run (P0-3). A green local check must never be
presented as a hosted CI run, and a release must never deploy an unverified tree.

## Decision

1. `npm run ci:local` runs the GL-01..GL-08 equivalents with the repo's REAL
   tools: secrets scan, SBOM, static analysis, contrast, coverage, portability,
   the full gate suite and `verify:repro`. It writes
   `artifacts/ci-local/report.json` and exits non-zero if any step fails.
2. `--fast` omits only the reproducibility chain and labels its report
   `PARTIAL — not a release gate`; it can never be mistaken for green.
3. `npm run release` refuses unless `verify` is PASS, `ci:local` is a complete
   PASS, and the operator attests a successful `verify:repro` with `--repro-ok`.
   That flag is an attestation of an observed run, not a shortcut; falsely
   setting it is a policy violation.
4. On an allowed release the tool hand-triggers the existing Render deploy with
   a key read only from `process.env.RENDER_API_KEY`, polls to `live`, confirms
   the deploy commit equals `git HEAD`, runs the live contract probe, and writes
   `artifacts/release.json`. No key value is ever printed, logged or committed.
5. P0-3 stays `OWNER-BLOCKED` until a real hosted CI run exists (PG-20 packet 1).
   The local gate is a zero-cost substitute with an honestly labelled limit.

## Consequences

- The release path is machine-refusable, not a checklist in a document.
- No gate, scanner or evidence rule is weakened; no fake green is possible from
  the local tools.
- A free hosted CI mirror may be added later as an owner option (PG-20 packet
  10), never as a requirement.
