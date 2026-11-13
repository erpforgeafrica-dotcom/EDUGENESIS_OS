# Officers — appointment register

This is the register the Phase 0 exit criterion reads. It records **people**,
not roles: the ADR index names the accountable role, and this file records
whether a person has been appointed to it.

| Role | Appointed person | Status | Appointed by | Date |
|---|---|---|---|---|
| Founder & CEO | — | VACANT — Founder & CEO | Board of Trustees | — |
| Chief AI & Model Orchestrator | — | VACANT — Founder & CEO | Founder & CEO | — |
| Chief Inclusion & Accessibility Officer | Noni / Amara Diop | APPOINTED | Founder & CEO | 2026-11-12 |
| Security Officer | — | VACANT — Founder & CEO | Founder & CEO | — |
| Finance Lead | — | VACANT — Founder & CEO | Founder & CEO | — |
| Curriculum Authority | — | VACANT — Founder & CEO | Founder & CEO | — |
| Chief Learning Scientist | — | VACANT — Founder & CEO | Founder & CEO | — |
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

The Phase 0 exit criterion is **owner-blocked**, not met: one role is appointed
and twelve are vacant. `docs/exit-criteria.json` records the owner
(Founder & CEO), the reason and the unblock path, and the exit-criteria gate
reports the shortfall as a warning rather than converting it into a pass.

## Why one name appears

The Chief Inclusion & Accessibility Officer is named because the accessibility
contract (ADR-0005, ADR-0011) has a decision owner in the approved architecture
document. Naming that person is not a claim that the other roles are filled; the
register says the opposite, row by row.
