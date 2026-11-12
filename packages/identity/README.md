# @edugenesis/identity

Owned by swarm unit **packages/identity**. Implements the interfaces declared in `packages/contracts`.

- Source: `src/`
- Tests: `src/**/*.test.ts` (compiled to `dist/**/*.test.js`, run with `node --test`)
- This package MUST NOT import a provider SDK. Provider access lives behind `packages/onekey`.
- This package MUST NOT contain a raw hex colour or a hardcoded absolute path.

## What it implements

| Module | Contract implemented | Governing authority |
|---|---|---|
| `identity.ts` | `IdentityService` | Doc 2 §4.2 — local-key adapter behind the WebAuthn seam (Slice 0 decision D-05). The ceremony is deferred; the seam, the credential shape, the verifier-only storage rule and the non-enumeration guarantee are not. |
| `policy.ts` | RBAC + ABAC bundle | Doc 16 §7 (Sponsor Firewall), Doc 1 v1.2 (least privilege, separation of duties). Deny always wins. |
| `consent.ts` | `ConsentService` | Doc 2 §4.2; Doc 7 Phase 1 exit criterion: "a consent withdrawal locks sharing surfaces but not core learning." |
| `age-assurance.ts` | `AgeAssuranceService` | Doc 2 §4.2 — an inconclusive evidence set returns `null`; it never guesses. |
| `session-risk.ts` | `SessionRiskService` | Doc 2 §4.2 — a hard denylist keeps protected characteristics out of the score. |

## Build and test

```bash
# from the repository root
npx tsc -b packages/identity
node --test "packages/identity/dist/**/*.test.js"
```

> **Use the glob form.** `node --test packages/identity/dist/` does NOT run the
> suite on Node 22+: a positional path is treated as a glob/file, so the
> directory resolves to `dist/index.js` and the runner reports one passing
> "test" while executing none of the assertions. The repository's own
> `npm test` uses the glob form for exactly this reason. From inside this
> package, `npm test` runs the suite.

## The consent dependency graph

A dependent scope may only be shared when every scope it depends on is granted.

```
progress_visible_to_guardian ──┬──> mentor_contact
                                └──> work_visible_to_employers
analytics_aggregate ─────────────> sponsor_aggregate_reporting
memory_personalisation            (no dependency)
```

Withdrawing a scope locks its dependents transitively, in one synchronous call
with no `await` boundary, so no observer can see a half-applied withdrawal.
`mayLearn` is derived from the scope model, never from the learner's consent
state, so no withdrawal can ever block core learning.
