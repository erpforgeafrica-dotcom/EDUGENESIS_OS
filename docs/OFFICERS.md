# Officers — appointment register

This is the register the Phase 0 exit criterion reads. It records **people**,
not roles: the ADR index names the accountable role, and this file records
whether a person has been appointed to it.

| Role | Appointed person | Status | Appointed by | Date |
|---|---|---|---|---|
| Founder & CEO | — | VACANT — Founder & CEO | Board of Trustees | — |
| Chief AI & Model Orchestrator | Marcus Thorne | APPOINTED | Founder & CEO | 2026-11-12 |
| Chief Systems Architect | Founder & CEO | APPOINTED | Founder & CEO (the role holder took the seat — owner decision D-4) | 2026-11-15 |
| Chief Inclusion & Accessibility Officer | Noni / Amara Diop | APPOINTED | Founder & CEO | 2026-11-12 |
| Security Officer | — | VACANT — Founder & CEO | Founder & CEO | — |
| Finance Lead | — | VACANT — Founder & CEO | Founder & CEO | — |
| Curriculum Authority | — | VACANT — Founder & CEO | Founder & CEO | — |
| Chief Learning Scientist | Nelly / Dr. Elena Rostova | APPOINTED | Founder & CEO | 2026-11-12 |
| Governance Lead | — | VACANT — Founder & CEO | Founder & CEO | — |
| Child Safeguarding Officer | — | VACANT — Founder & CEO | Founder & CEO | — |
| Programme Lead | — | VACANT — Founder & CEO | Founder & CEO | — |
| OpenCode Lead | — | VACANT — Founder & CEO | Founder & CEO | — |
| Hiring Platform Lead | — | VACANT — Founder & CEO | Founder & CEO | — |
| Communications Lead | — | VACANT — Founder & CEO | Founder & CEO | — |

## What the register means

- **APPOINTED** — a named person holds the role and the appointment is recorded.
- **VACANT — Founder & CEO** — the role has no named person. The Founder & CEO
  is the named authority who must fill it; the vacancy is not hidden behind a
  placeholder name, and no build may invent an appointment.

The Phase 0 exit criterion is **owner-blocked**, not met: four roles are
appointed and nine are vacant. `docs/exit-criteria.json` records the owner
(Founder & CEO), the reason and the unblock path, and the exit-criteria gate
reports the shortfall as a warning rather than converting it into a pass.

## The Chief Systems Architect seat (owner decision D-4, 2026-11-15)

The Chief Systems Architect seat was the one vacancy that blocked a technical
decision from being made by a person: ADR-0013 to ADR-0017 named it as the
accountable role, and it read VACANT. **The Founder & CEO took the seat** —
that is the owner's own decision, recorded here, not an appointment this build
invented. Two consequences follow, and both are recorded rather than implied:

1. **The ADR-0017 record is superseded by ADR-0018** (SQLite durability and the
   durable audit trail), because the owner chose the durable adapter over the
   in-memory seam ADR-0017 deferred.
2. **The exit criterion stays owner-blocked.** Filling one of fourteen roles is
   not the criterion: nine roles still have no named person, and the criterion
   reads "no row reads VACANT".

## Why three names appear

Each appointed person is named **in the approved architecture document** —
09 §11 and §12 name the decision owner for every ADR — and this register
records them exactly as that document writes them:

| Role | Named in 09 as |
|---|---|
| Chief AI & Model Orchestrator | Marcus Thorne (§1469, §2433, §2505) |
| Chief Inclusion & Accessibility Officer | Noni / Amara Diop (§1695, §1696, §2105, §2366) |
| Chief Learning Scientist | Nelly / Dr. Elena Rostova (§1755, §1756, §2433) |

Naming those people is not a claim that the other ten roles are filled; the
register says the opposite, row by row. The roles left vacant are the ones the
architecture document leaves to the Board (U-11) or to the Founder & CEO
(OQ-7), and no build may invent an appointment for them.
