# Genesis Slice 0 — Santa Review Rubric

**Method:** `santa-method`. Two independent reviewers, identical rubric, no shared context, both must
PASS. Fresh reviewers each round. Max 3 rounds, then escalate to the owner.

**Reviewers:** Reviewer B and Reviewer C are spawned with **no access to each other's assessment** and
**no memory of a previous round**. Neither is the agent that built the code.

**Output format (required, machine-checked):** JSON with `verdict` (`PASS`/`FAIL`), `checks[]`
(one per criterion, each `PASS`/`FAIL` with a `detail`), `critical_issues[]`, `suggestions[]`.

---

## Rubric

### C1 — Exit criteria met
Every exit criterion of Phase 0, Phase 1 and Phase 5 as written in `09_TECHNICAL_ARCHITECTURE_AI_BRAIN_AND_DEPLOYMENT.md` §12 is met **and proven by an executable check**. For each criterion the reviewer must find the test or command that proves it, or mark FAIL.

- PASS condition: every exit criterion maps to a named, passing check. A criterion proven only by a comment, a README claim, or the agent's own report is FAIL.
- FAIL signal: "the implementation looks right but I could not find the check that proves it".

### C2 — Accessibility contract is genuinely enforced
An emission missing `accessible_alternative`, with `equivalence_verified` false, or with `withheld: true`, **cannot reach a learner**.

- PASS condition: there is a test that constructs the broken emission and asserts it is blocked, and the gateway/guardian path consults the validator rather than a separate code path.
- FAIL signal: the validator exists but the delivery path does not call it; or the validator returns violations but the caller ignores them.

### C3 — The five fallback tiers are real
Tiers 0–4 are all implemented and exercised by a documented failover test.

- PASS condition: a test drives a scenario where the primary provider fails and the system walks the ladder, and the test asserts the **transitions in order**, including that Tier 0 (no provider at all) serves a learner.
- FAIL signal: tiers 0/2/3/4 are declared in types or comments but never executed.

### C4 — Credit exhaustion never denies core learning
When the budget pool reaches its hard cap and overage is disabled, a learner still receives a lesson.

- PASS condition: a test exhausts the budget and asserts a successful Tier 0 answer. `overageEnabled` must be permanently false.
- FAIL signal: the gateway throws `BudgetExceededError` to the learner instead of falling back.

### C5 — Provider independence
No learner-path code depends on a provider SDK or a provider hostname. A provider change is a registry change.

- PASS condition: a static gate exists that scans the tree and fails if a provider host/SDK appears outside `packages/onekey/src/providers/`, and that gate passes on the current tree.
- FAIL signal: the gate exists but a provider host string is present in another package, or the gate scans nothing.

### C6 — The public ledger holds no personal data
The ledger stores only hashes, counters and proofs. A PII-bearing payload is refused before it is written.

- PASS condition: tests prove the recursive field-name refusal (including nested and case-variant keys), a value-shape guard for emails/digit strings, and that a tampered chain is detected with the correct `brokenAtSeq`.
- FAIL signal: the guard only checks top-level keys; or the ledger and the private store share a write path.

### C7 — Consent withdrawal semantics
A consent withdrawal locks sharing surfaces and **does not** lock core learning.

- PASS condition: a test withdraws consent, asserts `mayShare` is false for the scope and for dependent scopes, and asserts `mayLearn` is still true. The dependency graph must be modelled, not assumed.
- FAIL signal: withdrawal is implemented but `mayLearn` is derived from the same state as sharing.

### C8 — Portability
The build runs from a copy at a different path, with a different (non-existent) `USERPROFILE`/`HOME`, with zero source edits: first-run works, a setting can be changed and persists inside the copy, and the normal path works.

- PASS condition: the portability gate executes that scenario and passes. A gate that is only described is FAIL.
- FAIL signal: any absolute path, user name or drive letter in source; or the settings store writing outside the project folder.

### C9 — Secrets and supply chain
No secret is committed, printed or logged. The dependency tree has no critical vulnerabilities.

- PASS condition: the secrets scan passes on the tracked tree, the SBOM is generated, and `dependency-analyzer` reports no critical/high-with-fix advisories in runtime dependencies.
- FAIL signal: a key in a tracked file; a key printed by a command; a scan that ignores `node_modules` but is presented as a full-tree scan.

### C10 — Governance: token and contract discipline
- No raw hex colour literal outside the token stylesheet.
- No provider import outside `packages/onekey`.
- `packages/contracts` is unmodified since the baseline commit (`e7a5e3f`).
- No hardcoded absolute path, user name or drive letter in any source file.
- PASS condition: each of these has a passing gate. FAIL signal: any one of them is unenforced or violated.

### C11 — Test quality, not test quantity
Tests assert behaviour, not implementation trivia. A test that cannot fail is a defect.

- PASS condition: for each of C2–C7 there is at least one test that would fail if the behaviour regressed (check by reading the assertion, not the name). Deliberate negative fixtures exist for every invariant and every conformance rule.
- FAIL signal: assertions on `expect(true)`, on mock call counts alone, or tests that pass against a deliberately broken implementation.

### C12 — Claim honesty
Every number in the code, the docs and the reports is labelled TARGET, ESTIMATE, or sourced. No achieved result is claimed. No vendor SLA, price, certification or legal conclusion is asserted.

- PASS condition: grep the source and docs for numeric claims; each is either a sourced constant, a TARGET, an ESTIMATE, or a test fixture.
- FAIL signal: a measured-looking result ("99.9% uptime", "12,000 learners reached") that no run produced.

### C13 — Internal consistency
The README, the session log, the ADR set and the code agree. An ADR that contradicts the code is a FAIL.

- PASS condition: spot-check three claims in the README against the code and the ADRs.
- FAIL signal: the README claims a gate that does not exist, or an ADR records a decision the code does not implement.

### C14 — Simplicity and altitude
No abstraction without a second caller. No configuration knob without a default and a reason. No speculative framework.

- PASS condition: each exported abstraction is used by at least one caller in the repo, or is explicitly named as a contract seam in an ADR.
- FAIL signal: unused exported machinery, an options bag with fields nobody sets, or a framework built for a hypothetical future phase.

### C15 — Independent reproducibility
A reviewer with no context can clone, bootstrap and run the verification from the README alone.

- PASS condition: following the README's commands works on a clean copy with no undocumented step.
- FAIL signal: a step that only works because of state on the build machine, or a command the README does not mention.

---

## Verdict gate

```
PASS requires:  Reviewer B verdict = PASS  AND  Reviewer C verdict = PASS
```

Any `critical_issues` entry from either reviewer is a fix-blocker. `suggestions` are optional.

## Fix cycle

1. Merge and dedupe the two reviewers' `critical_issues`.
2. Fix **only** the flagged issues — no opportunistic refactoring.
3. Re-spawn **both** reviewers with **fresh** context (anchoring bias is the failure mode this method exists to remove).
4. Repeat, max 3 rounds. On round 4, escalate to the owner with the outstanding issues and the evidence.
