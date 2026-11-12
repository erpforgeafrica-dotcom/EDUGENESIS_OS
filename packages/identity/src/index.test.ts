/**
 * Public surface — contract conformance.
 *
 * Authority: `packages/contracts` is the frozen interface. This test proves
 * the package satisfies all four identity contracts and that the public entry
 * point really exposes the services, so a broken re-export cannot ship
 * unnoticed.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as identity from './index.js';
import type {
  AgeAssuranceService,
  ConsentService,
  IdentityService,
  SessionRiskService,
} from '@edugenesis/contracts';

/** Compile-time proof that each factory satisfies the frozen contract. */
const _identity: IdentityService = identity.createIdentityService();
const _consent: ConsentService = identity.createConsentService();
const _age: AgeAssuranceService = identity.createAgeAssuranceService();
const _risk: SessionRiskService = identity.createSessionRiskService();

describe('public surface', () => {
  test('every service factory is exported from the package entry point', () => {
    assert.equal(typeof identity.createIdentityService, 'function');
    assert.equal(typeof identity.createConsentService, 'function');
    assert.equal(typeof identity.createAgeAssuranceService, 'function');
    assert.equal(typeof identity.createSessionRiskService, 'function');
    assert.equal(typeof identity.createPolicyEngine, 'function');
  });

  test('the identity service implements every contract method', () => {
    const service = identity.createIdentityService();
    for (const method of ['register', 'authenticate', 'get', 'assignRole'] as const) {
      assert.equal(typeof service[method], 'function', `missing ${method}`);
    }
  });

  test('the consent service implements every contract method', () => {
    const service = identity.createConsentService();
    for (const method of ['grant', 'withdraw', 'state', 'mayShare', 'mayLearn'] as const) {
      assert.equal(typeof service[method], 'function', `missing ${method}`);
    }
  });

  test('the age assurance service implements every contract method', () => {
    const service = identity.createAgeAssuranceService();
    for (const method of ['assure', 'requiresGuardian'] as const) {
      assert.equal(typeof service[method], 'function', `missing ${method}`);
    }
  });

  test('the session risk service implements every contract method', () => {
    const service = identity.createSessionRiskService();
    assert.equal(typeof service.assess, 'function');
  });

  test('the default policy bundle and the consent graph are exported', () => {
    assert.ok(identity.DEFAULT_POLICY_BUNDLE.rules.length > 0);
    assert.equal(identity.CONSENT_SCOPES.length, 6);
    assert.deepEqual(identity.CONSENT_DEPENDENCIES.mentor_contact, ['progress_visible_to_guardian']);
  });
});
