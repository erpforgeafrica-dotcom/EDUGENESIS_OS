import { ProviderUnavailableError } from '@edugenesis/contracts';

/**
 * The provider failure taxonomy the gateway routes on (Doc 16 §6.6; audit
 * findings F3-13 and F3-14).
 *
 * WHY a taxonomy and not one error type: the gateway has to answer three
 * DIFFERENT questions about a provider failure, and each answer has a
 * different consequence:
 *
 *   - "is this provider SICK?"   → count it towards the health circuit.
 *   - "is this provider BUSY?"   → do NOT count it; a rate limit is a
 *                                  throttle on a healthy provider.
 *   - "is this credential DEAD?" → do NOT count it; revoke it, never retry it,
 *                                  and surface it as a GOVERNANCE event.
 *
 * Before this module, every one of those looked like
 * `ProviderUnavailableError`, so the gateway could not tell them apart and
 * treated a throttle and a rejected credential as an outage. These two
 * subclasses are the distinction the gateway needs.
 *
 * WHY THEY EXTEND `ProviderUnavailableError`: every existing caller that
 * catches a provider failure keeps working, and the specialisations only ADD
 * precision. A caller that does not care about the difference sees the same
 * shape it saw before.
 */

/**
 * A credential failure: the provider REJECTED the credential (HTTP 401/403).
 *
 * WHY it is a governance class and not a health class: the provider is not
 * sick. The credential is dead, and a dead credential must never be sent
 * again — retrying it is what turns one expired key into an incident. The
 * credential is revoked on sight and the failure is surfaced for a human
 * (rotation, incident review), not as a provider outage.
 */
export class ProviderCredentialRevokedError extends ProviderUnavailableError {
  constructor(providerId: string, detail?: string) {
    super(providerId, detail);
    this.name = 'ProviderCredentialRevokedError';
  }
}

/**
 * A rate limit: the provider is HEALTHY and is throttling this caller
 * (HTTP 429).
 *
 * WHY it must not open the health circuit: a throttle arrives exactly when
 * the provider is busiest and most needed. Counting it as an outage removes
 * the provider from routing for the whole cooldown, which manufactures the
 * outage the ladder exists to absorb.
 */
export class ProviderRateLimitedError extends ProviderUnavailableError {
  constructor(providerId: string, detail?: string) {
    super(providerId, detail);
    this.name = 'ProviderRateLimitedError';
  }
}

/**
 * True when the failure is a credential rejection — the credential is dead
 * and must never be used again.
 *
 * WHY a type guard instead of `instanceof` at each call site: the check is
 * made in two places (the adapter that revokes, the gateway that skips the
 * provider) and the rule must not drift between them.
 */
export function isCredentialRevoked(err: unknown): err is ProviderCredentialRevokedError {
  return err instanceof ProviderCredentialRevokedError;
}

/** True when the failure is a rate limit on a healthy provider. */
export function isRateLimited(err: unknown): err is ProviderRateLimitedError {
  return err instanceof ProviderRateLimitedError;
}
