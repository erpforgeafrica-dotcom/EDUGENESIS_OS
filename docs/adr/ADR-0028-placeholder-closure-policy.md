# ADR-0028 — Placeholder closure: a fourth, machine-checked disposition

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-19
- **Governed by:** the immutable law (no gate, test, scanner or evidence rule is weakened), ADR-0021, ADR-0024, ADR-0026
- **Owner directive:** O-2026-11-19-1 — "assume placeholder and close all gaps"

## Context

Fourteen backlog items and three Phase 0 exit criteria need an act that only a
person or an external party can perform: a Founder's signature, nine officer
appointments, a hosted CI run (Actions is disabled at the account level), a
provider credential, legal counsel's sign-off, a screen-reader session, a
production key ceremony, a paid persistent disk.

Leaving them in `owner-gated`/`owner-blocked` forever is dishonest in the other
direction: it hides work that *can* be done — the wiring, the drill, the
verification path, the labelled artefact — behind an item nobody is working on.
Simply marking them `closed` would be worse: it would assert a signature that
does not exist, an appointment nobody made, and a CI run nobody can open.

## Decision

1. **A fourth disposition exists: `placeholder`.** It is a *distinct, stricter*
   record, never a synonym for `closed`.
2. A `placeholder` record MUST carry all of:
   - reproducible proof (the same command/exit evidence `closed` requires), **and**
   - `placeholder.ownerDirective` naming the owner instruction that authorised it, **and**
   - `placeholder.label` — the exact words a reader sees, starting with `PLACEHOLDER`, **and**
   - `placeholder.residualRisk` — what remains untrue and who must make it true.
   The reconciler refuses the record if any field is missing or the proof is
   below the `closed` bar. A placeholder is therefore *harder* to create than a
   close, not easier.
3. **A placeholder never counts as met.** `docs/exit-criteria.json` counts
   placeholder rows separately and prints them in their own block. The
   exit-criteria gate reports `met`, `placeholder`, `owner-blocked` and never
   conflates them.
4. **A placeholder is a real artefact wherever a real artefact is possible.**
   The signing ceremony mints a real Ed25519 key and verifies a real signature;
   the approval record is a real signature over a real digest; the CI substitute
   executes the workflow's steps; the accessibility substitute extracts the real
   accessible text tree. Nothing is a mock of the thing it replaces.
5. **Every placeholder names its own replacement.** `docs/PLACEHOLDER-CLOSURE-REGISTER.md`
   is the single table: item, what was made real, what is still untrue, the exact
   owner act that flips it to `closed`/`met`.
6. **Sunset.** A placeholder may carry a pilot launch. It may not carry a public
   launch beyond the pilot: before that, the register must read zero placeholders.
   This is a governance rule, not a build check, and it is stated so it cannot be
   forgotten.

## Consequences

- The backlog reaches zero open items without a single false green: every row is
  `closed` (proven) or `placeholder` (proven machinery + named residual).
- A future real signature, appointment, CI run or credential flips one row with
  no code change.
- The repository can be audited by reading two files: the ledger and the closure
  register. Disagreement between them is a defect.
