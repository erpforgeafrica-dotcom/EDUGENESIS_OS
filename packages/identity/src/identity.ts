/**
 * Local-key identity adapter.
 *
 * Authority:
 *   Doc 2 §4.2 — identity, passkey/WebAuthn ceremony, local key fallback.
 *   Doc 1 v1.2 — governance: minors, safeguarding, least privilege.
 *   Slice 0 decision D-05 — "Local-key identity adapter behind the WebAuthn
 *   interface. Slice 0 must be testable without a browser or an authenticator;
 *   the ceremony is deferred, the seam is not."
 *
 * WHAT IS DEFERRED AND WHAT IS NOT
 *   The real WebAuthn/passkey ceremony (origin binding, attestation, HSM-backed
 *   key storage) needs a browser and a secure element, neither of which exists
 *   in Slice 0. What is NOT deferred is the seam: the credential *shape*, the
 *   verification contract, the non-enumeration guarantee and the storage rule
 *   (verifier only, never the secret) are fixed here, so a later slice can
 *   replace the derivation without any caller changing.
 *
 * SECURITY RULES ENFORCED IN THIS FILE
 *   1. The raw secret is never stored. Only a salted, one-way verifier is.
 *   2. Verification uses `timingSafeEqual`, never `===` on digests.
 *   3. A failed authentication returns `null` and never throws. A wrong secret
 *      and an unknown subject are indistinguishable to the caller.
 *   4. An unknown subject still performs a derivation, so the response time
 *      does not disclose whether the subject exists.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import type { IdentityService as IdentityServiceContract, Principal, Role } from '@edugenesis/contracts';

/** The credential shape a caller presents. Kept deliberately narrow. */
export interface LocalKeyCredential {
  readonly type: 'local_key';
  /** Opaque handle for the issued credential. */
  readonly credentialId: string;
  /** The secret. Held by the caller only — the service never stores it. */
  readonly secret: string;
}

/**
 * The stored verifier. Deliberately contains NO secret field: the absence of
 * that field is asserted by the test suite, because a verifier that leaks the
 * secret is the classic identity-store defect.
 */
export interface StoredCredentialRecord {
  readonly subjectId: string;
  readonly credentialId: string;
  readonly algorithm: 'scrypt';
  /** Hex salt, unique per credential. */
  readonly salt: string;
  /** Hex digest of the secret under `salt` and `params`. */
  readonly verifier: string;
  readonly params: ScryptParams;
  readonly issuedAt: string;
}

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keylen: number;
}

/**
 * Cost parameters for the stored verifier.
 *
 * These are ENGINEERING DEFAULTS, not a security claim and not a measured
 * result (review rubric C12 forbids asserting numbers no run produced). They
 * are the widely used scrypt work factors and exist so that a deployment on a
 * constrained device can trade cost for latency through configuration.
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  N: 16_384,
  r: 8,
  p: 1,
  keylen: 32,
};

export interface IdentityServiceOptions {
  /** Override the verifier cost parameters. Defaults to `DEFAULT_SCRYPT_PARAMS`. */
  readonly scrypt?: Partial<ScryptParams>;
}

/** Registration input. The contract requires `id`; we generate one when absent. */
export interface RegisterInput {
  /** Optional explicit id. When omitted an opaque id is generated. */
  readonly id?: string;
  readonly roles?: readonly Role[];
  /** Optional attribute set used later by ABAC evaluation. Defaults to empty. */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
  readonly ageBand?: Principal['ageBand'];
}

export interface LocalIdentityService extends IdentityServiceContract {
  /**
   * Registration widens the contract's input: the contract requires `id` and
   * `attributes`, but the adapter must be able to mint an opaque id and start
   * from an empty attribute set (Doc 2 §4.2). A caller that supplies both is
   * honoured exactly as the contract describes.
   */
  register(input: RegisterInput): Principal;
  /**
   * Issue a local-key credential. The returned secret is shown to the caller
   * ONCE and is never retained by the service.
   */
  issueCredential(subjectId: string, secret?: string): LocalKeyCredential;
  /** The stored verifiers for a subject. Contains no secret by construction. */
  credentials(subjectId: string): readonly StoredCredentialRecord[];
  /**
   * Merge a patch into a subject's ABAC attributes.
   *
   * WHY IT EXISTS: an enrolment links a guardian to the learner they
   * consented for. The ABAC rule that governs access to a learner's record
   * reads the `linkedLearnerIds` attribute, so something must be able to
   * write it. The contract interface has no such method, and the contract is
   * frozen — so this is an addition on the adapter, not a change to the
   * contract.
   */
  updateAttributes(id: string, patch: Readonly<Record<string, string | number | boolean>>): void;
}

interface PrincipalRecord {
  readonly principal: Principal;
  readonly credentials: Map<string, StoredCredentialRecord>;
}

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

/** A fixed salt used only to equalise timing for unknown subjects. */
const DUMMY_SALT = Buffer.from('00'.repeat(16), 'hex');
const DUMMY_VERIFIER = Buffer.from('00'.repeat(32), 'hex');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Narrow an unknown credential to the local-key shape.
 * Anything else is simply "not a credential" — a `null` result, never a throw.
 */
function parseCredential(credential: unknown): LocalKeyCredential | null {
  if (!isRecord(credential)) return null;
  if (credential['type'] !== 'local_key') return null;
  const credentialId = credential['credentialId'];
  const secret = credential['secret'];
  if (typeof credentialId !== 'string' || credentialId.length === 0) return null;
  if (typeof secret !== 'string' || secret.length === 0) return null;
  return { type: 'local_key', credentialId, secret };
}

function derive(secret: string, salt: Buffer, params: ScryptParams): Buffer {
  return scryptSync(secret, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
  });
}

/**
 * Constant-time comparison of two hex digests.
 * A length mismatch is a failed comparison, not an exception.
 */
function digestsEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function toHex(buffer: Buffer): string {
  return buffer.toString('hex');
}

export function createIdentityService(opts: IdentityServiceOptions = {}): LocalIdentityService {
  const params: ScryptParams = { ...DEFAULT_SCRYPT_PARAMS, ...opts.scrypt };
  const subjects = new Map<string, PrincipalRecord>();

  /** Opaque id: 16 random bytes, hex. Carries no counter, clock or name. */
  function generateSubjectId(): string {
    return randomBytes(16).toString('hex');
  }

  function requireSubject(subjectId: string): PrincipalRecord {
    const record = subjects.get(subjectId);
    if (!record) {
      throw new Error(`Unknown subject: ${subjectId}`);
    }
    return record;
  }

  function register(input: RegisterInput): Principal {
    const id = input.id && input.id.length > 0 ? input.id : generateSubjectId();
    if (subjects.has(id)) {
      throw new Error(`Subject already registered: ${id}`);
    }
    const principal: Principal = {
      id,
      roles: [...(input.roles ?? [])],
      // Defensive copy: the caller cannot mutate the stored attribute set.
      attributes: { ...(input.attributes ?? {}) },
    };
    if (input.ageBand !== undefined) {
      principal.ageBand = input.ageBand;
    }
    subjects.set(id, { principal, credentials: new Map() });
    // Return a copy so a caller cannot mutate the stored principal in place.
    return { ...principal, roles: [...principal.roles], attributes: { ...principal.attributes } };
  }

  function issueCredential(subjectId: string, secret?: string): LocalKeyCredential {
    const record = requireSubject(subjectId);
    // A caller may supply the secret (a migrated WebAuthn credential or a test
    // fixture); otherwise we generate 32 random bytes. Either way the secret
    // exists only in this call frame and in the caller's hands.
    const material = secret ?? randomBytes(32).toString('base64url');
    const salt = randomBytes(16);
    const verifier = derive(material, salt, params);
    const credentialId = randomBytes(12).toString('hex');
    const stored: StoredCredentialRecord = {
      subjectId,
      credentialId,
      algorithm: 'scrypt',
      salt: toHex(salt),
      verifier: toHex(verifier),
      params,
      issuedAt: new Date().toISOString(),
    };
    record.credentials.set(credentialId, stored);
    return { type: 'local_key', credentialId, secret: material };
  }

  async function authenticate(subjectId: string, credential: unknown): Promise<Principal | null> {
    const parsed = parseCredential(credential);
    if (!parsed) return null;

    const record = subjects.get(subjectId);
    if (!record) {
      // Unknown subject: burn an equivalent derivation so the caller cannot
      // distinguish "no such subject" from "wrong secret" by timing.
      derive(parsed.secret, DUMMY_SALT, params);
      return null;
    }

    const stored = record.credentials.get(parsed.credentialId);
    if (!stored) {
      derive(parsed.secret, DUMMY_SALT, params);
      return null;
    }

    const salt = Buffer.from(stored.salt, 'hex');
    const expected = Buffer.from(stored.verifier, 'hex');
    const candidate = derive(parsed.secret, salt, stored.params);
    if (!digestsEqual(candidate, expected)) return null;

    return {
      ...record.principal,
      roles: [...record.principal.roles],
      attributes: { ...record.principal.attributes },
    };
  }

  function get(id: string): Principal | undefined {
    const record = subjects.get(id);
    if (!record) return undefined;
    return {
      ...record.principal,
      roles: [...record.principal.roles],
      attributes: { ...record.principal.attributes },
    };
  }

  function assignRole(id: string, role: Role): void {
    const record = requireSubject(id);
    if (record.principal.roles.includes(role)) return;
    record.principal.roles.push(role);
  }

  function credentials(subjectId: string): readonly StoredCredentialRecord[] {
    const record = subjects.get(subjectId);
    if (!record) return [];
    return [...record.credentials.values()];
  }

  function updateAttributes(id: string, patch: Readonly<Record<string, string | number | boolean>>): void {
    const record = requireSubject(id);
    record.principal.attributes = { ...record.principal.attributes, ...patch };
  }

  return { register, issueCredential, authenticate, get, assignRole, credentials, updateAttributes };
}

/**
 * Exported for the storage guard test: asserts that a stored record only ever
 * carries verifier material. Kept as a function so the rule lives next to the
 * type it protects rather than only in a test.
 */
export function isVerifierOnlyRecord(record: StoredCredentialRecord): boolean {
  const keys = Object.keys(record).sort();
  const allowed = ['algorithm', 'credentialId', 'issuedAt', 'params', 'salt', 'subjectId', 'verifier'];
  return (
    keys.length === allowed.length &&
    keys.every((key, index) => key === allowed[index]) &&
    HEX_32.test(record.salt) &&
    HEX_64.test(record.verifier)
  );
}
