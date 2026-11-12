/**
 * Session risk assessment.
 *
 * Authority:
 *   Doc 2 §4.2 — session risk scoring.
 *   Doc 1 v1.2 — non-discrimination, protection of minors.
 *
 * WHAT THIS SERVICE MUST NEVER DO
 *   Use a protected attribute as a risk factor. The platform serves children
 *   and operates in many jurisdictions, so a risk score built on disability,
 *   health, nationality, ethnicity, religion, sex, biometrics or similar
 *   would be both unlawful and indefensible. The denylist below is therefore
 *   a HARD boundary implemented in code, not a policy note:
 *
 *     1. only the DECLARED factor catalogue can contribute to a score, so a
 *        protected attribute cannot be introduced by configuration either;
 *     2. any signal whose key names a protected characteristic is IGNORED
 *        (never scored, never fatal) and reported for audit;
 *     3. the subject id never influences the score — the same signals always
 *        produce the same result.
 */
import type { SessionRiskService } from '@edugenesis/contracts';

export type RiskBand = 'low' | 'medium' | 'high';

/** The factors the service is allowed to score. */
export type RiskFactorKey =
  | 'new_device'
  | 'new_ip'
  | 'impossible_travel'
  | 'failed_authentication'
  | 'rapid_requests'
  | 'off_hours'
  | 'anomalous_payload_size'
  | 'session_reuse';

export interface RiskFactorSpec {
  readonly key: RiskFactorKey;
  /** Contribution of this factor at full strength. */
  readonly weight: number;
  /** Why the factor matters, in words a reviewer can check. */
  readonly description: string;
}

/**
 * The default weights.
 *
 * These are ENGINEERING DEFAULTS chosen for ordering and spread, not a
 * measured result and not a security claim (review rubric C12). A deployment
 * calibrates them against its own traffic through `weights`.
 */
export const DEFAULT_RISK_FACTORS: readonly RiskFactorSpec[] = [
  { key: 'new_device', weight: 0.3, description: 'The session runs on a device the subject has not used before.' },
  { key: 'new_ip', weight: 0.2, description: 'The session arrives from a network the subject has not used before.' },
  { key: 'impossible_travel', weight: 0.35, description: 'Two consecutive sessions are geographically impossible.' },
  { key: 'failed_authentication', weight: 0.25, description: 'Failed authentication attempts precede the session.' },
  { key: 'rapid_requests', weight: 0.15, description: 'Request volume is far above the subject’s normal rate.' },
  { key: 'off_hours', weight: 0.1, description: 'The session falls outside the subject’s usual hours.' },
  { key: 'anomalous_payload_size', weight: 0.15, description: 'Request or response size departs from the usual shape.' },
  { key: 'session_reuse', weight: 0.25, description: 'A session identifier is reused across principals.' },
];

/**
 * Protected characteristics that may never act as a risk signal.
 * Matched on whole words inside the signal key (camelCase and separators
 * are both split), so `disabilityStatus`, `disability_status` and
 * `has-disability` are all caught while `trace_id` is not.
 */
export const PROHIBITED_SIGNAL_KEYS: readonly string[] = [
  'disability',
  'disability_status',
  'health',
  'medical',
  'medical_condition',
  'diagnosis',
  'impairment',
  'nationality',
  'citizenship',
  'national_origin',
  'ethnicity',
  'ethnic_group',
  'ethnic_origin',
  'race',
  'racial_origin',
  'colour',
  'color',
  'religion',
  'religious_belief',
  'sex',
  'gender',
  'gender_identity',
  'sexual_orientation',
  'political_opinion',
  'marital_status',
  'genetic',
  'biometric',
  'biometric_data',
  'immigration_status',
  'age',
  'age_band',
];

/**
 * Two-word protected characteristics. These are checked as adjacent word
 * pairs so that a generic word such as "origin" or "status" is not blocked on
 * its own.
 */
export const PROHIBITED_SIGNAL_PHRASES: readonly string[] = [
  'national origin',
  'country of birth',
  'date of birth',
  'racial origin',
  'religious belief',
  'political opinion',
  'marital status',
  'sexual orientation',
  'gender identity',
  'disability status',
  'medical condition',
  'biometric data',
  'ethnic group',
  'ethnic origin',
  'immigration status',
  'age band',
];

const PROHIBITED_TOKEN_SET = new Set(PROHIBITED_SIGNAL_KEYS);
const PROHIBITED_PHRASE_SET = new Set(PROHIBITED_SIGNAL_PHRASES);

/** Split a signal key into words: camelCase and separators both break. */
function tokeniseKey(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Is this signal key naming a protected characteristic?
 *
 * Deliberately conservative: a key that merely mentions a protected
 * characteristic is ignored rather than scored. A false positive costs one
 * signal; a false negative costs fairness.
 */
export function isProhibitedSignalKey(key: string): boolean {
  const tokens = tokeniseKey(key);
  for (const token of tokens) {
    if (PROHIBITED_TOKEN_SET.has(token)) return true;
  }
  // Multi-word characteristics are matched as adjacent word sequences of two
  // or three words, so "country of birth" is caught while a legitimate signal
  // such as "country_mismatch" is not.
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const left = tokens[index];
    const right = tokens[index + 1];
    if (left === undefined || right === undefined) continue;
    if (PROHIBITED_PHRASE_SET.has(`${left} ${right}`)) return true;
    const third = tokens[index + 2];
    if (third !== undefined && PROHIBITED_PHRASE_SET.has(`${left} ${right} ${third}`)) return true;
  }
  return false;
}

export interface RiskThresholds {
  /** Score at or above which a session is medium risk. */
  readonly medium: number;
  /** Score at or above which a session is high risk. */
  readonly high: number;
}

/** The default band cut-points. Engineering defaults, not measured results. */
export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = { medium: 0.34, high: 0.67 };

export interface SessionRiskOptions {
  /**
   * Override factor weights by key. Weights for keys that are not declared
   * factors are ignored: the catalogue is the hard boundary.
   */
  readonly weights?: Readonly<Record<string, number>>;
  /** Override the band cut-points. */
  readonly thresholds?: { readonly medium?: number; readonly high?: number };
}

export interface SessionRiskAssessment {
  readonly score: number;
  readonly band: RiskBand;
  /** The factors that contributed, as `key=contribution`. */
  readonly factors: readonly string[];
  /** Prohibited signals that were ignored. */
  readonly ignoredProhibited: readonly string[];
  /** Signals that are not declared factors, and were ignored. */
  readonly ignoredUnknown: readonly string[];
}

export interface SessionRiskServiceExtended extends SessionRiskService {
  /** The full assessment, including what was ignored and why. */
  assessDetailed(subjectId: string, signals: Record<string, unknown>): SessionRiskAssessment;
}

/** Normalise a signal value to 0..1. Anything unusable is null. */
function normaliseValue(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }
  return null;
}

/** Round to four decimals so results are stable and readable. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function createSessionRiskService(opts: SessionRiskOptions = {}): SessionRiskServiceExtended {
  const weights = new Map<RiskFactorKey, number>();
  for (const factor of DEFAULT_RISK_FACTORS) {
    const override = opts.weights?.[factor.key];
    weights.set(factor.key, typeof override === 'number' ? override : factor.weight);
  }
  const thresholds: RiskThresholds = {
    medium: opts.thresholds?.medium ?? DEFAULT_RISK_THRESHOLDS.medium,
    high: opts.thresholds?.high ?? DEFAULT_RISK_THRESHOLDS.high,
  };

  function assessDetailed(subjectId: string, signals: Record<string, unknown>): SessionRiskAssessment {
    // The subject id is carried for the audit trail; it never influences the
    // score, so the same signals always give the same result.
    void subjectId;
    const factors: string[] = [];
    const ignoredProhibited: string[] = [];
    const ignoredUnknown: string[] = [];
    let total = 0;

    const entries = signals !== null && typeof signals === 'object' ? Object.entries(signals) : [];

    for (const [key, value] of entries) {
      // Boundary 1: a protected characteristic is never scored.
      if (isProhibitedSignalKey(key)) {
        ignoredProhibited.push(key);
        continue;
      }
      // Boundary 2: only declared factors can contribute at all.
      const weight = weights.get(key as RiskFactorKey);
      if (weight === undefined) {
        ignoredUnknown.push(key);
        continue;
      }
      const normalised = normaliseValue(value);
      if (normalised === null) continue;
      const contribution = round4(weight * normalised);
      if (contribution <= 0) continue;
      total += contribution;
      factors.push(`${key}=${contribution}`);
    }

    const score = round4(Math.min(1, total));
    const band: RiskBand = score >= thresholds.high ? 'high' : score >= thresholds.medium ? 'medium' : 'low';

    return { score, band, factors, ignoredProhibited, ignoredUnknown };
  }

  function assess(
    subjectId: string,
    signals: Record<string, unknown>,
  ): { score: number; band: RiskBand; factors: string[] } {
    const detail = assessDetailed(subjectId, signals);
    return { score: detail.score, band: detail.band, factors: [...detail.factors] };
  }

  return { assess, assessDetailed };
}
