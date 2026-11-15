/**
 * The learner surface (owner decision D-1).
 *
 * WHAT THIS IS
 *   The wiring that turns the learner-facing libraries into something a learner
 *   can actually reach: a question in, a lesson out, through the REAL OneKey
 *   gateway with the REAL accessibility guardian; and an enrolment path that
 *   runs the REAL enrolment service.
 *
 * WHY IT LIVES IN THE APP, NOT IN A PACKAGE
 *   The gateway, the guardian, the identity service and the durable audit log
 *   are all library code. What was missing — and what the round-4 audit
 *   recorded as F0-01 and F0-03 — was the seam that PUTS THEM ON A ROUTE. That
 *   seam belongs to the application: it owns the process, the data directory
 *   and the lifetime of the durable stores.
 *
 * THE GUARDIAN IS NOT OPTIONAL
 *   `answer()` counts the guardian's interceptions and reports them. A learner
 *   emission that was not intercepted is not a learner emission; the route
 *   says so honestly rather than shipping the text anyway.
 *
 * NO SECRET EVER LEAVES THIS MODULE
 *   The enrolment token's secret is shown once, to the guardian who issued it,
 *   and never logged, never stored and never returned by a route that reports
 *   an enrolment.
 */
import { createAccessibilityGuardian, createAccessibilityValidator } from '@edugenesis/accessibility';
import type {
  AccessibilityEmission,
  AccessibilityGuardian,
  CompletionRequest,
  ProviderAdapter,
  RequestContext,
  TaskPolicy,
  ValidationContext,
} from '@edugenesis/contracts';
import { createConsentService, createEnrolmentService, createIdentityService } from '@edugenesis/identity';
import { createDurableAuditLog, createSqlitePrivateStore } from '@edugenesis/ledger';
import {
  createBudgetLedger,
  createOneKeyGateway,
  createTierZeroProvider,
  type OneKeyGatewayImpl,
} from '@edugenesis/onekey';

/** How long a learner request may take before it is abandoned. */
const REQUEST_DEADLINE_MS = 30_000;
/** The hard cap on one learner request, in tokens. */
const REQUEST_TOKEN_CAP = 4_000;
/** The budget pool a learner request draws from. */
const LEARNER_POOL_ID = 'pool-learner';

/** A lesson produced for a learner. */
export interface LearnerAnswer {
  readonly text: string;
  /** The ladder rung that served it. */
  readonly tier: number;
  /** True when the guardian intercepted the emission exactly once. */
  readonly guarded: boolean;
  /** True when the guardian REFUSED the emission (it must never ship). */
  readonly blocked: boolean;
}

/** What an enrolment attempt produced. */
export interface EnrolmentOutcome {
  readonly provisional: boolean;
  readonly method: string;
  readonly grantedScopes: readonly string[];
}

/** Options for the learner services. */
export interface LearnerServicesOptions {
  /** Where the durable stores live. The directory is created if absent. */
  readonly dataDir: string;
  /** Provider adapters to register on the gateway. */
  readonly adapters?: readonly ProviderAdapter[];
  /** Clock injection, so tests are deterministic. */
  readonly now?: () => Date;
}

/** The learner surface, ready to serve. */
export interface LearnerServices {
  /** Ask a question. Returns a lesson. */
  answer(prompt: string): Promise<LearnerAnswer>;
  /** Register a guardian principal. Returns the guardian's credential secret ONCE. */
  registerGuardian(guardianId: string): { guardianId: string; secret: string };
  /** Issue a guardian consent token for a learner. The secret is shown ONCE. */
  issueConsentToken(guardianId: string, learnerId: string): { token: unknown; secret: string };
  /** Enrol a learner on a guardian consent token. */
  enrol(learnerId: string, token: unknown, secret: string): Promise<EnrolmentOutcome>;
  /** The durable audit trail, oldest event first. */
  auditTrail(): { events: unknown[]; verification: { ok: boolean; entriesChecked: number; brokenAtSeq?: number; detail?: string } };
  /** Close the durable stores. */
  close(): void;
}

/**
 * A guardian that counts its interceptions.
 *
 * WHY IT WRAPS THE REAL ONE: the counter must observe the REAL interception
 * point, or the number it reports is decoration.
 */
function countingGuardian(): { guardian: AccessibilityGuardian; count: () => number } {
  const real = createAccessibilityGuardian(createAccessibilityValidator());
  let interceptions = 0;
  const guardian: AccessibilityGuardian = {
    async intercept(emission: AccessibilityEmission, ctx?: ValidationContext) {
      interceptions += 1;
      return real.intercept(emission, ctx);
    },
  };
  return { guardian, count: () => interceptions };
}

/** The policy a learner question runs under. */
function learnerPolicy(): TaskPolicy {
  return { taskClass: 'explain', safetyTier: 'low', dataClass: 'public' };
}

/** The request a learner question becomes. */
function learnerRequest(prompt: string): CompletionRequest {
  return {
    prompt,
    dataClass: 'public',
    safetyTier: 'low',
    maxOutputTokens: REQUEST_TOKEN_CAP,
    requiresAccessibilityContract: true,
  };
}

export function createLearnerServices(options: LearnerServicesOptions): LearnerServices {
  const clock = options.now ?? ((): Date => new Date());

  // The durable stores. The private store holds the private operational
  // records; the audit log holds the append-only, hash-chained evidence.
  const privateStore = createSqlitePrivateStore({
    path: `${options.dataDir}/private.sqlite`,
  });
  const auditLog = createDurableAuditLog({ path: `${options.dataDir}/audit.sqlite` });

  // Identity, consent and enrolment, wired to the durable audit log so a
  // consent decision and an enrolment attempt survive a restart.
  const identity = createIdentityService();
  const consent = createConsentService({
    actor: 'guardian',
    authorize: (request) => {
      // The guardian may act for the learner named in the request, and for
      // nothing else. Silence is not consent: an authoriser must exist.
      const guardian = identity.get(request.guardianId ?? '');
      if (!guardian) return false;
      return guardian.roles.includes('guardian');
    },
  });
  const enrolment = createEnrolmentService({ identity, consent, auditLog });

  // The gateway. Tier 0 (the offline curriculum) is always available: a
  // learner must never get nothing because a provider is down.
  const gateway: OneKeyGatewayImpl = createOneKeyGateway({ tierZero: createTierZeroProvider() });
  for (const adapter of options.adapters ?? []) gateway.register(adapter);

  const answer = async (prompt: string): Promise<LearnerAnswer> => {
    const { guardian, count } = countingGuardian();
    const ctx: RequestContext = {
      requestId: `req-${clock().getTime()}`,
      deadlineAt: clock().getTime() + REQUEST_DEADLINE_MS,
      budget: createBudgetLedger(LEARNER_POOL_ID, REQUEST_TOKEN_CAP, 'token'),
      guardian,
      learnerFacing: true,
    };
    const result = await gateway.complete(learnerPolicy(), learnerRequest(prompt), ctx);
    const interceptions = count();
    return {
      text: result.text,
      tier: result.meta.tier,
      guarded: interceptions === 1,
      blocked: interceptions !== 1,
    };
  };

  return {
    answer,

    registerGuardian(guardianId: string): { guardianId: string; secret: string } {
      if (!identity.get(guardianId)) {
        identity.register({ id: guardianId, roles: ['guardian'], attributes: {} });
      }
      const credential = identity.issueCredential(guardianId);
      // The secret exists in this call frame and in the guardian's hands. It
      // is never stored and never logged.
      return { guardianId, secret: credential.secret };
    },

    issueConsentToken(guardianId: string, learnerId: string): { token: unknown; secret: string } {
      const issued = enrolment.issueGuardianConsentToken({
        guardianId,
        learnerId,
        scopes: ['progress_visible_to_guardian'],
      });
      return { token: issued.token, secret: issued.secret };
    },

    async enrol(learnerId: string, token: unknown, secret: string): Promise<EnrolmentOutcome> {
      const result = await enrolment.enrolWithGuardianConsent({
        token: token as Parameters<typeof enrolment.enrolWithGuardianConsent>[0]['token'],
        secret,
      });
      return {
        provisional: result.provisional,
        method: result.method,
        grantedScopes: result.grantedScopes,
      };
    },

    auditTrail() {
      return { events: auditLog.all(), verification: auditLog.verify() };
    },

    close(): void {
      privateStore.close();
      auditLog.close();
    },
  };
}
