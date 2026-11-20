#!/usr/bin/env node
/**
 * tools/verify-release-approval.mjs — the signed approval record, re-checked.
 *
 * WHY IT EXISTS: `docs/RELEASE-APPROVAL.md` claims a signed approval exists. A
 * claim is not evidence. This tool rebuilds the approval SUBJECT — a digest
 * over every shipped source and document — and verifies the Ed25519 signature
 * over it with the installed public key.
 *
 * The subject is built by `tools/approval-subject.mjs`, the same module the
 * signing ceremony uses, so the two can never disagree about what was signed.
 * It covers `packages/ apps/ tools/ docs/`, excludes the approval file and the
 * generated evidence, ignores everything git ignores (so a fresh clone hashes
 * the same set), and hashes each file in canonical LF form (so a Windows CRLF
 * checkout and a Linux LF checkout agree).
 *
 * Any content change to a source or document after approval breaks the
 * signature, which is the point.
 *
 * Zero runtime dependencies (ADR-0014).
 */
import { verify as cryptoVerify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { buildSubject } from './approval-subject.mjs';

const ROOT = resolve(process.cwd());
const SUBJECT_FILE = join(ROOT, 'config', 'release-approval-subject.json');
const SIGNATURE_FILE = join(ROOT, 'config', 'release-approval.sig');
const TRUST_FILE = join(ROOT, 'config', 'tier-zero-public-key.json');

for (const [name, path] of [['subject', SUBJECT_FILE], ['signature', SIGNATURE_FILE], ['trust root', TRUST_FILE]]) {
  if (!existsSync(path)) {
    console.error(`RESULT: FAIL — the ${name} file is missing (${relative(ROOT, path)}).`);
    process.exit(2);
  }
}

const built = buildSubject(ROOT);
const canonical = built.canonical;
const digest = built.digest;

const subject = JSON.parse(readFileSync(SUBJECT_FILE, 'utf8'));
const trust = JSON.parse(readFileSync(TRUST_FILE, 'utf8'));
const signature = readFileSync(SIGNATURE_FILE, 'utf8').trim();

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};

check('the subject digest matches the tree on disk', subject.digest === digest,
  `${digest.slice(0, 16)}… vs recorded ${String(subject.digest).slice(0, 16)}…`);
check('the subject names the same key as the installed trust root', subject.keyId === trust.keyId,
  `${subject.keyId}`);
check('the subject was built from the shipping set, not from ignored build output',
  built.mode === 'git',
  `${built.mode}; ${built.files.length} file(s), no *.tsbuildinfo`);

const ok = cryptoVerify(null, Buffer.from(canonical, 'utf8'), trust.publicKeyPem, Buffer.from(signature, 'base64'));
check('the Ed25519 signature verifies over the subject', ok, ok ? 'valid' : 'invalid or stale');
check('the approval states its placeholder signer class', subject.signerClass === 'PLACEHOLDER',
  String(subject.signerClass));

const failed = checks.filter((c) => !c.ok);
console.log(`\nRESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} — ${checks.length - failed.length}/${checks.length} approval checks over ${built.files.length} file(s).`);
if (failed.length > 0) {
  console.log('A source or document changed after approval. Re-sign under the owner directive, or treat the approval as void.');
  process.exit(1);
}
