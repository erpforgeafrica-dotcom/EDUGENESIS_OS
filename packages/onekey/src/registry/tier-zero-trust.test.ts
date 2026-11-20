/**
 * The installed Tier 0 trust root, exercised end to end.
 *
 * WHY THIS TEST EXISTS: a signature that nobody verifies is decoration. This
 * test loads the PUBLIC key installed in `config/`, the signed bundle that
 * ships with it, and the real verifier seam, then proves three things:
 *
 *   1. the shipped bundle verifies against the installed key;
 *   2. a single changed byte in a lesson body is refused;
 *   3. the trust root is honestly labelled as a PLACEHOLDER, so no reader can
 *      mistake it for the production key that only the owner's KMS/HSM holds.
 *
 * The private key lives outside the repository and is never read here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createEd25519Verifier } from './ed25519-signature.js';
import type { TierZeroBundle } from './signed-bundle.js';

const ROOT = new URL('../../../../', import.meta.url);
const read = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, ROOT)), 'utf8');

interface TrustRoot {
  readonly schemaVersion: number;
  readonly keyId: string;
  readonly algorithm: string;
  readonly status: string;
  readonly ownerDirective: string;
  readonly publicKeyPem: string;
  readonly note: string;
}

const trust = JSON.parse(read('config/tier-zero-public-key.json')) as TrustRoot;
const bundle = JSON.parse(read('config/tier-zero-bundle.json')) as TierZeroBundle;
const signature = read('config/tier-zero-bundle.sig').trim();

test('the shipped Tier 0 bundle verifies against the installed public key', () => {
  const verifier = createEd25519Verifier(trust.publicKeyPem);
  assert.equal(verifier.verify(bundle, signature), true);
});

test('one changed byte in a lesson body is refused', () => {
  const verifier = createEd25519Verifier(trust.publicKeyPem);
  const tampered: TierZeroBundle = {
    ...bundle,
    lessons: bundle.lessons.map((lesson, index) =>
      index === 0 ? { ...lesson, body: `${lesson.body} ` } : lesson),
  };
  assert.equal(verifier.verify(tampered, signature), false);
});

test('a reordered lesson list is refused', () => {
  const verifier = createEd25519Verifier(trust.publicKeyPem);
  const reordered: TierZeroBundle = { ...bundle, lessons: [...bundle.lessons].reverse() };
  assert.equal(verifier.verify(reordered, signature), false);
});

test('an empty or malformed signature is refused without throwing', () => {
  const verifier = createEd25519Verifier(trust.publicKeyPem);
  assert.equal(verifier.verify(bundle, ''), false);
  assert.equal(verifier.verify(bundle, 'not-base64-at-all'), false);
});

test('a different key cannot verify the shipped bundle', async () => {
  const { generateTestKeyPair } = await import('./ed25519-signature.js');
  const other = generateTestKeyPair();
  const verifier = createEd25519Verifier(other.publicKeyPem);
  assert.equal(verifier.verify(bundle, signature), false);
});

test('the trust root is honestly labelled as a placeholder', () => {
  assert.equal(trust.algorithm, 'ed25519');
  assert.match(trust.keyId, /^ph-ed25519-[0-9a-f]{16}$/);
  assert.equal(trust.status, 'PLACEHOLDER');
  assert.match(trust.ownerDirective, /O-\d{4}-\d{2}-\d{2}-\d+/);
  assert.match(trust.note, /NOT the production key/);
});
