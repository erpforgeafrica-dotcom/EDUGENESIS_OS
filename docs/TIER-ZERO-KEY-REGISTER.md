# Tier 0 key register

One row per trust root ever installed in this repository. The public key lives
in `config/tier-zero-public-key.json`; the private key has never been, and must
never be, inside the tree.

| Key ID | Algorithm | Class | Custody | Installed | Status |
|---|---|---|---|---|---|
| `ph-ed25519-bf69f6994c4f90f7` | Ed25519 | **PLACEHOLDER** | operator machine, outside the repo (`~/.edugenesis-keys/`), file mode 0600 | 2026-11-19 | ACTIVE — pilot only |

## What the placeholder key proves

`packages/onekey/src/registry/tier-zero-trust.test.ts` proves, on every test run:

1. the shipped bundle `config/tier-zero-bundle.json` verifies against the
   installed public key;
2. one changed byte in a lesson body is refused;
3. a reordered lesson list is refused;
4. an empty or malformed signature is refused without throwing;
5. a different key cannot verify the shipped bundle;
6. the trust root is labelled `PLACEHOLDER` and carries the owner directive.

The bundle is the shipped starter pack (`packages/curriculum/packs/starter-core-v1.json`)
converted to Tier 0 bundle shape and marked `DRAFT-PLACEHOLDER-CEREMONY` — it is
not a reviewed curriculum.

## What it does NOT prove

- **No KMS/HSM custody.** The private key sits on an operator machine. Anyone
  with that machine and that file can sign a Tier 0 bundle. The production
  ceremony requires a key generated inside, and never exported from, KMS/HSM.
- **No separation of duties.** One agent performed generation, signing and
  verification. The production ceremony requires a second custodian to witness.
- **No curriculum authority review.** The signed bundle is a draft.

## Replacing it (the real ceremony)

1. Generate an Ed25519 key inside KMS/HSM; export only the SPKI public key.
2. On an offline machine, run
   `node tools/sign-tier-zero.mjs <bundle.json> <out.sig>` with
   `EDUGENESIS_BUNDLE_SIGNING_KEY` pointing at the offline copy — the tool
   refuses a key path inside the repository.
3. Replace `config/tier-zero-public-key.json` with the production public key,
   `status: "PRODUCTION"`, a new `keyId`, and the ceremony record reference.
4. Re-sign `config/tier-zero-bundle.json`; run `npm test` so the trust test
   proves the new chain.
5. Append a row to this table, mark the placeholder `RETIRED (not trusted)`, and
   delete the placeholder private key from the operator machine.
