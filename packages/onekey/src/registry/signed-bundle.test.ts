import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidBundleSignatureError,
  isSignedBundle,
  UnsignedBundleError,
  verifyTierZeroBundle,
  type TierZeroBundle,
} from './signed-bundle.js';

// F1-09: the signed-bundle pipeline refuses an unsigned bundle and delegates
// verification to an injected verifier. The signature below is a test token,
// not a real credential — the real signing key is owner-gated (KMS/HSM).
test('signed bundle: unsigned bundles are refused and verification is delegated', () => {
  const bundle: TierZeroBundle = {
    version: '1.0.0',
    watermark: 'offline-2026-11',
    lessons: [{ id: 'algebra/linear-eq', body: 'ax + b = c' }],
  };

  assert.equal(isSignedBundle(bundle), false);
  const verifier = { verify: () => true };
  assert.throws(
    () => verifyTierZeroBundle(bundle, verifier),
    (err: unknown) => err instanceof UnsignedBundleError,
    'an unsigned bundle must never enter the offline library',
  );

  const signed = { ...bundle, signature: 'kms-owned-signature-placeholder' };
  assert.equal(isSignedBundle(signed), true);

  let seenSignature: string | undefined;
  const verified = verifyTierZeroBundle(signed, {
    verify(_candidate, signature) {
      seenSignature = signature;
      return true;
    },
  });
  assert.equal(verified, signed, 'a verified bundle is returned unchanged');
  assert.equal(seenSignature, signed.signature, 'verification must see the supplied signature');

  assert.throws(
    () => verifyTierZeroBundle(signed, { verify: () => false }),
    (err: unknown) => err instanceof InvalidBundleSignatureError,
  );
});
