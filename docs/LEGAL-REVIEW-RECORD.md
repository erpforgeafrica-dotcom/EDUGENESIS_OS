# Legal review record

**PLACEHOLDER — this is not legal advice and no lawyer has reviewed it.** The
record exists so that counsel receives one complete, current packet and so that
the open question is visible rather than buried. Owner directive `O-2026-11-19-1`.

## Packet handed to counsel

| Document | What it answers |
|---|---|
| `docs/PRIVACY-DPIA-DATA-FLOW.md` | What personal data is processed, where it flows, what it is used for, and the DPIA screening |
| `docs/RUNBOOK-INCIDENT.md` | How a breach is contained, who is told, and the 72-hour decision path |
| `docs/RUNBOOK-BACKUP-RESTORE.md` | Retention, deletion and restore of durable state |
| `docs/OFFICERS.md` | Who is accountable for each control, and which seats are interim |
| `render.yaml` | The hosting region (Frankfurt) and the fact that the free instance is ephemeral |
| ADR-0021, ADR-0025, ADR-0026 | Why hosted enrolment is refused by default, how sponsor money is allocated, and how durability is achieved without a paid disk |

## Questions counsel must answer

1. **Lawful basis for a minor's enrolment** in the pilot jurisdictions, and
   whether guardian consent tokens are sufficient evidence of consent.
2. **Children's-data safeguards**: is the current refusal to hold hosted
   enrolment data (ADR-0021, both feature flags default OFF) sufficient for a
   demonstration instance, or is a separate DPIA filing required per region?
3. **Sponsor ledger**: the public ledger publishes pseudonymous sponsor
   references, amounts and a hash chain. Does publishing amounts alone
   constitute personal data in any pilot jurisdiction?
4. **Retention**: the documented schedule deletes learner state on request and
   keeps sponsor ledger entries for accountability. Is the split defensible?
5. **Cross-border transfer** from the Frankfurt region to any sub-processor
   (currently: none — there are zero runtime dependencies and no third-party
   service in the learner path; Render is the host).
6. **AI-generated lesson content**: what disclosure is required, given Tier 1
   is unprovisioned and every lesson is served from a reviewed offline pack?

## Status

| Field | Value |
|---|---|
| Review state | NOT REVIEWED |
| Counsel | not engaged |
| Date | — |
| Required changes | — |

## Flipping it

When counsel responds, record the date, the firm, the required changes and the
disposition above; apply the changes; then move `PG-12` from `placeholder` to
`closed` in `docs/production-ledger.json`. Until then the pilot may run only on
the demonstration instance, which holds no real learner data.
