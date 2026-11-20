#!/usr/bin/env node
/**
 * tools/sign-release-approval.mjs — the release-approval ceremony.
 *
 *   EG_RELEASE_APPROVAL_KEY=<path to an Ed25519 PEM outside the repository> \
 *     node tools/sign-release-approval.mjs [--signer-class PLACEHOLDER]
 *
 * WHY IT IS IN THE REPOSITORY: a ceremony that exists only in someone's shell
 * history is not repeatable, and a release process nobody can re-run is a
 * process that silently rots. This tool rebuilds the subject with the SAME
 * module the verifier uses (`tools/approval-subject.mjs`), signs it, and writes
 * `config/release-approval-subject.json` and `config/release-approval.sig`.
 *
 * It refuses:
 *   - a key path inside the repository (a private key must never be committed,
 *     and an agent must never be able to fabricate a ceremony from the tree)
 *   - a missing or unreadable key
 *   - a key that does not match the installed trust root's public key
 *   - an absolute path that does not exist
 *
 * It prints the digest and the key id. It never prints key material.
 *
 * Zero runtime dependencies (ADR-0014).
 */
import { createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { buildSubject } from './approval-subject.mjs';

const ROOT = resolve(process.cwd());
const TRUST_FILE = join(ROOT, 'config', 'tier-zero-public-key.json');
const SUBJECT_FILE = join(ROOT, 'config', 'release-approval-subject.json');
const SIGNATURE_FILE = join(ROOT, 'config', 'release-approval.sig');
const OWNER_DIRECTIVE = process.env['EG_OWNER_DIRECTIVE'] ?? 'O-2026-11-19-1';

function fail(message) {
  console.error(`sign-release-approval — ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let signerClass = 'PLACEHOLDER';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--signer-class') {
    signerClass = String(args[i + 1] ?? '');
    if (signerClass === '') fail('--signer-class needs a value');
    i += 1;
  } else {
    fail(`unexpected argument ${args[i]}`);
  }
}

const keyPath = process.env['EG_RELEASE_APPROVAL_KEY'] ?? '';
if (keyPath === '') {
  fail('EG_RELEASE_APPROVAL_KEY must name the Ed25519 private key (PEM) outside the repository');
}
const absoluteKey = isAbsolute(keyPath) ? keyPath : resolve(ROOT, keyPath);
if (!existsSync(absoluteKey)) fail('the key file does not exist');
const keyInsideRepo = !relative(ROOT, absoluteKey).startsWith(`..${sep}`) && !isAbsolute(relative(ROOT, absoluteKey));
if (keyInsideRepo) fail('the private key must live OUTSIDE the repository');

const privateKey = createPrivateKey(readFileSync(absoluteKey, 'utf8'));
const publicPemFromKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
if (!existsSync(TRUST_FILE)) fail('config/tier-zero-public-key.json is missing');
const trust = JSON.parse(readFileSync(TRUST_FILE, 'utf8'));
const installed = String(trust.publicKeyPem ?? '').trim();
if (installed !== publicPemFromKey.trim()) {
  fail('the private key does not match the installed trust root public key');
}

const built = buildSubject(ROOT);
const signature = cryptoSign(null, Buffer.from(built.canonical, 'utf8'), privateKey).toString('base64');

writeFileSync(SUBJECT_FILE, `${JSON.stringify({
  schemaVersion: 1,
  approvedAt: new Date().toISOString(),
  scope: built.scope,
  excluded: built.excluded,
  subjectMode: built.mode,
  fileCount: built.files.length,
  files: built.files,
  digest: built.digest,
  keyId: trust.keyId,
  signerClass,
  ownerDirective: OWNER_DIRECTIVE,
  note: signerClass === 'PLACEHOLDER'
    ? 'Agent-held placeholder signer. Proves the approval mechanism end to end; does not prove that a person with authority approved the release.'
    : 'Signed by the named signer class.',
}, null, 2)}\n`, 'utf8');
writeFileSync(SIGNATURE_FILE, `${signature}\n`, 'utf8');

const approvalPath = join(ROOT, 'docs', 'RELEASE-APPROVAL.md');
if (existsSync(approvalPath)) {
  const approval = readFileSync(approvalPath, 'utf8');
  if (approval.includes('__DIGEST__')) {
    writeFileSync(approvalPath, approval.replace('__DIGEST__', built.digest), 'utf8');
  }
}

console.log(`subject mode  : ${built.mode}`);
console.log(`files covered : ${built.files.length}`);
console.log(`subject digest: ${built.digest}`);
console.log(`keyId         : ${trust.keyId}`);
console.log(`signer class  : ${signerClass}`);
console.log(`signature     : ${signature.length} base64 chars (value not printed)`);
