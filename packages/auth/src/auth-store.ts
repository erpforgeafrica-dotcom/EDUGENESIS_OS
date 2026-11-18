/**
 * Durable principals, failure counters and audit trail backed by `node:sqlite`.
 * All SQL is parameter-bound. Stored password hashes never leave this module:
 * `authenticate` returns only a principal (id + roles), never `stored`.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, verifyPassword } from './password.js';
import type { AuthPrincipal, AuthRole } from './roles.js';

export interface AuthStoreOptions {
  readonly dataDir?: string;
  readonly now?: () => Date;
  readonly lockoutThreshold?: number;
  readonly lockoutMs?: number;
}

export interface AuthPrincipalRecord extends AuthPrincipal {
  readonly id: string;
}

export interface AuthStore {
  register(input: { id: string; password: string; roles: readonly AuthRole[] }): AuthPrincipal;
  authenticate(id: string, password: string): { ok: true; principal: AuthPrincipal } | { ok: false; reason: string; locked: boolean };
  isLocked(id: string): boolean;
  rolesOf(id: string): readonly AuthRole[] | undefined;
  grantRole(id: string, role: AuthRole): void;
  auditEvent(event: { actor: string; action: string; target?: string; outcome: string; at?: string }): void;
  auditTrail(): readonly { seq: number; at: string; actor: string; action: string; target: string; outcome: string }[];
  close(): void;
}

const DEFAULT_THRESHOLD = 5;
const DEFAULT_LOCKOUT_MS = 15 * 60 * 1000;
const VALID_ROLES: readonly string[] = ['learner', 'guardian', 'sponsor', 'operator', 'auditor'];

interface FailureRow {
  readonly count: number;
  readonly first_at: number;
  readonly locked_until: number;
}

interface PrincipalRow {
  readonly id: string;
  readonly stored: string;
  readonly roles: string;
}

type AuditRow = { seq: number; at: string; actor: string; action: string; target: string; outcome: string };

export function createAuthStore(options: AuthStoreOptions = {}): AuthStore {
  const now = options.now ?? (() => new Date());
  const threshold = options.lockoutThreshold ?? DEFAULT_THRESHOLD;
  const lockoutMs = options.lockoutMs ?? DEFAULT_LOCKOUT_MS;

  let dbPath = ':memory:';
  if (options.dataDir !== undefined) {
    mkdirSync(options.dataDir, { recursive: true });
    dbPath = join(options.dataDir, 'auth.sqlite');
  }
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS principals (
      id TEXT PRIMARY KEY,
      stored TEXT NOT NULL,
      roles TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS failures (
      id TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      first_at INTEGER NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      outcome TEXT NOT NULL
    );
  `);

  const findPrincipal = db.prepare('SELECT id, stored, roles FROM principals WHERE id = ?');
  const insertPrincipal = db.prepare('INSERT INTO principals (id, stored, roles) VALUES (?, ?, ?)');
  const updateRoles = db.prepare('UPDATE principals SET roles = ? WHERE id = ?');
  const findFailures = db.prepare('SELECT count, first_at, locked_until FROM failures WHERE id = ?');
  const upsertFailures = db.prepare(`
    INSERT INTO failures (id, count, first_at, locked_until) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      count = excluded.count,
      first_at = excluded.first_at,
      locked_until = excluded.locked_until
  `);
  const insertAudit = db.prepare('INSERT INTO audit (at, actor, action, target, outcome) VALUES (?, ?, ?, ?, ?)');
  const allAudit = db.prepare('SELECT seq, at, actor, action, target, outcome FROM audit ORDER BY seq ASC');

  function getPrincipal(id: string): PrincipalRow | undefined {
    return findPrincipal.get(id) as PrincipalRow | undefined;
  }

  function getFailures(id: string): FailureRow | undefined {
    return findFailures.get(id) as FailureRow | undefined;
  }

  function writeAudit(event: { actor: string; action: string; target?: string; outcome: string; at?: string }): void {
    insertAudit.run(event.at ?? now().toISOString(), event.actor, event.action, event.target ?? '', event.outcome);
  }

  return {
    register(input) {
      if (getPrincipal(input.id) !== undefined) {
        throw new Error(`Principal already exists: ${input.id}`);
      }
      const stored = hashPassword(input.password);
      const roles: AuthRole[] = [...input.roles];
      insertPrincipal.run(input.id, stored, JSON.stringify(roles));
      return { id: input.id, roles };
    },

    authenticate(id, password) {
      const nowMs = now().getTime();
      const failure = getFailures(id);

      // Lockout is checked BEFORE any password work.
      if (failure !== undefined && failure.locked_until > nowMs) {
        return { ok: false, reason: 'Account is temporarily locked.', locked: true };
      }
      const expired = failure !== undefined && failure.locked_until > 0 && failure.locked_until <= nowMs;
      if (expired) upsertFailures.run(id, 0, nowMs, 0);

      const row = getPrincipal(id);
      if (row === undefined || !verifyPassword(password, row.stored)) {
        const previousCount = expired ? 0 : (failure?.count ?? 0);
        const count = previousCount + 1;
        const lockedUntil = count >= threshold ? nowMs + lockoutMs : 0;
        upsertFailures.run(id, count, failure?.first_at ?? nowMs, lockedUntil);
        return { ok: false, reason: 'Invalid id or password.', locked: lockedUntil > nowMs };
      }

      // Success clears the bucket.
      upsertFailures.run(id, 0, nowMs, 0);
      return { ok: true, principal: { id: row.id, roles: parseRoles(row.roles) } };
    },

    isLocked(id) {
      const failure = getFailures(id);
      return failure !== undefined && failure.locked_until > now().getTime();
    },

    rolesOf(id) {
      const row = getPrincipal(id);
      return row === undefined ? undefined : parseRoles(row.roles);
    },

    grantRole(id, role) {
      const row = getPrincipal(id);
      if (row === undefined) throw new Error(`Unknown principal: ${id}`);
      const roles = parseRoles(row.roles);
      if (!roles.includes(role)) {
        roles.push(role);
        updateRoles.run(JSON.stringify(roles), id);
      }
      writeAudit({ actor: 'system', action: 'grantRole', target: id, outcome: role });
    },

    auditEvent: writeAudit,

    auditTrail() {
      return allAudit.all() as AuditRow[];
    },

    close() {
      db.close();
    },
  };
}

function parseRoles(raw: string): AuthRole[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((role: unknown): role is AuthRole =>
      typeof role === 'string' && VALID_ROLES.includes(role),
    );
  } catch {
    return [];
  }
}
