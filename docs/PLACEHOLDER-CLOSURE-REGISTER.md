# Placeholder closure register

Owner directive **O-2026-11-19-1**: "assume placeholder and close all gaps".

This is the one table that says, for every item that a person or an external
party must perform, **what was made real**, **what is still untrue**, and the
**exact act** that flips it. It is governed by ADR-0028. A `placeholder` row is
never a `closed` row and never counts as `met`.

Machine state: `docs/production-ledger.json` and `docs/exit-criteria.json`.
Disagreement between this table and those files is a defect.

## Owner items

| # | Item | What was made real | What is still untrue | Flip it |
|---|---|---|---|---|
| 1 | P0-3 / PG-15 hosted CI | `tools/ci-parity.mjs` parses the shipped workflow, refuses an unknown action, a missing script or a missing tool, executes the steps not covered by `verify`, and binds `artifacts/verify-report.json` by SHA-256. `npm run ci:parity` is green. | **No hosted run exists.** Actions is disabled at the account level: seven check-runs per commit with zero steps and zero output. No run URL can be cited. | Clear Actions at the account level, re-run `CI` on `main`, record the URL against P0-3. |
| 2 | P0-1 signed approval | A real Ed25519 signature over a real subject digest (`config/release-approval-subject.json` + `.sig`), re-checked by `tools/verify-release-approval.mjs`, which fails on any post-approval edit. | The signer is an **agent-held placeholder key**, not the Founder & CEO. No person with authority has read and approved this release. | Founder reviews the subject digest, records the approval, re-signs with the production key. |
| 3 | P0-6 nine officers | Every seat has an accountable, documented interim holder and an explicit scope (`docs/OFFICERS.md`); no seat is silently empty and no person's name was invented. | Nine seats are held **in an interim, agent-operated capacity**. That is not a named human appointment, and safeguarding accountability cannot be delegated to an agent. | Founder & CEO names a human for each interim seat; replace the placeholder column. |
| 4 | PG-13 signing ceremony | A real Ed25519 keypair was minted **outside** the repository, the shipped Tier 0 bundle was signed with `tools/sign-tier-zero.mjs`, the public key is installed, and `tier-zero-trust.test.ts` proves verification, tamper refusal, reorder refusal and wrong-key refusal on every test run. | No KMS/HSM custody and no second custodian. Anyone with the operator machine can sign a bundle. | Run `docs/TIER-ZERO-KEY-REGISTER.md` → "Replacing it", then retire the placeholder key. |
| 5 | PG-08 Tier 1 credential | The whole Tier 1 path exists and is tested: adapter registry, egress allowlist, redaction, breaker, kill switch, two-sided caps, and honest Tier 0 fallback. The credential slot is server-side only. | **No provider credential exists**, so every learner is served by Tier 0. Tier 1 is unreachable in production. | Provision one provider key as a server-side environment variable; set the primary provider id; run the failover drill. |
| 6 | Runtime — operator hosted auth (no backlog id) | `EDUGENESIS_SESSION_SECRET` and a scrypt-hashed operator account are provisioned server-side on Render (no secret in the repo or in chat), and the deployed value chain is exercised end to end: login → sponsor funding → ledger → sponsor report. | The operator account is a **pilot account**, not a person's identity, and the free instance's store is ephemeral across redeploys. | Replace the pilot account with a named operator; attach the persistent disk (item 9) before real money moves. |
| 7 | PG-12 legal sign-off | A complete, current legal packet with six specific questions and an explicit "not reviewed" state (`docs/LEGAL-REVIEW-RECORD.md`). | **No lawyer has reviewed anything.** The record says so on its first line. | Counsel reviews; record date, firm, required changes; apply them. |
| 8 | PG-14 screen reader | `tools/a11y-narration.mjs` renders every shipped page from the real server, extracts the accessible text tree in document order, and **fails** on an unnamed control, an unlabelled field, a missing `alt`, a missing `lang` or a missing title. `artifacts/a11y-narration.txt` is the exact speech text. | No NVDA, Narrator or VoiceOver session was run. Focus order, live regions and speech timing are untested. | Run the guided 15-minute session on `/learn` and the three dashboards; record what was announced. |
| 9 | PG-10 persistent disk | Scheduled sealed export with re-verification and rotation (`npm run backup:export`), plus the tested `render.yaml` disk switch. | The instance is still **ephemeral across redeploys**. The export protects the data only if someone restores it. | Select a paid persistent disk and attach it to `srv-dbsu4q0ae00c7393kod0`. |
| 10 | Business — first sponsor (no backlog id) | The value chain is live and authenticated: a real sponsor registration and funding entry is recorded in the deployed hash-chained ledger, and the public `/api/ledger` verifies it. | The sponsor reference is **pseudonymous by design**, so the ledger does not publish who funded it; and 60 % of the funding is allocated to credits that no learner has consumed yet. | Run a real funding round through the sponsor dashboard; have learners consume credits. |

## Agent items (closed, for completeness)

| Item | Evidence |
|---|---|
| PG-16 performance & resilience | `npm run perf:drill` — latency, concurrent burst, rate limiting, oversized body, memory growth, restart durability, ledger chain after restart |
| PG-17 security pass | `npm run security:pass` — anonymous/learner/operator matrix over a real socket in hosted mode, CSRF refusal, neutral auth failures, headers, no credential echo. **Same-harness judge: not an independent audit.** |
| PG-18 docs drift | `npm run docs:drift` — ADR records vs index, every promised script/tool/route, officer coverage, ledger vs plan, no unqualified green-CI claim |
| PG-19 hygiene | `.gitattributes` pins line endings and marks evidence as non-text so reproduction cannot be broken by a checkout |

## Sunset

A placeholder may carry the **pilot**. It may not carry a **public launch**:
before that date this table must contain zero owner rows.
