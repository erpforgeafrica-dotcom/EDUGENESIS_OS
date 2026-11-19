# EduGenesis OS — owner packets (PG-20)

One step each. Do the step, paste back the exact confirmation, and I will close
the matching item in `docs/production-ledger.json` with fresh evidence.
Nothing here requires the owner to write code. Secrets are never pasted into chat.

| # | Item | Exact owner action | Paste back | I will then |
|---|---|---|---|---|
| 1 | P0-3 / PG-15 real CI | Enable GitHub Actions billing on `erpforgeafrica-dotcom`, then push `main` (or re-run the existing `.github/workflows/ci.yml`). | The run URL `https://github.com/erpforgeafrica-dotcom/EDUGENESIS_OS/actions/runs/<id>` and its green conclusion. | Mark P0-3 VERIFIED, keep `ci:local` as the zero-cost fallback, re-run the release gate. |
| 2 | P0-1 signed approval record | Record the Founder & CEO's written approval of this release (the name is enough; no signature image needed in chat). | The approval reference or date. | Attach the reference to `docs/exit-criteria.json` P0-1 and re-score. |
| 3 | P0-6 nine officer roles | Name the vacant officers listed in `docs/OFFICERS.md` (Security Officer, Finance Lead, Governance Lead, Child Safeguarding Officer, Programme Lead, OpenCode Lead, Hiring Platform Lead, Communications Lead, Founder & CEO is already recorded). | The names, one per role. | Record them in `docs/OFFICERS.md` and close P0-6. |
| 4 | PG-13 signing-key ceremony | On an OFFLINE machine, run `node tools/sign-tier-zero.mjs <bundle.json> <out.sig>` with `EDUGENESIS_BUNDLE_SIGNING_KEY` set to the path of an Ed25519 private key you generated and custodied in KMS/HSM. Follow `docs/TIER-ZERO-SIGNING-CEREMONY.md`. | "Ceremony complete, public key installed at <config location>" — NOT the private key. | Flip the verifier to the production public key and mark the signed bundle VERIFIED. |
| 5 | PG-08 Tier 1 provider key | Create a provider account, then set its key as a server-side Render environment variable named for the provider (never in the repo, never in chat). | "Provider credential provisioned on Render" plus which provider. | Wire Tier 1 behind per-learner/global caps, redaction, breaker, kill switch and the honest Tier 0 fallback; ADR it. |
| 6 | PG-07/operator hosted auth | Set Render env `EDUGENESIS_SESSION_SECRET` (random, server-side only) and bootstrap one operator account via the documented local command. | "Session secret and operator account provisioned." | Exercise the end-to-end value chain on the deployed instance: sponsor funds → ledger → report → learner lesson, and record the live scenario. |
| 7 | PG-12 legal sign-off | Send `docs/PRIVACY-DPIA-DATA-FLOW.md`, `docs/RUNBOOK-INCIDENT.md` and the retention schedule to legal counsel. | "Legal review completed on <date>" and any required changes. | Apply only the requested changes and mark sign-off OWNER-BLOCKED→VERIFIED with the date. |
| 8 | PG-14 screen reader | Run the guided 15-minute NVDA/Narrator script in `docs/DASHBOARD-SPEC.md`/accessibility evidence (install NVDA free, or use Windows Narrator) on `/learn` and each dashboard. | The speech-output capture or a short note of what was announced. | Mark screen-reader behaviour VERIFIED, or keep it explicitly UNVERIFIED if you decline. |
| 9 | PG-10 durable disk | If true durability is wanted, select a paid Render persistent disk and attach it to `srv-dbsu4q0ae00c7393kod0`. | "Persistent disk attached" and the mount path. | Enable the commented, tested `render.yaml` switch and run the backup/restore drill against it. |
| 10 | PG-15 free-CI mirror (optional) | If you want a real hosted run without GitHub Actions billing, authorise a free CI host (e.g. a CircleCI/woodpecker account) and paste the repo hook URL. | The webhook URL or repo hook confirmation. | Add the mirror config as an option; it never becomes a requirement. |

## Standing note

No item above authorises spending money, touching billing, or pasting a secret.
The release is "pilot-launch ready pending owner actions" until items 1, 2, 3,
5, 6, 7 and 8 are closed. Items 4 and 9 are hardening upgrades with an honest
free-tier fallback already shipped.
