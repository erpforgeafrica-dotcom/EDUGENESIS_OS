/**
 * Identity service — behaviour tests.
 *
 * Authority: Doc 2 §4.2 (identity, consent, risk), Doc 7 Phase 1.
 * ADR-0015 (node:test as the runner) and the Slice 0 decision D-05
 * (local-key identity adapter behind the WebAuthn seam).
 *
 * Every assertion here is a behavioural contract. A test that cannot fail is
 * a defect (review rubric C11), so each one names the behaviour it protects.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createIdentityService, isVerifierOnlyRecord } from './identity.js';
import type { IdentityService as IdentityServiceContract, Principal } from '@edugenesis/contracts';

/** Compile-time proof that the adapter satisfies the frozen contract. */
const _contractCheck: IdentityServiceContract = createIdentityService();

describe('identity service', () => {
  test('register creates an opaque principal id and an empty attribute set', () => {
    const service = createIdentityService();

    const principal = service.register({});

    assert.equal(typeof principal.id, 'string');
    assert.ok(principal.id.length > 0);
    // Doc 2 §4.2: the principal carries no attribute set until an assurance or
    // enrolment flow supplies one. A default empty set keeps ABAC evaluation
    // deterministic (an absent attribute is never silently invented).
    assert.deepEqual(principal.attributes, {});
    assert.deepEqual(principal.roles, []);
  });

  test('register generates distinct ids and never derives them from the input', () => {
    const service = createIdentityService();

    const first = service.register({});
    const second = service.register({});

    assert.notEqual(first.id, second.id);
    // An opaque id carries no counter, no timestamp and no name material.
    assert.doesNotMatch(first.id, /^\d+$/);
    assert.doesNotMatch(first.id, /learner|user|subject/i);
  });

  test('register honours a supplied id so upstream callers keep working', () => {
    const service = createIdentityService();

    const principal = service.register({ id: 'supplied-id', attributes: { region: 'ke' } });

    assert.equal(principal.id, 'supplied-id');
    assert.deepEqual(principal.attributes, { region: 'ke' });
    assert.equal(service.get('supplied-id')?.id, 'supplied-id');
  });

  test('a valid credential authenticates and returns the principal', async () => {
    const service = createIdentityService();
    const principal = service.register({});
    const credential = service.issueCredential(principal.id);

    const authenticated = await service.authenticate(principal.id, credential);

    assert.ok(authenticated);
    assert.equal(authenticated.id, principal.id);
  });

  test('a wrong secret returns null and never throws', async () => {
    const service = createIdentityService();
    const principal = service.register({});
    const credential = service.issueCredential(principal.id);

    const authenticated = await service.authenticate(principal.id, {
      type: 'local_key',
      credentialId: credential.credentialId,
      secret: 'not-the-secret',
    });

    assert.equal(authenticated, null);
  });

  test('a non-existent subject returns null and never throws', async () => {
    const service = createIdentityService();
    const credential = service.issueCredential(service.register({}).id);

    const authenticated = await service.authenticate('does-not-exist', credential);

    assert.equal(authenticated, null);
  });

  test('a malformed credential returns null and never throws', async () => {
    const service = createIdentityService();
    const principal = service.register({});
    service.issueCredential(principal.id);

    const malformed: unknown[] = [
      undefined,
      null,
      'secret-string',
      42,
      {},
      { type: 'local_key' },
      { type: 'webauthn', credentialId: 'c', secret: 's' },
      { type: 'local_key', credentialId: 'c' },
      { type: 'local_key', credentialId: 'c', secret: 12345 },
    ];

    for (const candidate of malformed) {
      const authenticated = await service.authenticate(principal.id, candidate);
      assert.equal(authenticated, null, `expected null for credential ${JSON.stringify(candidate)}`);
    }
  });

  test('the raw secret is never stored — only a salted verifier is', () => {
    const service = createIdentityService();
    const principal = service.register({});
    const credential = service.issueCredential(principal.id, 'correct-horse-battery-staple');

    const records = service.credentials(principal.id);

    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record);

    // The stored record must carry a verifier and a salt — never the secret.
    const serialised = JSON.stringify(record);
    assert.ok(!serialised.includes('correct-horse-battery-staple'));
    assert.ok(!('secret' in record));
    assert.ok(!serialised.includes(credential.secret));
    assert.equal(record.algorithm, 'scrypt');
    assert.match(record.salt, /^[0-9a-f]{32}$/);
    assert.match(record.verifier, /^[0-9a-f]{64}$/);
    // The verifier is a digest, not the secret in another encoding.
    assert.notEqual(record.verifier, credential.secret);
  });

  test('the stored record carries verifier material and nothing else', () => {
    const service = createIdentityService();
    const principal = service.register({});
    service.issueCredential(principal.id, 'correct-horse-battery-staple');

    const record = service.credentials(principal.id)[0];
    assert.ok(record);
    assert.equal(isVerifierOnlyRecord(record), true);

    // A record that leaked a secret would carry an extra field, and the guard
    // must reject it.
    const leaky = Object.assign({}, record, { secret: 'correct-horse-battery-staple' });
    assert.equal(isVerifierOnlyRecord(leaky), false);
  });

  test('each issued credential gets its own salt, so verifiers are not comparable', async () => {
    const service = createIdentityService();
    const principal = service.register({});
    const first = service.issueCredential(principal.id, 'same-secret');
    const second = service.issueCredential(principal.id, 'same-secret');

    const records = service.credentials(principal.id);
    assert.equal(records.length, 2);
    const [a, b] = records;
    assert.ok(a && b);
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.verifier, b.verifier);

    // Both credentials still verify: the salt is per credential, not per secret.
    assert.ok(await service.authenticate(principal.id, first));
    assert.ok(await service.authenticate(principal.id, second));
  });

  test('a credential issued for one subject does not authenticate another', async () => {
    const service = createIdentityService();
    const alice = service.register({});
    const bob = service.register({});
    const aliceCredential = service.issueCredential(alice.id);

    const authenticated = await service.authenticate(bob.id, aliceCredential);

    assert.equal(authenticated, null);
  });

  test('assignRole adds a role and get reflects it', () => {
    const service = createIdentityService();
    const principal = service.register({});

    service.assignRole(principal.id, 'mentor');

    const stored = service.get(principal.id);
    assert.ok(stored);
    assert.deepEqual(stored.roles, ['mentor']);
    // Assigning the same role twice is idempotent — role lists are a set.
    service.assignRole(principal.id, 'mentor');
    assert.deepEqual(service.get(principal.id)?.roles, ['mentor']);
  });

  test('get returns undefined for an unknown id', () => {
    const service = createIdentityService();

    assert.equal(service.get('nobody'), undefined);
  });

  test('the stored principal is not shared by reference with the caller', () => {
    const service = createIdentityService();
    const principal: Principal = service.register({ roles: ['learner'] });

    principal.roles.push('admin');

    // A caller mutating the returned object must not be able to escalate.
    assert.deepEqual(service.get(principal.id)?.roles, ['learner']);
  });
});
