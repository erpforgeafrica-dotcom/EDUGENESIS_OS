/**
 * RBAC + ABAC policy engine — behaviour tests.
 *
 * Authority: Doc 16 §7 (the Sponsor Firewall), Doc 1 v1.2 (least privilege,
 * safeguarding), Doc 2 §4.2.
 *
 * Review rubric C11: every assertion below is a behavioural contract that must
 * fail if the behaviour regresses.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DEFAULT_POLICY_BUNDLE, createPolicyEngine, matchesScope, readStringList } from './policy.js';
import type { Principal, Role } from '@edugenesis/contracts';

function principal(roles: Role[], attributes: Record<string, string | number | boolean> = {}): Principal {
  return { id: 'subject-1', roles, attributes };
}

const engine = createPolicyEngine([DEFAULT_POLICY_BUNDLE]);

describe('policy scope matching', () => {
  test('an exact scope matches only that action', () => {
    assert.equal(matchesScope('audit.export', 'audit.export'), true);
    assert.equal(matchesScope('audit.export', 'audit.export.write'), false);
    assert.equal(matchesScope('audit.export', 'audit.read'), false);
  });

  test('a trailing star covers a whole namespace', () => {
    assert.equal(matchesScope('learner.dashboard.*', 'learner.dashboard.read'), true);
    assert.equal(matchesScope('learner.dashboard.*', 'learner.dashboard.write'), true);
    assert.equal(matchesScope('learner.dashboard.*', 'learner.work.read'), false);
  });

  test('a star matches one or more segments, so it can span a whole surface', () => {
    // "*.write" must reach reporting.aggregate.write, not only audit.write.
    assert.equal(matchesScope('*.write', 'audit.write'), true);
    assert.equal(matchesScope('*.write', 'reporting.aggregate.write'), true);
    assert.equal(matchesScope('*.write', 'reporting.aggregate.read'), false);
  });
});

describe('policy attribute helpers', () => {
  test('a list attribute is read from JSON or from a comma separated string', () => {
    assert.deepEqual(readStringList('["a","b"]'), ['a', 'b']);
    assert.deepEqual(readStringList('a, b'), ['a', 'b']);
  });

  test('an unreadable list attribute yields an empty list, never a wildcard', () => {
    // A malformed attribute must not be treated as "contains everything".
    assert.deepEqual(readStringList(undefined), []);
    assert.deepEqual(readStringList('["a"'), []);      // broken JSON array
    assert.deepEqual(readStringList('{"not":"an array"}'), []);
    assert.deepEqual(readStringList(42), []);
    // A plain string is the comma-separated form, so it is one entry.
    assert.deepEqual(readStringList('not json'), ['not json']);
  });
});

describe('policy engine', () => {
  test('a sponsor may read aggregate reporting', () => {
    const decision = engine.evaluate(principal(['sponsor']), 'reporting.aggregate.read');

    assert.equal(decision.allowed, true);
    assert.equal(decision.matchedRule, 'sponsor.aggregate.read');
  });

  test('a sponsor is denied a learner-level dashboard', () => {
    // Doc 16 §7 — the Sponsor Firewall: a sponsor sees aggregates, never a
    // learner-level dashboard.
    const decision = engine.evaluate(principal(['sponsor']), 'learner.dashboard.read', 'subject-1');

    assert.equal(decision.allowed, false);
    assert.equal(decision.matchedRule, 'sponsor.firewall.learner_dashboard');
  });

  test('a sponsor is denied a learner dashboard even for an unmentioned learner', () => {
    const decision = engine.evaluate(principal(['sponsor']), 'learner.dashboard.read');

    assert.equal(decision.allowed, false);
  });

  test('deny beats allow: a broad allow cannot re-permit a denied action', () => {
    // The rule that must never be weakened: an explicit deny outranks a wider
    // allow, regardless of the order the rules are declared in.
    const strict = createPolicyEngine([
      {
        name: 'conflict',
        rules: [
          { id: 'broad.allow', effect: 'allow', roles: ['admin'], scope: '*' },
          { id: 'narrow.deny', effect: 'deny', roles: ['admin'], scope: 'learner.dashboard.*' },
        ],
      },
    ]);

    const decision = strict.evaluate(principal(['admin']), 'learner.dashboard.read');

    assert.equal(decision.allowed, false);
    assert.equal(decision.matchedRule, 'narrow.deny');
  });

  test('deny beats allow even when the allow is declared after the deny', () => {
    const strict = createPolicyEngine([
      {
        name: 'conflict-reordered',
        rules: [
          { id: 'narrow.deny', effect: 'deny', roles: ['admin'], scope: 'learner.dashboard.*' },
          { id: 'broad.allow', effect: 'allow', roles: ['admin'], scope: '*' },
        ],
      },
    ]);

    const decision = strict.evaluate(principal(['admin']), 'learner.dashboard.read');

    assert.equal(decision.allowed, false);
    assert.equal(decision.matchedRule, 'narrow.deny');
  });

  test('a rule whose ABAC condition fails does not match at all', () => {
    const conditional = createPolicyEngine([
      {
        name: 'conditional',
        rules: [
          {
            id: 'conditional.allow',
            effect: 'allow',
            roles: ['mentor'],
            scope: 'mentor.cohort.read',
            conditions: (p, resource) => resource === p.attributes['assignedCohort'],
          },
        ],
      },
    ]);

    const mentor = principal(['mentor'], { assignedCohort: 'cohort-a' });

    assert.equal(conditional.evaluate(mentor, 'mentor.cohort.read', 'cohort-a').allowed, true);
    // A failing condition must not be treated as a pass.
    assert.equal(conditional.evaluate(mentor, 'mentor.cohort.read', 'cohort-b').allowed, false);
  });

  test('an unmatched action is denied by default', () => {
    const decision = engine.evaluate(principal(['learner']), 'admin.roles.assign');

    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /default deny/i);
  });

  test('a principal with no matching role is denied', () => {
    const decision = engine.evaluate(principal(['learner']), 'audit.export');

    assert.equal(decision.allowed, false);
  });
});

describe('default bundle — sponsor firewall (Doc 16 §7)', () => {
  test('a sponsor may export aggregate reporting when a region scope exists', () => {
    const sponsor = principal(['sponsor'], { region: 'ke' });

    const decision = engine.evaluate(sponsor, 'reporting.aggregate.export');

    assert.equal(decision.allowed, true);
  });

  test('a sponsor without a region scope cannot export aggregate reporting', () => {
    // ABAC: the reporting boundary is regional, not merely role-based.
    const decision = engine.evaluate(principal(['sponsor']), 'reporting.aggregate.export');

    assert.equal(decision.allowed, false);
  });

  test('a sponsor is denied learner work and safeguarding data', () => {
    const sponsor = principal(['sponsor'], { region: 'ke' });

    assert.equal(engine.evaluate(sponsor, 'learner.work.read', 'subject-1').allowed, false);
    assert.equal(engine.evaluate(sponsor, 'safeguarding.incident.read').allowed, false);
  });
});

describe('default bundle — mentor', () => {
  const mentor = principal(['mentor'], { assignedCohorts: '["cohort-a","cohort-b"]' });

  test('a mentor may view an assigned cohort', () => {
    const decision = engine.evaluate(mentor, 'mentor.cohort.read', 'cohort-a');

    assert.equal(decision.allowed, true);
  });

  test('a mentor may not view a cohort they are not assigned to', () => {
    const decision = engine.evaluate(mentor, 'mentor.cohort.read', 'cohort-z');

    assert.equal(decision.allowed, false);
  });

  test('a mentor request without a named cohort is refused', () => {
    // "May view ASSIGNED cohorts" cannot be satisfied by an unnamed cohort.
    const decision = engine.evaluate(mentor, 'mentor.cohort.read');

    assert.equal(decision.allowed, false);
  });

  test('a mentor is denied a learner-level dashboard', () => {
    const decision = engine.evaluate(mentor, 'learner.dashboard.read', 'subject-1');

    assert.equal(decision.allowed, false);
  });
});

describe('default bundle — learner', () => {
  const learner = principal(['learner']);

  test('a learner may read and write their own work', () => {
    assert.equal(engine.evaluate(learner, 'learner.work.read', learner.id).allowed, true);
    assert.equal(engine.evaluate(learner, 'learner.work.write', learner.id).allowed, true);
  });

  test('a learner may not read or write another learner’s work', () => {
    assert.equal(engine.evaluate(learner, 'learner.work.read', 'other-subject').allowed, false);
    assert.equal(engine.evaluate(learner, 'learner.work.write', 'other-subject').allowed, false);
  });

  test('a learner may not read another learner’s dashboard', () => {
    assert.equal(engine.evaluate(learner, 'learner.dashboard.read', 'other-subject').allowed, false);
  });
});

describe('default bundle — auditor', () => {
  const auditor = principal(['auditor']);

  test('an auditor may export', () => {
    const decision = engine.evaluate(auditor, 'audit.export');

    assert.equal(decision.allowed, true);
    assert.equal(decision.matchedRule, 'auditor.export');
  });

  test('an auditor may read aggregate reporting', () => {
    assert.equal(engine.evaluate(auditor, 'reporting.aggregate.read').allowed, true);
  });

  test('an auditor is read-only: every write action is denied', () => {
    assert.equal(engine.evaluate(auditor, 'audit.write').allowed, false);
    assert.equal(engine.evaluate(auditor, 'learner.work.write', 'subject-1').allowed, false);
    assert.equal(engine.evaluate(auditor, 'reporting.aggregate.write').allowed, false);
  });

  test('an auditor is export-only: learner-level data is denied', () => {
    assert.equal(engine.evaluate(auditor, 'learner.dashboard.read', 'subject-1').allowed, false);
    assert.equal(engine.evaluate(auditor, 'learner.work.read', 'subject-1').allowed, false);
  });
});

describe('default bundle — safeguarding separation of duties', () => {
  test('an admin may not read safeguarding incident details', () => {
    const decision = engine.evaluate(principal(['admin']), 'safeguarding.incident.read');

    assert.equal(decision.allowed, false);
    assert.equal(decision.matchedRule, 'admin.firewall.safeguarding');
  });

  test('the safeguarding lead may read and write incident details', () => {
    const lead = principal(['safeguarding_lead']);

    assert.equal(engine.evaluate(lead, 'safeguarding.incident.read').allowed, true);
    assert.equal(engine.evaluate(lead, 'safeguarding.incident.write').allowed, true);
  });

  test('an admin may read the case log but not the incident details', () => {
    const admin = principal(['admin']);

    assert.equal(engine.evaluate(admin, 'safeguarding.case.read').allowed, true);
    assert.equal(engine.evaluate(admin, 'safeguarding.incident.read').allowed, false);
  });
});

describe('default bundle — guardian and volunteer ABAC', () => {
  test('a guardian with consent and a linked learner may read progress', () => {
    const guardian = principal(['guardian'], {
      guardianConsent: true,
      linkedLearnerIds: '["subject-1"]',
    });

    const decision = engine.evaluate(guardian, 'learner.progress.read', 'subject-1');

    assert.equal(decision.allowed, true);
  });

  test('a guardian without recorded consent may not read progress', () => {
    const guardian = principal(['guardian'], { linkedLearnerIds: '["subject-1"]' });

    const decision = engine.evaluate(guardian, 'learner.progress.read', 'subject-1');

    assert.equal(decision.allowed, false);
  });

  test('a guardian may not read progress for a learner they are not linked to', () => {
    const guardian = principal(['guardian'], {
      guardianConsent: true,
      linkedLearnerIds: '["subject-1"]',
    });

    const decision = engine.evaluate(guardian, 'learner.progress.read', 'other-subject');

    assert.equal(decision.allowed, false);
  });

  test('a volunteer must be an adult or 16_17 to hold a support role', () => {
    const adultVolunteer: Principal = { id: 'v1', roles: ['volunteer'], attributes: {}, ageBand: 'adult' };
    const minorVolunteer: Principal = { id: 'v2', roles: ['volunteer'], attributes: {}, ageBand: '13_15' };

    assert.equal(engine.evaluate(adultVolunteer, 'volunteer.learner.support').allowed, true);
    assert.equal(engine.evaluate(minorVolunteer, 'volunteer.learner.support').allowed, false);
  });
});
