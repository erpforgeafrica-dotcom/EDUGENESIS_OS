/**
 * @edugenesis/identity — public surface.
 *
 * Re-exports every public member of the package. Importing this module is the
 * only supported entry point, so an internal file can be reorganised without
 * breaking a consumer.
 *
 * The package implements the four identity contracts declared in
 * `packages/contracts`: `IdentityService`, `ConsentService`,
 * `AgeAssuranceService` and `SessionRiskService`.
 */
export * from './identity.js';
export * from './enrolment.js';
export * from './policy.js';
export * from './consent.js';
export * from './age-assurance.js';
export * from './session-risk.js';
