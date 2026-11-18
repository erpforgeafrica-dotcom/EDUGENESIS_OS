/**
 * Concrete Ed25519 signing/verification for the Tier 0 offline-bundle seam.
 *
 * Zero runtime dependencies (ADR-0014): only `node:crypto` is used. No key
 * material is embedded here. The PEM strings returned by generateTestKeyPair()
 * exist solely for tests and the owner's offline ceremony — production code
 * must load the public key from configuration and the private key from a
 * KMS/HSM or an offline vault that never enters this repository.
 */

import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import {
  verifyTierZeroBundle,
  type BundleSignatureVerifier,
  type SignedTierZeroBundle,
  type TierZeroBundle,
} from './signed-bundle.js';

/** Either a PEM string (SPKI public / PKCS#8 private) or a parsed KeyObject. */
export type CryptoKey = string | KeyObject;

/**
 * Deterministic UTF-8 bytes for a bundle.
 *
 * Keys are emitted in a fixed order — version, watermark, lessons; each lesson
 * as id then body — by constructing a fresh object rather than spreading the
 * input, so key insertion order in the caller's object cannot change the bytes
 * and a `signature` field can never leak into what gets signed.
 */
export function canonicalBundleBytes(bundle: TierZeroBundle): Uint8Array {
  const lessons = Array.isArray(bundle.lessons) ? bundle.lessons : [];
  const canonical = {
    version: bundle.version,
    watermark: bundle.watermark,
    lessons: lessons.map((lesson) => ({
      id: lesson.id,
      body: lesson.body,
    })),
  };
  return Buffer.from(JSON.stringify(canonical), 'utf8');
}

/**
 * Build a verifier bound to one public key. Every failure path — malformed
 * key, malformed base64, wrong-length signature, mismatch — returns false;
 * no exception escapes the verification seam.
 */
export function createEd25519Verifier(publicKey: CryptoKey): BundleSignatureVerifier {
  return {
    verify(bundle: TierZeroBundle, signature: string): boolean {
      try {
        const bytes = canonicalBundleBytes(bundle);
        const signatureBytes = Buffer.from(signature, 'base64');
        return cryptoVerify(null, bytes, publicKey, signatureBytes);
      } catch {
        return false;
      }
    },
  };
}

/** Produce a base64 Ed25519 signature over the canonical bundle bytes. */
export function signBundle(bundle: TierZeroBundle, privateKey: CryptoKey): string {
  const bytes = canonicalBundleBytes(bundle);
  return cryptoSign(null, bytes, privateKey).toString('base64');
}

/**
 * Generate an Ed25519 keypair as PEM strings.
 *
 * FOR TESTS AND THE OWNER'S OFFLINE CEREMONY ONLY. Never call from a
 * production code path: a keypair minted at runtime has no custody or trust.
 */
export function generateTestKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/**
 * Accept a bundle only after the injected verifier authenticates it. Delegates
 * to the existing seam so unsigned and invalid bundles keep their established
 * error types.
 */
export function loadSignedTierZeroBundle(
  input: TierZeroBundle | SignedTierZeroBundle,
  verifier: BundleSignatureVerifier,
): SignedTierZeroBundle {
  return verifyTierZeroBundle(input, verifier);
}
