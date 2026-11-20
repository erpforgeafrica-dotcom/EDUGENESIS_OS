# Release approval record

**PLACEHOLDER APPROVAL — this is a machine-verifiable interim record, not a
signature by a human being.** The Founder & CEO has not signed. See "What is
still untrue" below, and `docs/PLACEHOLDER-CLOSURE-REGISTER.md` item P0-1.

## What was approved

The release subject is a digest over every shipped source and document.

| Field | Value |
|---|---|
| Scope | `packages/`, `apps/`, `tools/`, `docs/` |
| Included | every tracked file under the scope, plus untracked files that are not git-ignored |
| Excluded | `docs/RELEASE-APPROVAL.md`, `docs/RELEASE-APPROVAL.sig`, and everything git ignores (`**/dist/`, `**/node_modules/`, `*.tsbuildinfo`, `artifacts/`) |
| Hashing | canonical LF form: CRLF becomes LF, nothing else changes, so a Windows and a Linux checkout of the same content hash identically |
| Files covered | see `config/release-approval-subject.json` → `fileCount` and `files` |
| Subject digest | `17e261a5621ccba874e0bd5f8dfe4f90c01186684638b046d80a2ed40e82cefc` |
| Signer class | `PLACEHOLDER` (agent-held key) |
| Key ID | `ph-ed25519-bf69f6994c4f90f7` |
| Owner directive | `O-2026-11-19-1` |
| Signature | `config/release-approval.sig` (Ed25519, base64) |

## How anyone re-checks it

```
node tools/verify-release-approval.mjs
```

The tool rebuilds the digest from the tree with `tools/approval-subject.mjs` —
the same module the ceremony uses — compares it with the recorded one, and
verifies the signature with the installed public key. Exit 0 means the tree is
exactly the tree that was approved. **Any content change to a source file or
document after approval makes it exit non-zero** — which is why the approval
must be re-signed after the final change, and why the tool is the authority
rather than this paragraph.

## How the ceremony is re-run

```
EG_RELEASE_APPROVAL_KEY=<ed25519-private-key.pem outside the repository> \
  node tools/sign-release-approval.mjs
```

The tool refuses a key inside the repository, a key that does not match the
installed trust root, and a missing key. It prints the digest and the key id,
never key material.

## What is still untrue

- The signer is an agent-held **placeholder** key, not the Founder & CEO. It
  proves the approval *mechanism* end to end; it does not prove that a person
  with authority read and approved the release.
- The key is not in KMS/HSM custody (`docs/TIER-ZERO-KEY-REGISTER.md`), and in
  the placeholder ceremony it is the same key that signs the Tier 0 bundle. Two
  ceremonies, one key, one custodian.
- The checksums of the rendered Doc 1 v1.2 and Doc 09 PDFs are not re-hashed
  here; `node tools/checksums.mjs --verify` remains the check for those, and it
  covers the shipped tree rather than the PDFs.

## Flipping it to a real approval

1. The Founder & CEO reviews the release subject (the digest above names exactly
   what was reviewed).
2. Record the approval in the register with the date and the approver's name.
3. Re-sign the same subject with the production key from the real ceremony, and
   pass `--signer-class OWNER`.
4. Replace this paragraph with the signature reference; `P0-1` moves from
   `placeholder` to `met` in `docs/exit-criteria.json`.
