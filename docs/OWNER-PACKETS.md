# EduGenesis OS — owner packets (PG-20)

**Every backlog item is now closed or placeholdered (ADR-0028).** A placeholder
is not a promise that someone is working on it: it is a real, tested mechanism
plus a named residual that only the owner can remove. This file is the one-step
instruction for each flip.

**Pilot launch** may proceed with the placeholders below. **Public launch** may
not: `docs/PLACEHOLDER-CLOSURE-REGISTER.md` must read zero owner rows first.

Nothing here requires the owner to write code, and no secret is ever pasted into
chat.

| # | Backlog / criterion | Exact owner action | Paste back | The flip |
|---|---|---|---|---|
| 1 | **PG-15 / P0-3** hosted CI | Clear the GitHub Actions block at the account level for `erpforgeafrica-dotcom`, then re-run `CI` on `main`. The repository is public, so Actions is not billable; the block is account state, not a workflow defect (seven check-runs per commit with zero steps and zero output). | The run URL `https://github.com/erpforgeafrica-dotcom/EDUGENESIS_OS/actions/runs/<id>` and its green conclusion. | PG-15 and P0-3 → `closed`/`met`; `npm run ci:parity` still runs as the zero-cost local mirror. |
| 2 | **P0-1** signed approval | Read the subject digest in `docs/RELEASE-APPROVAL.md` (it names exactly which files were approved) and approve this release in writing. | The approval reference and date. | Re-sign the same subject with the production key; P0-1 → `met`. |
| 3 | **P0-6** nine officer seats | Name a human for each `PLACEHOLDER SEAT` in `docs/OFFICERS.md`. The Child Safeguarding Officer **cannot** be delegated to an agent. | The names, one per role. | P0-6 → `met`; the interim column is replaced, never silently dropped. |
| 4 | **PG-13** key ceremony | Generate an Ed25519 key inside KMS/HSM, export only the SPKI public key, then follow `docs/TIER-ZERO-KEY-REGISTER.md` → "Replacing it" on an offline machine. | "Ceremony complete, public key installed at `<config location>`" — **not** the private key. | PG-13 → `closed`; the placeholder key is retired and deleted. |
| 5 | **PG-08** Tier 1 credential | Create one provider account and set its key as a **server-side** Render environment variable named for the provider. | "Provider credential provisioned on Render" plus which provider. | Run the failover drill; PG-08 → `closed`. |
| 6 | **PG-12** legal sign-off | Send `docs/PRIVACY-DPIA-DATA-FLOW.md`, `docs/RUNBOOK-INCIDENT.md`, `docs/RUNBOOK-BACKUP-RESTORE.md` and `docs/LEGAL-REVIEW-RECORD.md` to counsel. | "Legal review completed on `<date>`" and the required changes. | Apply the changes; PG-12 → `closed`. |
| 7 | **PG-14** screen reader | Run the guided 15-minute NVDA/Narrator session on `/learn` and the three dashboards. `artifacts/a11y-narration.txt` is the exact text to expect. | The speech output capture, or a note of what was announced. | PG-14 → `closed`. |
| 8 | **PG-10** persistent disk | Select a paid Render persistent disk and attach it to `srv-dbsu4q0ae00c7393kod0`. | "Persistent disk attached" and the mount path. | Enable the tested `render.yaml` switch; PG-10 → `closed`. |
| 9 | **Runtime — operator hosted auth** (no backlog id) | **Provisioned under `O-2026-11-19-1`** and exercised live: 30/30 checks in `artifacts/live-e2e.json` (re-run with `node tools/live-e2e.mjs <url>`). The credentials live only in the owner's vault. What remains: replace the pilot `operator` account with a named person's account. | "Named operator account provisioned." | The value chain runs as a person, not a shared pilot identity. |
| 10 | **Business — first sponsor** (no backlog id) | **Done under `O-2026-11-19-1`**: a real 100 000-cent round (6 000 credits) against the pseudonymous reference `KEEP-Rotation-Engine` is in the deployed hash-chained ledger, and the replay was refused as a duplicate. What remains: a real sponsor's own round, and learners consuming the credits. | The sponsor's own reference and the funding confirmation. | A real sponsor relationship; credits consumed by real learners. |

## Standing note

No item above authorises spending money, touching billing, or pasting a secret.

`docs/production-ledger.json` reads **14 closed / 6 placeholder / 0 open**. The
six placeholders are PG-08, PG-10, PG-12, PG-13, PG-14 and PG-15; the three
Phase 0 criteria are P0-1, P0-3 and P0-6. Every one is itemised in
`docs/PLACEHOLDER-CLOSURE-REGISTER.md` with what is real, what is untrue and the
exact flip.
