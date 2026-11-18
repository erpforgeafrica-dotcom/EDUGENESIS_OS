/** Public surface of `@edugenesis/auth`. */
export { hashPassword, verifyPassword } from './password.js';

export {
  ROLE_PERMISSIONS,
  hasPermission,
  toContractRole,
  fromContractRole,
} from './roles.js';
export type { AuthRole, Permission, AuthPrincipal } from './roles.js';

export { createSessionManager } from './session.js';
export type { SessionPayload, SessionManagerOptions, SessionManager } from './session.js';

export { createAuthStore } from './auth-store.js';
export type { AuthStoreOptions, AuthPrincipalRecord, AuthStore } from './auth-store.js';
