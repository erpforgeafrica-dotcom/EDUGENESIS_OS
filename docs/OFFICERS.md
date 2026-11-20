# Officers — appointment register

This is the register the Phase 0 exit criterion reads. It records **people**,
not roles: the ADR index names the accountable role, and this file records
whether a person has been appointed to it.

**Interim seats are not appointments.** Under owner directive `O-2026-11-19-1`
every vacant seat now has a documented interim holder so no control is
unowned — but an interim seat held by an agent is **not a named human
appointment**, and this register says so in the row. ADR-0028 governs the
distinction. A build never invents a person.

| Role | Appointed person | Status | Interim seat (placeholder) | Appointed by | Date |
|---|---|---|---|---|---|
| Founder & CEO | — | OWNER SEAT — held by the owner, with no appointment instrument in this tree | PLACEHOLDER — owner seat, not delegated | — (no instrument in this tree) | — |
| Chief AI & Model Orchestrator | Marcus Thorne | APPOINTED | — | Founder & CEO | 2026-11-12 |
| Chief Systems Architect | Founder & CEO | APPOINTED | — | Founder & CEO (owner decision D-4) | 2026-11-15 |
| Chief Inclusion & Accessibility Officer | Noni / Amara Diop | APPOINTED | — | Founder & CEO | 2026-11-12 |
| Security Officer | — | PLACEHOLDER SEAT | PLACEHOLDER — agent-operated interim; runs `npm run security:pass` and owns the secrets scan | Founder & CEO directive O-2026-11-19-1 | 2026-11-19 |
| Finance Lead | — | PLACEHOLDER SEAT | PLACEHOLDER — agent-operated interim; owns the sponsor ledger reconciliation and refuses a broken chain | Founder & CEO directive O-2026-11-19-1 | 2026-11-19 |
| Curriculum Authority | — | PLACEHOLDER SEAT | PLACEHOLDER — agent-operated interim; every shipped pack is `status: draft` and marked `reviewRequired` | Founder & CEO directive O-2026-11-19-1 | 2026-11-19 |
| Chief Learning Scientist | Nelly / Dr. Elena Rostova | APPOINTED | — | Founder & CEO | 2026-11-12 |
| Governance Lead | — | PLACEHOLDER SEAT | PLACEHOLDER — agent-operated interim; owns ADR-0028 and this register | Founder & CEO directive O-2026-11-19-1 | 2026-11-19 |
| Child Safeguarding Officer | — | PLACEHOLDER SEAT | PLACEHOLDER — **cannot be delegated**: no learner data is hosted while this seat is interim (ADR-0021 flags stay OFF) | Founder & CEO directive O-2026-11-19-1 | 2026-11-19 |
| Programme Lead | — | PLACEHOLDER SEAT | PLACEHOLDER — agent-operated interim; owns the pilot runbook | Founder & CEO directive O-2026-11-19-1 | 2026-11-19 |
| OpenCode Lead | — | PLACEHOLDER SEAT | PLACEHOLDER — agent-operated interim; owns the local CI and release gate | Founder & CEO directive O-2026-11-19-1 | 2026-11-19 |
| Hiring Platform Lead | — | PLACEHOLDER SEAT | PLACEHOLDER — agent-operated interim; no hiring surface is exposed | Founder & CEO directive O-2026-11-19-1 | 2026-11-19 |
| Communications Lead | — | PLACEHOLDER SEAT | PLACEHOLDER — agent-operated interim; no public campaign is authorised | Founder & CEO directive O-2026-11-19-1 | 2026-11-19 |

## What the register means

- **APPOINTED** — a named person holds the role and the appointment is recorded.
- **PLACEHOLDER SEAT** — the role has a documented interim holder and an
  explicit scope, so no control is unowned; it is **not** a human appointment.
  The seat is accountable for exactly the machinery named in its row and for
  nothing that needs a person's judgement.
- **VACANT** — would mean no interim holder and no scope. No row reads VACANT.
- **OWNER SEAT** — the founder's own seat. The owner holds it by ownership; no
  appointment instrument for it exists in this tree, so this register neither
  claims an appointment nor names an appointing body. It is not an APPOINTED row.

## The safeguarding limit (non-negotiable)

The Child Safeguarding Officer seat **cannot** be exercised by an agent. While
it is a placeholder seat:

1. hosted enrolment stays refused (`hostedEnrol` default OFF, ADR-0021);
2. hosted audit reads stay refused (`hostedAudit` default OFF);
3. the demonstration instance holds no real learner data;
4. any pilot with real children in the loop requires a named human in this seat
   **before** the first enrolment.

That limit is a product rule, not a registry note, and it is enforced in
`apps/cli/src/serve.ts` by the two flags defaulting to false.

## The Chief Systems Architect seat (owner decision D-4, 2026-11-15)

The Chief Systems Architect seat was the one vacancy that blocked a technical
decision from being made by a person: ADR-0013 to ADR-0017 named it as the
accountable role, and it read VACANT. **The Founder & CEO took the seat** — the
owner's own decision, recorded here. Two consequences follow:

1. **ADR-0017 is superseded by ADR-0018** (SQLite durability and the durable
   audit trail), because the owner chose the durable adapter over the in-memory
   seam ADR-0017 deferred.
2. **The exit criterion stays `placeholder`.** Interim seats are machinery, not
   appointments; the criterion reads "filled by name".

## Why three names appear

Each appointed person is named **in the approved architecture document** — 09
§11 and §12 name the decision owner for every ADR — and this register records
them exactly as that document writes them:

| Role | Named in 09 as |
|---|---|
| Chief AI & Model Orchestrator | Marcus Thorne (§469, §433, §505) |
| Chief Inclusion & Accessibility Officer | Noni / Amara Diop (§695, §696, §105, §366) |
| Chief Learning Scientist | Nelly / Dr. Elena Rostova (§713) |
