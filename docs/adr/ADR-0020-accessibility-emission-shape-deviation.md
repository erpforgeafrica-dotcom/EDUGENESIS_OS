# ADR-0020 — Accessibility emission shape stays frozen; Doc 7 deviation is recorded

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-17
- **Supersedes:** nothing; closes gap-register F1-13 (minor) by the second path its own fix permits ("record the deviation in an ADR with the reason")
- **Governed by:** `contracts-baseline` gate (frozen contracts), `accessibility-contract` gate, REVIEW_RUBRIC.md C13 — *an ADR that contradicts the code is a FAIL*
- **Decided by:** the build authority 2026-11-17 under the owner's "close all 43 gaps" instruction; this records an existing shape rather than making a new product promise

## Context

Doc 7 §5.1/§5.2 describes the accessibility emission with `reading_level` nested,
`sensory_profile` as a structured object, and `interaction_mode` containing the
easy-read, dyslexia, low-stimulation and sign-language concepts. The frozen
contract in `packages/contracts/src/index.ts:63-93,116-155` instead uses a
top-level `reading_level`, six boolean sensory flags
(`hasNonVisual`, `hasNonAudio`, `hasNonMotor`, `reducedMotionSafe`, `captioned`,
`transcribed`) and `interaction_mode { input, output }`. The conceptual fields
named in Doc 7 do not exist in the shipped type.

Changing the frozen contract would break the `contracts-baseline` gate and every
consumer that was written against it. Pretending the two shapes are identical
would be dishonest. Gap F1-13 therefore offers a second path: record the
deviation with its reason.

## Decision

**Keep the frozen contract and the emitted shape exactly as they are. Record the
deviation here instead of editing either the contract or Doc 7 in this wave.**

The concrete mapping, stated for reviewers:

| Doc 7 concept | Shipped field | Relationship |
|---|---|---|
| reading level (nested object) | top-level `reading_level` | same fact, flatter shape |
| non-visual need | `sensory_profile.hasNonVisual` | boolean flag |
| non-audio need | `sensory_profile.hasNonAudio` | boolean flag |
| motor need | `sensory_profile.hasNonMotor` | boolean flag |
| reduced motion | `sensory_profile.reducedMotionSafe` | boolean, safety-oriented polarity |
| captions / transcript | `sensory_profile.captioned` / `transcribed` | boolean flags |
| easy-read / dyslexia / low-stimulation / sign-language | not emitted | **not implemented** — no field claims it |

The last row is the honest limit: the product does not currently emit those four
preferences, so no downstream consumer may infer them from the boolean flags.

## Consequences

- The frozen contract, the hash preimage and the downstream emission consumers
  are untouched; `contracts-baseline` and `accessibility-contract` continue to
  hold without exception.
- A reviewer comparing the emission to Doc 7 sees an explicit, accountable
  deviation instead of an undocumented mismatch.
- Closing the remaining four Doc 7 preference concepts is a **product decision**,
  not a mechanical rename. It requires a new contract version and an ADR that
  supersedes this one; it is therefore escalated, not silently implemented here.

## Verification

- `node tools/verify-all.mjs` — `contracts-baseline` PASS, `accessibility-contract`
  PASS, `adr-governance` PASS with this row present in `docs/adr/README.md`.
- `npm run verify:repro` — the four evidence artifacts remain byte-identical over
  two runs with this record in the manifest.
