# ADR-0023 — Operator role maps to the existing `admin` contract role

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-17
- **Decided by:** the build authority 2026-11-17 under the production-completion mandate (PG-01)

## Context

The production mandate asks for roles learner, guardian, sponsor, operator and
auditor. The frozen `Role` union in `packages/contracts/src/index.ts` already
defines `learner | guardian | mentor | sponsor | volunteer | admin |
safeguarding_lead | accessibility_lead | auditor` but has no `operator`.
`packages/contracts/src` is frozen (contracts-baseline gate): a change is a
blocker, not an amendment, so the union must not be edited.

## Decision

1. The authentication package uses an internal `AuthRole` union of
   `learner | guardian | sponsor | operator | auditor`, as the mandate names.
2. Persistence and interop with the identity service map `operator` to the
   frozen contract role `admin` and back. Auth roles never appear in a frozen
   contract type.
3. The permission matrix grants `operator` exactly the capabilities an `admin`
   has in this product: settings read, kill/revive provider, audit read.

## Consequences

- No frozen contract changes; the contracts-baseline gate stays green.
- The mapping is one function in `packages/auth` and is unit-tested both ways.
- The named "operator" dashboards and kill-switch actor records use `operator`
   as the human-facing label while storing `admin` at the contract boundary.
