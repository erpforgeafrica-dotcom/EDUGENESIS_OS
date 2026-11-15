# Forensic audit — round 4 (reconciliation at HEAD `677f415`)

**Date:** 2026-11-13 · **Build root:** `EDUGENESIS_OS_BUILD` · **HEAD:** `677f415` · **Remote:** none
**Method:** the round-3 register was written before repairs R1–R17 landed. This round re-verifies
every round-3 finding against the code that actually ships now, and adds first-hand coverage of
the surfaces round 3 lost (F2, F4, F6, F7), plus a fresh end-to-end verification run.

Skills used, per the compelled-skill law: `production-audit` (frame + scoring), `code-review`
(change-risk lens), `security-testing` (F8/F4 probes), `accessibility-testing` (F2 probes),
`test-strategy` (F6 gate soundness, delegated). No matching skill: `ui-ux-pro-max` — the UI
surface is one settings page and the design-token/contrast gates already cover it.

---

## 1. Verified state — what is true at `677f415`

| Check | Command | Result |
|---|---|---|
| Working tree at session start | `git status --porcelain=v1` | **clean** |
| HEAD | `git rev-parse HEAD` | `677f415fddc1b680a089c211cd696ea8f105aabc` |
| Remote | `git remote -v` | **none** |
| Build | `npm run build` (inside `npm run verify`) | exit 0 |
| Tests | `npm run test:only` via glob + meta-gate | **483/483 pass, 0 fail, 29 suites** (after Batch A) |
| Gates | `node tools/verify-all.mjs` | **16/16 PASS, 0 blockers failed, 0 warnings** |
| Secrets | `npm run secrets:scan` | 0 findings (live canary) |
| Chain | checksums → 179 files (assets included, build cache and local override excluded); attestation PASS | manifest bound |
| Exit criteria | `exit-criteria` gate | **13 met, 3 owner-blocked** (P0-1, P0-3, P0-6) |

**Current working tree after Batch E (the two accessibility gate halves):** `npm run verify`
exit 0 — **495/495 tests** (29 suites), **18/18 gates PASS**, 0 warnings, secrets scan 0
findings over 179 files (canary live), **181-file manifest**, attestation PASS, and the path
gate reads **143 shipped file(s)**. The table above is the `677f415` snapshot the audit was
performed against and is left as observed; these are the numbers of the tree that now carries
the fixes.

**New structural defect found by this run:** `npm run verify` on a clean tree **dirtied the
tree by design** — it rewrites `artifacts/attestation.json`, `artifacts/checksums.sha256` and
`artifacts/sbom.cdx.json` — and the attestation then recorded `git HEAD 677f415` together with
`gitDirty: true`. The root cause is self-reference, not the rewrite: a document inside the tree
cannot name the commit that carries it, and a timestamp taken from HEAD moves the moment the
artifact is committed. A committed attestation could therefore never simultaneously (a) name
its commit and (b) describe a clean tree. The round-3 finding "attestation names a different
commit" is closed in its instance but was **alive as a structural defect**. Recorded as
**F6-R4-01** (see §5). **Fixed in the working tree:** `tools/attest.mjs` stores **no VCS-derived
field at all** — no commit, no dirty flag, no HEAD-derived timestamp — because committing the
attestation is exactly what makes the tree clean, so a *stored* dirty flag contradicts itself on
commit (a clean checkout regenerates it with `dirty: false`, the bytes differ, the tree is dirty
again, and `git status` can never be empty). HEAD, the code-tree state and the artifact-tree
state are printed to the console and never attested; the attested bytes are a function of tree
content only, plus `buildTime` when `SOURCE_DATE_EPOCH` is declared. `tools/sbom.mjs` dropped the
HEAD-date fallback for the same reason. `npm run verify:repro` is the executable check that two
runs produce identical evidence, and the standing check for the fix is that `npm run verify` on a
committed tree leaves `git status --porcelain` empty (evidence in §7).

---

## 2. Register reconciliation — 85 round-3 findings vs current code

Verified **closed by repairs R1–R17** (each re-read at `677f415`, not accepted from the repair table):

| Closed | Finding | Closed by |
|---|---|---|
| F0-02, F1-05 | ADR-0013 recorded a `node:sqlite` seam that does not exist | ADR-0017 supersedes it; `adr-governance` gate |
| F0-07, F1-01 | Attestation bound a red report / a different commit | evidence chain regenerated; still structurally non-idempotent (§1) |
| F1-02 | PWA rendered dark while claiming light | `<html data-theme="light">`; `pwa-light-default` gate PASS |
| F1-03 | P1-1 evidence cited a test file with no enrolment test | evidence now `packages/identity/dist/enrolment.test.js` (minTests 13) |
| F1-04, F1-11 | ADR owner column contradicted records; P0-2 check could not detect absence | index reconciled; `adr-governance` gate |
| F1-06 | No accessibility CI job | dedicated `accessibility` job exists in `ci.yml` |
| F1-08 | P0-4 evidence pointed at a file with no tokens | evidence now `app.css` (`--eg-` tokens) + `verify-contrast.mjs` |
| F3-01 | Egress allowlist was dead code | adapter now calls `projectEgressPayload` + `projectGroundedContext` |
| F3-02 | Empty provider answer delivered as a lesson | gateway treats empty text as a provider failure |
| F3-03 | Zero usage threw an untyped Error out of `complete()` | gateway records it as a provider failure and falls through |
| F3-04 | Tier 0 last-resort asserted relevance it did not have | notice is score-aware |
| F3-05 | Policy trusted the client's data class / safety tier | effective classification = stricter of request and server policy |
| F3-06 | Hard cap did not bound real spend | budget tested against worst case **before** the call |
| F3-08 | Conformance suite destroyed the adapter it tested | `dispose()` moved last |
| F3-10 | `meta.policyReason` was not redacted | both sinks redacted |
| F3-12 | Provider base URL unvalidated | `assertSafeBaseUrl` at construction — **narrowed, see F8-06** |
| F5-05 | Negative money accepted at append | refused |
| F5-06 | Sponsor report defaulted missing producer keys | required keys; drift refused |
| F5-11 | Report published over a broken chain | chain verified before any figure |

**Still open at `677f415` — re-verified in code this round:**

| Severity | ID | Where | What the code still does |
|---|---|---|---|
| **BLOCKER** | F0-01 | `apps/cli/src/serve.ts:217` | Served routes are `/api/health`, `/api/settings`, assets and static. No learner route exists. |
| **BLOCKER** | F0-03 | `packages/identity/src/enrolment.ts:222` | `createEnrolmentService` has exactly one caller: its own test. |
| major | F8-03 | `packages/identity/src/consent.ts:252` | `grant()`/`withdraw()` accept any learner, any scope, any caller-supplied time and actor. No authorisation. |
| major | F8-01 | `packages/identity/src/enrolment.ts:258` | `issueGuardianConsentToken` checks only that the principal exists; a learner principal can be issued a guardian token. |
| major | F8-02 | `packages/identity/src/enrolment.ts:361` | Age band is caller-asserted and trusted; age assurance is never called. |
| major | F8-05 | `packages/ledger/src/pii-guard.ts:52` | Exact-after-normalisation key matching only; composite keys (`learner.name`) and homoglyphs pass. |
| major | F8-06 | `packages/onekey/src/providers/qwen-adapter.ts:144` | `assertSafeBaseUrl` constrains scheme and credentials, **not destination** — any HTTPS host is accepted. |
| major | F8-07 | `packages/onekey/src/providers/qwen-adapter.ts:230` | Egress projection lives in the Qwen adapter; the gateway hands every other adapter the raw request. |
| major | F8-08 | `apps/cli/src/serve.ts:202` | No Origin / `Sec-Fetch-Site` check on settings writes. |
| major | F8-04 | `packages/identity/src/consent.ts:164` | Consent, enrolment and ledger trails are in-memory; a restart erases the evidence. |
| major | F3-09 | `packages/onekey/src/conformance.ts:95` | Nothing requires an adapter to pass conformance; the Qwen adapter is never run through it. |
| major | F3-13 | `packages/onekey/src/gateway.ts:294` | Any non-budget error calls `breaker.recordFailure` — a 429 trips the health circuit on a healthy provider. |
| major | F3-14 | `packages/onekey/src/providers/qwen-adapter.ts:308` | 401/403 is mapped to `ProviderUnavailableError`; the credential is neither revoked nor rotated. |
| major | F3-15 | `packages/onekey/src/gateway.ts:146` | `describeError` redacts key-shaped strings but still surfaces provider id and HTTP status to the learner. |
| major | F3-20 | `packages/onekey/src/gateway.ts:419` | After every tier fails the trail records "deferred to human support" even when no Tier 4 handler exists. |
| major | F3-11 | `packages/onekey/src/kill-switch.ts:31` | `killed` is a process-local `Map`; a restart resurrects a provider killed for safety/residency/licence. |
| major | F5-03 | `packages/ledger/src/ledger-store.ts:256` | Chain is verified only when a caller asks; read/write do not enforce it. |
| major | F5-02 | `packages/ledger/src/ledger-store.ts:221` | No serialisation or seq uniqueness; concurrent appends can fork the chain. |
| major | F5-01 | `packages/ledger/src/ledger-store.ts:216` | Ledger is in-memory; no durability, WAL or crash semantics (owner-gated with F8-04). |
| major | F1-09 | `packages/onekey/src/registry.ts:14` | Phase 5 items still unimplemented (model card/lifecycle, signed Tier 0 bundle, regions allowlist, Tier 2 adapter). |
| major | F1-07 | `docs/exit-criteria.json:142` | P5-4 evidence still does not prove the "no learner-facing credit message" clause. |
| major | F0-05, F0-06 | identity | Duplicates of F8-01 / F8-02. |
| major | F3-07, F3-19, F3-16, F3-17 | onekey | Credit-exhaustion guarantee remains caller-conditional; policy can promise a Tier 0 delivery no provider can make; failover drill is a Set union; Tier 0 message framing. |
| minor | 34 remain | — | See `docs/gap-register.json`; the sharpest are F8-09 (secrets scan skips `artifacts/` and git history), F8-10 (locator check misses drive-relative `C:foo` and scheme-only forms), F8-12 (hosted settings GET is unauthenticated and discloses key names/lengths), F3-28 (half-open admits more than one probe), F5-04 (`all()` returns live mutable entries). |

Counts after reconciliation: **85 âˆ’ 22 verified closed = 63 open** — **2 blockers, 27 majors,
34 minors**. The JSON register is annotated with this status in `docs/gap-register.json`
(`reconciliation` block); unlisted IDs remain open exactly as recorded.

---

## 3. First-hand coverage of the four lost surfaces

### F2 — accessibility (partial, source-level only)
The settings page is genuinely better than most: `lang`, a skip link, `main[tabindex=-1]`, a
labelled control for every input, `role="status" aria-live="polite"`, and the `token-contrast`
gate computes WCAG ratios in both themes and passes. Two defects found in source:
- **No `:focus-visible` rule for any interactive control.** The only focus rule in the whole
  stylesheet is `.eg-main:focus` (`app.css:46`). Keyboard users get the UA default at best, and
  the skip-link/buttons/inputs have no authored focus indicator — WCAG 2.4.7.
- **No `aria-describedby` anywhere** (`index.html`), so every hint and error message is visually
  adjacent but programmatically unassociated with its control — WCAG 1.3.1 / 3.3.1.
- No `prefers-reduced-motion` block exists. There is currently no authored animation, so this is
  latent, not yet a defect.

Not verified: screen-reader behaviour, 200 % zoom/reflow, target size, real browser focus order.

**Delegated F2 digest returned (03:53): 17 findings — 5 major, 12 minor.** The five majors:

| ID | Finding | Register relation |
|---|---|---|
| F2-01 | The accessibility emission contract is library-only: no shipped app path emits or validates an `AccessibilityEmission`, yet the Settings UI exposes an "Accessibility Guardian" toggle for a guard that never runs. | new |
| F2-02 | `.btn--quiet:hover` is **1.26:1** in the default light theme — `--eg-overlay` is never remapped under `[data-theme=light]`, so the dark navy overlay meets the light-theme ink. Repro: "Reload" (`index.html:165`) and generated "Remove" buttons (`app.js:87`). | new |
| F2-03 | 0 `aria-describedby` across 15 inputs; 12 of 13 hints are anonymous `<p>` elements, so portability/budget rules are unavailable in forms mode. | duplicates F2-R4-02 |
| F2-04 | The two accessibility gates named in the audit scope do not exist anywhere in the repo; the de facto contrast tool (`tools/verify-contrast.mjs`) passes 46/46 while never testing hover, `--eg-overlay` under light, or link-on-gold. | new |
| F2-05 | `AccessibleAlternative.text` is optional and ARC-I1 checks only object-shape + `equivalence_verified`, so an emission with no text alternative validates as compliant. | new |

Minor rows (12) are in `%TEMP%\opencode\eg-audit\F2-round4.json`; the sharpest are the
vacuity in the emission fixtures and the untested stateful contrast pairs.

**Repaired in the working tree after the digests landed:** F2-02 (`--eg-overlay` remapped for
`[data-theme=light]`, plus `text-primary/overlay`, `link-hover/canvas`, `link-hover/surface`
added to `tools/verify-contrast.mjs`) and F2-03 (`aria-describedby` on every hinted control,
hint ids added). The two gates those findings asked for now exist and pass (Batch E:
`keyboard-focus`, `form-semantics`). F2-01 and F2-05 remain open: they need the guardian wired
into a learner route and a stricter ARC-I1.

### F4 — identity (first-hand)
Confirmed F8-03 / F8-01 / F8-02 by reading the code (quoted above). The crypto is sound: scrypt
with a salted verifier and `timingSafeEqual`, and tokens match presented claims against issued
claims. The gap is **authority**, not cryptography: nothing in the identity package asks *who is
calling* before it grants, withdraws or mints.

### F6 — verification and tools (first-hand, plus delegated reviewer)
The gates are real: they read the shipped tree, have negative fixtures, and the four new gates
(`pwa-light-default`, `adr-governance`, `keyboard-focus`, `form-semantics`) compute rather than
string-match. Three defects:
- **F6-R4-01 (major):** `npm run verify` is not idempotent — it rewrites three artifacts and the
  attestation then records a dirty tree. A clean-checkout reproduction can never match a
  committed attestation. Fix: bind the artifacts by their own digests and delete every field
  whose value depends on the commit that carries the file.
  **Fixed in the working tree:** `tools/attest.mjs` stores **no VCS-derived field** — no
  `gitHead`, no `gitDirty`, no dirty flag and no HEAD-derived timestamp — because a stored dirty
  flag contradicts itself once committed (§1); HEAD, code-tree and artifact-tree state are
  console-only. `tools/sbom.mjs` no longer derives `metadata.timestamp` from HEAD
  (`SOURCE_DATE_EPOCH` or omitted, which CycloneDX 1.5 permits); `npm run verify:repro`
  (`tools/verify-repro.mjs`) runs the chain twice and fails on any artifact drift.
- **F6-R4-02 (minor):** `secrets-scan.mjs:35` excludes `artifacts/` explicitly, and the scanner
  walks the working tree only — a secret in git history or in a published artifact is invisible.
  **Closed (2026-11-13):** the scanner now reads every surface a secret can escape through. The
  published `artifacts/` directory is inside the scanned tree, and every blob reachable from any
  ref is scanned as history (`git rev-list --objects --all` enumerates, `git cat-file
  --batch-check` types and sizes, identical content is deduplicated by blob hash, each blob is
  read with `git cat-file blob`). Path exclusions deliberately do **not** apply to the history
  surface: whatever was once committed was once published, so a secret that was committed and
  later deleted — or a settings file that once carried a real key — is still named. A finding is
  attributed to `history/<path> @ <short-sha>` with a salted fingerprint; no secret value is ever
  printed. The canary self-test now plants a canary in a **file** and in a **blob** and refuses to
  pass unless the same detection code finds both, so the history detector cannot be inert.
  Measured over this repository's 31 commits: **185 tree files and 351 history blobs, 0 findings**.
- **F6-R4-03 (minor):** `verify-coverage.mjs` enumerates six hard-coded gateway paths (F1-14);
  a new learner-facing path is not counted.
  **Closed (2026-11-13):** the path list is now a **delivery-path registry** declared in the
  package that owns the gateway (`packages/onekey/src/testing/delivery-paths.ts`) — six
  learner-facing paths plus the operator control, each declaring the ladder rung it proves. The
  gate imports the registry, drives every entry through a real gateway with the real guardian,
  and holds **no path knowledge of its own**. The ladder is derived from `FALLBACK_TIER_ROLE` in
  the contracts, so the gate fails when a rung loses its only learner path, and it also fails when
  an entry serves from a tier other than the one it declares — a registry may not lie about its
  own path. Locked by 5 tests that drive every entry end to end.
- **F6-R4-04 (minor, found while fixing F6-02):** the manifest hashed gitignored
  `settings/settings.local.json` — machine-local learner overrides that may hold API keys — so
  two copies of the same commit produced different manifests, and a secret-bearing file
  received a published digest. **Fixed:** `EXCLUDE_PATTERNS` in `tools/checksums.mjs`; the
  manifest holds 0 `settings.local` lines.

**Delegated F6 digest returned (03:59): 33 gate assertions — 4 blocker, 13 major, 11 minor,
5 clean.** The digest is adversarial: it tests whether each gate *can* fail, not whether it
returned green. Four blockers, all gate-soundness not product code:

| ID | Gate | Why it is a blocker |
|---|---|---|
| F6-01 | attestation | A committed attestation can never name its own commit (§1), and no gate consumes `gitDirty`. Same structural defect as F6-R4-01. **Fixed:** the attestation stores **no VCS state at all** — no commit, no dirty flag, no HEAD-derived timestamp; HEAD and both tree states are console-only, so the file is a pure function of content and a committed checkout regenerates it byte for byte. `verify:repro` is the executable check. |
| F6-02 | checksums | `INCLUDE_ROOTS` omitted `assets/` entirely (0 of 183 lines), while 7 of 183 entries were gitignored `*.tsbuildinfo` files. **Fixed:** `assets/` added, `*.tsbuildinfo` excluded; manifest now 179 files with assets covered and machine-local state excluded. |
| F6-03 | aggregate | A gate whose sibling package is unbuilt returns `{passed:false, severity:'warning'}`. With every `packages/*/dist` deleted the run still reports `passed:true`, exit 0 - **an unrunnable gate is indistinguishable from a passing one**. **Closed via owner decision D-5 (2026-11-13):** `gateStatus()` now derives a third state `unverified` (a warning is never a pass); `summarise()` fails the run on any unverified gate; the report is `schemaVersion 2` with `result: PASS \| FAIL \| INCOMPLETE` and a counted `unverified` field; `verify-all.mjs` exits non-zero when any gate is unverified; `attest.mjs` refuses a chain that names an unverified gate. Locked by 3 tests in `gates.test.ts`. |
| F6-04 | path-portability | The config-file scan was dead code (it `readdirSync`s file paths, `ENOTDIR` is swallowed), and the extension/regex scope missed `.md/.yml/.yaml/.csv` and the forward-slash spellings of the drive-letter, POSIX-home and user-profile path classes. **Partially fixed:** `paths.ts` now stats before reading and names four root configs (`package.json`, `tsconfig.base.json`, `tsconfig.json`, `render.yaml`) plus every `packages/*` and `apps/*` `tsconfig.json` / `package.json` - **141 files scanned (124 source + 17 config)**, locked by `paths.test.ts`. **Closed in Batch F (2026-11-13):** the detectors in `scan.ts` now match both separator styles for every class - drive letter, UNC share, user-profile segment, POSIX home segment (new rules `abs-unc-posix` and `abs-home-profile`). The UNC host token must be at least two alphanumeric characters, so an escaped-newline string and the Windows device namespace are not false positives, and a forward-slash share host must be dot-free, so protocol-relative URLs are not. `.md` and `.csv` joined the scanned extensions, and the documentation that ships with the product joined the scanned scope through `listDocumentationFiles`. Locked by eight new fixtures in `scan.test.ts`. The gate's claim ("anywhere in the shipped tree") now matches its check. (The literal path spellings that this row previously quoted as evidence were rewritten into this prose by owner decision, so the scanner does not flag its own audit record.) |

The 13 majors each show a gate that passes without exercising its failure path: closed
vocabularies (F6-13 provider names, F6-10 `VACANT` counted as an owner), mutable oracles
(F6-14 contracts baseline, F6-06 exit-criteria literal), non-blocking downgrades (F6-12 tamper
→ warning), vacuous assertions (F6-11 `shareBefore` computed then discarded), and
own-code-own-fixture coupling (F6-15/F6-16). F6-07 shows CI does not call the guarded test
entry point and never diffs regenerated artifacts. Full rows:
`%TEMP%\opencode\eg-audit\F6-round4.json`.

**Register impact of the digests:** 50 reviewer rows land (17 F2 + 33 F6). Four are duplicates
of R4 findings already recorded (F2-03→F2-R4-02, F6-01→F6-R4-01, F6-05→F6-R4-02,
F6-08→F6-R4-03); F6-11 is not a duplicate but tightens A1's negative-fixture requirement. The
5 F6 rows graded `none` are verdicts that held, not findings. Net new: **41 findings — 3
blockers, 15 majors, 23 minors**. Counted from the two digest files, not estimated: F2 17−1
duplicate = 16 (4 major, 12 minor); F6 33−3 duplicates−5 verdicts = 25 (3 blocker, 11 major,
11 minor). An earlier draft of this paragraph said 17 majors / 21 minors; that split did not
reconcile with the digests and is corrected here.

**After the Batch A and evidence repairs in this tree** (derivation shown so it can be re-checked):
- Round-3 corpus: **54 open of 85** — 0 blockers, 21 majors, 33 minors.
  `reconciliation.closed_ids` holds 31.
- Round-4 first-hand corpus: **0 open of 6** — the two findings that were open (the secrets scan
  skipping the published artifacts and never reading git history, and the coverage gate hard-coding
  six gateway paths) are both closed; the other four were closed earlier. Closed in this tree:
  F6-R4-01, F2-R4-01 (focus ring), F2-R4-02 (`aria-describedby`), F6-R4-04 (machine-local settings
  in the manifest), and now F6-R4-02 (secrets-scan boundary: artifacts + whole git history) and
  F6-R4-03 (coverage driven by the delivery-path registry).
- Reviewer corpus: **36 open of 41** - 0 blockers, 13 majors, 23 minors. Closed: F6-02,
  F2-02, F2-03, and in this batch F6-03 (D-5 unverified-gate semantics) and F6-04 (detector
  widening plus the documentation scope). The reviewer rows F6-05 and F6-08 duplicated F6-R4-02
  and F6-R4-03; they were never counted as open and are resolved with their first-hand IDs.
- Combined: **90 open - 0 blockers, 34 majors, 56 minors** (54 + 0 + 36).

**AND NOW THE PRODUCT BLOCKERS ARE CLOSED TOO (owner decision D-1, 2026-11-13 — "build it
now").** F0-01 and F0-03 were the last two open blockers in the round-3 corpus: the server
exposed a health check and a settings API and nothing else, and the enrolment service had no
runtime caller. Both are now closed in code:
- **F0-01** — the server serves a learner runtime. `GET /learn` serves the learner screen;
  `POST /api/learn` runs the REAL OneKey gateway with the REAL accessibility guardian and counts
  the interception (an emission the guardian did not intercept exactly once is refused, not
  shipped). Proven by a test that drives the real route over a real socket.
- **F0-03** — the enrolment service has a runtime caller. `POST /api/enrol` registers a guardian,
  issues the single-use consent token and enrols the learner; the response never carries a
  credential secret, and the decision is written to the durable audit log (D-3).
- The accessibility gates were widened at the same time, so the NEW page is inside their scope
  rather than beside it.

**THEREFORE: no audit finding in this register remains open at BLOCKER severity.** What remains
open is 34 majors and 56 minors, plus the two claims no source review can settle (runtime
accessibility, and the runtime experience itself).

The machine record is `docs/gap-register.json` for the round-3 corpus and the six R4 IDs the
register names; the 41 reviewer rows live in the two digest files cited above, and their bodies
are summarised here rather than merged into the register. This document is therefore the
authoritative statement of the reviewer counts.

The blocker that blocks the *product* is still F0-01/F0-03. F6-03 used to block the *evidence
claim*; since D-5 it is closed - an unverified gate now fails the chain, so "18/18 PASS" again
means eighteen gates that actually ran and held. What the gates still do not prove is runtime
experience: the accessibility surface has no browser or screen-reader run.


### F7 — runtime reality (first-hand)
Confirmed: `eg serve` honours `process.env['PORT']` in hosted mode; the server is real and
answers `/api/health`. But the runtime surface has no learner path, no durable store, and no
authentication on the hosted settings GET (`authorizePeer` returns `allowed: true` for every
peer when `hosted` is true; `publicSettings` discloses key names and lengths).

---

## 4. Production readiness

**Production audit: 44/100 — blocked.** Two cap conditions apply: sensitive child-data
operations have no authorisation (consent/enrolment), and there is no rollback path because
there is no deployment. The **library slice in isolation scores 86/100** — contracts, crypto,
ledger invariants and gate suite are strong — but a library no learner can reach is not a
product. Anyone reading 86 must also read the slice boundary in `README.md`.

**After Batch A:** the authorisation cap is lifted for the consent/enrolment surfaces (A1–A7
verified, 495/495 tests). The product score stays blocked because the two product blockers are
untouched: no learner route (F0-01) and no production caller of `createEnrolmentService`
(F0-03), and there is still no deployment or rollback path.

---

## 5. Fix plan — ordered, each with a named executable check

Batch A — authority (closes the sharpest security findings, all code-only):
**Status: implemented in the working tree (A1–A7), 495/495 tests, 18/18 gates. Evidence per item:**
1. **A1 · F8-03** consent authorisation: make `grant`/`withdraw` take an actor principal and an
   authoriser; refuse when the actor may not act for that learner. Check: `consent.test.ts` —
   "a third party cannot grant or withdraw for another learner"; gate `consent-withdrawal`
   extended with a negative fixture.
2. **A2 · F8-01** guardian role: refuse a guardian token when the principal's role is not
   `guardian`. Check: `enrolment.test.ts` — "a learner principal cannot be issued a guardian token".
3. **A3 · F8-02** age assurance: enrolment refuses a caller-asserted band unless a verifier
   attests it. Check: `enrolment.test.ts` — "an unverified age band is refused".
4. **A4 · F8-06** destination allowlist: `assertSafeBaseUrl(baseUrl, { allowedHosts })`, default
   to the provider's own host; refuse link-local, metadata, and non-allowlisted hosts. Check:
   `qwen-adapter.test.ts` — "a non-allowlisted HTTPS host is refused at construction".
5. **A5 · F8-08** CSRF: require same-origin (`Origin`/`Sec-Fetch-Site`) on settings writes, and a
   per-process token in the page. Check: `serve.test.ts` — "a cross-origin POST is refused 403".
6. **A6 · F8-05** PII: normalise compound keys (`learner.name`, `learner-name`) and reject
   homoglyph/ZWSP variants. Check: `pii-guard.test.ts` — three new refusals.
7. **A7 · F8-10** locator: refuse drive-relative `C:foo`, scheme-only `data:`/`mailto:`/`blob:`.
   Check: `egress.test.ts` — four new refusals.

Batch B — gateway-level boundary and provider honesty:
8. **B1 · F8-07** move egress projection into the gateway (wrap every adapter at registration),
   so no adapter can receive raw context. Check: `gateway.test.ts` — "a custom adapter receives
   only the projected payload"; conformance suite runs the wrapper.
9. **B2 · F3-09** bind conformance to registration: `register()` refuses an adapter that has not
   passed, or runs the suite once at construction. Check: registry test — "an unconformant
   adapter cannot be registered".
10. **B3 · F3-13** 429 must not trip the health circuit: classify retryable rate limits
    separately from failures. Check: `gateway.test.ts` — "a 429 leaves the circuit closed".
11. **B4 · F3-14** 401/403 revokes the credential: adapter marks it dead, gateway skips the
    provider and surfaces a governance-typed failure. Check: `qwen-adapter.test.ts` — "a 401
    disposes the credential and never retries it".
12. **B5 · F3-20** deferral honesty: record `deferred` only when a Tier 4 handler exists and
    accepted the work; otherwise record `failed`. Check: `gateway.test.ts` — "no handler means
    no deferral claim".

Batch C — ledger integrity:
13. **C1 · F5-03** verify on read and write (cheap: verify the tail link on append, full verify on
    `all()`), with an opt-out for bulk reads. Check: `ledger-store.test.ts` — "a tampered entry
    makes read throw".
14. **C2 · F5-02** serialise appends and enforce unique `seq`. Check: "two concurrent appends
    produce two distinct seqs and one chain".
15. **C3 · F5-04** `all()` returns defensive copies. Check: "mutating a returned entry does not
    mutate the store".

Batch D — evidence chain:
16. **D1 · F6-R4-01** delete every field whose value depends on the commit that carries the
    artifact; bind the artifacts by their own digests.
    Check: `npm run verify` on a committed tree leaves `git status --porcelain` empty, and
    `verify:repro` re-runs the chain and compares digests.
    **Implemented:** `tools/attest.mjs` stores no VCS state — no `gitHead`, no `gitDirty`, no
    dirty flag, no HEAD-derived timestamp; HEAD, code-tree and artifact-tree state print to the
    console only. A *stored* dirty flag would still be self-referential: committing the file is
    what makes the tree clean, so the committed copy would always disagree with a regenerated
    one. `tools/sbom.mjs` applies the same `SOURCE_DATE_EPOCH`-or-omit rule.
    `tools/verify-repro.mjs` + `npm run verify:repro` compare two consecutive runs against each
    other (not against stale on-disk files).

Batch E — accessibility:
17. **E1 · F2-01** authored `:focus-visible` for links, buttons, inputs, checkboxes and the skip
    link, with a 3:1 non-text contrast check. Check: gate `keyboard-focus` parses the
    stylesheet and fails on a missing rule; negative fixture included.
    **CLOSED.** `packages/verification/src/gates/keyboard-focus-gate.ts` (id `keyboard-focus`,
    severity `blocker`) parses the token stylesheet with a recursive `parseRules` walk (so
    `@media` blocks are not silently dropped) and fails when: no standalone `:focus-visible`
    rule exists; its `outline` is `none`/`0`/`transparent` (last declaration wins, per the CSS
    cascade) or is a literal instead of a token; `outline-offset` is missing; no second ring
    (`box-shadow`) exists; no filled-control override sets `outline-color`; no
    `@media (forced-colors: active)` re-authoring; any `:focus` rule suppresses the outline; or
    a referenced `var(--token)` is never defined. Six negative fixtures in
    `negative-fixtures.test.ts` prove each refusal. Gate result on the shipped tree: **PASS**.
    Runtime claim (a person tabs and sees the ring) stays UNVERIFIED — no browser run.
18. **E2 · F2-02** `aria-describedby` on every control with a hint or error; error summary
    announced. Check: gate `form-semantics` asserts every input with a sibling `.hint` has a
    matching `aria-describedby`.
    **CLOSED.** `packages/verification/src/gates/form-semantics-gate.ts` (id `form-semantics`,
    severity `blocker`) reads `apps/cli/public/index.html` and fails when: an id is duplicated;
    an `aria-describedby`/`aria-labelledby` token resolves to no id; a visible input/select/
    textarea has no accessible name (`aria-label`, resolvable `aria-labelledby`, or `<label
    for>`); a control owning a `hint-<id>` node does not reference it; a hint node is
    referenced by nothing; or the page has no `role="status"`/`role="alert"` live region. Six
    negative fixtures in `negative-fixtures.test.ts` prove each refusal. Gate result on the
    shipped tree: **PASS** (15 controls, 15 `for=` bindings, 14 containers, 13 hint nodes with
    11 wired by their owning control and 0 orphans, 18 distinct idref targets). Runtime claim
    (a screen reader announces the hint) stays UNVERIFIED — no screen-reader run.

Owner decisions (cannot be closed by code) — **ALL FOUR TAKEN 2026-11-13:**
19. **D-1 Runtime: BUILD IT NOW.** The learner route and the enrolment path are wired into the
    running server, not held for Slice 1. Closes F0-01 + F0-03.
20. **D-2 Durability: `node:sqlite`.** A SQLite file behind the EXISTING repository seams — the
    frozen contracts are UNCHANGED, because the durable store implements `PrivateStore` rather
    than replacing it. Closes F8-04, F5-01, and enables the shared kill switch / circuit
    (F3-11, F8-11, F3-36).
21. **D-3 Durable audit log: YES.** An append-only, hash-chained audit log for consent and
    enrolment, persisted to SQLite (Child Safeguarding + Legal).
22. **D-4 Chief Systems Architect: THE FOUNDER & CEO TAKES THE SEAT.** The vacancy is filled by
    the owner; the role is no longer an open blocker.

**HOW D-3 IS WIRED, AND WHY IT MIRRORS THE IN-MEMORY TRAIL.** The identity package depends only
on the contracts, so the durable log is described by a LOCAL structural interface (`AuditSink`)
rather than a new package dependency. The sink receives the same events the service already
records — opaque ids, a kind, a flat detail bag — and never a credential secret: a test asserts
the secret never reaches it. Two properties were preserved deliberately:
- **A guardian grant refused for lack of authority leaves NO trace, durable or not.** The
  service authorises *before* it records, so a refusal cannot later be read as consent. A
  hash-chained log is easier to read as evidence than an in-memory array, so writing refusals
  into it would be MORE dangerous, not less.
- **The withdrawal CASCADE is durable too** — every dependent scope that got locked is part of
  the evidence, not just the scope the learner acted on.

### The deployment (2026-11-13, owner decision "push + deploy")

- **Repository:** `https://github.com/erpforgeafrica-dotcom/EDUGENESIS_OS` (public). The whole
  history was pushed; the secrets scanner had already proven 0 findings across the tree and
  351 historical blobs, so nothing secret left the machine.
- **Service:** `https://edugenesis-web-yju6.onrender.com` — Render Blueprint `exs-…` from the
  repository's own `render.yaml`, one free web service in Frankfurt, health check
  `/api/health`, `autoDeployTrigger: checksPass`.
- **Verified live, not assumed:** `GET /api/health` → 200 (`hosted: true`); `GET /learn` → 200
  with the live region and the labelled control; `POST /api/learn` → a real curriculum lesson
  (`tier 0`, `guarded: true`); and **`GET /api/audit` → 403** — *"The audit trail is private
  evidence and is never exposed on a hosted instance."* The private-evidence rule holds on a
  public instance, and that was checked from the outside, not from the code.
- **The workspace is the KORA team** (`tea-…`), because Render's MCP cannot create a workspace
  and the other two teams belong to other products. Moving the service to a dedicated
  EduGenesis workspace is a dashboard action for the owner.

---

## 6. What is NOT verified

- **F2, F4, F6, F7 are now covered first-hand only in part** — source-level review, no browser,
  no screen reader, no concurrency stress. Both delegated digests have landed (§3) and are
  folded in above; neither reviewer ran a browser or a screen reader either, so the runtime
  accessibility surface stays UNVERIFIED.
- No deployment. No Render workspace was named, so no state-changing command was run.
- No vendor SLA, price, quota or certification is asserted.
- The hosted settings GET is confirmed unauthenticated by code reading, not by an external probe.
- Git history **is** now scanned (F6-R4-02 closed): 351 historical blobs across this
  repository's 31 commits, 0 findings, so "no secret ever committed" is now proven by the
  scanner for the refs in this clone. The honest limit: the scan reaches objects reachable
  from the refs of this clone — a secret in an unreachable, rewritten or force-pushed object
  is outside it, and only a history rewrite (or a fresh clone with a clean filter) removes
  a secret that was once published.

### The runtime accessibility claim — NOW PARTLY VERIFIED (2026-11-13, owner decision "go ahead")

For four audit rounds this repository could say only: "every gate reads source; no browser
has ever been run." That is now partly false. A real Chrome (HeadlessChrome 157.0.0.0) was
driven over the DevTools Protocol against the running server, and the following was MEASURED,
not asserted:

| Claim | How it was measured | Result |
|---|---|---|
| The question field has an accessible name | `Accessibility.getFullAXTree` | textbox, accessible name **"Your question"** |
| The button has an accessible name | same | button, accessible name **"Ask"** |
| The answer is announced | accessibility tree | a node with role **status** exists |
| Keyboard order | real `Tab` key presses | skip link → question input → Ask button → links → (repeats) |
| The focus ring is VISIBLE | computed style of each focused element, from the live cascade | **every** focused element: `outline: 3px solid rgb(143,168,255)`, `outline-offset: 2px`, plus a second ring `box-shadow 0 0 0 5px` — a dual ring, as the design system specifies |
| A question really gets answered | typed and submitted through the real UI | the live region read **"Your lesson is ready."** and the card carried a real curriculum lesson (152 characters) |
| The screen is quiet | browser console | **0 errors** |
| It renders in the learner theme | screenshot | light theme, Aurora components (`.btn--primary`, `.card`, `.eg-status`) |

**WHAT IS STILL UNVERIFIED:** a SCREEN READER was not run. The accessibility tree is what a
screen reader consumes, and the live region's `role="status" aria-live="polite"` is the
mechanism — but no NVDA, JAWS, VoiceOver or Orca session has read this page, so the claim
"a screen reader announces the answer" remains **UNVERIFIED**. The `browse` extension path
(the owner's own Chrome, where a real screen reader could be attached) could not be used:
the relay on this machine fails to start ("browse relay did not start"), and no browser is
paired with it. The claim is therefore narrowed, not overstated.

**ALSO NOTE — the deployment is not CI-gated yet.** The Render service deploys on
`checksPass`, but the GitHub account is **billing-locked** ("The job was not started because
your account is locked due to a billing issue"), so no CI run can start and the guardrail
cannot fire. The first deploy was applied by hand on a locally verified tree (551/551 tests,
18/18 gates, repro 4/4 `same`). The blueprint was NOT weakened to `commit` — the guardrail is
still declared; it is the account that cannot run it. Fix the billing issue and the
guardrail works again.

---

## 7. Batch A closure - executed 2026-11-13 (code-only security batch)

Every item below was implemented, then proved by build + tests + the gate chain.
The last authoritative run (after the Batch F detector widening, the D-5 unverified-gate
semantics and the F6-R4-02/F6-R4-03 boundary repairs): `npm run verify` -> build 0,
**510/510 tests**, 30 suites, `18/18 gates PASS`, `0 blockers failed`, `0 unverified`,
secrets scan `0 findings` (canary live in a file **and** in a blob; **185 tree files +
351 history blobs**), SBOM 10 components, manifest **183 files**, attestation **PASS**.

**Evidence chain, exactly as executed** (`npm run verify`, exit 0, 2026-11-13):
`path-portability` scanned **161 shipped file(s)** — source, config and the documentation
that ships with the product;
`guardian-coverage` reported **6/6 learner-facing deliveries guarded exactly once = 100%**
driven by the delivery-path registry;
`secrets:scan` read **185 tree files and 351 history blobs**, skipped 0, and its canary fired
on both surfaces; the manifest hashed **183
files**; the attestation reports 18 gates, 18 passed, 183 files verified, and prints
`git HEAD <current commit> (informational; the attestation names no commit)` plus
`artifact tree: 4 regenerated path(s) (reported, never attested)`. `artifacts/attestation.json`
contains **no `gitHead`, no `source` block (no dirty flag, no changed paths) and no `timestamp`
key** — no `SOURCE_DATE_EPOCH` was declared. Its bytes are a function of tree content alone.

The sha256 values are deliberately **not transcribed here**. This document is inside the tree
that `tools/checksums.mjs` hashes and `tools/attest.mjs` attests, so quoting a digest of the
manifest inside the manifest would change the value being quoted — the same self-reference
removed from the attestation. The digests live in `artifacts/checksums.sha256` and
`artifacts/attestation.json`, and `npm run verify` prints them on every run. Note also that the
citation of `677f415` in this report is the commit the work started from; the tree that
produced these artifacts is the working tree described above.

| # | Finding | Change | Negative test that fails without it |
|---|---|---|---|
| A1 | F8-03 consent had no authorisation | `ConsentAuthorizer` + `ConsentServiceOptions.authorize/identity/actorId`; guardian grant and withdrawal are **refused by default**; `ConsentRefusedError`; audit events carry `recordedAt` (service clock, not caller clock) | `consent.test.ts` "authority" block, 6 tests: no policy -> refuse, policy says no -> refuse, non-guardian principal -> refuse, withdrawal without actorId -> refuse, backdated `at` cannot move `recordedAt` |
| A2 | F8-01 a learner could be issued a guardian token | `issueGuardianConsentToken` requires a registered principal with role `guardian` and a named learner | "a learner principal cannot be issued a guardian consent token" (audit event `refused`) |
| A3 | F8-02 age band was caller-asserted and then trusted by ABAC | `AgeAssurance` seam; only an attested band is written to the principal; a caller band is recorded as `ageBandUnverified`; a band that contradicts the attested one is refused | 3 tests: unverified band never becomes a band, attested band is written, contradiction refused |
| A4 | F8-06 base URL was scheme-checked only | `BaseUrlPolicy` + `DEFAULT_ALLOWED_HOSTS` (two DashScope hosts) + hard `METADATA_HOSTS` block + credential-in-URL refusal; `allowedHosts` option for a named proxy | 6 tests: foreign host refused, plaintext refused (loopback allowed), metadata host refused **even when allowlisted**, credentials refused, named proxy admitted, trailing separators normalised |
| A5 | F7-05 settings writes were CSRF-able | `authorizeSettingsWrite` on POST/PUT `/api/*`: loopback peer AND `application/json` AND (when present) a loopback `Origin`, with `Sec-Fetch-Site: cross-site` refused outright | 10 tests in `serve.test.ts`: `text/plain` refused (the no-preflight attack shape), form-encoded refused, foreign `Origin` refused, `cross-site` refused, loopback origins admitted, non-URL `Origin` refused |
| A6 | F4-01 forbidden field names could be spelled in another alphabet | `normalizeFieldName` now NFKC-folds, lower-cases, folds ~45 Cyrillic/Greek/Latin confusables to ASCII, then strips | 4 tests: full-width `learner_id` caught, Cyrillic `learner_id` caught, Greek `address` caught, ASCII normalisation unchanged and a benign name still permitted |
| A7 | F6-11 locator check missed real path spellings | `isUnsafeLocatorShape` covers drive-relative, POSIX-absolute, UNC, home-relative, `.`/`..`, `scheme:`, `scheme:/`, `://`; the check runs on the trimmed value and on every percent-decoded form (2 passes), and a malformed escape is refused | 3 tests: 8 previously-passing spellings refused (drive-relative, both traversal forms, `~`, leading whitespace, `data:`, encoded traversal, `scheme:/`), malformed escape refused, 4 legitimate content ids still travel |

Residual, stated rather than hidden:

- **A1 residual:** `createEnrolmentService` receives an already-constructed `ConsentService`,
  so it cannot inject an authorizer into it. A deployment that builds the consent service
  without `authorize` will now get a refusal at enrolment - the correct failure, but the
  wiring responsibility sits with the composition root. `packages/contracts/src` is frozen,
  so this is an option-injection seam, not a signature change.
- **A5 residual:** the CSRF gate is unit-tested as a pure function. No socket-level test
  exists, because a same-machine connection always arrives from loopback and would prove
  nothing about origin handling.

## 8. F6 register - independently verified, not accepted on report

| ID | Reviewer claim | My verdict | Evidence |
|---|---|---|---|
| F6-01 | attestation names `f1f3b5e` while HEAD is `677f415` | **REFUTED as stated; residue confirmed, now FIXED** | The attestation did not name `f1f3b5e`: `source.gitHead` equalled `git rev-parse HEAD`. The residue was `gitDirty: true` plus a HEAD-derived timestamp — a document inside the tree cannot name the commit that contains it, so the attested state was never a shipped commit. Both fields are now removed; the document names no commit and carries a timestamp only from `SOURCE_DATE_EPOCH`. |
| F6-02 | manifest omits `assets/`, hashes 7 gitignored `*.tsbuildinfo` | **CONFIRMED, then FIXED** | Before: 0 `assets/` lines, 7 `tsbuildinfo` lines. After: `assets/edugenesis-tokens.css` present, 0 `tsbuildinfo`. A second defect of the same class was found while fixing it: gitignored `settings/settings.local.json` (learner overrides, may hold API keys) was in the manifest; now excluded. Manifest 179 files. |
| F6-03 | `gates.ts` passes on blocker failures only, so warning failures never block | **CONFIRMED, CLOSED via D-5** | Owner decision D-5 executed: a warning-severity result derives `unverified` and is never a pass; `summarise()` fails the run on any unverified gate; the report carries `schemaVersion 2`, `result: PASS \| FAIL \| INCOMPLETE` and a counted `unverified` field; `verify-all.mjs` exits non-zero on unverified; `attest.mjs` refuses a report naming an unverified gate. Locked by the inverted warning test, the F6-03 regression and the `gateStatus` unit test in `gates.test.ts`. |
| F6-04 | path-portability gate scans 0 config files | **CONFIRMED, PARTIALLY FIXED** | Root cause: `collectSourceFiles` walks directories; `listConfigFiles` returns file paths; `walk` swallowed `ENOTDIR`. Live proof before the fix: gate evidence "122 source file(s) and **0** config file(s)". After `readSourceFiles`: "141 shipped file(s)" = **124 source + 17 config**. Locked by 4 tests in `packages/verification/src/paths.test.ts`; `render.yaml` was named by no scanner and is now in the scanned config set. **Closed in Batch F (2026-11-13):** the detectors match both separator styles, `.md`/`.csv` joined the scanned extensions, and shipped documentation joined the scanned scope; locked by eight new fixtures in `scan.test.ts`. (The forward-slash path spellings this row previously quoted were rewritten into prose by owner decision.) |

## 9. F2 register - status after this session

Folded from the accessibility reviewer (17 findings: 0 blocker / 5 major / 12 minor).
Implemented in the working tree this session: `aria-describedby` wired from every hinted
control to a stable hint id (`apps/cli/public/index.html`), and the quiet-button hover pair
retuned in `assets/edugenesis-tokens.css` (the 1.26:1 light-theme state).
Still open: no shipped path emits an `AccessibilityEmission` (F2-01, blocker-grade for the
"accessibility guardian" claim) and `accessible_alternative.text` remains optional in the
frozen contract (F2-05). The two source fixes above are now **enforced**: the `keyboard-focus`
gate proves the tokenised dual-ring focus system survives forced colors and is never suppressed,
and the `form-semantics` gate proves every control is named and every hint is announced by the
control it describes — both blocker-severity, each locked by six negative fixtures. No browser
or screen-reader run was performed: the runtime accessibility surface remains **UNVERIFIED**.

## 10. Batch F + D-5 closure - executed 2026-11-13

Both items were chosen by the owner and executed in one batch:

- **F6-04 (Batch F):** `scan.ts` detectors widened to both separator styles for the
  drive-letter, UNC-share, user-profile and POSIX-home classes (new rules `abs-unc-posix`
  and `abs-home-profile`). The UNC host token must be at least two alphanumeric characters,
  so an escaped-newline string and the Windows device namespace are not false positives; a
  forward-slash share host must be dot-free, so protocol-relative URLs are not. `.md` and
  `.csv` joined the scanned extensions, and the documentation that ships with the product
  joined the scanned scope through the new `listDocumentationFiles` (root docs + `docs/`).
  Eight new fixtures in `scan.test.ts` cover every widened spelling, the URL-vs-share
  boundary and the escape/device negatives.
- **Doc evidence scrub (owner choice "widen + scrub"):** the 25 literal path spellings the
  widened detectors would have flagged in `docs/AUDIT_ROUND4.md`, `docs/gap-register.json`,
  `SESSION_PROCESS_LOG.md` and `settings/settings.schema.json` were rewritten into
  equivalent prose, so the findings stay provable while the tree no longer quotes machine
  paths. The detectors themselves also turned out to be their own first catch — three
  doc-comment spellings inside `scan.ts`/`scan.test.ts` were rewritten the same way.
- **F6-03 (D-5):** owner decision "third state `unverified` fails the strict chain".
  `gateStatus()` in `types.ts` derives `pass | fail | unverified`; `summarise()` fails the
  run when any gate is unverified; `tools/verify-all.mjs` writes `schemaVersion 2` with
  `result: PASS | FAIL | INCOMPLETE` and a counted `unverified` field, prints it, and exits
  non-zero on it; `tools/attest.mjs` refuses a chain with unverified gates. The exit-criteria
  gate's three owner-blocked rows are unaffected: they are blocker-severity rows that ran and
  passed, not unverified gates.

Verified state after this batch (`npm run verify`, exit 0): **505/505 tests**, 29 suites,
18/18 gates PASS, 0 unverified, path gate **159 shipped file(s)** with no absolute path,
secrets scan 0 findings, attestation PASS. `git status` clean after the source/doc commit
and the regenerated evidence commit.
