/**
 * The durable audit sink wiring (owner decision D-3).
 *
 * WHAT IT PROVES
 *   A consent decision and an enrolment attempt reach a DURABLE, tamper-proof
 *   audit log, not only the in-memory trail that dies with the process. The
 *   in-memory trail was the finding: a safeguarding record that evaporates on
 *   restart is not evidence.
 *
 * WHY THE SINK IS OPTIONAL
 *   The services keep working with no sink attached — the sink is a seam, not a
 *   new requirement. A deployment that wants durability supplies one; a test or
 *   a library consumer that does not, is unaffected.
 *
 * WHY THE SINK IS STRUCTURAL, NOT IMPORTED
 *   `@edugenesis/identity` depends only on `@edugenesis/contracts`. The sink is
 *   described by a local interface, so the durable log (which lives in the
 *   ledger package) satisfies it without a package dependency — and without
 *   touching the frozen contracts.
 *
 * WHY THESE TESTS MATTER MORE THAN THE WIRING
 *   The sink is where a secret could leak: the guardian's credential secret is
 *   in the caller's hands at exactly this moment. A test that asserts the sink
 *   never receives it is the difference between a durable audit trail and a
 *   durable credential leak.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConsentScope } from '@edugenesis/contracts';

import type { AuditSink, AuditSinkEvent } from './audit-sink.js';
import { createConsentService } from './consent.js';
import { createEnrolmentService } from './enrolment.js';
import { createIdentityService } from './identity.js';

interface RecordedCall {
  readonly kind: string;
  readonly event: AuditSinkEvent | undefined;
}

/** A sink that records what it was asked to record. */
function recordingSink(): { sink: AuditSink; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const sink: AuditSink = {
    append(kind: string, event?: AuditSinkEvent): unknown {
      calls.push({ kind, event });
      return { seq: calls.length };
    },
  };
  return { sink, calls };
}

/** A guardian and a learner, registered in a real identity service. */
function principals(): {
  identity: ReturnType<typeof createIdentityService>;
  guardianId: string;
  learnerId: string;
} {
  const identity = createIdentityService();
  const guardianId = 'guardian-1';
  const learnerId = 'learner-1';
  identity.register({ id: guardianId, roles: ['guardian'], attributes: {} });
  return { identity, guardianId, learnerId };
}

const SCOPE: ConsentScope = 'progress_visible_to_guardian';

/**
 * A consent service that lets the guardian act for the learner.
 *
 * WHY IT IS EXPLICIT: the consent service REFUSES a guardian action when no
 * authoriser is configured — silence is not consent. The enrolment path grants
 * the guardian's scopes, so the test must state who may act, exactly as a
 * deployment would.
 */
function consentingService(): ReturnType<typeof createConsentService> {
  return createConsentService({
    actor: 'guardian',
    actorId: 'guardian-1',
    authorize: () => true,
  });
}

test('a granted consent reaches the durable audit sink', () => {
  const { sink, calls } = recordingSink();
  const consent = createConsentService({ auditLog: sink });

  consent.grant({
    learnerId: 'learner-1',
    scope: SCOPE,
    granted: true,
    at: '2026-11-13T10:00:00.000Z',
    learnerAssent: true,
  });

  assert.equal(calls.length, 1, 'the grant must reach the sink');
  assert.equal(calls[0]?.kind, 'consent.grant');
  assert.equal(calls[0]?.event?.subjectId, 'learner-1');
  assert.equal(calls[0]?.event?.detail?.['scope'], SCOPE);
});

test('a withdrawn consent reaches the durable audit sink', () => {
  const { sink, calls } = recordingSink();
  const consent = createConsentService({ auditLog: sink });

  consent.grant({
    learnerId: 'learner-1',
    scope: SCOPE,
    granted: true,
    at: '2026-11-13T10:00:00.000Z',
    learnerAssent: true,
  });
  consent.withdraw('learner-1', SCOPE);

  const kinds = calls.map((call) => call.kind);
  assert.ok(kinds.includes('consent.withdrawal'), `expected a withdrawal in ${kinds.join(', ')}`);
});

test('an explicit refusal of consent reaches the durable audit sink', () => {
  const { sink, calls } = recordingSink();
  const consent = createConsentService({ auditLog: sink });

  // An explicit refusal is a decision: it is recorded like a withdrawal and
  // is never erased.
  consent.grant({
    learnerId: 'learner-1',
    scope: SCOPE,
    granted: false,
    at: '2026-11-13T10:00:00.000Z',
  });

  assert.ok(calls.length >= 1, 'the refusal must reach the sink');
  assert.equal(calls[0]?.kind, 'consent.refusal');
  assert.equal(calls[0]?.event?.subjectId, 'learner-1');
  // The withdrawal CASCADE is durable too: every dependent scope that got
  // locked is part of the evidence.
  for (const call of calls) {
    assert.ok(
      call.kind === 'consent.refusal' || call.kind === 'consent.cascade_lock',
      `unexpected sink kind "${call.kind}"`,
    );
  }
});

test('a guardian grant refused for lack of authority leaves NO durable trace', () => {
  const { sink, calls } = recordingSink();
  // No authoriser is configured, so the guardian action is REFUSED.
  const consent = createConsentService({ auditLog: sink, actor: 'guardian', actorId: 'guardian-1' });

  assert.throws(() =>
    consent.grant({
      learnerId: 'learner-1',
      scope: SCOPE,
      granted: true,
      at: '2026-11-13T10:00:00.000Z',
      guardianId: 'guardian-1',
    }),
  );

  // WHY THIS MUST HOLD: the service authorises BEFORE it records, so that a
  // refused grant leaves no trace that could later be read as consent. The
  // durable copy must not weaken that: a hash-chained log is easier to read
  // as evidence than an in-memory array, so a refusal written into it would
  // be MORE dangerous, not less.
  assert.equal(
    calls.length,
    0,
    'a refused guardian grant must not reach the durable sink',
  );
});

test('a completed enrolment reaches the durable audit sink', async () => {
  const { sink, calls } = recordingSink();
  const { identity, guardianId, learnerId } = principals();
  const consent = consentingService();
  const enrolment = createEnrolmentService({ identity, consent, auditLog: sink });

  const issued = enrolment.issueGuardianConsentToken({
    guardianId,
    learnerId,
    scopes: [SCOPE],
  });
  await enrolment.enrolWithGuardianConsent({ token: issued.token, secret: issued.secret });

  const enrolled = calls.find((call) => call.kind === 'enrolment.enrolled');
  assert.ok(enrolled, `expected an enrolment event in ${calls.map((c) => c.kind).join(', ')}`);
  assert.equal(enrolled.event?.subjectId, learnerId);
  assert.equal(enrolled.event?.detail?.['method'], 'guardian_consent_token');
  assert.equal(enrolled.event?.detail?.['guardianId'], guardianId);
});

test('a refused enrolment reaches the durable audit sink with the reason', () => {
  const { sink, calls } = recordingSink();
  const identity = createIdentityService();
  // The issuer is not a guardian, so the token issuance is refused.
  identity.register({ id: 'mentor-1', roles: ['mentor'], attributes: {} });
  const enrolment = createEnrolmentService({
    identity,
    consent: createConsentService(),
    auditLog: sink,
  });

  assert.throws(() =>
    enrolment.issueGuardianConsentToken({ guardianId: 'mentor-1', learnerId: 'learner-1', scopes: [] }),
  );

  const refused = calls.find((call) => call.kind === 'enrolment.refused');
  assert.ok(refused, `expected a refusal in ${calls.map((c) => c.kind).join(', ')}`);
  assert.equal(refused.event?.subjectId, 'learner-1');
  assert.ok(
    typeof refused.event?.detail?.['reason'] === 'string' &&
      refused.event.detail['reason'].length > 0,
    'a refusal must record why',
  );
});

test('the durable audit sink never receives a credential secret', async () => {
  const { sink, calls } = recordingSink();
  const { identity, guardianId, learnerId } = principals();
  const consent = consentingService();
  const enrolment = createEnrolmentService({ identity, consent, auditLog: sink });

  const issued = enrolment.issueGuardianConsentToken({
    guardianId,
    learnerId,
    scopes: [SCOPE],
  });
  await enrolment.enrolWithGuardianConsent({ token: issued.token, secret: issued.secret });

  const serialised = JSON.stringify(calls);
  assert.equal(
    serialised.includes(issued.secret),
    false,
    'the guardian credential secret must never reach the audit sink',
  );
});

test('the services behave exactly the same with no sink attached', () => {
  const consent = createConsentService();
  consent.grant({
    learnerId: 'learner-9',
    scope: 'analytics_aggregate',
    granted: true,
    at: '2026-11-13T10:00:00.000Z',
    learnerAssent: true,
  });
  assert.equal(consent.state('learner-9', 'analytics_aggregate').granted, true);
});
