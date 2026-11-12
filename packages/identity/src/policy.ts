/**
 * RBAC + ABAC policy engine.
 *
 * Authority:
 *   Doc 16 §7 — the Sponsor Firewall: a sponsor sees aggregates, never a
 *                learner-level dashboard, and never safeguarding detail.
 *   Doc 1 v1.2 — least privilege, separation of duties, safeguarding.
 *   Doc 2 §4.2 — identity and the attributes used for contextual decisions.
 *
 * DESIGN
 *   A rule is `{ effect, roles, scope, conditions? }`. A rule MATCHES a
 *   request when all of the following hold:
 *     1. the principal holds one of the rule's roles,
 *     2. the rule's `scope` pattern matches the requested action,
 *     3. every ABAC condition on the rule evaluates true.
 *   A rule whose conditions FAIL does not match at all. It neither allows nor
 *   denies — it simply does not apply. (A conditional deny that fails must not
 *   block, and a conditional allow that fails must not permit.)
 *
 *   DENY ALWAYS WINS. If any matching deny rule exists the request is denied,
 *   whatever allow rules matched as well. This is the single most important
 *   property of the bundle and it is asserted directly by the test suite.
 *
 * SCOPE GRAMMAR
 *   A scope is a dotted path of action segments, e.g. `learner.dashboard.read`.
 *   A pattern segment `*` matches one or more segments, so `*.write` covers
 *   `audit.write` and `reporting.aggregate.write` alike. Every other segment
 *   must match literally. A pattern with no `*` matches exactly one action.
 */
import type { Principal, Role } from '@edugenesis/contracts';

export type PolicyEffect = 'allow' | 'deny';

/**
 * An ABAC guard. The principal's attributes carry the context (region,
 * age band, guardian consent, cohort assignment); `resource` names the
 * instance the request is about, so "your own record" and "your assigned
 * cohort" can be expressed.
 */
export type PolicyCondition = (principal: Principal, resource?: string) => boolean;

export interface PolicyRule {
  /** Stable identifier surfaced as `matchedRule`. Defaults to `<bundle>:<scope>`. */
  readonly id?: string;
  readonly effect: PolicyEffect;
  readonly roles: readonly Role[];
  /** Action scope pattern. `*` matches one or more segments. */
  readonly scope: string;
  readonly conditions?: PolicyCondition;
}

export interface PolicyBundle {
  readonly name: string;
  readonly rules: readonly PolicyRule[];
}

export interface PolicyDecision {
  readonly allowed: boolean;
  /** Human-readable justification. Never empty — a decision without a reason is unauditable. */
  readonly reason: string;
  /** The rule that decided the outcome. */
  readonly matchedRule?: string;
}

export interface PolicyEngine {
  evaluate(principal: Principal, action: string, resource?: string): PolicyDecision;
}

/** A rule after normalisation, with a guaranteed id and bundle provenance. */
interface NormalisedRule {
  readonly id: string;
  readonly effect: PolicyEffect;
  readonly roles: readonly Role[];
  readonly scope: string;
  readonly conditions?: PolicyCondition;
}

// ---------------------------------------------------------------------------
// Scope matching
// ---------------------------------------------------------------------------

function matchSegments(
  pattern: readonly string[],
  action: readonly string[],
  patternIndex: number,
  actionIndex: number,
): boolean {
  if (patternIndex === pattern.length) return actionIndex === action.length;
  const segment = pattern[patternIndex];
  if (segment === undefined) return false;
  if (segment === '*') {
    // A star consumes one or more segments.
    for (let take = actionIndex + 1; take <= action.length; take += 1) {
      if (matchSegments(pattern, action, patternIndex + 1, take)) return true;
    }
    return false;
  }
  if (actionIndex >= action.length) return false;
  if (segment !== action[actionIndex]) return false;
  return matchSegments(pattern, action, patternIndex + 1, actionIndex + 1);
}

/**
 * Does `pattern` cover `action`?
 * `reporting.aggregate.read` matches only itself; `learner.dashboard.*`
 * covers the whole `learner.dashboard` namespace; `*.write` covers every
 * write action at any depth.
 */
export function matchesScope(pattern: string, action: string): boolean {
  return matchSegments(pattern.split('.'), action.split('.'), 0, 0);
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

/**
 * Read a list-valued attribute. Attribute values are `string | number |
 * boolean`, so a list is carried as a JSON array string or a comma-separated
 * string. Anything else yields an empty list — an unreadable attribute is
 * never treated as "contains everything".
 */
export function readStringList(value: string | number | boolean | undefined): readonly string[] {
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    // JSON form. A value that parses to anything other than an array is not a
    // list, so it yields an empty list rather than a bogus single entry.
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is string => typeof entry === 'string');
    } catch {
      return [];
    }
  }
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** True when the resource is the principal's own record (or no instance was named). */
function isOwnRecord(principal: Principal, resource?: string): boolean {
  if (resource === undefined) return true;
  return resource === principal.id;
}

/** True when the cohort named by `resource` is in the mentor's assignment. */
function isAssignedCohort(principal: Principal, resource?: string): boolean {
  if (resource === undefined) return false;
  return readStringList(principal.attributes['assignedCohorts']).includes(resource);
}

/** True when the learner named by `resource` is linked to this guardian. */
function isLinkedLearner(principal: Principal, resource?: string): boolean {
  if (resource === undefined) return false;
  return readStringList(principal.attributes['linkedLearnerIds']).includes(resource);
}

/** A sponsor must carry a region scope before it may export reporting. */
function hasRegionScope(principal: Principal): boolean {
  const region = principal.attributes['region'];
  return typeof region === 'string' && region.length > 0;
}

/** Guardians need recorded consent before any learner progress leaves the private store. */
function hasGuardianConsent(principal: Principal): boolean {
  return principal.attributes['guardianConsent'] === true;
}

/** A volunteer working with minors must themselves be an adult or a 16_17. */
function isScreenedAdult(principal: Principal): boolean {
  return principal.ageBand === 'adult' || principal.ageBand === '16_17';
}

// ---------------------------------------------------------------------------
// The default bundle
// ---------------------------------------------------------------------------

/**
 * The platform's real boundaries.
 *
 * This bundle encodes the separations the governing documents insist on:
 *   - the Sponsor Firewall (Doc 16 §7): aggregates yes, learner dashboards no;
 *   - separation of duties: an admin administers the platform, the
 *     safeguarding lead owns incident detail;
 *   - least privilege for mentors (assigned cohorts only), learners (their own
 *     work only) and auditors (read-only, export-only).
 */
export const DEFAULT_POLICY_BUNDLE: PolicyBundle = {
  name: 'edugenesis.default',
  rules: [
    // --- Sponsor: aggregates only (Doc 16 §7) --------------------------------
    {
      id: 'sponsor.aggregate.read',
      effect: 'allow',
      roles: ['sponsor'],
      scope: 'reporting.aggregate.read',
    },
    {
      id: 'sponsor.aggregate.export',
      effect: 'allow',
      roles: ['sponsor'],
      scope: 'reporting.aggregate.export',
      conditions: hasRegionScope,
    },
    {
      id: 'sponsor.firewall.learner_dashboard',
      effect: 'deny',
      roles: ['sponsor'],
      scope: 'learner.dashboard.*',
    },
    {
      id: 'sponsor.firewall.learner_work',
      effect: 'deny',
      roles: ['sponsor'],
      scope: 'learner.work.*',
    },
    {
      id: 'sponsor.firewall.safeguarding',
      effect: 'deny',
      roles: ['sponsor'],
      scope: 'safeguarding.*',
    },

    // --- Mentor: assigned cohorts only ---------------------------------------
    {
      id: 'mentor.cohort.read',
      effect: 'allow',
      roles: ['mentor'],
      scope: 'mentor.cohort.read',
      conditions: isAssignedCohort,
    },
    {
      id: 'mentor.cohort.write',
      effect: 'allow',
      roles: ['mentor'],
      scope: 'mentor.cohort.write',
      conditions: isAssignedCohort,
    },
    {
      id: 'mentor.cohort.progress',
      effect: 'allow',
      roles: ['mentor'],
      scope: 'mentor.cohort.progress.read',
      conditions: isAssignedCohort,
    },
    {
      id: 'mentor.firewall.learner_dashboard',
      effect: 'deny',
      roles: ['mentor'],
      scope: 'learner.dashboard.*',
    },

    // --- Learner: own work only ----------------------------------------------
    {
      id: 'learner.own.work_read',
      effect: 'allow',
      roles: ['learner'],
      scope: 'learner.work.read',
      conditions: isOwnRecord,
    },
    {
      id: 'learner.own.work_write',
      effect: 'allow',
      roles: ['learner'],
      scope: 'learner.work.write',
      conditions: isOwnRecord,
    },
    {
      id: 'learner.own.dashboard',
      effect: 'allow',
      roles: ['learner'],
      scope: 'learner.dashboard.read',
      conditions: isOwnRecord,
    },
    {
      id: 'learner.firewall.others',
      effect: 'deny',
      roles: ['learner'],
      scope: 'learner.others.*',
    },

    // --- Guardian: consent plus linkage --------------------------------------
    {
      id: 'guardian.progress',
      effect: 'allow',
      roles: ['guardian'],
      scope: 'learner.progress.read',
      conditions: (p, resource) => hasGuardianConsent(p) && isLinkedLearner(p, resource),
    },
    {
      id: 'guardian.firewall.safeguarding',
      effect: 'deny',
      roles: ['guardian'],
      scope: 'safeguarding.incident.*',
    },

    // --- Auditor: read-only, export-only -------------------------------------
    {
      id: 'auditor.aggregate_read',
      effect: 'allow',
      roles: ['auditor'],
      scope: 'reporting.aggregate.read',
    },
    {
      id: 'auditor.export',
      effect: 'allow',
      roles: ['auditor'],
      scope: 'audit.export',
    },
    {
      id: 'auditor.read_only',
      effect: 'deny',
      roles: ['auditor'],
      scope: '*.write',
    },
    {
      id: 'auditor.firewall.learner',
      effect: 'deny',
      roles: ['auditor'],
      scope: 'learner.*',
    },

    // --- Admin: administers, but never owns safeguarding detail --------------
    {
      id: 'admin.identity',
      effect: 'allow',
      roles: ['admin'],
      scope: 'admin.identity.read',
    },
    {
      id: 'admin.roles',
      effect: 'allow',
      roles: ['admin'],
      scope: 'admin.roles.assign',
    },
    {
      id: 'admin.safeguarding.case',
      effect: 'allow',
      roles: ['admin'],
      scope: 'safeguarding.case.read',
    },
    {
      id: 'admin.firewall.safeguarding',
      effect: 'deny',
      roles: ['admin'],
      scope: 'safeguarding.incident.*',
    },

    // --- Safeguarding lead: owns incident detail -----------------------------
    {
      id: 'safeguarding.lead.incident_read',
      effect: 'allow',
      roles: ['safeguarding_lead'],
      scope: 'safeguarding.incident.read',
    },
    {
      id: 'safeguarding.lead.incident_write',
      effect: 'allow',
      roles: ['safeguarding_lead'],
      scope: 'safeguarding.incident.write',
    },
    {
      id: 'safeguarding.lead.incident_export',
      effect: 'allow',
      roles: ['safeguarding_lead'],
      scope: 'safeguarding.incident.export',
    },

    // --- Accessibility lead: owns the accessibility profile -------------------
    {
      id: 'accessibility.lead.profile_read',
      effect: 'allow',
      roles: ['accessibility_lead'],
      scope: 'accessibility.profile.read',
    },
    {
      id: 'accessibility.lead.profile_write',
      effect: 'allow',
      roles: ['accessibility_lead'],
      scope: 'accessibility.profile.write',
    },

    // --- Volunteer: screened adults only -------------------------------------
    {
      id: 'volunteer.support',
      effect: 'allow',
      roles: ['volunteer'],
      scope: 'volunteer.learner.support',
      conditions: isScreenedAdult,
    },
  ],
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function isPolicyBundle(value: PolicyBundle | PolicyRule): value is PolicyBundle {
  return 'rules' in value;
}

function normalise(
  bundles: readonly PolicyBundle[],
): readonly NormalisedRule[] {
  const normalised: NormalisedRule[] = [];
  for (const bundle of bundles) {
    for (const rule of bundle.rules) {
      normalised.push({
        id: rule.id ?? `${bundle.name}:${rule.scope}`,
        effect: rule.effect,
        roles: [...rule.roles],
        scope: rule.scope,
        ...(rule.conditions ? { conditions: rule.conditions } : {}),
      });
    }
  }
  return normalised;
}

/**
 * Build an engine from one or more bundles.
 *
 * Accepts either named bundles (`[{ name, rules }]`) or a bare list of rules
 * (`[{ effect, roles, scope }]`), so a caller can express a one-off decision
 * without inventing a bundle name.
 */
export function createPolicyEngine(bundles: readonly PolicyBundle[]): PolicyEngine;
export function createPolicyEngine(rules: readonly PolicyRule[]): PolicyEngine;
export function createPolicyEngine(input: readonly (PolicyBundle | PolicyRule)[]): PolicyEngine {
  const source: readonly PolicyBundle[] =
    input.length > 0 && input.every(isPolicyBundle)
      ? input
      : [
          {
            name: 'inline',
            rules: input.filter((entry): entry is PolicyRule => !isPolicyBundle(entry)),
          },
        ];
  const rules = normalise(source);

  function evaluate(principal: Principal, action: string, resource?: string): PolicyDecision {
    let allowRule: NormalisedRule | undefined;

    for (const rule of rules) {
      if (!rule.roles.some((role) => principal.roles.includes(role))) continue;
      if (!matchesScope(rule.scope, action)) continue;
      if (rule.conditions && !rule.conditions(principal, resource)) continue;

      if (rule.effect === 'deny') {
        // Deny wins immediately and unconditionally.
        return {
          allowed: false,
          reason: `Denied by rule "${rule.id}" — an explicit deny outranks any allow.`,
          matchedRule: rule.id,
        };
      }
      if (!allowRule) allowRule = rule;
    }

    if (allowRule) {
      return {
        allowed: true,
        reason: `Allowed by rule "${allowRule.id}".`,
        matchedRule: allowRule.id,
      };
    }

    return {
      allowed: false,
      reason: `No rule matched action "${action}" — default deny.`,
    };
  }

  return { evaluate };
}
