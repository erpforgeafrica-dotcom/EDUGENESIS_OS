# DPIA — Data-flow map

**Documentation for legal review, not legal advice. Sign-off is owner-only.**

**Status.** Draft for legal review. The facts below are drawn from the shipped
code and configuration; the legal conclusions are deliberately left to the
owner's counsel. Where a decision is not made it is marked **owner decision
required**, not filled in with a guess.

## Hosting and operator geography

- The web service is configured for the **Frankfurt (EU)** region in
  `render.yaml` (`region: frankfurt`), provisionally pending confirmation of the
  pilot region.
- The operator is based in **Nigeria**. Access to learner records by the
  operator is therefore a cross-border access from an EU-hosted service. Whether
  that is a restricted transfer, and what safeguard applies, is a **legal
  question for owner counsel**; this document does not answer it.
- On the free plan the filesystem is ephemeral. Data present in a container does
  not survive a redeploy or spin-down. Snapshots may be copied to an
  owner-controlled location; their destination geography is an **owner
  decision**.

## Data-flow map by role

| Role | Data in | Where it lands | Data out / who can read |
|---|---|---|---|
| **Learner** | A question; age-assurance signal; accessibility preferences | Request context only; the lesson text is returned, not stored as a learner record | Guarded emission to the learner; nothing to the public ledger |
| **Guardian** | Identity/credential; consent grants and withdrawals; enrolment authority; click-to-fill favorites where data exists | `private.sqlite` via `createSqlitePrivateStore`; consent/enrolment events appended to `audit.sqlite` via `createDurableAuditLog` | Guardian sees only the scopes they hold; the credential secret is shown once and never logged |
| **Sponsor** | Sponsorship action | Hashes, counters and proofs in the **public** `ledger.sqlite` journal via `createSqliteLedgerJournal` | Public "anyone can check that we did" view. **No personal data** — the ledger has a PII guard and a separate code path |
| **Operator** | Settings, kill-switch state, snapshots | `settings/settings.local.json`; `onekey-kill-switch` in `private.sqlite`; sealed `.json` snapshots | Administrative evidence only; public visitors see none of it |

**The hard boundary.** `packages/ledger/src/sqlite-private-store.ts` and
`packages/ledger/src/durable-audit-log.ts` deliberately do **not** import the
public ledger, and the public ledger must never import them. A store that cannot
reach the ledger cannot leak learner data into a published artefact.

## Consent and guardian flows mapped to code paths

| Flow | Code path | Evidence |
|---|---|---|
| Guardian identity | `packages/identity/src/identity.ts` | Identity record written to the private store |
| Consent grant / withdrawal | `packages/identity/src/consent.ts` (`createConsentService`) | Consent decision appended through `packages/identity/src/audit-sink.ts` → `packages/ledger/src/durable-audit-log.ts` |
| Guardian grant refused for lack of authority | `packages/identity/src/consent.ts` | **No event is recorded** — the service authorises before it records, so a refusal cannot be read as consent |
| Age assurance | `packages/identity/src/age-assurance.ts` | Feeds the enrolment decision |
| Enrolment (provisional / enrolled / refused) | `packages/identity/src/enrolment.ts` (`createEnrolmentService`) | Enrolment events appended to the durable audit log; wiring in `apps/cli/src/learner.ts` |
| Policy / session risk | `packages/identity/src/policy.ts`, `session-risk.ts` | Decision inputs; no independent personal-data store |
| Kill switch (governance state) | `apps/cli/src/kill-switch-store.ts` | One `safeguarding` record (`onekey-kill-switch`) in `private.sqlite` |

The audit log is append-only and hash-chained: there is no update or delete
operation. A correction is a **compensating event** naming the sequence it
corrects. `verify()` reports the first broken sequence and never throws, so a
tampered chain stays readable.

## Retention schedule

No statutory period is asserted here; each row is an owner decision until
counsel sets a period.

| Data | Store | Retention rule (to be confirmed) |
|---|---|---|
| Learner identity / profile | `private.sqlite` | Until the learner/guardian requests deletion or the owner sets a limit |
| Consent decisions | `audit.sqlite` | Retained as safeguarding evidence; corrections appended, never overwritten |
| Enrolment outcomes | `audit.sqlite` | Retained as safeguarding evidence; same correction discipline |
| Safeguarding / assessment / transcript | `private.sqlite` | Owner decision required before any deletion |
| Public sponsor ledger | `ledger.sqlite` | Append-only hashes/counters, no personal data; retained while the sponsor report is published |
| Sealed snapshots | Owner-controlled location | Expire on the same schedule as their source data; a snapshot older than a deletion is an owner decision |

Deletion workflow: `RUNBOOK-INCIDENT.md` §6. Deleting a private record does not
rewrite the audit chain; a compensating event records the removal and its
authority.

## Subprocessors

| Subprocessor | Role | Data exposed | Notes |
|---|---|---|---|
| **Render** | Hosting (web service) | All in-container data while the instance lives | Frankfurt region configured; free-tier disk is ephemeral; hosting agreement is owner-only |
| **Generic AI provider** (configured through the OneKey gateway) | Lesson generation | The learner's prompt/context sent by the adapter | Provider identity is configuration, not a code constant. Its region, retention and training use are **not established** here and are an owner decision to verify before relying on hosted generation |
| Tier 0 offline bundle | Local curriculum | Nothing leaves the device | Local, no subprocessor |

No other hosted database is declared: durability is file-backed through
`node:sqlite` (ADR-0014, ADR-0018, ADR-0019).

## Gaps requiring owner / legal action

1. Confirm the Render region actually used by the pilot instance (Frankfurt is
   provisional in `render.yaml`).
2. Decide the lawful basis and transfer safeguard for Nigerian operator access
   to EU-hosted learner data.
3. Identify the configured AI provider and obtain its data-processing terms;
   decide whether learner prompts may leave the EU.
4. Set numeric retention periods; this document deliberately does not invent
   them.
5. Appoint the VACANT roles listed in `RUNBOOK-INCIDENT.md`.

**Documentation for legal review, not legal advice. Sign-off is owner-only.**
