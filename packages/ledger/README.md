# @edugenesis/ledger

Owned by swarm unit **S3**. Implements the interfaces declared in `packages/contracts`
(`LedgerStore`, `PrivateStore`, `ReinvestmentEngine`, `LedgerEntry`, `PublicProof`,
`ChainVerification`, `FORBIDDEN_LEDGER_FIELDS`, `LedgerTamperError`). The contracts file is
frozen and is NOT modified by this package.

- Source: `src/`
- Tests: `src/**/*.test.ts` (compiled to `dist/**/*.test.js`)
- Zero runtime dependencies: `node:crypto` and `node:sqlite` only, nothing else.
- This package MUST NOT import a provider SDK (provider access lives behind `packages/onekey`).
- This package MUST NOT contain a raw hex colour or a hardcoded absolute path.

## Authority

| Document | Clause | What it fixes here |
|---|---|---|
| Doc 1 v1.2 | §6 | The 60 % reinvestment rule; the ledger as the sponsor's proof |
| Doc 2 | §2.5 | No personal data in a ledger payload, ever |
| Doc 2 | §15 | Append-only, hash-chained, tamper-evident ledger; private store; corrections as compensating entries |
| Doc 2 | §27 | Data classification — the public ledger is `public`, the private store holds `learner_scoped`/`sensitive` |
| Doc 6 | §7 | Defence in depth (here: two independent PII lines) |
| Doc 7 | — | Independent audit: exclusions carry reasons; proofs are reproducible |
| Doc 16 | §3.5 | Anchor Sponsor framework; sponsor receives an aggregate, de-identified report |

## Modules

| File | Responsibility |
|---|---|
| `hash.ts` | SHA-256 helpers and the canonical JSON serialiser (recursive key sort; array order preserved) |
| `pii-guard.ts` | The two lines of defence: forbidden field names (normalised, recursive) and value-shape detection |
| `ledger-store.ts` | The public append-only hash chain, Merkle root, tamper detection, corrections |
| `private-store.ts` | The private operational store and `redactForSponsor()` (small-cohort suppression) |
| `money.ts` | Integer minor-unit primitives (`readAmountCents`, `roundDiv`, `sumCents`) |
| `reinvestment.ts` | The 60 % engine: eligible base, required reinvestment, allocation by category, exclusions |
| `sponsor-report.ts` | The aggregate, privacy-reviewed artefact the Anchor Sponsor receives |

## The hash chain

```
entryHash(n) = SHA-256( canonicalJson({ seq, type, at, payload, previousEntryHash }) )
```

`canonicalJson` sorts object keys recursively (code-unit order, so it is locale-independent)
and preserves array order, because array order carries meaning in a ledger. `previousEntryHash`
is the literal string `"genesis"` for `seq = 1` and the previous entry's `entryHash` thereafter.
`seq` is assigned by the store, never by the caller, so an entry can never overwrite an earlier
one. `verify()` recomputes every hash and every link and reports the first broken `seq`.
`merkleRoot()` hashes the entry hashes as Merkle leaves (binary tree, odd node duplicated),
which is a single value a sponsor can pin on a public board.

### Correction discipline

There is no update and no delete, and none may be added. A mistake is corrected by appending a
**compensating** entry (`appendCorrection()`) that records `corrects_seq`,
`corrects_entry_hash` and a reason. The original entry stays visible forever and the whole
chain stays verifiable.

### Tamper evidence, not tamper resistance

`all()` returns the live entry array so an auditor can attempt an edit; `verify()` then reports
the break at the right `seq`. `exportPublic()` is the copy-returning accessor: mutating its
result cannot change the store.

## PII rules (exact)

**Line 1 — field names.** The contract's `FORBIDDEN_LEDGER_FIELDS` (21 names) plus
`EXTENDED_FORBIDDEN_LEDGER_FIELDS` (identity, contact, civic, location, health, free-text
variants). Matching is **exact after normalisation**: lower-case and strip every
non-alphanumeric character, so `learner_id`, `learnerId`, `LEARNER_ID` and `learner.id` all
collapse to `learnerid` and are refused. The walk is **recursive** through nested objects and
arrays. `sponsor_name` stays legal (it is an organisation, not a learner); `name` does not.

**Line 2 — value shapes** (applies to string values only):

| Rule | Detection | Exemptions |
|---|---|---|
| V1 email-address | an email-shaped substring | none |
| V2 long-digit-string | a run of 8+ consecutive digits | compact dates (`YYYYMMDD`); hex digests of 32+ characters (a hash is not a person) |
| V3 phone-shape | a candidate of 9+ digits joined by `space - . ( )` that starts with `+` or `0` | date-like prefixes (`2026-11-12`, `12-11-2026`) |

**Documented limits.** Numbers are never scanned by V2/V3 — money is integer minor units, so a
large amount legitimately looks like a long digit string; the field-name rule governs money
keys. An 8-digit national id under an innocuous key is indistinguishable from an ordinary
identifier and is caught only by the field-name rule.

## Money

Every monetary value is an **integer number of minor units (cents)**. No float ever holds
money. `requiredReinvestment = floor(base * bps / 10000)` is computed in `BigInt`.
`roundDiv()` performs the only unavoidable division (cost per task) in integer arithmetic with
round-half-up. A payload key that looks like money (`*_cents`, `*_minor_units`) is refused if
its value is not an integer.

## The 60 % rule — worked example

Fixture (period `2026-01-01` .. `2026-03-31`):

| seq | type | amount | in period | role |
|---|---|---|---|---|
| 1 | `sponsor_pledge` | 1,000,000 cents | yes | funding |
| 2 | `sponsor_deposit` | 500,000 cents | yes | funding |
| 3 | `grant_awarded` | 250,000 cents | yes | funding |
| 4 | `credit_consumed` | 100 units | yes | excluded — not a funding type |
| 5 | `sponsor_pledge` | 100,000 cents | no (before) | excluded — outside period |
| 6 | `reinvestment_allocation` (devices) | 900,000 cents | yes | allocation |
| 7 | `reinvestment_allocation` (content) | 300,000 cents | yes | allocation |
| 8 | `reinvestment_allocation` (content) | 150,000 cents | no (after) | excluded — outside period |

```
eligible base   = 1,000,000 + 500,000 + 250,000        = 1,750,000 cents ($17,500)
required (60%)  = 1,750,000 * 6000 / 10000             = 1,050,000 cents ($10,500)
allocated       = 900,000 (devices) + 300,000 (content) = 1,200,000 cents
compliant       = 1,200,000 >= 1,050,000                = true
```

The same entries and the same period always produce the same result (entries are processed in
`seq` order, categories are emitted in sorted order, no clock and no randomness). Every entry
that did not enlarge the eligible base appears in `excluded` with a reason.

## The sponsor report

`buildSponsorReport(ledger, privateStore, options)` returns: ledger state (entries, chain
verdict, Merkle root), funding (base, required, allocated, compliant, by category), usage
(tasks, requested, cost in cents, cost per task), availability (basis points + rate), fallback
(rate + tier histogram), latency (samples, mean, p50, p95, max), credit balances, and the
de-identified cohort/region/learning-area aggregates.

The private store reaches the report **only** through `redactForSponsor()`, which reads four
whitelisted keys (`cohort`, `region`, `learningArea`, `learnerRef`) and never copies free
text. A cohort below the minimum size is suppressed **entirely** — it is removed from every
aggregate, not merely labelled, because a labelled cell can be recovered by subtraction. The
finished report is then scanned with the same PII guard and publishes the verdict inside
`privacy.piiScan`.

## Running the tests

```
npx tsc -b packages/ledger
node --test "packages/ledger/dist/**/*.test.js"
```

> **Runner caveat (verified on Node v24.19.0):** `node --test packages/ledger/dist/`
> (a *directory* argument) does **not** execute the test files in Node 24 — it reports
> `tests 1 / pass 1 / exit 0` even when a deliberately failing test file is present in the
> directory. That is a false green. Use the glob form above (which is also what the repository
> `npm test` script uses), or `npm run test:only -- packages/ledger/dist`.
