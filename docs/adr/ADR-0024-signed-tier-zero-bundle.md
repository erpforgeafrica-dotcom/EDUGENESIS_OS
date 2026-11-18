# ADR-0024 — Ed25519-signed Tier-0 bundle with an owner-only key ceremony

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-17
- **Decided by:** the build authority 2026-11-17 under the production-completion mandate (PG-13 / F1-09)

## Context

F1-09 left a signature *seam* (`registry/signed-bundle.ts`) that refuses unsigned
bundles but delegates crypto to an injected verifier. No concrete verifier and
no production key existed, so a signed bundle could never be loaded. The
mandate requires Ed25519 sign/verify with `node:crypto`, enforced at load, with
a clearly marked non-production test key in tests only.

## Decision

1. `registry/ed25519-signature.ts` implements deterministic canonical bytes,
   Ed25519 sign/verify via `node:crypto`, and `loadSignedTierZeroBundle()` which
   calls the existing `verifyTierZeroBundle()` seam — unsigned or invalid
   bundles throw and are never served to a learner.
2. The verifier's public key is configuration; the private key NEVER enters the
   repository, the browser, logs or any agent context. `generateTestKeyPair()`
   is explicitly non-production and is used only in tests.
3. `tools/sign-tier-zero.mjs` is the owner-run ceremony signer: the key path is
   read only from `EDUGENESIS_BUNDLE_SIGNING_KEY`, a path inside the repo is
   refused, and no key material is printed. `docs/TIER-ZERO-SIGNING-CEREMONY.md`
   is the checklist.

## Consequences

- The crypto is real and tested (tamper, wrong key, unsigned, malformed all
  fail). Production trust is still OWNER-BLOCKED until the owner generates and
  custodies the key and places the public key in verifier config — this is a
  one-step owner action, not a code change.
- No gate or scanner is weakened; no PEM literal is committed (the secrets
  scanner would correctly flag it).
- No frozen contract is changed.
