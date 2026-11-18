/**
 * Signed Tier 0 offline-bundle pipeline seam (Doc 09 §12.7).
 *
 * WHY a seam and not a concrete signature: a real signature requires an
 * external signing key (KMS/HSM) the owner must supply. This module NEVER
 * fabricates a key or a signature — it defines the verification contract and
 * refuses any bundle that is unsigned or whose signature does not verify.
 * Wiring a real KMS-backed verifier is owner-gated; the seam is ready for it.
 */

/** One cached lesson in an offline bundle. */
export interface BundledLesson {
  readonly id: string;
  readonly body: string;
}

/** An offline Tier 0 bundle with a version watermark. */
export interface TierZeroBundle {
  readonly version: string;
  readonly watermark: string;
  readonly lessons: readonly BundledLesson[];
}

/** A bundle that carries a signature produced by the external signer. */
export interface SignedTierZeroBundle extends TierZeroBundle {
  readonly signature: string;
}

/** The verification side of the external signing pipeline. */
export interface BundleSignatureVerifier {
  /** True only when the signature authenticates these exact bundle bytes. */
  verify(bundle: TierZeroBundle, signature: string): boolean;
}

export class UnsignedBundleError extends Error {}

export class InvalidBundleSignatureError extends Error {}

/** True when a bundle actually carries a non-empty signature. */
export function isSignedBundle(
  bundle: TierZeroBundle | SignedTierZeroBundle,
): bundle is SignedTierZeroBundle {
  const signature = (bundle as Partial<SignedTierZeroBundle>).signature;
  return typeof signature === 'string' && signature.length > 0;
}

/**
 * Verify a Tier 0 bundle before it is accepted into the offline library.
 * Refuses unsigned bundles outright and delegates cryptographic verification
 * to the injected verifier — no key material lives in this module.
 */
export function verifyTierZeroBundle(
  bundle: TierZeroBundle | SignedTierZeroBundle,
  verifier: BundleSignatureVerifier,
): SignedTierZeroBundle {
  if (!isSignedBundle(bundle)) {
    throw new UnsignedBundleError('a Tier 0 bundle without a signature is refused');
  }
  if (!verifier.verify(bundle, bundle.signature)) {
    throw new InvalidBundleSignatureError('the Tier 0 bundle signature did not verify');
  }
  return bundle;
}
