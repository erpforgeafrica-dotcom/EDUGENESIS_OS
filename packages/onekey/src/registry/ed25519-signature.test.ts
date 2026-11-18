/**
 * ed25519-signature.test.ts — TDD contract for concrete Ed25519 Tier 0 signing.
 *
 * RED phase first: every assertion below is written against the intended API
 * before ed25519-signature.ts exists. No literal PEM text appears here — the
 * secrets scanner (tools/secrets-scan.mjs) flags private-key headers in any
 * published file, so keys are generated at runtime by generateTestKeyPair().
 *
 * Run with: node --test <built>/ed25519-signature.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';

import {
  canonicalBundleBytes,
  createEd25519Verifier,
  generateTestKeyPair,
  loadSignedTierZeroBundle,
  signBundle,
} from './ed25519-signature.js';
import {
  InvalidBundleSignatureError,
  UnsignedBundleError,
  type SignedTierZeroBundle,
  type TierZeroBundle,
} from './signed-bundle.js';

/** Runtime-generated keypairs. Never literals, never committed. */
const ownerKeys = generateTestKeyPair();
const otherKeys = generateTestKeyPair();

const verifier = createEd25519Verifier(ownerKeys.publicKeyPem);

const bundle: TierZeroBundle = {
  version: '1.0.0',
  watermark: 'wm-2026-11-17',
  lessons: [
    { id: 'lesson-1', body: 'First lesson body.' },
    { id: 'lesson-2', body: 'Second lesson body.' },
  ],
};

/** Hand-derived canonical form — independent of the implementation. */
const CANONICAL_JSON =
  '{"version":"1.0.0","watermark":"wm-2026-11-17",' +
  '"lessons":[{"id":"lesson-1","body":"First lesson body."},' +
  '{"id":"lesson-2","body":"Second lesson body."}]}';

test('generates a runtime Ed25519 keypair without embedding PEM material', () => {
  assert.equal(typeof ownerKeys.publicKeyPem, 'string');
  assert.ok(ownerKeys.publicKeyPem.length > 0);
  assert.equal(typeof ownerKeys.privateKeyPem, 'string');
  assert.ok(ownerKeys.privateKeyPem.length > 0);
  assert.notStrictEqual(ownerKeys.publicKeyPem, ownerKeys.privateKeyPem);
});

test('a signed bundle verifies with the matching public key', () => {
  const signature = signBundle(bundle, ownerKeys.privateKeyPem);
  assert.equal(typeof signature, 'string');
  assert.ok(signature.length > 0);
  assert.equal(verifier.verify(bundle, signature), true);

  // A KeyObject public key must work as well as a PEM string.
  const keyObjectVerifier = createEd25519Verifier(createPublicKey(ownerKeys.publicKeyPem));
  assert.equal(keyObjectVerifier.verify(bundle, signature), true);

  // A KeyObject private key must sign bytes the PEM signer also verifies.
  const viaKeyObject = signBundle(bundle, createPrivateKey(ownerKeys.privateKeyPem));
  assert.equal(verifier.verify(bundle, viaKeyObject), true);
});

test('a tampered lesson body fails verification', () => {
  const signature = signBundle(bundle, ownerKeys.privateKeyPem);
  const tampered: TierZeroBundle = {
    version: bundle.version,
    watermark: bundle.watermark,
    lessons: [
      { id: 'lesson-1', body: 'TAMPERED body.' },
      { id: 'lesson-2', body: 'Second lesson body.' },
    ],
  };
  assert.equal(verifier.verify(tampered, signature), false);
});

test('a tampered version fails verification', () => {
  const signature = signBundle(bundle, ownerKeys.privateKeyPem);
  const tampered: TierZeroBundle = {
    version: '9.9.9',
    watermark: bundle.watermark,
    lessons: bundle.lessons,
  };
  assert.equal(verifier.verify(tampered, signature), false);
});

test('an unsigned bundle throws UnsignedBundleError when loaded', () => {
  assert.throws(() => loadSignedTierZeroBundle(bundle, verifier), UnsignedBundleError);
});

test('a signature from a different public key fails verification', () => {
  const signature = signBundle(bundle, otherKeys.privateKeyPem);
  const wrongVerifier = createEd25519Verifier(otherKeys.publicKeyPem);
  assert.equal(verifier.verify(bundle, signature), false);
  assert.equal(wrongVerifier.verify(bundle, signature), true);
});

test('a malformed base64 signature fails without throwing', () => {
  // A truncated base64 string that still decodes to a valid-length buffer can
  // verify, so use values guaranteed not to be a 64-byte Ed25519 signature.
  assert.equal(verifier.verify(bundle, '%%%not-base64%%%'), false);
  assert.equal(verifier.verify(bundle, ''), false);
  assert.equal(verifier.verify(bundle, 'AAAA'), false);
});

test('canonical bytes are deterministic regardless of key insertion order', () => {
  const reordered: TierZeroBundle = {
    lessons: [
      { body: 'First lesson body.', id: 'lesson-1' },
      { body: 'Second lesson body.', id: 'lesson-2' },
    ],
    watermark: 'wm-2026-11-17',
    version: '1.0.0',
  };
  assert.equal(Buffer.from(canonicalBundleBytes(bundle)).toString('utf8'), CANONICAL_JSON);
  assert.deepStrictEqual(canonicalBundleBytes(reordered), canonicalBundleBytes(bundle));
});

test('the signature field is never part of the canonical bytes', () => {
  const signed = { ...bundle, signature: 'a-signature-value' } as SignedTierZeroBundle;
  assert.deepStrictEqual(canonicalBundleBytes(signed), canonicalBundleBytes(bundle));
});

test('loadSignedTierZeroBundle returns the bundle when the signature is valid', () => {
  const signature = signBundle(bundle, ownerKeys.privateKeyPem);
  const signed: SignedTierZeroBundle = { ...bundle, signature };
  const loaded = loadSignedTierZeroBundle(signed, verifier);
  assert.strictEqual(loaded, signed);
  assert.equal(loaded.signature, signature);
  assert.deepStrictEqual(loaded.lessons, bundle.lessons);
});

test('loadSignedTierZeroBundle throws InvalidBundleSignatureError on a bad signature', () => {
  const signed: SignedTierZeroBundle = {
    ...bundle,
    signature: signBundle(bundle, otherKeys.privateKeyPem),
  };
  assert.throws(() => loadSignedTierZeroBundle(signed, verifier), InvalidBundleSignatureError);
});
