/**
 * Consent service: grants, atomic withdrawal, sharing locks.
 *
 * Authority:
 *   Doc 2 §4.2 — consent, withdrawal, the sharing/learning distinction.
 *   Doc 7 Phase 1 — exit criterion: "a consent withdrawal locks sharing
 *                   surfaces but not core learning."
 *   Review rubric C7 — the dependency graph must be MODELLED, not assumed,
 *                      and `mayLearn` must not be derived from sharing state.
 *
 * THE DEPENDENCY GRAPH (modelled, exported, asserted)
 *   A dependent scope may only be shared when every scope it depends on is
 *   currently granted. The graph is:
 *
 *     progress_visible_to_guardian ──┬──> mentor_contact
 *                                     └──> work_visible_to_employers
 *     analytics_aggregate ─────────────> sponsor_aggregate_reporting
 *     memory_personalisation            (no dependency)
 *
 *   Read as: "progress visibility" is the switch that governs whether the
 *   learner's progress may leave the private store towards a mentor or an
 *   employer; "aggregate analytics" is the switch that governs whether
 *   aggregate reporting (including sponsor reporting) may be produced.
 *
 *   Withdrawing a scope therefore locks its dependents transitively, and a
 *   dependent scope stays locked while its dependency is ungranted even if
 *   the dependent scope was granted on its own.
 *
 * ATOMICITY
 *   `withdraw` performs the whole cascade — the scope and every transitive
 *   dependent — inside a single synchronous call with no `await` boundary.
 *   No caller, no observer and no concurrent task can observe a state in
 *   which the parent is withdrawn but a dependent is still shared.
 */
import type {
  ConsentGrant,
  ConsentRecord,
  ConsentScope,
  ConsentService as ConsentServiceContract,
  Principal,
} from '@edugenesis/contracts';

/** Every sharing surface the platform knows about. */
export const CONSENT_SCOPES: readonly ConsentScope[] = [
  'progress_visible_to_guardian',
  'work_visible_to_employers',
  'analytics_aggregate',
  'sponsor_aggregate_reporting',
  'mentor_contact',
  'memory_personalisation',
];

/**
 * What each scope depends on. A scope is shareable only when it and all of
 * its transitive dependencies are granted.
 */
export const CONSENT_DEPENDENCIES: Readonly<Record<ConsentScope, readonly ConsentScope[]>> = {
  progress_visible_to_guardian: [],
  work_visible_to_employers: ['progress_visible_to_guardian'],
  analytics_aggregate: [],
  sponsor_aggregate_reporting: ['analytics_aggregate'],
  mentor_contact: ['progress_visible_to_guardian'],
  memory_personalisation: [],
};

/**
 * Whether a scope is a SHARING surface or a CORE-LEARNING surface.
 *
 * Every scope in the model is a sharing surface. Core learning is deliberately
 * absent from the consent model: consent governs who may see a learner, not
 * whether the learner may learn. `mayLearn` reads this table — never the
 * learner's consent state — so no withdrawal can ever reach it.
 */
export type ConsentScopeKind = 'sharing' | 'core_learning';

export const CONSENT_SCOPE_KINDS: Readonly<Record<ConsentScope, ConsentScopeKind>> = {
  progress_visible_to_guardian: 'sharing',
  work_visible_to_employers: 'sharing',
  analytics_aggregate: 'sharing',
  sponsor_aggregate_reporting: 'sharing',
  mentor_contact: 'sharing',
  memory_personalisation: 'sharing',
};

/** An audit event. Carries no personal data beyond the opaque learner id. */
export interface ConsentAuditEvent {
  /** The time the caller CLAIMS the decision happened. */
  readonly at: string;
  /**
   * The time this service RECORDED the decision.
   *
   * WHY BOTH: `at` is supplied by the caller, so an audit trail built only from
   * it can be backdated. The decision still carries the claimed time (a
   * migration may legitimately record a past decision), but the trail also
   * carries the moment the process witnessed it, which no caller can choose.
   */
  readonly recordedAt: string;
  readonly learnerId: string;
  readonly scope: ConsentScope;
  readonly event: 'grant' | 'withdrawal' | 'refusal' | 'cascade_lock';
  readonly actor: 'learner' | 'guardian' | 'system';
  /** The scope whose withdrawal caused a cascade lock. */
  readonly cause?: ConsentScope;
  /** Recorded when the grant carried learner assent. */
  readonly learnerAssent?: boolean;
}

/** The action an authorisation decision is about. */
export type ConsentAction = 'grant' | 'withdraw';

export interface ConsentAuthorisationRequest {
  readonly action: ConsentAction;
  readonly learnerId: string;
  readonly scope: ConsentScope;
  readonly actor: 'learner' | 'guardian' | 'system';
  /** Present when a guardian is acting. */
  readonly guardianId?: string;
}

/**
 * Deployment-supplied authority check.
 *
 * WHY IT IS INJECTED: this package holds the consent STATE, not the
 * relationships between people. Whether guardian G may act for learner L is a
 * fact the identity/enrolment layer owns. The service therefore cannot invent
 * it, and must not assume it.
 */
export type ConsentAuthorizer = (request: ConsentAuthorisationRequest) => boolean;

/** A consent action that the authority rules refuse. */
export class ConsentRefusedError extends Error {
  readonly code = 'CONSENT_REFUSED';

  constructor(message: string) {
    super(message);
    this.name = 'ConsentRefusedError';
  }
}

export interface ConsentServiceOptions {
  /** Actor recorded for withdrawals. Defaults to 'learner'. */
  readonly actor?: 'learner' | 'guardian' | 'system';
  /** The acting guardian's principal id, when `actor` is 'guardian'. */
  readonly actorId?: string;
  /** Clock injection. Defaults to the system clock. */
  readonly now?: () => Date;
  /**
   * Authority check for guardian actions.
   *
   * SECURE DEFAULT: when this is absent, a GUARDIAN grant or withdrawal is
   * REFUSED. A learner acting on their own consent is still permitted — that is
   * the contract's model. A deployment that lets guardians act must say who may
   * act for whom; silence is not consent.
   */
  readonly authorize?: ConsentAuthorizer;
  /**
   * Optional principal lookup, used to refuse a guardian id that is not a
   * person at all (or is not a guardian). Supplying it turns a typo into a
   * refusal instead of a recorded grant.
   */
  readonly identity?: { get(id: string): Principal | undefined };
}

export interface ConsentService extends ConsentServiceContract {
  /** The audit trail for one learner, oldest event first. */
  auditTrail(learnerId: string): readonly ConsentAuditEvent[];
  /** Scopes the learner has a recorded decision for that are currently not shareable. */
  lockedScopes(learnerId: string): readonly ConsentScope[];
}

/** The timestamp used for a scope the learner has never decided about. */
const NEVER = '1970-01-01T00:00:00.000Z';

type HistoryEntry = ConsentRecord['history'][number];

interface ScopeState {
  granted: boolean;
  history: HistoryEntry[];
}

/** Reverse edges of the dependency graph: scope -> the scopes that depend on it. */
const DEPENDENTS: ReadonlyMap<ConsentScope, readonly ConsentScope[]> = (() => {
  const map = new Map<ConsentScope, ConsentScope[]>();
  for (const scope of CONSENT_SCOPES) map.set(scope, []);
  for (const scope of CONSENT_SCOPES) {
    for (const dependency of CONSENT_DEPENDENCIES[scope]) {
      map.get(dependency)?.push(scope);
    }
  }
  return map;
})();

/** Every scope reachable from `scope` by following dependency edges. */
function transitiveDependencies(scope: ConsentScope): readonly ConsentScope[] {
  const seen = new Set<ConsentScope>();
  const queue: ConsentScope[] = [...CONSENT_DEPENDENCIES[scope]];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...CONSENT_DEPENDENCIES[current]);
  }
  return [...seen];
}

/** Every scope that must be locked when `scope` is withdrawn. */
function transitiveDependents(scope: ConsentScope): readonly ConsentScope[] {
  const seen = new Set<ConsentScope>();
  const queue: ConsentScope[] = [...(DEPENDENTS.get(scope) ?? [])];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(DEPENDENTS.get(current) ?? []));
  }
  return [...seen];
}

export function createConsentService(opts: ConsentServiceOptions = {}): ConsentService {
  const actor = opts.actor ?? 'learner';
  const now = opts.now ?? (() => new Date());
  const stateByLearner = new Map<string, Map<ConsentScope, ScopeState>>();
  const auditByLearner = new Map<string, ConsentAuditEvent[]>();

  function learnerScopes(learnerId: string): Map<ConsentScope, ScopeState> {
    let scopes = stateByLearner.get(learnerId);
    if (!scopes) {
      scopes = new Map<ConsentScope, ScopeState>();
      stateByLearner.set(learnerId, scopes);
    }
    return scopes;
  }

  function scopeState(learnerId: string, scope: ConsentScope): ScopeState {
    const scopes = learnerScopes(learnerId);
    let state = scopes.get(scope);
    if (!state) {
      state = { granted: false, history: [] };
      scopes.set(scope, state);
    }
    return state;
  }

  function record(
    learnerId: string,
    scope: ConsentScope,
    event: ConsentAuditEvent['event'],
    eventActor: ConsentAuditEvent['actor'],
    at: string,
    extra?: { cause?: ConsentScope; learnerAssent?: boolean },
  ): void {
    const trail = auditByLearner.get(learnerId) ?? [];
    trail.push({
      at,
      recordedAt: now().toISOString(),
      learnerId,
      scope,
      event,
      actor: eventActor,
      ...(extra?.cause ? { cause: extra.cause } : {}),
      ...(extra?.learnerAssent === undefined ? {} : { learnerAssent: extra.learnerAssent }),
    });
    auditByLearner.set(learnerId, trail);
  }

  /**
   * Refuse a guardian action unless a policy says this guardian may act for
   * this learner on this scope.
   *
   * WHY REFUSING IS THE DEFAULT: a recorded guardian grant is evidence that a
   * child's data may be shared. If the service cannot name who authorised it,
   * the honest answer is "no", not "probably".
   */
  function requireGuardianAuthority(
    learnerId: string,
    scope: ConsentScope,
    guardianId: string,
    action: ConsentAction,
  ): void {
    if (!opts.authorize) {
      throw new ConsentRefusedError(
        `a guardian ${action} requires an authorisation policy; none was configured`,
      );
    }
    const principal = opts.identity?.get(guardianId);
    if (opts.identity && !principal) {
      throw new ConsentRefusedError(`unknown guardian: ${guardianId}`);
    }
    if (principal && !principal.roles.includes('guardian')) {
      throw new ConsentRefusedError(`principal ${guardianId} is not a guardian`);
    }
    const allowed = opts.authorize({ action, learnerId, scope, actor: 'guardian', guardianId });
    if (!allowed) {
      throw new ConsentRefusedError(
        `guardian ${guardianId} may not ${action} consent for learner ${learnerId}`,
      );
    }
  }

  function snapshot(learnerId: string, scope: ConsentScope): ConsentRecord {
    const state = stateByLearner.get(learnerId)?.get(scope);
    if (!state) {
      return { learnerId, scope, granted: false, updatedAt: NEVER, history: [] };
    }
    const last = state.history.at(-1);
    return {
      learnerId,
      scope,
      granted: state.granted,
      updatedAt: last ? last.at : NEVER,
      history: state.history.map((entry) => ({ ...entry })),
    };
  }

  /**
   * The single place a withdrawal happens.
   *
   * The scope and every transitive dependent are locked inside one synchronous
   * call. There is no `await` between the first and the last mutation, so no
   * observer can see a half-applied withdrawal.
   */
  function performWithdrawal(
    learnerId: string,
    scope: ConsentScope,
    withdrawalActor: 'learner' | 'guardian' | 'system',
    at: string,
    event: 'withdrawal' | 'refusal' = 'withdrawal',
  ): ConsentRecord {
    const state = scopeState(learnerId, scope);
    state.granted = false;
    state.history.push({ at, granted: false, actor: withdrawalActor });
    record(learnerId, scope, event, withdrawalActor, at);

    // Cascade to every dependent, in the same synchronous call.
    for (const dependent of transitiveDependents(scope)) {
      const dependentState = scopeState(learnerId, dependent);
      dependentState.granted = false;
      dependentState.history.push({ at, granted: false, actor: 'system' });
      record(learnerId, dependent, 'cascade_lock', 'system', at, { cause: scope });
    }

    return snapshot(learnerId, scope);
  }

  function grant(grant: ConsentGrant): ConsentRecord {
    const grantActor: 'learner' | 'guardian' = grant.guardianId ? 'guardian' : 'learner';
    if (grantActor === 'guardian' && grant.guardianId) {
      // Authorise BEFORE anything is recorded: a refused grant must leave no
      // trace that could later be read as consent.
      requireGuardianAuthority(grant.learnerId, grant.scope, grant.guardianId, 'grant');
    }
    if (!grant.granted) {
      // An explicit refusal is recorded like a withdrawal and is never erased.
      return performWithdrawal(grant.learnerId, grant.scope, grantActor, grant.at, 'refusal');
    }

    const state = scopeState(grant.learnerId, grant.scope);
    state.granted = true;
    state.history.push({ at: grant.at, granted: true, actor: grantActor });
    record(grant.learnerId, grant.scope, 'grant', grantActor, grant.at, {
      ...(grant.learnerAssent === undefined ? {} : { learnerAssent: grant.learnerAssent }),
    });
    return snapshot(grant.learnerId, grant.scope);
  }

  function withdraw(learnerId: string, scope: ConsentScope): ConsentRecord {
    if (actor === 'guardian') {
      if (!opts.actorId) {
        throw new ConsentRefusedError(
          'a guardian withdrawal must name the guardian in ConsentServiceOptions.actorId',
        );
      }
      requireGuardianAuthority(learnerId, scope, opts.actorId, 'withdraw');
    }
    return performWithdrawal(learnerId, scope, actor, now().toISOString());
  }

  function state(learnerId: string, scope: ConsentScope): ConsentRecord {
    return snapshot(learnerId, scope);
  }

  function mayShare(learnerId: string, scope: ConsentScope): boolean {
    const own = stateByLearner.get(learnerId)?.get(scope);
    if (!own || !own.granted) return false;
    // A scope is shareable only while every transitive dependency is granted.
    for (const dependency of transitiveDependencies(scope)) {
      const dependencyState = stateByLearner.get(learnerId)?.get(dependency);
      if (!dependencyState || !dependencyState.granted) return false;
    }
    return true;
  }

  /**
   * Core learning is never gated by consent.
   *
   * PHASE 1 EXIT CRITERION — "a consent withdrawal locks sharing surfaces but
   * not core learning."
   *
   * This decision is derived from the SCOPE MODEL, not from the learner's
   * consent state: if the model contained a core-learning scope, learning
   * would need a consent decision, and this would have to refuse. It contains
   * none, so learning is always permitted. The learner's own state is
   * deliberately NOT read here — a withdrawal cannot reach it.
   */
  function mayLearn(_learnerId: string): boolean {
    for (const scope of CONSENT_SCOPES) {
      if (CONSENT_SCOPE_KINDS[scope] === 'core_learning') return false;
    }
    return true;
  }

  function auditTrail(learnerId: string): readonly ConsentAuditEvent[] {
    return (auditByLearner.get(learnerId) ?? []).map((event) => ({ ...event }));
  }

  function lockedScopes(learnerId: string): readonly ConsentScope[] {
    const scopes = stateByLearner.get(learnerId);
    if (!scopes) return [];
    return CONSENT_SCOPES.filter((scope) => {
      const state = scopes.get(scope);
      return state !== undefined && !state.granted;
    });
  }

  return { grant, withdraw, state, mayShare, mayLearn, auditTrail, lockedScopes };
}
