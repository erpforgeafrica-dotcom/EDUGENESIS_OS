# Architecture Decision Records — EduGenesis OS

Every decision that shapes the platform is recorded here. An ADR is immutable
once accepted: a decision that turns out to be wrong is **superseded** by a
later ADR, not edited in place.

| Field | Meaning |
|---|---|
| **Context** | The forces in play when the decision was made, including what was true at that moment. |
| **Decision** | What was decided, in the present tense. |
| **Consequences** | What becomes easier, what becomes harder, and what is now true that was not true before. |
| **Alternatives considered** | The options that were rejected, and why. |
| **Status** | `Proposed`, `Accepted` or `Superseded`. |
| **Owner** | The role accountable for the decision. |
| **Revisit trigger** | The observable condition that would cause this decision to be reopened. |

## Status meanings

- **Accepted** — the decision is compelled by a controlling document or by the
  product law, and it is binding on engineering.
- **Proposed** — the decision is the architectural recommendation; it requires
  the named owner and the listed revisit condition before it becomes binding.
- **Superseded** — replaced by a later ADR, which is named in the row.

## Index

| ADR | Title | Status | Owner | Record |
|---|---|---|---|---|
| ADR-0001 | Provider abstraction and the OneKey gateway | Accepted | Chief AI & Model Orchestrator | Proposal §11 |
| ADR-0002 | No payment object exists in the learner request path | Accepted | Chief AI & Model Orchestrator | Proposal §11 |
| ADR-0003 | Ledger-versus-store separation | Accepted | Finance Lead | Proposal §11 |
| ADR-0004 | Offline-first and Tier 0 are a product guarantee, not a degraded mode | Accepted | Chief AI & Model Orchestrator | Proposal §11 |
| ADR-0005 | Accessibility as a runtime contract enforced at the emission boundary | Accepted | Chief Inclusion & Accessibility Officer | Proposal §11 |
| ADR-0006 | AI Main Tutor with Occasional Human Enrichment | Accepted | Chief Learning Scientist | Proposal §11 |
| ADR-0007 | Background autonomy is preparation only; production authority is human-governed | Accepted | Chief AI & Model Orchestrator | Proposal §11 |
| ADR-0008 | Data residency posture for the Alibaba / Qwen pilot | Proposed | Security Officer | Proposal §11 |
| ADR-0009 | Deployment platform and Render resource allocation | Proposed | Chief AI & Model Orchestrator | Proposal §11 |
| ADR-0010 | Sponsor firewall enforcement | Accepted | Governance Lead | Proposal §11 |
| ADR-0011 | The learner PWA defaults to the LIGHT theme | Accepted | Chief Inclusion & Accessibility Officer | Proposal §11 |
| ADR-0012 | No real learner data in technical demonstrations | Accepted | Child Safeguarding Officer | Proposal §11 |
| [ADR-0013](ADR-0013-typescript-on-node-with-node-sqlite.md) | TypeScript on Node 24 with `node:sqlite` behind a repository interface | Accepted | Chief AI & Model Orchestrator | This directory |
| [ADR-0014](ADR-0014-zero-runtime-dependencies.md) | Zero runtime dependencies | Accepted | Security Officer | This directory |
| [ADR-0015](ADR-0015-node-test-as-the-test-runner.md) | `node:test` as the test runner | Accepted | OpenCode Lead | This directory |
| [ADR-0016](ADR-0016-versioned-json-settings-and-the-settings-ui.md) | Versioned JSON settings inside the project, edited by a local Settings UI served by `eg serve` | Accepted | Chief AI & Model Orchestrator | This directory |

## ADR-0001 to ADR-0012

ADRs 0001–0012 are recorded in full, with their context, decision,
alternatives and consequences, in
`EDUGENESIS_OS_PROPOSAL/09_TECHNICAL_ARCHITECTURE_AI_BRAIN_AND_DEPLOYMENT.md`
§11. They are carried into this index unchanged: their titles, statuses and
governing citations are mirrored above, and their prose remains the authority.
They are not duplicated here because a decision record that exists in two
places is a decision record that will drift.

## ADR-0013 to ADR-0016

These four record the foundation choices of this repository: the runtime, the
dependency policy, the test runner and the settings surface. Together they are
what makes the product law — *this folder runs identically on any machine it is
copied to* — true rather than aspirational.
