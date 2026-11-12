/**
 * Age assurance.
 *
 * Authority:
 *   Doc 2 §4.2 — age assurance resolves an age band; inconclusive means null.
 *   Doc 1 v1.2 — the platform serves minors, in regions where a government
 *                identity document is frequently unavailable, so the service
 *                must be honest about uncertainty instead of confident.
 *
 * THE RULE (never guess)
 *   Evidence is graded. Only a trusted attestation, a verified date of birth
 *   or a declared age CORROBORATED by a passed identity check may resolve a
 *   band. A self-declared age on its own proves nothing, and the service says
 *   so by returning null.
 *
 * GUARDIAN REQUIREMENT (fail closed)
 *   `under_13` and `13_15` require a guardian. `16_17` and `adult` do not.
 *   An UNKNOWN band requires a guardian: an unresolved age must never be
 *   treated as an adult.
 */
import type { AgeAssuranceService, Principal } from '@edugenesis/contracts';

export type AgeBand = NonNullable<Principal['ageBand']>;

/** The evidence an assurance flow may supply. Every field is optional. */
export interface AgeEvidence {
  /** A trusted attestor (school register, verified ID provider) resolved the band. */
  readonly attestedBand?: AgeBand;
  /** Date of birth read from an identity document. ISO date or datetime. */
  readonly verifiedDateOfBirth?: string;
  /** An age stated by the learner or the guardian. */
  readonly declaredAge?: number;
  /** The outcome of an independent identity check. */
  readonly idCheckOutcome?: 'pass' | 'fail' | 'unavailable';
}

export type AgeAssuranceOutcome = 'matched' | 'insufficient' | 'skipped';

export interface AgeAssuranceTraceEntry {
  /** The rule that was evaluated. */
  readonly rule: string;
  readonly outcome: AgeAssuranceOutcome;
  /** Why the rule did or did not conclude. */
  readonly detail: string;
}

export interface AgeAssuranceDecision {
  /** The resolved band, or null when the evidence is inconclusive. */
  readonly band: Principal['ageBand'] | null;
  /** The rule that produced the band, when one did. */
  readonly decidedBy?: string;
  /** Every rule that was evaluated, in order. */
  readonly trace: readonly AgeAssuranceTraceEntry[];
}

export interface AgeAssuranceServiceExtended extends AgeAssuranceService {
  /** The full decision, including the rule trace. */
  assureDetailed(subjectId: string, evidence: unknown): AgeAssuranceDecision;
}

export interface AgeAssuranceOptions {
  /** Clock injection, used to turn a date of birth into an age. */
  readonly now?: () => Date;
}

/** Bands that require a guardian to act. */
export const GUARDIAN_REQUIRED_BANDS: readonly AgeBand[] = ['under_13', '13_15'];

function isAgeBand(value: unknown): value is AgeBand {
  return value === 'under_13' || value === '13_15' || value === '16_17' || value === 'adult';
}

/** Whole years between `birth` and `reference`, floored. */
function ageInYears(birth: Date, reference: Date): number {
  let age = reference.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = reference.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && reference.getUTCDate() < birth.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/** Map an age in whole years to the platform's bands. */
function bandForAge(age: number): AgeBand {
  if (age < 13) return 'under_13';
  if (age < 16) return '13_15';
  if (age < 18) return '16_17';
  return 'adult';
}

/** The oldest age the service will believe. Beyond this the evidence is nonsense. */
const MAX_PLAUSIBLE_AGE = 120;

function readEvidence(evidence: unknown): AgeEvidence {
  if (typeof evidence !== 'object' || evidence === null) return {};
  const source = evidence as Record<string, unknown>;
  const result: {
    attestedBand?: AgeBand;
    verifiedDateOfBirth?: string;
    declaredAge?: number;
    idCheckOutcome?: 'pass' | 'fail' | 'unavailable';
  } = {};
  if (isAgeBand(source['attestedBand'])) result.attestedBand = source['attestedBand'];
  if (typeof source['verifiedDateOfBirth'] === 'string') {
    result.verifiedDateOfBirth = source['verifiedDateOfBirth'];
  }
  if (typeof source['declaredAge'] === 'number' && Number.isFinite(source['declaredAge'])) {
    result.declaredAge = source['declaredAge'];
  }
  const outcome = source['idCheckOutcome'];
  if (outcome === 'pass' || outcome === 'fail' || outcome === 'unavailable') {
    result.idCheckOutcome = outcome;
  }
  return result;
}

export function createAgeAssuranceService(opts: AgeAssuranceOptions = {}): AgeAssuranceServiceExtended {
  const now = opts.now ?? (() => new Date());

  function assureDetailed(subjectId: string, evidence: unknown): AgeAssuranceDecision {
    // The subject id is part of the call for audit and future per-subject
    // rate limiting; it does not influence the band.
    void subjectId;
    const parsed = readEvidence(evidence);
    const trace: AgeAssuranceTraceEntry[] = [];

    // Rule 1 — a trusted attestation is conclusive.
    if (parsed.attestedBand !== undefined) {
      trace.push({
        rule: 'attested_band',
        outcome: 'matched',
        detail: `A trusted attestation resolved the band "${parsed.attestedBand}".`,
      });
      return { band: parsed.attestedBand, decidedBy: 'attested_band', trace };
    }
    trace.push({ rule: 'attested_band', outcome: 'skipped', detail: 'No trusted attestation supplied.' });

    // Rule 2 — a verified date of birth is conclusive.
    if (parsed.verifiedDateOfBirth !== undefined) {
      const birth = new Date(parsed.verifiedDateOfBirth);
      const reference = now();
      if (Number.isNaN(birth.getTime())) {
        trace.push({
          rule: 'verified_dob',
          outcome: 'insufficient',
          detail: 'The supplied date of birth could not be parsed.',
        });
      } else if (birth.getTime() > reference.getTime()) {
        trace.push({
          rule: 'verified_dob',
          outcome: 'insufficient',
          detail: 'The supplied date of birth is in the future.',
        });
      } else {
        const age = ageInYears(birth, reference);
        if (age > MAX_PLAUSIBLE_AGE) {
          trace.push({
            rule: 'verified_dob',
            outcome: 'insufficient',
            detail: `The supplied date of birth implies an age of ${age}, which is implausible.`,
          });
        } else {
          const band = bandForAge(age);
          trace.push({
            rule: 'verified_dob',
            outcome: 'matched',
            detail: `A verified date of birth implies an age of ${age}.`,
          });
          return { band, decidedBy: 'verified_dob', trace };
        }
      }
    } else {
      trace.push({ rule: 'verified_dob', outcome: 'skipped', detail: 'No verified date of birth supplied.' });
    }

    // Rule 3 — a declared age corroborated by a passed identity check.
    if (parsed.declaredAge !== undefined && parsed.idCheckOutcome === 'pass') {
      const age = Math.floor(parsed.declaredAge);
      if (age < 0 || age > MAX_PLAUSIBLE_AGE) {
        trace.push({
          rule: 'id_check_confirmed_age',
          outcome: 'insufficient',
          detail: `The declared age ${parsed.declaredAge} is implausible.`,
        });
      } else {
        const band = bandForAge(age);
        trace.push({
          rule: 'id_check_confirmed_age',
          outcome: 'matched',
          detail: `An identity check corroborated the declared age of ${age}.`,
        });
        return { band, decidedBy: 'id_check_confirmed_age', trace };
      }
    } else if (parsed.declaredAge !== undefined) {
      trace.push({
        rule: 'id_check_confirmed_age',
        outcome: 'skipped',
        detail: 'No passed identity check corroborates the declared age.',
      });
    } else {
      trace.push({
        rule: 'id_check_confirmed_age',
        outcome: 'skipped',
        detail: 'No declared age supplied.',
      });
    }

    // Rule 4 — a declared age without corroboration is not enough.
    if (parsed.declaredAge !== undefined) {
      trace.push({
        rule: 'declared_age_uncorroborated',
        outcome: 'insufficient',
        detail: 'A self-declared age alone cannot resolve a band.',
      });
    } else {
      trace.push({
        rule: 'declared_age_uncorroborated',
        outcome: 'skipped',
        detail: 'No declared age supplied.',
      });
    }

    // Rule 5 — nothing conclusive.
    trace.push({
      rule: 'no_conclusive_evidence',
      outcome: 'insufficient',
      detail: 'No rule resolved a band; the age remains unassured.',
    });
    return { band: null, trace };
  }

  async function assure(subjectId: string, evidence: unknown): Promise<Principal['ageBand'] | null> {
    return assureDetailed(subjectId, evidence).band;
  }

  function requiresGuardian(ageBand: Principal['ageBand']): boolean {
    if (ageBand === undefined) {
      // Fail closed: an unknown age is never treated as an adult.
      return true;
    }
    return GUARDIAN_REQUIRED_BANDS.includes(ageBand);
  }

  return { assure, assureDetailed, requiresGuardian };
}
