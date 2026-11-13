/**
 * Enrolment tests.
 *
 * These are the tests behind the Phase 1 exit criterion: "A learner can enrol
 * via passkey, or via provisional identity plus guardian consent token; the
 * path taken is recorded in the audit log."
 *
 * Each case is written as an ATTACK on the enrolment path, not as a happy path
 * with an assertion bolted on. The happy path proves the criterion; the
 * attacks prove it is not a rubber stamp.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createConsentService } from './consent.js';
import { createIdentityService } from './identity.js';
import {
  EnrolmentRefusedError,
  PasskeyCeremonyUnavailableError,
  createEnrolmentService,
} from './enrolment.js';
import type { ConsentScope } from '@edugenesis/contracts';

/** A fixed clock, so an audit trail is reproducible. */
function fixedClock(start = Date.UTC(2026, 10, 12, 9, 0, 0)) {
  let tick = 0;
  return {
    now: (): Date => new Date(start + tick++ * 1000),
    advance(ms: number): void {
      tick += Math.ceil(ms / 1000);
    },
  };
}

interface Harness {
  enrolment: ReturnType<typeof createEnrolmentService>;
  identity: ReturnType<typeof createIdentityService>;
  consent: ReturnType<typeof createConsentService>;
  clock: ReturnType<typeof fixedClock>;
}

function harness(): Harness {
  const clock = fixedClock();
  const identity = createIdentityService();
  const consent = createConsentService({ now: () => clock.now() });
  const enrolment = createEnrolmentService({
    identity,
    consent,
    now: () => clock.now(),
  });
  return { enrolment, identity, consent, clock };
}

/** A registered guardian. */
function addGuardian(h: Harness, guardianId = 'guardian-1'): void {
  h.identity.register({ id: guardianId, roles: ['guardian'] });
}

test('enrolment: a learner enrols provisionally on a guardian consent token', async () => {
  const h = harness();
  addGuardian(h);
  const issued = h.enrolment.issueGuardianConsentToken({
    guardianId: 'guardian-1',
    learnerId: 'learner-1',
    scopes: ['progress_visible_to_guardian'],
  });

  const result = await h.enrolment.enrolWithGuardianConsent({
    token: issued.token,
    secret: issued.secret,
  });

  assert.equal(result.method, 'guardian_consent_token');
  assert.equal(result.provisional, true);
  assert.equal(result.principal.id, 'learner-1');
  assert.deepEqual(result.principal.roles, ['learner']);
  assert.equal(result.principal.attributes['guardianConsent'], true);
  assert.equal(result.principal.attributes['enrolmentStatus'], 'provisional');
  assert.equal(h.enrolment.isProvisional('learner-1'), true);
});

test('enrolment: the path taken is recorded in the audit log', async () => {
  const h = harness();
  addGuardian(h);
  const issued = h.enrolment.issueGuardianConsentToken({
    guardianId: 'guardian-1',
    learnerId: 'learner-1',
    scopes: ['progress_visible_to_guardian'],
  });

  await h.enrolment.enrolWithGuardianConsent({ token: issued.token, secret: issued.secret });

  const trail = h.enrolment.auditTrail('learner-1');
  assert.equal(trail.length, 1);
  const entry = trail[0];
  assert.equal(entry?.method, 'guardian_consent_token');
  assert.equal(entry?.outcome, 'enrolled');
  assert.equal(entry?.provisional, true);
  assert.equal(entry?.subjectId, 'learner-1');
  assert.equal(entry?.guardianId, 'guardian-1');
  assert.equal(entry?.consentTokenId, issued.token.tokenId);
  assert.ok((entry?.at ?? '').length > 0, 'the audit entry must be timestamped');
});

test('enrolment: the guardian consent unlocks exactly the scopes the token names', async () => {
  const h = harness();
  addGuardian(h);
  const scopes: ConsentScope[] = ['progress_visible_to_guardian', 'mentor_contact'];
  const issued = h.enrolment.issueGuardianConsentToken({
    guardianId: 'guardian-1',
    learnerId: 'learner-1',
    scopes,
  });

  const result = await h.enrolment.enrolWithGuardianConsent({
    token: issued.token,
    secret: issued.secret,
  });

  assert.deepEqual([...result.grantedScopes].sort(), [...scopes].sort());
  assert.equal(h.consent.mayShare('learner-1', 'progress_visible_to_guardian'), true);
  assert.equal(h.consent.mayShare('learner-1', 'mentor_contact'), true);
  // A scope the guardian did NOT authorise stays ungranted.
  assert.equal(h.consent.mayShare('learner-1', 'work_visible_to_employers'), false);
});

test('enrolment: the guardian is linked to the learner they consented for', async () => {
  const h = harness();
  addGuardian(h);
  const issued = h.enrolment.issueGuardianConsentToken({
    guardianId: 'guardian-1',
    learnerId: 'learner-1',
    scopes: [],
  });

  await h.enrolment.enrolWithGuardianConsent({ token: issued.token, secret: issued.secret });

  const guardian = h.identity.get('guardian-1');
  assert.equal(
    guardian?.attributes['linkedLearnerIds'],
    JSON.stringify(['learner-1']),
    'the guardian is linked to the learner as a JSON list attribute',
  );
});

test('enrolment: a wrong secret is refused and the refusal is recorded', async () => {
  const h = harness();
  addGuardian(h);
  const issued = h.enrolment.issueGuardianConsentToken({
    guardianId: 'guardian-1',
    learnerId: 'learner-1',
    scopes: [],
  });

  await assert.rejects(
    () => h.enrolment.enrolWithGuardianConsent({ token: issued.token, secret: 'not-the-secret' }),
    (error: unknown) => {
      assert.ok(error instanceof EnrolmentRefusedError);
      assert.equal(error.method, 'guardian_consent_token');
      assert.match(error.reason, /credential did not verify/i);
      return true;
    },
  );

  assert.equal(h.identity.get('learner-1'), undefined, 'a refused enrolment must not create a learner');
  const trail = h.enrolment.auditTrail('learner-1');
  assert.equal(trail.length, 1);
  assert.equal(trail[0]?.outcome, 'refused');
  assert.equal(trail[0]?.method, 'guardian_consent_token');
});

test('enrolment: an expired token is refused', async () => {
  const h = harness();
  addGuardian(h);
  const issued = h.enrolment.issueGuardianConsentToken({
    guardianId: 'guardian-1',
    learnerId: 'learner-1',
    scopes: [],
    ttlMs: 1_000,
  });
  h.clock.advance(60_000);

  await assert.rejects(
    () => h.enrolment.enrolWithGuardianConsent({ token: issued.token, secret: issued.secret }),
    (error: unknown) => {
      assert.ok(error instanceof EnrolmentRefusedError);
      assert.match(error.reason, /expired/i);
      return true;
    },
  );
  assert.equal(h.identity.get('learner-1'), undefined);
});

test('enrolment: a token cannot be used twice', async () => {
  const h = harness();
  addGuardian(h);
  const issued = h.enrolment.issueGuardianConsentToken({
    guardianId: 'guardian-1',
    learnerId: 'learner-1',
    scopes: [],
  });

  await h.enrolment.enrolWithGuardianConsent({ token: issued.token, secret: issued.secret });

  await assert.rejects(
    () => h.enrolment.enrolWithGuardianConsent({ token: issued.token, secret: issued.secret }),
    (error: unknown) => {
      assert.ok(error instanceof EnrolmentRefusedError);
      assert.match(error.reason, /already used/i);
      return true;
    },
  );
});

test('enrolment: a token is bound to the learner it names', async () => {
  const h = harness();
  addGuardian(h);
  const issued = h.enrolment.issueGuardianConsentToken({
    guardianId: 'guardian-1',
    learnerId: 'learner-1',
    scopes: [],
  });

  // The same token, presented for a different learner.
  const tampered = { ...issued.token, learnerId: 'learner-2' };

  await assert.rejects(
    () => h.enrolment.enrolWithGuardianConsent({ token: tampered, secret: issued.secret }),
    (error: unknown) => {
      assert.ok(error instanceof EnrolmentRefusedError);
      assert.match(error.reason, /does not match the token that was issued/i);
      return true;
    },
  );
  assert.equal(h.identity.get('learner-2'), undefined);
  assert.equal(h.identity.get('learner-1'), undefined, 'a refused enrolment must not create a learner');
});

test('enrolment: a caller cannot widen the scopes on a presented token', async () => {
  const h = harness();
  addGuardian(h);
  const issued = h.enrolment.issueGuardianConsentToken({
    guardianId: 'guardian-1',
    learnerId: 'learner-1',
    scopes: ['progress_visible_to_guardian'],
  });

  // The guardian consented to one scope. The caller edits the token it passes
  // in to claim every scope.
  const widenedScopes: ConsentScope[] = [
    'progress_visible_to_guardian',
    'sponsor_aggregate_reporting',
  ];
  const widened = { ...issued.token, scopes: widenedScopes };

  await assert.rejects(
    () => h.enrolment.enrolWithGuardianConsent({ token: widened, secret: issued.secret }),
    (error: unknown) => {
      assert.ok(error instanceof EnrolmentRefusedError);
      assert.match(error.reason, /does not match the token that was issued/i);
      return true;
    },
  );
  assert.equal(h.consent.mayShare('learner-1', 'sponsor_aggregate_reporting'), false);
});

test('enrolment: a token this service never issued is refused', async () => {
  const h = harness();
  addGuardian(h);
  const issued = h.enrolment.issueGuardianConsentToken({
    guardianId: 'guardian-1',
    learnerId: 'learner-1',
    scopes: [],
  });
  const forged = { ...issued.token, tokenId: 'not-a-real-token-id' };

  await assert.rejects(
    () => h.enrolment.enrolWithGuardianConsent({ token: forged, secret: issued.secret }),
    (error: unknown) => {
      assert.ok(error instanceof EnrolmentRefusedError);
      assert.match(error.reason, /not issued by this service/i);
      return true;
    },
  );
});

test('enrolment: the passkey path refuses, names the deferred ceremony, and records the attempt', () => {
  const h = harness();

  assert.throws(
    () => h.enrolment.enrolWithPasskey({ learnerId: 'learner-9' }),
    (error: unknown) => {
      assert.ok(error instanceof PasskeyCeremonyUnavailableError);
      assert.match(error.message, /D-05/i);
      return true;
    },
  );

  const trail = h.enrolment.auditTrail('learner-9');
  assert.equal(trail.length, 1);
  assert.equal(trail[0]?.method, 'passkey');
  assert.equal(trail[0]?.outcome, 'refused');
});

test('enrolment: the audit trail never carries a name, an email or a number', async () => {
  const h = harness();
  addGuardian(h);
  const issued = h.enrolment.issueGuardianConsentToken({
    guardianId: 'guardian-1',
    learnerId: 'learner-1',
    scopes: ['progress_visible_to_guardian'],
  });
  await h.enrolment.enrolWithGuardianConsent({ token: issued.token, secret: issued.secret });

  const serialised = JSON.stringify(h.enrolment.auditTrail());
  assert.doesNotMatch(serialised, /@/, 'the audit trail must not carry an email address');
  assert.doesNotMatch(serialised, /\+\d/, 'the audit trail must not carry a telephone number');
  assert.ok(
    !serialised.includes(issued.secret),
    'the audit trail must not carry the token secret',
  );
});

test('enrolment: a provisional learner may still learn, whatever their consent state', async () => {
  const h = harness();
  addGuardian(h);
  const issued = h.enrolment.issueGuardianConsentToken({
    guardianId: 'guardian-1',
    learnerId: 'learner-1',
    scopes: ['progress_visible_to_guardian'],
  });
  await h.enrolment.enrolWithGuardianConsent({ token: issued.token, secret: issued.secret });

  // Withdrawing every sharing scope must not reach core learning.
  h.consent.withdraw('learner-1', 'progress_visible_to_guardian');

  assert.equal(h.consent.mayShare('learner-1', 'progress_visible_to_guardian'), false);
  assert.equal(h.consent.mayLearn('learner-1'), true, 'a provisional learner may still learn');
});
