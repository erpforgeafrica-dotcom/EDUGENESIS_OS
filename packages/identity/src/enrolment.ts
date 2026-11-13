/**
 * Enrolment — the paths a learner may enter the platform by.
 *
 * Authority:
 *   09 §12.3 Phase 1 exit criterion 1 — "A learner can enrol via passkey, or
 *   via provisional identity plus guardian consent token; the path taken is
 *   recorded in the audit log."
 *   Doc 2 §4.2 — identity, the passkey/WebAuthn ceremony, the local-key
 *   fallback.
 *   Slice 0 decision D-05 — the WebAuthn CEREMONY is deferred (it needs a
 *   browser and a secure element); the SEAM is not.
 *
 * WHAT IS IMPLEMENTED HERE
 *   The guardian-consent path, end to end:
 *     - a guardian is issued a consent token bound to ONE learner and to the
 *       consent scopes the guardian authorised;
 *     - the token carries a credential handle, and the secret is shown once —
 *       only a salted verifier is ever stored;
 *     - the learner enrols provisionally by presenting the token and its
 *       secret;
 *     - the scopes the guardian consented to are granted through the CONSENT
 *       service, so a later withdrawal locks them exactly as it locks any
 *       other grant;
 *     - the path taken is written to the enrolment audit log.
 *
 * WHAT IS DEFERRED, AND WHY IT IS NOT A HOLE
 *   `enrolWithPasskey` refuses with a typed error that names the missing
 *   ceremony. The criterion is a disjunction — "via passkey, OR via provisional
 *   identity plus guardian consent token" — so the implemented branch
 *   satisfies it, and the audit log records WHICH branch was taken, which is
 *   what the criterion asks to be verifiable.
 *
 * SECURITY RULES ENFORCED IN THIS FILE
 *   1. The token secret is never stored here or by the identity service. Only
 *      a salted, one-way verifier is kept, and it is verified with the
 *      identity service's constant-time path.
 *   2. A token is bound to one learner, expires, and is single-use.
 *   3. A token that is expired, already used, bound to another learner, or
 *      presented with the wrong secret is REFUSED, and the refusal is recorded
 *      in the audit log with the path that was attempted.
 *   4. The audit log carries opaque ids only — never a name, an email address
 *      or a telephone number.
 *   5. A provisional learner may learn. Enrolment grants SHARING scopes only;
 *      core learning is never gated on an enrolment state.
 */
import { randomBytes } from 'node:crypto';

import type { ConsentScope, Principal, Role } from '@edugenesis/contracts';

import type { ConsentService } from './consent.js';
import type { LocalIdentityService } from './identity.js';

/** The two ways a learner may enrol. Both are recorded in the audit log. */
export type EnrolmentMethod = 'passkey' | 'guardian_consent_token';

/** What happened on an enrolment attempt. */
export type EnrolmentOutcome = 'enrolled' | 'refused';

/**
 * An enrolment audit event.
 *
 * Carries opaque ids only. A name, an email address or a telephone number in
 * this log would be personal data in a file that outlives the learner.
 */
export interface EnrolmentAuditEvent {
  /** When the attempt happened. */
  readonly at: string;
  /** The learner the attempt was about. */
  readonly subjectId: string;
  /** The path that was taken. */
  readonly method: EnrolmentMethod;
  /** Whether the attempt enrolled a learner or was refused. */
  readonly outcome: EnrolmentOutcome;
  /** True while the learner is still provisional. */
  readonly provisional: boolean;
  /** The guardian whose authority was exercised, when one was. */
  readonly guardianId?: string;
  /** The consent token the attempt presented, when one was presented. */
  readonly consentTokenId?: string;
  /** Why it happened, in words a human can audit. */
  readonly detail: string;
}

/**
 * A guardian's consent to one learner's enrolment.
 *
 * The token itself is not a secret: it is a handle. The secret that proves
 * the guardian's authority travels separately and is shown once.
 */
export interface GuardianConsentToken {
  readonly tokenId: string;
  /** The learner this token authorises. One token, one learner. */
  readonly learnerId: string;
  /** The guardian whose authority this is. */
  readonly guardianId: string;
  /** The credential handle the secret is checked against. */
  readonly credentialId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** The sharing scopes the guardian authorised. */
  readonly scopes: readonly ConsentScope[];
}

/** A freshly issued token. The secret is shown ONCE and never stored. */
export interface IssuedGuardianConsentToken {
  readonly token: GuardianConsentToken;
  readonly secret: string;
}

/** Thrown when an enrolment attempt is refused. */
export class EnrolmentRefusedError extends Error {
  /** Why the attempt was refused. */
  readonly reason: string;
  /** The path that was attempted. */
  readonly method: EnrolmentMethod;

  constructor(reason: string, method: EnrolmentMethod) {
    super(`Enrolment refused on the ${method} path: ${reason}`);
    this.name = 'EnrolmentRefusedError';
    this.reason = reason;
    this.method = method;
  }
}

/**
 * Thrown when the passkey ceremony is requested.
 *
 * The ceremony needs a browser and an authenticator, neither of which exists
 * in Slice 0. The seam is fixed here so a later slice replaces the body
 * without any caller changing.
 */
export class PasskeyCeremonyUnavailableError extends Error {
  constructor() {
    super(
      'The passkey enrolment ceremony is not available in Slice 0: it requires a browser ' +
        'and an authenticator (Slice 0 decision D-05). The seam is fixed and the ceremony ' +
        'is deferred. Enrol through a guardian consent token instead.',
    );
    this.name = 'PasskeyCeremonyUnavailableError';
  }
}

/** Input for issuing a guardian consent token. */
export interface IssueGuardianConsentTokenInput {
  /** The guardian. Must already exist in the identity service. */
  readonly guardianId: string;
  /** The learner this token authorises. Allocated by the platform. */
  readonly learnerId: string;
  /** The sharing scopes the guardian authorises. */
  readonly scopes: readonly ConsentScope[];
  /** How long the token stays valid. Defaults to 24 hours. */
  readonly ttlMs?: number;
}

/** Input for the guardian-consent enrolment path. */
export interface GuardianConsentEnrolmentInput {
  readonly token: GuardianConsentToken;
  /** The secret issued with the token. */
  readonly secret: string;
  /** The learner's age band, when it is already known. */
  readonly ageBand?: Principal['ageBand'];
}

/** Input for the passkey path. The ceremony is deferred. */
export interface PasskeyEnrolmentInput {
  /** The learner id the caller intends to enrol. */
  readonly learnerId: string;
}

export interface EnrolmentResult {
  readonly principal: Principal;
  /** True when the learner is enrolled provisionally. */
  readonly provisional: boolean;
  /** The path that was taken. */
  readonly method: EnrolmentMethod;
  /** The sharing scopes the guardian's consent unlocked. */
  readonly grantedScopes: readonly ConsentScope[];
}

export interface EnrolmentServiceOptions {
  readonly identity: LocalIdentityService;
  readonly consent: ConsentService;
  /** Clock injection. Defaults to the system clock. */
  readonly now?: () => Date;
  /**
   * The age-assurance service.
   *
   * WHY IT IS INJECTED AND NOT OPTIONAL IN SPIRIT: the round-3 audit found the
   * age band was whatever the caller typed, and the ABAC policy trusted it. A
   * band is evidence only when an assurance process attests it. When this is
   * absent, NO band is written to the principal — a caller-supplied band is
   * recorded as unverified and never becomes an authorisation attribute.
   */
  readonly ageAssurance?: AgeAssurance;
}

/** The age-assurance seam. The ceremony itself is a Slice 1 integration. */
export interface AgeAssurance {
  /** The band this service has verified for a subject, if any. */
  verifiedBand(subjectId: string): Principal['ageBand'] | undefined;
}

export interface EnrolmentService {
  /** Issue a guardian consent token. The secret is returned once. */
  issueGuardianConsentToken(input: IssueGuardianConsentTokenInput): IssuedGuardianConsentToken;
  /** Enrol a learner provisionally on a guardian's consent token. */
  enrolWithGuardianConsent(input: GuardianConsentEnrolmentInput): Promise<EnrolmentResult>;
  /** The passkey path. Refuses — the ceremony is deferred (D-05). */
  enrolWithPasskey(input: PasskeyEnrolmentInput): never;
  /** The enrolment audit trail, oldest event first. */
  auditTrail(subjectId?: string): readonly EnrolmentAuditEvent[];
  /** Whether a learner is still provisional. */
  isProvisional(subjectId: string): boolean;
}

const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Read a list attribute written as a JSON array string.
 *
 * The frozen contract types attributes as scalars, so a list is stored as its
 * JSON text. A value that is not a JSON array is read as empty rather than
 * guessed at.
 */
function parseStringList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

export function createEnrolmentService(options: EnrolmentServiceOptions): EnrolmentService {
  const { identity, consent } = options;
  const clock = options.now ?? ((): Date => new Date());

  const audit: EnrolmentAuditEvent[] = [];
  /**
   * The claims of every token this service issued, keyed by token id.
   *
   * WHY THE CLAIMS ARE HELD HERE AND NOT TRUSTED FROM THE CALLER: the token
   * is a handle, like a credential. The guardian's authority is proven by the
   * credential secret, but the CLAIMS — which learner, which scopes, until
   * when — would otherwise be whatever the caller typed into the object it
   * passed in. A caller could widen the scopes. So the presented token is
   * matched against the issued one, and a mismatch is refused.
   */
  const issuedTokens = new Map<string, GuardianConsentToken>();
  /** Token ids that have already been spent. A token is single-use. */
  const usedTokenIds = new Set<string>();

  function record(event: EnrolmentAuditEvent): void {
    audit.push(event);
  }

  function refuse(reason: string, method: EnrolmentMethod, subjectId: string, extra?: Partial<EnrolmentAuditEvent>): never {
    record({
      at: clock().toISOString(),
      subjectId,
      method,
      outcome: 'refused',
      provisional: false,
      detail: reason,
      ...extra,
    });
    throw new EnrolmentRefusedError(reason, method);
  }

  function issueGuardianConsentToken(input: IssueGuardianConsentTokenInput): IssuedGuardianConsentToken {
    const guardian = identity.get(input.guardianId);
    if (!guardian) {
      refuse('the token issuer is not a registered principal', 'guardian_consent_token', input.learnerId, {
        guardianId: input.guardianId,
      });
    }
    // A token is a guardian credential. Handing one to a learner account is
    // how a child would end up consenting for themselves.
    if (!guardian.roles.includes('guardian')) {
      refuse('the token issuer is not a guardian', 'guardian_consent_token', input.learnerId, {
        guardianId: input.guardianId,
      });
    }
    if (!input.learnerId || input.learnerId.length === 0) {
      refuse('a consent token must name the learner it authorises', 'guardian_consent_token', input.learnerId, {
        guardianId: input.guardianId,
      });
    }

    // The secret is issued by the identity service, which keeps only a
    // verifier. It exists in this call frame and in the caller's hands.
    const credential = identity.issueCredential(input.guardianId);
    const issuedAt = clock();
    const ttl = input.ttlMs ?? DEFAULT_TOKEN_TTL_MS;

    const token: GuardianConsentToken = {
      tokenId: randomBytes(12).toString('hex'),
      learnerId: input.learnerId,
      guardianId: input.guardianId,
      credentialId: credential.credentialId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttl).toISOString(),
      scopes: [...input.scopes],
    };
    issuedTokens.set(token.tokenId, token);
    return { token, secret: credential.secret };
  }

  /**
   * True when the presented token is exactly the one this service issued.
   * Every claim is compared: a caller that widens the scopes or redirects the
   * token to another learner must be refused, not obeyed.
   */
  function matchesIssuedToken(presented: GuardianConsentToken, issued: GuardianConsentToken): boolean {
    return (
      presented.learnerId === issued.learnerId &&
      presented.guardianId === issued.guardianId &&
      presented.credentialId === issued.credentialId &&
      presented.issuedAt === issued.issuedAt &&
      presented.expiresAt === issued.expiresAt &&
      presented.scopes.length === issued.scopes.length &&
      presented.scopes.every((scope, index) => scope === issued.scopes[index])
    );
  }

  async function enrolWithGuardianConsent(input: GuardianConsentEnrolmentInput): Promise<EnrolmentResult> {
    const method: EnrolmentMethod = 'guardian_consent_token';
    const presented = input.token;
    const subjectId = presented.learnerId;

    const issued = issuedTokens.get(presented.tokenId);
    if (!issued) {
      refuse('the consent token was not issued by this service', method, subjectId, {
        consentTokenId: presented.tokenId,
      });
    }
    if (!matchesIssuedToken(presented, issued)) {
      refuse('the consent token does not match the token that was issued', method, subjectId, {
        consentTokenId: presented.tokenId,
        guardianId: issued.guardianId,
      });
    }
    const token = issued;

    if (usedTokenIds.has(token.tokenId)) {
      refuse('the consent token was already used', method, subjectId, { consentTokenId: token.tokenId });
    }

    const expiresAt = new Date(token.expiresAt).getTime();
    if (Number.isNaN(expiresAt)) {
      refuse('the consent token carries no valid expiry', method, subjectId, { consentTokenId: token.tokenId });
    }
    if (expiresAt <= clock().getTime()) {
      refuse('the consent token has expired', method, subjectId, { consentTokenId: token.tokenId });
    }

    // The guardian's authority is verified by the identity service, which
    // returns null for a wrong secret and for an unknown guardian alike.
    const guardian = await identity.authenticate(token.guardianId, {
      type: 'local_key',
      credentialId: token.credentialId,
      secret: input.secret,
    });
    if (!guardian) {
      refuse('the guardian credential did not verify', method, subjectId, {
        consentTokenId: token.tokenId,
        guardianId: token.guardianId,
      });
    }

    const roles: readonly Role[] = ['learner'];
    // A band the caller asserts is not evidence. Only a band the assurance
    // service attests is written as an authorisation attribute.
    const verifiedBand = options.ageAssurance?.verifiedBand(subjectId);
    if (
      input.ageBand !== undefined &&
      verifiedBand !== undefined &&
      input.ageBand !== verifiedBand
    ) {
      refuse('the supplied age band does not match the verified band', method, subjectId, {
        consentTokenId: token.tokenId,
        guardianId: token.guardianId,
      });
    }
    const ageBand = verifiedBand;
    let principal: Principal;
    try {
      principal = identity.register({
        id: subjectId,
        roles,
        attributes: {
          // The guardian's consent is recorded on the principal, because the
          // ABAC rule that guards learner records reads this attribute.
          guardianConsent: true,
          enrolmentStatus: 'provisional',
          enrolmentMethod: method,
          // An unverified band is recorded as a flag, never as a band.
          ...(input.ageBand !== undefined && ageBand === undefined
            ? { ageBandUnverified: true }
            : {}),
        },
        ...(ageBand !== undefined ? { ageBand } : {}),
      });
    } catch (error) {
      refuse(
        `the learner could not be enrolled: ${error instanceof Error ? error.message : String(error)}`,
        method,
        subjectId,
        { consentTokenId: token.tokenId, guardianId: token.guardianId },
      );
    }

    // The scopes the guardian authorised become ordinary consent grants, so a
    // later withdrawal locks them exactly as it locks any other grant.
    const grantedScopes: ConsentScope[] = [];
    for (const scope of token.scopes) {
      consent.grant({
        learnerId: principal.id,
        scope,
        granted: true,
        at: clock().toISOString(),
        guardianId: token.guardianId,
      });
      grantedScopes.push(scope);
    }

    // The guardian is now linked to this learner, so the ABAC rule that
    // governs access to a learner's record has something to match. The
    // attribute is a JSON string: the frozen contract types attributes as
    // scalars, and the policy engine reads this one as a list.
    const linked = identity.get(token.guardianId)?.attributes['linkedLearnerIds'];
    const linkedList = Array.isArray(linked)
      ? linked.filter((value): value is string => typeof value === 'string')
      : parseStringList(linked);
    if (!linkedList.includes(principal.id)) {
      identity.updateAttributes(token.guardianId, {
        linkedLearnerIds: JSON.stringify([...linkedList, principal.id]),
      });
    }

    usedTokenIds.add(token.tokenId);

    record({
      at: clock().toISOString(),
      subjectId: principal.id,
      method,
      outcome: 'enrolled',
      provisional: true,
      guardianId: token.guardianId,
      consentTokenId: token.tokenId,
      detail:
        `enrolled provisionally on a guardian consent token; ` +
        `${String(grantedScopes.length)} sharing scope(s) granted`,
    });

    return { principal, provisional: true, method, grantedScopes };
  }

  function enrolWithPasskey(input: PasskeyEnrolmentInput): never {
    record({
      at: clock().toISOString(),
      subjectId: input.learnerId,
      method: 'passkey',
      outcome: 'refused',
      provisional: false,
      detail: 'the passkey ceremony is deferred (Slice 0 decision D-05)',
    });
    throw new PasskeyCeremonyUnavailableError();
  }

  function auditTrail(subjectId?: string): readonly EnrolmentAuditEvent[] {
    const events = subjectId === undefined ? audit : audit.filter((event) => event.subjectId === subjectId);
    return [...events];
  }

  function isProvisional(subjectId: string): boolean {
    return identity.get(subjectId)?.attributes['enrolmentStatus'] === 'provisional';
  }

  return {
    issueGuardianConsentToken,
    enrolWithGuardianConsent,
    enrolWithPasskey,
    auditTrail,
    isProvisional,
  };
}
