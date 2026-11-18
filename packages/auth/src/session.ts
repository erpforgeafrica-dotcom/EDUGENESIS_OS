/**
 * Stateless HMAC-signed sessions. Token shape:
 *   base64url(JSON payload).base64url(HMAC-SHA256(payloadBytes, secret))
 * No server-side session table: the signature carries authenticity, and the
 * embedded `exp` carries expiry. CSRF is minted per session and embedded so a
 * caller can echo it on state-changing requests.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthPrincipal, AuthRole } from './roles.js';

export interface SessionPayload {
  readonly v: 1;
  readonly sub: string;
  readonly roles: readonly AuthRole[];
  readonly iat: number;
  readonly exp: number;
  readonly csrf: string;
}

export interface SessionManagerOptions {
  readonly secret: string;
  readonly ttlSec?: number;
  readonly now?: () => Date;
}

export interface SessionManager {
  issue(principal: AuthPrincipal): { token: string; csrf: string; expiresAt: number };
  verify(token: string): SessionPayload | null;
}

const VALID_ROLES: readonly string[] = ['learner', 'guardian', 'sponsor', 'operator', 'auditor'];

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const secret = options.secret;
  const ttlSec = options.ttlSec ?? 3600;
  const now = options.now ?? (() => new Date());

  function sign(payloadBytes: Buffer): Buffer {
    return createHmac('sha256', secret).update(payloadBytes).digest();
  }

  return {
    issue(principal) {
      const nowSec = Math.floor(now().getTime() / 1000);
      const exp = nowSec + ttlSec;
      const csrf = randomBytes(16).toString('hex'); // 32 hex chars, >= 16
      const payload: SessionPayload = {
        v: 1,
        sub: principal.id,
        roles: [...principal.roles],
        iat: nowSec,
        exp,
        csrf,
      };
      const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
      const token = `${payloadBytes.toString('base64url')}.${sign(payloadBytes).toString('base64url')}`;
      return { token, csrf, expiresAt: exp };
    },

    verify(token) {
      try {
        const parts = token.split('.');
        if (parts.length !== 2) return null;
        const payloadPart = parts[0] ?? '';
        const signaturePart = parts[1] ?? '';
        if (payloadPart.length === 0 || signaturePart.length === 0) return null;

        const payloadBytes = Buffer.from(payloadPart, 'base64url');
        const supplied = Buffer.from(signaturePart, 'base64url');
        // Reject non-canonical base64url so stray characters cannot be smuggled.
        if (payloadBytes.toString('base64url') !== payloadPart) return null;
        if (supplied.toString('base64url') !== signaturePart) return null;

        const expected = sign(payloadBytes);
        if (expected.length !== supplied.length) return null;
        if (!timingSafeEqual(expected, supplied)) return null;

        const decoded: unknown = JSON.parse(payloadBytes.toString('utf8'));
        if (!isSessionPayload(decoded)) return null;
        const nowSec = Math.floor(now().getTime() / 1000);
        if (nowSec >= decoded.exp) return null;
        return decoded;
      } catch {
        return null;
      }
    },
  };
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['v'] !== 1) return false;
  if (typeof record['sub'] !== 'string' || record['sub'].length === 0) return false;
  if (typeof record['iat'] !== 'number' || !Number.isFinite(record['iat'])) return false;
  if (typeof record['exp'] !== 'number' || !Number.isFinite(record['exp'])) return false;
  if (typeof record['csrf'] !== 'string' || record['csrf'].length === 0) return false;
  const roles: unknown = record['roles'];
  if (!Array.isArray(roles)) return false;
  if (!roles.every((role: unknown) => typeof role === 'string' && VALID_ROLES.includes(role))) {
    return false;
  }
  return true;
}
