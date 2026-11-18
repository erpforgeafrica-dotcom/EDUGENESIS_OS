/**
 * Local role model. Deliberately independent of `@edugenesis/contracts`, whose
 * surface is frozen for this verification run. Mapping functions translate to
 * and from the contract's role vocabulary without importing it.
 */

export type AuthRole = 'learner' | 'guardian' | 'sponsor' | 'operator' | 'auditor';

export type Permission =
  | 'settings:read'
  | 'enrol:write'
  | 'audit:read'
  | 'sponsor:read'
  | 'sponsor:write'
  | 'ledger:read'
  | 'report:read'
  | 'operator:kill'
  | 'operator:revive';

/** The permission matrix. `readonly` so callers cannot widen a role at runtime. */
export const ROLE_PERMISSIONS: Readonly<Record<AuthRole, readonly Permission[]>> = {
  learner: [],
  guardian: ['enrol:write'],
  sponsor: ['sponsor:read', 'report:read', 'ledger:read'],
  operator: [
    'settings:read',
    'audit:read',
    'ledger:read',
    'report:read',
    'sponsor:read',
    'sponsor:write',
    'operator:kill',
    'operator:revive',
  ],
  auditor: ['audit:read', 'ledger:read', 'report:read'],
};

/** True when any of the principal's roles grants the permission. */
export function hasPermission(roles: readonly AuthRole[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}

/** Map an auth role to the contract vocabulary (`operator` -> `admin`). */
export function toContractRole(role: AuthRole): string {
  return role === 'operator' ? 'admin' : role;
}

const PASS_THROUGH_ROLES: readonly string[] = ['learner', 'guardian', 'sponsor', 'auditor'];

/** Map a contract role back to an auth role. Unknown values fail closed to learner. */
export function fromContractRole(role: string): AuthRole {
  if (role === 'admin') return 'operator';
  return PASS_THROUGH_ROLES.includes(role) ? (role as AuthRole) : 'learner';
}

export interface AuthPrincipal {
  readonly id: string;
  readonly roles: readonly AuthRole[];
}
