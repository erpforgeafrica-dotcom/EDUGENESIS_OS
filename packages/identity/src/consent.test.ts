/**
 * Consent service — behaviour tests.
 *
 * Authority: Doc 2 §4.2; Doc 7 Phase 1; review rubric C7.
 *
 * PHASE 1 EXIT CRITERION (the assertion this whole file exists to protect):
 *   "a consent withdrawal locks sharing surfaces but not core learning."
 *
 * Every withdrawal test below ends with the same question — did the learner
 * keep the ability to LEARN? If a change ever makes `mayLearn` depend on the
 * consent state, these tests fail. That is the point.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CONSENT_DEPENDENCIES,
  CONSENT_SCOPES,
  ConsentRefusedError,
  createConsentService,
} from './consent.js';
import type { ConsentScope } from '@edugenesis/contracts';

const LEARNER = 'learner-1';

function at(iso: string): () => Date {
  return () => new Date(iso);
}

describe('consent dependency graph', () => {
  test('mentor_contact depends on progress_visible_to_guardian', () => {
    assert.deepEqual(CONSENT_DEPENDENCIES.mentor_contact, ['progress_visible_to_guardian']);
  });

  test('the dependency graph is acyclic', () => {
    // A cycle would make the lock cascade unbounded, so it is a hard error.
    for (const scope of CONSENT_SCOPES) {
      const seen = new Set<ConsentScope>();
      const stack = [...CONSENT_DEPENDENCIES[scope]];
      while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined) break;
        assert.ok(!seen.has(current), `cycle detected at ${scope} -> ${current}`);
        seen.add(current);
        stack.push(...CONSENT_DEPENDENCIES[current]);
      }
    }
  });

  test('every dependency names a known scope', () => {
    for (const scope of CONSENT_SCOPES) {
      for (const dependency of CONSENT_DEPENDENCIES[scope]) {
        assert.ok(CONSENT_SCOPES.includes(dependency), `unknown dependency ${dependency}`);
      }
    }
  });
});

describe('consent grants and withdrawals', () => {
  test('a grant records the scope with history', () => {
    const service = createConsentService({
      now: at('2026-01-01T00:00:00.000Z'),
      authorize: () => true,
    });

    const record = service.grant({
      learnerId: LEARNER,
      scope: 'progress_visible_to_guardian',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
      guardianId: 'guardian-1',
    });

    assert.equal(record.granted, true);
    assert.equal(record.scope, 'progress_visible_to_guardian');
    assert.equal(record.history.length, 1);
    assert.equal(record.history[0]?.granted, true);
    assert.equal(record.history[0]?.actor, 'guardian');
    assert.equal(service.mayShare(LEARNER, 'progress_visible_to_guardian'), true);
  });

  test('a withdrawal makes mayShare false for that scope', () => {
    const service = createConsentService({ now: at('2026-01-01T00:00:00.000Z') });
    service.grant({
      learnerId: LEARNER,
      scope: 'progress_visible_to_guardian',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });

    service.withdraw(LEARNER, 'progress_visible_to_guardian');

    assert.equal(service.mayShare(LEARNER, 'progress_visible_to_guardian'), false);
  });

  test('a withdrawal locks every dependent scope', () => {
    const service = createConsentService({ now: at('2026-01-01T00:00:00.000Z') });
    service.grant({
      learnerId: LEARNER,
      scope: 'progress_visible_to_guardian',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });
    service.grant({
      learnerId: LEARNER,
      scope: 'mentor_contact',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(service.mayShare(LEARNER, 'mentor_contact'), true);

    service.withdraw(LEARNER, 'progress_visible_to_guardian');

    // The dependent surface is locked by the cascade, not only by the caller.
    assert.equal(service.mayShare(LEARNER, 'mentor_contact'), false);
    // And the lock is materialised, not merely implied by the graph.
    assert.equal(service.state(LEARNER, 'mentor_contact').granted, false);
  });

  test('the cascade is transitive', () => {
    const service = createConsentService({ now: at('2026-01-01T00:00:00.000Z') });
    // sponsor_aggregate_reporting -> analytics_aggregate
    service.grant({
      learnerId: LEARNER,
      scope: 'analytics_aggregate',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });
    service.grant({
      learnerId: LEARNER,
      scope: 'sponsor_aggregate_reporting',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });

    service.withdraw(LEARNER, 'analytics_aggregate');

    assert.equal(service.mayShare(LEARNER, 'sponsor_aggregate_reporting'), false);
  });

  test('withdrawing a dependent scope does not lock its dependency', () => {
    const service = createConsentService({ now: at('2026-01-01T00:00:00.000Z') });
    service.grant({
      learnerId: LEARNER,
      scope: 'progress_visible_to_guardian',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });
    service.grant({
      learnerId: LEARNER,
      scope: 'mentor_contact',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });

    service.withdraw(LEARNER, 'mentor_contact');

    assert.equal(service.mayShare(LEARNER, 'mentor_contact'), false);
    assert.equal(service.mayShare(LEARNER, 'progress_visible_to_guardian'), true);
  });

  test('a scope that was never granted cannot be shared', () => {
    const service = createConsentService();

    assert.equal(service.mayShare(LEARNER, 'analytics_aggregate'), false);
  });

  test('a dependent scope cannot be shared while its dependency is ungranted', () => {
    const service = createConsentService({ now: at('2026-01-01T00:00:00.000Z') });
    // mentor_contact is granted, but progress_visible_to_guardian never was.
    service.grant({
      learnerId: LEARNER,
      scope: 'mentor_contact',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(service.mayShare(LEARNER, 'mentor_contact'), false);
  });

  test('the withdrawal is recorded in history with the actor', () => {
    const service = createConsentService({
      actor: 'guardian',
      actorId: 'guardian-1',
      authorize: () => true,
      now: at('2026-01-02T00:00:00.000Z'),
    });
    service.grant({
      learnerId: LEARNER,
      scope: 'progress_visible_to_guardian',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
      guardianId: 'guardian-1',
    });

    const withdrawn = service.withdraw(LEARNER, 'progress_visible_to_guardian');

    assert.equal(withdrawn.granted, false);
    const last = withdrawn.history[withdrawn.history.length - 1];
    assert.ok(last);
    assert.equal(last.granted, false);
    assert.equal(last.actor, 'guardian');
    assert.equal(last.at, '2026-01-02T00:00:00.000Z');
  });

  test('history is never erased: a re-grant keeps the earlier withdrawal', () => {
    const service = createConsentService({ now: at('2026-01-01T00:00:00.000Z') });
    service.grant({
      learnerId: LEARNER,
      scope: 'progress_visible_to_guardian',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });
    service.withdraw(LEARNER, 'progress_visible_to_guardian');
    service.grant({
      learnerId: LEARNER,
      scope: 'progress_visible_to_guardian',
      granted: true,
      at: '2026-01-03T00:00:00.000Z',
    });

    const record = service.state(LEARNER, 'progress_visible_to_guardian');

    assert.equal(record.granted, true);
    assert.equal(record.history.length, 3);
    assert.deepEqual(
      record.history.map((entry) => entry.granted),
      [true, false, true],
    );
  });

  test('the cascade is recorded in the dependent scope’s history as a system event', () => {
    const service = createConsentService({ now: at('2026-01-01T00:00:00.000Z') });
    service.grant({
      learnerId: LEARNER,
      scope: 'progress_visible_to_guardian',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });
    service.grant({
      learnerId: LEARNER,
      scope: 'mentor_contact',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });

    service.withdraw(LEARNER, 'progress_visible_to_guardian');

    const dependent = service.state(LEARNER, 'mentor_contact');
    const last = dependent.history[dependent.history.length - 1];
    assert.ok(last);
    assert.equal(last.granted, false);
    assert.equal(last.actor, 'system');
  });

  test('a withdrawal of a never-granted scope is still recorded', () => {
    const service = createConsentService({ now: at('2026-01-01T00:00:00.000Z') });

    const record = service.withdraw(LEARNER, 'memory_personalisation');

    assert.equal(record.granted, false);
    assert.equal(record.history.length, 1);
  });

  test('state of an untouched scope is granted:false with no history', () => {
    const service = createConsentService();

    const record = service.state(LEARNER, 'work_visible_to_employers');

    assert.equal(record.granted, false);
    assert.deepEqual(record.history, []);
  });
});

describe('consent — core learning is never locked (Phase 1 exit criterion)', () => {
  test('mayLearn stays true after every sharing scope is withdrawn', () => {
    // PHASE 1 EXIT CRITERION: "a consent withdrawal locks sharing surfaces but
    // not core learning." The learner keeps their lessons no matter what they
    // withdraw. This is the single most important assertion in the package.
    const service = createConsentService({ now: at('2026-01-01T00:00:00.000Z') });
    for (const scope of CONSENT_SCOPES) {
      service.grant({
        learnerId: LEARNER,
        scope,
        granted: true,
        at: '2026-01-01T00:00:00.000Z',
      });
    }

    for (const scope of CONSENT_SCOPES) {
      service.withdraw(LEARNER, scope);
    }

    assert.equal(service.mayLearn(LEARNER), true);
  });

  test('mayLearn stays true when a withdrawal cascades through the graph', () => {
    const service = createConsentService({ now: at('2026-01-01T00:00:00.000Z') });
    service.grant({
      learnerId: LEARNER,
      scope: 'progress_visible_to_guardian',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });
    service.grant({
      learnerId: LEARNER,
      scope: 'mentor_contact',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });

    service.withdraw(LEARNER, 'progress_visible_to_guardian');

    // The sharing surfaces are locked...
    assert.equal(service.mayShare(LEARNER, 'mentor_contact'), false);
    assert.equal(service.mayShare(LEARNER, 'progress_visible_to_guardian'), false);
    // ...and core learning is untouched.
    assert.equal(service.mayLearn(LEARNER), true);
  });

  test('mayLearn is true for a learner who never granted any consent', () => {
    const service = createConsentService();

    assert.equal(service.mayLearn(LEARNER), true);
  });
});

describe('consent — audit trail', () => {
  test('the audit trail records the cause of a cascade lock', () => {
    const service = createConsentService({ now: at('2026-01-01T00:00:00.000Z') });
    service.grant({
      learnerId: LEARNER,
      scope: 'progress_visible_to_guardian',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });
    service.grant({
      learnerId: LEARNER,
      scope: 'mentor_contact',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });

    service.withdraw(LEARNER, 'progress_visible_to_guardian');

    const trail = service.auditTrail(LEARNER);
    const cascade = trail.find((event) => event.event === 'cascade_lock');
    assert.ok(cascade, 'expected a cascade_lock audit event');
    assert.equal(cascade.scope, 'mentor_contact');
    assert.equal(cascade.cause, 'progress_visible_to_guardian');
    assert.equal(cascade.actor, 'system');
  });

  test('locked sharing surfaces are listed for the learner-facing UI', () => {
    const service = createConsentService({ now: at('2026-01-01T00:00:00.000Z') });
    service.grant({
      learnerId: LEARNER,
      scope: 'progress_visible_to_guardian',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });
    service.grant({
      learnerId: LEARNER,
      scope: 'mentor_contact',
      granted: true,
      at: '2026-01-01T00:00:00.000Z',
    });

    service.withdraw(LEARNER, 'progress_visible_to_guardian');

    const locked = service.lockedScopes(LEARNER);
    assert.ok(locked.includes('progress_visible_to_guardian'));
    assert.ok(locked.includes('mentor_contact'));
    assert.ok(!locked.includes('analytics_aggregate'));
  });
});

/**
 * AUTHORITY TESTS.
 *
 * The round-3 audit found the service performed no authorisation at all: any
 * caller could record a guardian grant for any learner. These tests make that
 * a refusal, and they exist so a future refactor cannot quietly restore it.
 */
describe('consent authority', () => {
  const guardianGrant = (): Parameters<ReturnType<typeof createConsentService>['grant']>[0] => ({
    learnerId: LEARNER,
    scope: 'progress_visible_to_guardian',
    granted: true,
    at: '2026-01-01T00:00:00.000Z',
    guardianId: 'guardian-1',
  });

  test('a guardian grant is refused when no authorisation policy is configured', () => {
    const service = createConsentService({ now: at('2026-01-02T00:00:00.000Z') });
    assert.throws(() => service.grant(guardianGrant()), ConsentRefusedError);
    assert.equal(service.mayShare(LEARNER, 'progress_visible_to_guardian'), false);
    assert.deepEqual(service.auditTrail(LEARNER), []);
  });

  test('a guardian grant is refused when the policy says no', () => {
    const service = createConsentService({
      now: at('2026-01-02T00:00:00.000Z'),
      authorize: () => false,
    });
    assert.throws(() => service.grant(guardianGrant()), ConsentRefusedError);
    assert.equal(service.mayShare(LEARNER, 'progress_visible_to_guardian'), false);
  });

  test('a principal that is not a guardian cannot be recorded as one', () => {
    const service = createConsentService({
      now: at('2026-01-02T00:00:00.000Z'),
      authorize: () => true,
      identity: {
        get: (id) => ({ id, roles: ['learner'], attributes: {} }),
      },
    });
    assert.throws(() => service.grant(guardianGrant()), ConsentRefusedError);
    assert.equal(service.mayShare(LEARNER, 'progress_visible_to_guardian'), false);
  });

  test('an authorised guardian grant records the acting guardian', () => {
    const seen: string[] = [];
    const service = createConsentService({
      now: at('2026-01-02T00:00:00.000Z'),
      authorize: (request) => {
        seen.push(`${request.action}:${request.guardianId}:${request.learnerId}`);
        return true;
      },
      identity: {
        get: (id) => ({ id, roles: ['guardian'], attributes: {} }),
      },
    });
    const record = service.grant(guardianGrant());
    assert.equal(record.granted, true);
    assert.equal(record.history[0]?.actor, 'guardian');
    assert.deepEqual(seen, [`grant:guardian-1:${LEARNER}`]);
  });

  test('a guardian withdrawal without actorId is refused', () => {
    const service = createConsentService({
      actor: 'guardian',
      now: at('2026-01-02T00:00:00.000Z'),
      authorize: () => true,
    });
    assert.throws(
      () => service.withdraw(LEARNER, 'progress_visible_to_guardian'),
      ConsentRefusedError,
    );
  });

  test('the recorded time is the service clock, not the claimed time', () => {
    const service = createConsentService({ now: at('2026-03-01T12:00:00.000Z') });
    service.grant({
      learnerId: LEARNER,
      scope: 'analytics_aggregate',
      granted: true,
      at: '2020-01-01T00:00:00.000Z',
    });
    const [event] = service.auditTrail(LEARNER);
    assert.ok(event);
    assert.equal(event.at, '2020-01-01T00:00:00.000Z');
    assert.equal(event.recordedAt, '2026-03-01T12:00:00.000Z');
  });
});

