# ADR-0022 — Hosted settings are deny-by-default behind operator auth

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-17
- **Decided by:** the build authority 2026-11-17 under the production-completion mandate (PG-02)

## Context

F8-12 was left owner-gated: hosted `GET /api/settings` was publicly readable.
The endpoint is masked (`describeApiKeys` returns existence and length only), so
no credential value leaked, but a public configuration surface is still an
unnecessary disclosure of provider topology and base URLs, and it is the natural
entry point for a settings write if a future bug widens the route.

## Decision

1. On a hosted instance `GET /api/settings` is DENIED by default to every caller.
2. It is readable only to an authenticated principal with the `operator` role
   (PG-01), and only through a fully redacted projection: the same
   `publicSettings()` mask used locally, with every `apiKeys` entry reduced to
   `{ present: boolean, length: number }` and every URL host validated.
3. Writes remain refused on hosted instances in all cases (ADR-0012-era rule kept).
4. Host auth failures are indistinguishable to an unauthenticated caller: 403
   with no hint about which credential or role was wrong.

## Consequences

- The public live contract's `/api/settings` expectation changes from
  `200 { provider: local-echo, apiKeys: {} }` to `403` for an anonymous caller;
  the contract probe is updated deliberately, never weakened.
- A local, loopback-only operator keeps the existing read/write behaviour.
- No contract in `packages/contracts/src` is changed.
