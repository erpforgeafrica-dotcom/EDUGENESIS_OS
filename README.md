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
npm run verify      # typecheck + tests + secrets scan + SBOM
npm run serve       # start the local server and the Settings UI
```

Requires **Node.js 22.5 or newer**. Nothing else — no Docker, no database server, no Python.
If the machine has no suitable Node, `tools/bootstrap.ps1` downloads a portable runtime **into this
folder** and uses it. It never installs anything globally.

---

## Layout

```
packages/
  contracts/     Frozen shared interfaces. The swarm contract. EDITED BY NOBODY.
  accessibility/ Nine-element emission contract + ARC-I1..I12 + the Guardian
  onekey/        Routing policy, budget, circuit breaker, kill switch, 5 fallback tiers
  ledger/        Public hash chain, private store, 60% reinvestment, sponsor report
  identity/      Identity, RBAC+ABAC policy, consent, age assurance, session risk
  verification/  The gates that decide whether the build is real
apps/
  cli/           `eg doctor | settings | serve | selftest`
tools/           Bootstrap, SBOM, secrets scan, contrast gate, portability gate
settings/        Versioned, schema-validated settings — never a secret
docs/adr/        ADR-0001..0016
```

---

## The portability law

This product must run identically on any Windows PC that copies this folder — a different user name, a
different drive letter, a different Node install. Therefore:

- No hardcoded absolute paths, user names or drive letters anywhere in source. `tools/verify-portability.mjs`
  **fails the build** if one appears.
- The settings file lives **inside the project folder** and is edited by a Settings UI served by `eg serve`.
  A non-technical user can change the port, data folder, feature toggles and API keys there.
- `tools/verify-portability.mjs` copies the folder to a different path, points `USERPROFILE`/`HOME` at a
  non-existent directory, and runs first-run, settings-change and normal use with zero source edits.

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
   claim, and it prints its own evidence.

---

## Related controlled documents

`../EDUGENESIS_OS_PROPOSAL/` holds the proposal package: the Alibaba / Qwen Anchor Sponsor proposal, the
brand identity, the Aurora design system, the disability inclusion plan, the UX plan and the technical
architecture with the ADR set this repository implements.

`SESSION_PROCESS_LOG.md` records the scope decision, the swarm decomposition, the attempt log and the
evidence ledger for this build.
