# EduGenesis OS — Genesis Slice 0

**Zero-cost, AI-first global education, generosity and opportunity infrastructure.**

This repository is the executable form of the EduGenesis OS controlled document set. Slice 0 builds
**Phase 0 (governance)**, **Phase 1 (platform foundation)** and **Phase 5 (OneKey routing, provider
adapter and fallback tiers)** — the three phases whose exit criteria are machine-verifiable.

Governing baseline: **Document 1 v1.2 — Master Requirements and Governance Charter** (single source of truth).
Nothing in this repository may contradict it.

---

## The three promises this slice makes executable

| Promise | Where it lives | How it is proven |
|---|---|---|
| **Accessibility is a runtime contract, not a post-processing layer.** | `packages/accessibility` | The ARC-I1…I12 invariant engine blocks an emission that lacks a verified accessible equivalent. The guardian refuses to deliver it. |
| **A sponsor can never be locked in, and a learner can never be cut off.** | `packages/onekey` | The five-tier fallback ladder (Tier 0 cached curriculum → Tier 4 human/deferred). A provider outage, a quota exhaustion or a credit exhaustion still returns a lesson. |
| **Donated resources are provable without exposing a child.** | `packages/ledger` | An append-only hash-chained public ledger holding only hashes, counters and proofs — with a private store that has no path to it, and a PII guard that refuses a payload before it is written. |

---

## Quick start

```bash
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File tools\bootstrap.ps1

# POSIX
sh tools/bootstrap.sh

# Then
npm run doctor      # environment + settings + secrets check
npm run verify      # build + typecheck + tests + every gate + secrets + SBOM + attestation
npm run serve       # start the local server and the Settings UI
```

Requires **Node.js 22.5 or newer**. Nothing else — no Docker, no database server, no Python.
If the machine has no suitable Node, `tools/bootstrap.ps1` downloads a portable runtime **into this
folder** and uses it. It never installs anything globally.

---

## Layout

```
packages/
  contracts/     Frozen shared interfaces. The swarm contract. src/ is EDITED BY NOBODY.
  accessibility/ Nine-element emission contract + ARC-I1..I12 + the Guardian
  onekey/        Routing policy, budget, circuit breaker, kill switch, 5 fallback tiers, egress guard
  ledger/        Public hash chain, private store, 60% reinvestment, sponsor report
  identity/      Identity, RBAC+ABAC policy, consent, age assurance, session risk
  verification/  The gates that decide whether the build is real
apps/
  cli/           `eg doctor | settings | serve | selftest`, plus the Settings UI and PWA shell
tools/           Bootstrap, SBOM, secrets scan, contrast, portability, guardian coverage,
                 provider re-point, checksums, attestation
settings/        Versioned, schema-validated settings — never a secret
docs/adr/        ADR-0001..0016 (0001–0012 from the proposal, 0013–0016 build-local)
docs/            Exit-criteria register, contract amendments, officer roster
artifacts/       Generated evidence: sbom.cdx.json, verify-report.json,
                 checksums.sha256, attestation.json
render.yaml      The Render Blueprint (ADR-0009)
```

---

## The portability law

This product must run identically on any Windows PC that copies this folder — a different user name, a
different drive letter, a different Node install. Therefore:

- No hardcoded absolute paths, user names or drive letters anywhere in source. The **`path-portability`
  gate** fails the build if one appears.
- The settings file lives **inside the project folder** and is edited by a Settings UI served by `eg serve`.
  A non-technical user can change the port, data folder, feature toggles and API keys there.
- `tools/verify-portability.mjs` is the *runtime* proof, not the static scan: it copies the folder to a
  different path, points `USERPROFILE`/`HOME` at a non-existent directory, and runs first-run,
  settings-change and normal use with zero source edits.

## The rules this code obeys

1. **Zero cost to learners.** No payment object exists in a learner request path. The learner-facing
   surface contains no paywall, no subscription check and no premium tier.
2. **The sponsor firewall.** Sponsors fund and receive aggregate accountability. They do not control
   curriculum, moderation, certification, accessibility, safeguarding or equity allocation.
3. **No learner data in the public record.** The ledger holds hashes, counters and proofs only.
4. **No secrets in the tree.** API keys live in a gitignored settings file, are write-only over HTTP and
   are never logged.
5. **Accessibility is tested, not asserted.** Acceptance criteria are executed against representative
   users before release; a feature without an accessible equivalent is withheld, not degraded.
6. **Evidence over assertion.** A green status is not a deployed artifact. `npm run verify` is the only
   claim, and it prints its own evidence: the gate table, the test count, the secret-scan result, the
   SBOM digest and an attestation file. `node tools/verify-all.mjs` can be run alone to see the gate
   table without the rest.

### The evidence chain

`npm run verify` produces four files under `artifacts/`, and each one binds the previous:

| File | What it is | What makes it trustworthy |
|---|---|---|
| `verify-report.json` | Every gate, its severity, its verdict and its evidence line | Written by the gate runner itself, not by a person summarising it |
| `sbom.cdx.json` | CycloneDX 1.5 bill of materials | The serial is derived from the dependency graph, and the timestamp from `SOURCE_DATE_EPOCH` → the git commit date → now, so two runs of one commit produce identical bytes |
| `checksums.sha256` | A sorted `sha256  path` line per shipped file | Covers the source tree, the documents and the two files above, with a fixed include list that does not depend on git |
| `attestation.json` | The digests of the three files above, plus the gate counts | **Refuses to exist** unless the report is green *and* every listed file still matches its recorded digest. A red or tampered tree is refused with exit 1, and any stale attestation from an earlier run is deleted |

### The dependency advisory check

`npm audit` **inside this repository** is the dependency evidence of record. Run it from the project
root:

```
npm audit --omit=dev     # runtime advisories
npm audit                # including the dev toolchain
```

The runtime dependency set is empty (`dependencies: {}`); the only dev dependencies are `typescript`
and `@types/node`. Any third-party advisory tool must be pointed at this directory explicitly — a tool
that resolves a different working directory will report a different project's dependencies, which is
not evidence about this one.

Every scanner that polices the tree also proves it can fail:

- the secrets scan **plants a canary token** in a throwaway directory and refuses to pass unless it
  detects it, so "0 findings" is a measurement and not an inert scanner;
- the design-token gate, the provider-leak gate and the contracts-baseline gate each have negative
  fixtures that build the smallest tree that must fail;
- the frozen-contract gate also treats an **untracked** file under `packages/contracts/` as a change,
  because `git diff` alone cannot see one.

---

## Deployment

The platform is **Render**, described in git by `render.yaml` (ADR-0009, proposal §9.4). The Blueprint
declares **one** free web service, `edugenesis-web`, which runs `node apps/cli/dist/serve.js --hosted`.
Hosted mode widens *who* may connect — the platform proxy is never a loopback peer — and makes every
`/api/` write a `403`, so the public instance is a read-only demonstration.

The free tier's limits are load-bearing and are not worked around. **These are TARGET
LIMITS quoted from Render's own published free-tier documentation, not limits this
build has measured** — no instance has been created, so nothing here is an
achieved result:

- a Free web service spins down after 15 minutes idle;
- its filesystem is ephemeral, so a local SQLite file is not a system of record;
- Free Postgres expires 30 days after creation and has no backups.

Durable learner state therefore lives on the learner's device (Tier 0 offline bundle). A free instance
is a demonstration and governance surface, never a production host. **No deployment has been performed
from this repository**, and no Render workspace has been named for it.

---

## Related controlled documents

`../EDUGENESIS_OS_PROPOSAL/` holds the proposal package: the Alibaba / Qwen Anchor Sponsor proposal, the
brand identity, the Aurora design system, the disability inclusion plan, the UX plan and the technical
architecture with the ADR set this repository implements.

`SESSION_PROCESS_LOG.md` records the scope decision, the swarm decomposition, the attempt log and the
evidence ledger for this build.
