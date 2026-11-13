# Officers — appointment register

This is the register the Phase 0 exit criterion reads. It records **people**,
not roles: the ADR index names the accountable role, and this file records
whether a person has been appointed to it.

| Role | Appointed person | Status | Appointed by | Date |
|---|---|---|---|---|
| Founder & CEO | — | VACANT — Founder & CEO | Board of Trustees | — |
| Chief AI & Model Orchestrator | Marcus Thorne | APPOINTED | Founder & CEO | 2026-11-12 |
| Chief Systems Architect | — | VACANT — Founder & CEO | Founder & CEO | — |
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

The Phase 0 exit criterion is **owner-blocked**, not met: three roles are
appointed and ten are vacant. `docs/exit-criteria.json` records the owner
(Founder & CEO), the reason and the unblock path, and the exit-criteria gate
reports the shortfall as a warning rather than converting it into a pass.

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
