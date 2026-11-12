# ADR-0014 — Zero runtime dependencies

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-12
- **Governed by:** Product law — portability (GLOBAL.md §9); supply-chain security (Document 2 §7.6, Document 1 v1.2).

## Context

A dependency is three things at once: a supply-chain surface, a licence
obligation, and a version that can drift away from the code that used it. For a
platform whose core promise is that *the folder you copied still works*, every
dependency is a promise the project must keep on somebody else's behalf.

The pressure to add dependencies is real and specific. The obvious candidates
were an HTTP framework, a JSON Schema validator, a CLI argument parser, a test
framework, a CycloneDX SBOM generator and a secrets scanner. Each is a
well-known package, and each would have been faster to adopt than to build.

The counter-argument is the offline first-run. A non-technical owner copies
this folder onto a machine with no toolchain. If the first thing that must
happen is `npm install` against a registry, then the first run depends on
network access, on the registry being reachable, on the lockfile resolving to
exactly the audited versions, and on the package owner having not been
compromised that morning. The portability gate (a copy at a new path with a
non-existent `HOME`) is much easier to pass when the tree needs nothing from
the network to run.

## Decision

**The runtime has zero dependencies.** The published packages — `contracts`,
`accessibility`, `onekey`, `ledger`, `identity`, `verification` and `cli` —
declare no runtime dependencies at all.

**Dev dependencies are limited to exactly two:** `typescript` and `@types/node`.
Nothing else.

Everything the platform needs at runtime is built on Node built-ins:

| Need | Built on |
|---|---|
| HTTP server and JSON API | `node:http` |
| Argument parsing and dispatch | hand-written (`apps/cli/src/args.ts`) |
| JSON Schema validation | hand-written subset validator (`apps/cli/src/schema-validate.ts`, `tools/settings-schema-check.mjs`) |
| Atomic settings writes | `node:fs` (temp file + rename) |
| Tests | `node:test` (ADR-0015) |
| CycloneDX SBOM | `node:fs` + `node:crypto` (`tools/sbom.mjs`) |
| Secrets scanning | `node:fs`, `node:crypto`, `node:child_process` (`tools/secrets-scan.mjs`) |
| Portable runtime provisioning | OS tools (`Expand-Archive`, `tar`) invoked by `tools/bootstrap.*` |

## Consequences

**Positive**

- The dependency tree is empty at runtime, so there are no runtime advisories
  and nothing to audit beyond this repository's own source.
- `npm audit` on the runtime tree is vacuously clean, and the SBOM describes
  only the build toolchain.
- First run works offline once the folder is copied and the TypeScript compiler
  is available; the bootstrap can also provision that compiler into the folder.
- Every line of behaviour is reviewable by the team that owns the product, with
  no upstream surprise upgrades.
- A vendored copy of a dependency is impossible to confuse with a real one: it
  is simply not there.

**Negative**

- Small utilities are re-implemented rather than consumed: a JSON Schema
  validator, an argument parser, a table renderer, an SBOM writer. Each is a
  maintenance and test burden that a package would have carried.
- The hand-written validators are partial by design — they cover the subset of
  draft 2020-12 this project uses. A future schema that reaches outside that
  subset needs the validator extended, not a package added.
- Error messages from a hand-written validator are less friendly than a mature
  library's.
- We own the correctness of things the ecosystem has already debugged for
  millions of users, and we must test them ourselves.

## Alternatives considered

1. **Adopt the obvious packages (Express or Fastify, Ajv, Commander, Jest or
   Vitest, `@cyclonedx/cyclonedx-library`, `gitleaks`).** Rejected. Every one
   adds a transitive tree to a platform whose defining constraint is that it
   must install nothing, and the four of them together would have outweighed
   the code they replace.
2. **Runtime-zero but tooling-heavy (dependencies as dev dependencies only).**
   Rejected for the same product, because the first build still needs a registry
   and a lockfile resolution, and the portability gate must survive a machine
   with no network.
3. **Adopt Bun or Deno as the runtime.** Rejected. A second runtime is a second
   provisioning problem, and it does not remove the dependency question.
4. **Vendor the dependencies into the repository.** Rejected. A vendored copy
   is a dependency with worse provenance: it looks like our code, so it escapes
   review, and it silently rots.

## Revisit trigger

Reopen this decision when:

- a required capability cannot be implemented on Node built-ins in fewer than
  roughly 500 lines of owned, tested code;
- the Security Officer mandates a specific audited, signed, offline-verifiable
  dependency for a capability with a genuine safety consequence;
- the platform must run on a runtime that does not ship the built-ins this
  design depends on.
