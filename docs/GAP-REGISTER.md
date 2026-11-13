# EduGenesis OS — Forensic Gap Register

- Registers merged: **5/8** — MISSING: F2, F4, F6, F7
- Raw findings: 85 → merged: 85 (deduped by file+title)
- Severity: **10 blocker / 39 major / 36 minor**
- Proven: 85 · Unverified: 0 · Owner-blocked: 0

| # | Sev | Surface | File:Line | Finding | Corroborated by |
|---|---|---|---|---|---|
| 1 | BLOCKER | F0 | apps/cli/src/serve.ts:217 | There is no learner runtime: the shipped server exposes a health check and a settings API, and nothing else | — |
| 2 | BLOCKER | F0 | packages/identity/src/enrolment.ts:222 | The enrolment service has zero runtime callers: the P1-1 path exists as a library and nowhere else | — |
| 3 | BLOCKER | F1 | apps/cli/public/index.html:2 | P1-4 recorded met but the PWA renders the DARK theme by default; Accepted ADR-0011 is contradicted | — |
| 4 | BLOCKER | F1 | artifacts/attestation.json:4 | Attestation certifies a red report: artifacts/attestation.json says PASS 14/14 while artifacts/verify-report.json on disk says FAIL 12/14 | — |
| 5 | BLOCKER | F3 | packages/onekey/src/gateway.ts:295 | The learner path throws an UNTYPED Error when a provider reports zero usage (raw Error escapes complete()) | — |
| 6 | BLOCKER | F3 | packages/onekey/src/policy.ts:133 | The policy engine trusts the CLIENT-declared data class and safety tier and ignores the server-side TaskPolicy's | — |
| 7 | BLOCKER | F3 | packages/onekey/src/providers/qwen-adapter.ts:193 | The egress allowlist is dead code: the only real provider adapter never calls it and ships raw grounded context to the third party | — |
| 8 | BLOCKER | F3 | packages/onekey/src/providers/qwen-adapter.ts:258 | A live provider returning HTTP 200 with no/empty content delivers an EMPTY TEXT to the learner | — |
| 9 | BLOCKER | F3 | packages/onekey/src/providers/tier-zero.ts:228 | Tier 0 last-resort serves an UNRELATED lesson while asserting it 'covers this topic' | — |
| 10 | BLOCKER | F0 | docs/adr/ADR-0013-typescript-on-node-with-node-sqlite.md:36 | ADR-0013 records a node:sqlite repository interface and adapter that exist nowhere in the code | — |
| 11 | MAJOR | F0 | packages/identity/src/consent.ts:165 | The consent and enrolment audit trails are in-memory Maps: an audit log that dies with the process | — |
| 12 | MAJOR | F0 | packages/identity/src/enrolment.ts:258 | issueGuardianConsentToken hands a fresh guardian credential to any caller and performs no authorisation check | — |
| 13 | MAJOR | F0 | packages/identity/src/enrolment.ts:361 | Enrolment trusts a caller-supplied age band instead of the age-assurance service | — |
| 14 | MAJOR | F1 | docs/exit-criteria.json:46 | P0-4's evidence points at a file with no tokens and no contrast ledger artefact is attached | — |
| 15 | MAJOR | F1 | docs/exit-criteria.json:142 | P5-4's cited evidence proves continued delivery but not the 'no learner-facing credit message' clause | — |
| 16 | MAJOR | F3 | packages/onekey/src/conformance.ts:95 | No adapter is required to run the conformance suite, and the one real adapter would fail it | — |
| 17 | MAJOR | F3 | packages/onekey/src/conformance.ts:226 | The conformance suite destroys a live adapter's credential and then fails its own budget rule because of it | — |
| 18 | MAJOR | F3 | packages/onekey/src/failover.ts:291 | No single request walks all five tiers; tiersExercised is a Set union that hides the double Tier 0 visit | — |
| 19 | MAJOR | F3 | packages/onekey/src/gateway.ts:214 | 'Core learning is never denied on credit exhaustion' is caller-conditional, and the denial message states that credits ran out | — |
| 20 | MAJOR | F3 | packages/onekey/src/gateway.ts:288 | A 429 rate-limit trips the health circuit on a healthy provider | — |
| 21 | MAJOR | F3 | packages/onekey/src/gateway.ts:297 | The hard cap does not bound real provider spend: the provider is called and paid for, then the charge is refused and the answer discarded | — |
| 22 | MAJOR | F3 | packages/onekey/src/gateway.ts:392 | The audit trail records 'the request is deferred to human support' even when no Tier 4 handler exists | — |
| 23 | MAJOR | F3 | packages/onekey/src/gateway.ts:393 | The failure the learner path throws carries the raw provider error (HTTP status, provider id, 'credential') | — |
| 24 | MAJOR | F3 | packages/onekey/src/kill-switch.ts:29 | The kill switch is per-process and in-memory: a kill issued on one replica does not stop traffic on another | — |
| 25 | MAJOR | F3 | packages/onekey/src/policy.ts:231 | The routing decision asserts servedOffline/tier-zero even when no Tier 0 provider exists, so the decision can promise a delivery the gateway refuses | — |
| 26 | MAJOR | F3 | packages/onekey/src/providers/qwen-adapter.ts:134 | The provider base URL is unvalidated: any scheme or host, and redirects are followed | — |
| 27 | MAJOR | F3 | packages/onekey/src/providers/tier-zero.ts:58 | The Tier 0 learner message does not satisfy §6.6 step 6 and frames Tier 0 as a degraded fallback | — |
| 28 | MAJOR | F5 | packages/ledger/src/ledger-store.ts:256 | Chain integrity is not enforced on read/write; tampering only detected when caller explicitly verifies | — |
| 29 | MAJOR | F5 | packages/ledger/src/sponsor-report.ts:209 | Sponsor report silently defaults missing/mismatched producer keys to zero/false, hiding contract drift | — |
| 30 | MAJOR | F8 | packages/identity/src/consent.ts:164 | No store is durable: the consent, enrolment and ledger audit trails are in-memory arrays, so a restart erases the evidence and no third party can verify it | — |
| 31 | MAJOR | F8 | packages/identity/src/consent.ts:252 | Consent service performs no authorization: grant()/withdraw() accept any learnerId, any scope, and a caller-supplied timestamp and actor | — |
| 32 | MAJOR | F8 | packages/identity/src/enrolment.ts:258 | Guardian consent token is minted against ANY existing principal; the guardian's role is never checked, so a learner account can act as the guardian | — |
| 33 | MAJOR | F8 | packages/identity/src/enrolment.ts:361 | Age band is a caller-asserted attribute that the ABAC policy trusts; enrolment never calls age assurance | — |
| 34 | MAJOR | F8 | packages/ledger/src/pii-guard.ts:52 | PII guard misses composite and homoglyph key names, so a learner's name can be written to the permanent public ledger | — |
| 35 | MAJOR | F8 | packages/onekey/src/providers/qwen-adapter.ts:144 | assertSafeBaseUrl constrains the scheme but not the destination: any HTTPS host (including link-local metadata) is accepted, so a tampered base URL exfiltrates the bearer credential | — |
| 36 | MAJOR | F3 | packages/onekey/src/gateway.ts:508 | meta.policyReason is not redacted: a raw key in a kill reason reaches the delivered result | — |
| 37 | MAJOR | F3 | packages/onekey/src/providers/qwen-adapter.ts:236 | §6.6 step 2 (revoke/rotate the credential on 401/403, never retry it) is not implemented | — |
| 38 | MAJOR | F5 | packages/ledger/src/ledger-store.ts:163 | Negative monetary values can be appended for money-key fields; append path does not enforce non-negative amounts | — |
| 39 | MAJOR | F8 | apps/cli/src/serve.ts:202 | Settings API has no CSRF/Origin protection: any web page the operator visits can rewrite the local settings file | — |
| 40 | MAJOR | F0 | artifacts/attestation.json:31 | The committed attestation names a different commit than the tree it ships with | — |
| 41 | MAJOR | F1 | .github/workflows/ci.yml:24 | P0-5 recorded met, but there is no accessibility CI job and no red build | — |
| 42 | MAJOR | F1 | docs/adr/README.md:30 | ADR owner column contradicts the ADR prose for 11 of 16 records; P0-2's check cannot detect it | — |
| 43 | MAJOR | F1 | docs/exit-criteria.json:75 | P1-1's register evidence cites identity.test.js, which contains no enrolment test | — |
| 44 | MAJOR | F1 | packages/onekey/src/registry.ts:14 | Phase 5 work items unimplemented: 13-item model card + lifecycle, signed Tier 0 bundle pipeline, adapter regions allowlist, Tier 2 adapter | — |
| 45 | MAJOR | F3 | packages/onekey/src/gateway.ts:456 | The nine-element compliance emission is computed and then thrown away | — |
| 46 | MAJOR | F8 | packages/onekey/src/providers/qwen-adapter.ts:230 | The egress boundary lives in one adapter, not in the gateway: every other registered adapter receives the raw request including nested context | — |
| 47 | MAJOR | F5 | packages/ledger/src/ledger-store.ts:216 | Ledger is in-memory only, not SQLite/append-only durable store as hunted; no WAL/journal, crash/truncation semantics absent | — |
| 48 | MAJOR | F1 | docs/adr/ADR-0013-typescript-on-node-with-node-sqlite.md:36 | ADR-0013 records a repository interface + node:sqlite adapter; neither exists in the code | — |
| 49 | MAJOR | F5 | packages/ledger/src/ledger-store.ts:221 | No concurrency serialization or seq uniqueness enforcement; concurrent appends can fork the hash chain | — |
| 50 | MINOR | F0 | packages/identity/src/enrolment.ts:299 | Token claim matching compares scopes by position, so a client that reorders scopes is refused | — |
| 51 | MINOR | F1 | packages/contracts/src/index.ts:116 | The nine-element emission's concrete fields differ from Doc 7 5.1/5.2 (reading_level nesting, sensory_profile and interaction_mode shape) | — |
| 52 | MINOR | F1 | tools/verify-coverage.mjs:116 | P1-3's coverage gate enumerates six hard-coded gateway paths, so a new learner-facing path would not be counted | — |
| 53 | MINOR | F3 | packages/onekey/src/gateway.ts:40 | The ladder is six rungs, not five, and the package's own docstring says five | — |
| 54 | MINOR | F3 | packages/onekey/src/index.ts:29 | The package's public surface re-exports the concrete Qwen adapter, and the registry guard exempts exactly the file that does it | — |
| 55 | MINOR | F3 | packages/onekey/src/policy.ts:200 | Locale coverage is only a tie-break, never an eligibility rule - and Tier 0 treats it as a hard filter | — |
| 56 | MINOR | F3 | packages/onekey/src/providers/local-echo.ts:81 | The local-echo input-token estimate ignores the request context, under-charging the ledger | — |
| 57 | MINOR | F3 | packages/onekey/src/redact.ts:35 | Redaction is string-only and is skipped on some of the same package's error paths | — |
| 58 | MINOR | F3 | packages/onekey/src/testing/support.ts:137 | Dead options and exports: refuseOverBudget, timeoutMs, GatewayOptions.policyEngine, tryProjectEgressPayload | — |
| 59 | MINOR | F5 | packages/ledger/src/ledger-store.test.ts:270 | Test suite does not cover several adversarial/contract-risk cases (negative money at append, unicode-homoglyph/ZWSP field evasions beyond normalization assumptions, sponsor-report key drift failures) | — |
| 60 | MINOR | F5 | packages/ledger/src/pii-guard.ts:247 | PII guard value scanning cannot detect names/free-text PII under innocuous keys or obfuscated/non-pattern values | — |
| 61 | MINOR | F5 | packages/ledger/src/private-store.ts:149 | Private-store separation and privacy are enforced by in-memory convention/interface, not durable isolation/encryption controls | — |
| 62 | MINOR | F5 | packages/ledger/src/sponsor-report.ts:255 | Sponsor report does not fail when ledger chain is broken; it publishes a report with chainOk=false | — |
| 63 | MINOR | F8 | apps/cli/src/serve.ts:92 | The hosted settings server is unauthenticated and internet-reachable, disclosing the API-key names and lengths and absolute filesystem paths | — |
| 64 | MINOR | F8 | packages/onekey/src/kill-switch.ts:31 | The kill switch is process-local: a restart resurrects a provider killed for a safety, residency or licence failure | — |
| 65 | MINOR | F1 | .github/workflows/ci.yml:24 | CI does not implement the 9.2 GL-01..GL-08 pipeline the Phase 0 work item promises | — |
| 66 | MINOR | F3 | packages/onekey/src/gateway.ts:168 | The gateway can be constructed with a policy engine that holds a different breaker and kill switch than the gateway's own | — |
| 67 | MINOR | F3 | packages/onekey/src/providers/qwen-adapter.ts:315 | Provider statusText is returned to the audit trail without redaction | — |
| 68 | MINOR | F5 | packages/ledger/src/reinvestment.ts:141 | Double-count detection for semantically duplicated funding/allocation records is absent; engine trusts ledger entries as unique facts | — |
| 69 | MINOR | F8 | packages/onekey/src/egress.ts:208 | projectGroundedContext's locator check misses drive-relative and scheme-only path forms | — |
| 70 | MINOR | F8 | tools/secrets-scan.mjs:121 | The secrets scanner never scans git history and skips the artifacts directory, and the published checksum manifest carries a digest of the plaintext API-key file | — |
| 71 | MINOR | F0 | packages/identity/src/enrolment.ts:359 | The enrolmentMethod attribute is written and never read | — |
| 72 | MINOR | F1 | docs/exit-criteria.json:25 | P0-2's evidence is a string-contains check that cannot detect a missing owner or an 'unassigned' status | — |
| 73 | MINOR | F3 | packages/onekey/src/gateway.ts:591 | The ARC-I4 uncertainty note is unreachable: no adapter in the package reports confidence | — |
| 74 | MINOR | F5 | packages/ledger/src/ledger-store.ts:256 | `all()` exposes live mutable entry objects, permitting in-process mutation/deletion outside append-only API semantics | — |
| 75 | MINOR | F3 | packages/onekey/src/circuit-breaker.ts:75 | The half-open circuit does not admit exactly one probe, and the promotion happens on read | — |
| 76 | MINOR | F3 | packages/onekey/src/failover.ts:57 | The failover drill accepts an injected gateway while claiming 'The drill is offline' | — |
| 77 | MINOR | F3 | packages/onekey/src/gateway.ts:170 | The per-request attempt trail is never evicted | — |
| 78 | MINOR | F3 | packages/onekey/src/providers/qwen-adapter.ts:242 | The adapter has no retry, yet its 429 message advertises a retry-after hint that is never acted on | — |
| 79 | MINOR | F1 | README.md:111 | Deployment story in the docs is incomplete: env vars, PORT, health check and rollback are undocumented in the README | — |
| 80 | MINOR | F3 | packages/onekey/src/gateway.ts:575 | The emitted risk tier is hardcoded to 1 regardless of the request's safety tier | — |
| 81 | MINOR | F0 | packages/identity/src/enrolment.ts:200 | A guardian consent token cannot be revoked before it expires | — |
| 82 | MINOR | F3 | packages/onekey/src/providers/qwen-adapter.ts:276 | latencyMs is hardcoded to 0 in the network adapter | — |
| 83 | MINOR | F3 | packages/onekey/src/registry.ts:65 | The registry snapshots capabilities at registration and the policy engine enforces the stale snapshot | — |
| 84 | MINOR | F5 | packages/ledger/src/ledger-store.ts:200 | Payload timestamps accepted as any parseable date string, not strictly normalized ISO-8601; canonical preimage hashes the provided string form | — |
| 85 | MINOR | F5 | packages/ledger/src/reinvestment.ts:117 | 60% reinvestment excludes out-of-period allocations from compliance math, which can misstate compliance for period funding | — |

## Surface summaries

### F0
Solo's own first-hand review of the live tree, independent of the three swarm surfaces, and every finding re-verified against the code rather than accepted from a report. The dominant theme: the slice is a LIBRARY plus a GATE SUITE. It contains no learner runtime, no durable store and no audit trail that outlives the process, and the documentation claimed otherwise in three places (an ADR, a package README and the Render Blueprint). The crypto and the core invariants are genuinely sound — scrypt with a salted verifier and timingSafeEqual, real RBAC/ABAC rules that read the enrolment attributes, and a token implementation that matches presented claims against issued claims rather than trusting the caller.

### F1
F1 traced all 16 Phase 0/1/5 exit-criteria rows and the Phase 1/5 work items against the frozen snapshot. Six criteria are genuinely proven by a named executable check; six are implemented but their register evidence is wrong, partial or too weak; three are honestly owner-blocked; one (P1-4) is mislabelled. Two blockers: the shipped evidence chain is self-contradictory (a PASS attestation binds a report that is red on disk, digest mismatch), and the PWA renders the dark theme by default, contradicting the recorded P1-4 met and Accepted ADR-0011. The recurring defect class is evidence that proves a different behaviour than the criterion text: P1-1 cites a test file with no enrolment test, P0-4 cites a file with no tokens, P5-4 cites a test that skips half the criterion, and P0-2/P0-5 cite checks that cannot fail on the exact defect. Eleven of sixteen ADR owner rows contradict the ADR prose, and ADR-0013 records a repository/node:sqlite seam that does not exist. Every gap found is closable in code; none requires an owner decision.

### F3
The OneKey package is a real, thoughtfully commented implementation - the fallback chain, the typed error taxonomy, the attempt trail and the policy hard rules are genuinely there - but several load-bearing promises are only prose. PROVEN by execution against a copy of the snapshot: the egress boundary has zero production callers and the one network adapter ships raw grounded context (safeguarding/disability notes) to the provider; a live provider empty answer reaches the learner as an empty lesson; a zero-usage answer throws an untyped Error out of the learner path; the Tier 0 last-resort serves an unrelated lesson while claiming it covers this topic; and the policy engine routes on the CLIENT-declared data class, ignoring the server-side policy. The credit-exhaustion guarantee is real only when a caller wires a Tier 0 provider, the hard cap does not bound real provider spend, the kill switch and circuit breaker are per-process, and the failover drill [0,1,2,3,4] report is a Set union over three different requests that hides tier 0 being visited twice and skipped once. Nothing outside apps/cli/src/selftest.ts consumes the package, so no learner-facing application exists yet to expose or mask these paths.

### F5
packages/ledger implements an in-memory hash-chained event log with deterministic hashing, PII name/value guards, private-store redaction, 60% reinvestment math, and sponsor aggregation, but not a durable SQLite-backed ledger. Core integrity controls are partial: append-only is API-level only (mutable `all()` exposure), verification is opt-in, and there is no persistence, WAL, or concurrency serialization. Money handling is mostly integer-safe in computations/reads yet append accepts negative money-key values and sponsor metrics silently default on key drift. No-PII and 60% claims are bounded by implementation semantics (pattern-based PII scan, timestamp-window attribution, no semantic dedupe) rather than absolute guarantees.

### F8
IN PROGRESS - probes pending.
