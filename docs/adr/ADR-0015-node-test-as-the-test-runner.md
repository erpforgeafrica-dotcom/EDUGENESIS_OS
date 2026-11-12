# ADR-0015 — `node:test` as the test runner

- **Status:** Accepted
- **Owner:** Chief Systems Architect
- **Date:** 2026-11-12
- **Governed by:** Evidence over assertion (Document 2 §8 NFR-Q, Document 1 v1.2); ADR-0014.

## Context

The review rubric for this build asks of every behaviour claim: *"a test that
cannot fail is a defect"* and *"the implementation looks right but I could not
find the check that proves it"*. That standard is only meaningful if a reviewer
can read a test and see exactly what it asserts, and then break the
implementation and watch it fail.

Three requirements follow from it.

1. The runner must not hide what it asserts. A test whose correctness depends
   on a framework's implicit behaviour is harder to falsify.
2. The runner must already be present on every machine the product must run
   on, or the first-run experience gains a prerequisite that the portability law
   does not allow.
3. The runner must not become a supply-chain surface, because the whole
   dependency policy of ADR-0014 is about keeping the tree auditable.

`node:test` satisfies all three. It ships inside the Node runtime, it is
invoked with no configuration file, and it emits a spec reporter that prints
each assertion.

## Decision

**Tests are written with `node:test` and executed with `node --test`.**

- Test files are TypeScript, live next to the source they cover
  (`src/<name>.test.ts`), and are compiled by the ordinary `tsc -b` build into
  `dist/<name>.test.js`.
- The runner executes the **compiled** test files. There is no TypeScript
  loader, no transform step and no second test toolchain.
- The root scripts are `npm run test` (build, then run the compiled suites) and
  `npm run test:only` (run the compiled suites as they are).
- Assertions use `node:assert/strict`. Mocks are not used: tests exercise real
  objects, including a real `node:sqlite` database, because a mock asserts
  that the code called the thing it was told to call, not that the thing works.
- A test that cannot fail is a defect. A deliberate negative fixture is
  required for every invariant and every conformance rule.

## Consequences

**Positive**

- The runner is already on the machine. `node --test` needs no install, so the
  test path has exactly the same prerequisites as the product path.
- No configuration file, no transform pipeline, no plugin resolution. What the
  build produces is what the runner runs — there is no second truth about what
  was tested.
- The spec reporter prints each assertion, so a reviewer can read the evidence
  rather than a pass/fail stamp.
- The test dependencies are exactly the two dev dependencies of ADR-0014:
  `typescript` and `@types/node`. `node:test` and `node:assert` are typed by
  `@types/node` itself.
- The same command runs locally, in the bootstrap and in CI:
  `npm run test:only`.

**Negative**

- `node:test` offers fewer helpers than a mature framework: no built-in
  parameterised tests, no snapshot testing, no built-in mocking. Small helpers
  are written by hand, which is more code to own.
- Discovery follows the runner's file-name convention (`*.test.js`); a file
  that does not match it is silently not run, so the convention has to be
  enforced by review.
- `--test-reporter=spec` is the default choice here, but the runner's output
  format is a runtime surface, not a stable public API, and may change between
  Node majors.
- There is no built-in watch mode or parallel-isolation harness. When the suite
  grows, these will need either an owned shim or a different runner.

## Alternatives considered

1. **Jest, Vitest or Mocha.** Rejected. Each contradicts ADR-0014, brings a
   large transitive tree, and hides assertion behaviour behind a framework the
   team would have to trust. Vitest was the strongest candidate on ergonomics
   and was still rejected: the runner's own dependency surface is the point.
2. **A hand-rolled assertion and runner harness.** Rejected. Re-inventing a
   test harness is worse than using the one that ships with the runtime, and it
   would produce a weaker guarantee, not a stronger one.
3. **`node:test` with a TypeScript loader (tsx, ts-node, swc).** Rejected. It
   adds a dependency and puts a transform in the test path, so the code under
   test is not the code that was built.
4. **Assertion-only scripts with a shell runner.** Rejected. No isolation, no
   structured reporting, no per-test failure isolation, and no way to run one
   test by name.

## Revisit trigger

Reopen this decision when:

- the suite needs fixtures, watch mode or per-test isolation that `node:test`
  cannot provide without an owned shim of more than roughly 200 lines;
- the runner's discovery or reporting behaviour changes in a way that breaks
  the CI contract;
- the supported Node floor rises to a version whose test runner supersedes
  `node:test`.
