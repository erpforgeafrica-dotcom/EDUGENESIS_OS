# ADR-0021 — Hosted enrolment and audit behind authentication

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-17
- **Supersedes:** ADR-0012
- **Decided by:** the build authority 2026-11-17 under the production-completion mandate (PG-03)

## Context

ADR-0012 refused `/api/enrol` and `/api/audit` on every hosted instance because
a public demonstration must not hold real learner data on ephemeral storage.
That kept the demo safe but stopped the value chain at Q&A: a sponsor could not
fund, a ledger could not be written by a runtime route, and no report could be
produced on the deployed instance.

PG-01 now supplies zero-dependency authentication and authorisation with five
roles (learner, guardian, sponsor, operator, auditor). PG-10 supplies an
export/restore design for the durable journals. With those in place the reason
for a blanket refusal no longer holds for the entitled roles.

## Decision

On a hosted instance, `/api/enrol` and `/api/audit`:

1. are gated by PG-01 authentication and an explicit role check:
   enrolment requires the `guardian` or `operator` role; audit-read requires
   the `auditor` or `operator` role;
2. are controlled by the feature flags `EDUGENESIS_HOSTED_ENROL=1` and
   `EDUGENESIS_HOSTED_AUDIT=1` (both default OFF) so the demonstration can be
   switched back to refusal with no code change;
3. remain private evidence — never exposed to an unauthenticated visitor, and
   never written to the public ledger or any sponsor artefact;
4. require guardian consent for any learner-linked enrolment (the existing
   consent service is reused; no new personal-data path is introduced);
5. keep ADR-0012's refusal as the default state of the flags, so the deployed
   demonstration is unchanged until an operator deliberately enables a flag.

## Consequences

- The chain sponsor funds -> ledger -> report -> learner learns can run on the
  deployed instance when the flags are enabled by an entitled operator.
- An unauthenticated caller still receives 403. Negative tests prove this.
- Hosted private data is still ephemeral; PG-10's export/restore is the honest
  limit, and the durability caveat remains documented.
- No contract in `packages/contracts/src` is changed.
