/**
 * EduGenesis OS — the PRIVATE operational store and its de-identified view.
 *
 * THE BOUNDARY THIS MODULE PROTECTS
 * The platform holds two stores and they must never touch:
 *
 *   PUBLIC LEDGER (packages/ledger/ledger-store.ts)
 *     Hash-chained, published, append-only, permanent. Carries hashes, counters
 *     and proofs. NO personal data, ever (Doc 2 §2.5; Doc 16 §3.5).
 *
 *   PRIVATE OPERATIONAL STORE (this module)
 *     Identity, consent, safeguarding, accessibility profiles, assessments and
 *     transcripts. Lives in the process, for the minimum time, for the minimum
 *     audience (Doc 2 §15).
 *
 * There is NO CODE PATH from this module to the ledger store, and this file
 * deliberately does not import `ledger-store.ts` at all. The only sanctioned way
 * for private data to influence the public record is `redactForSponsor()` below,
 * which produces an AGGREGATE with no identifiers — and even that aggregate is
 * never written to the ledger; it is the artefact the Anchor Sponsor receives
 * (Doc 16 §3.5, Doc 7 public impact reporting).
 *
 * If a future change ever needs to write learner data into the ledger, it is
 * not a feature request: it is a violation of Doc 2 §2.5 and it is a bug.
 *
 * STORAGE
 * The store is in-memory by design. Node 24 ships `node:sqlite` and it was
 * verified to work on this build host, but a ledger package that persists
 * identity records would have to own a data directory, a retention policy and a
 * wipe path — none of which belong in a package whose job is to prove a
 * boundary. Persistence is a concern of the service that owns the data, behind
 * this interface.
 */

import type { PrivateRecord, PrivateRecordKind, PrivateStore } from '@edugenesis/contracts';

import { assertNoPersonalData } from './pii-guard.js';

/** Every private record kind the store accepts. */
export const PRIVATE_RECORD_KINDS: readonly PrivateRecordKind[] = [
  'identity',
  'consent',
  'safeguarding',
  'accessibility_profile',
  'assessment',
  'session_transcript',
];

/**
 * The ONLY keys of a private record that may influence a de-identified view.
 *
 * An allowlist, never a denylist: a new field added to a private record must
 * not silently become part of a sponsor report. Everything not on this list —
 * every free-text note, every prompt, every transcript fragment — is ignored
 * by construction, not by filtering.
 */
export const REDACTION_READ_KEYS = {
  /** Organisational cohort identifier, e.g. "Kisumu-G7-A". */
  cohort: 'cohort',
  /** Region the cohort sits in, e.g. "Kisumu". */
  region: 'region',
  /** Learning area, e.g. "algebra". */
  learningArea: 'learningArea',
  /**
   * A pseudonymous, per-learner reference used ONLY to count distinct learners.
   *
   * It is never emitted. Counting distinct learners is what makes small-cohort
   * suppression meaningful: without it, "three rows" would be indistinguishable
   * from "three learners", and a cohort of one learner would pass a naive
   * row-count check.
   */
  learnerRef: 'learnerRef',
} as const;

/** Default minimum cohort size for suppression. */
export const DEFAULT_MIN_COHORT_SIZE = 5;

/** A cohort that survived suppression. */
export interface SponsorRedactionCohort {
  cohort: string;
  learnerCount: number;
  recordCount: number;
}

/** A region aggregate (learners counted once per region). */
export interface SponsorRedactionRegion {
  region: string;
  learnerCount: number;
  cohortCount: number;
}

/** A learning-area aggregate. */
export interface SponsorRedactionLearningArea {
  learningArea: string;
  learnerCount: number;
}

/**
 * A de-identified, aggregate view of the private store.
 *
 * Contains no identifier of any person, no free text, and no cell derived from
 * a cohort smaller than the configured minimum.
 */
export interface SponsorRedaction {
  generatedAt: string;
  minCohortSize: number;
  /** Distinct learners across all surviving cohorts. */
  learnerCount: number;
  cohortCount: number;
  cohorts: SponsorRedactionCohort[];
  regions: SponsorRedactionRegion[];
  learningAreas: SponsorRedactionLearningArea[];
  /** How many cohorts were withheld for being too small. */
  suppressedCohortCount: number;
  /** Records that carried no cohort attribution at all. */
  unattributedRecordCount: number;
  /** Self-check: the view was scanned for personal data. */
  piiScan: { ok: boolean; violations: string[] };
}

/** Options for `redactForSponsor`. */
export interface SponsorRedactionOptions {
  /** Cohorts below this many distinct learners are suppressed entirely. */
  minCohortSize?: number;
  /** Timestamp for the view (injection keeps the output reproducible). */
  generatedAt?: string;
}

/** Deep copy of a private record payload. */
function copyData(data: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(data);
  } catch {
    throw new Error(
      'A private record payload must be structured-cloneable (plain data only). ' +
        'Functions, class instances with methods and other exotic values are not storable.',
    );
  }
}

/**
 * Create the private operational store.
 *
 * In-memory, process-local, and never reachable from the ledger. `put` copies
 * the caller's payload so a later mutation of the caller's object cannot change
 * what the store holds; `get`/`all`/`byKind` copy on the way out so a caller
 * cannot mutate stored identity data by accident.
 */
export function createPrivateStore(): PrivateStore {
  const records = new Map<string, PrivateRecord>();

  const clone = (record: PrivateRecord): PrivateRecord => ({
    id: record.id,
    kind: record.kind,
    at: record.at,
    data: copyData(record.data),
  });

  return {
    put(record: PrivateRecord): void {
      if (!record || typeof record.id !== 'string' || record.id.length === 0) {
        throw new Error('A private record needs a non-empty id.');
      }
      if (!PRIVATE_RECORD_KINDS.includes(record.kind)) {
        throw new Error(
          `Unknown private record kind "${String(record.kind)}". ` +
            `Expected one of: ${PRIVATE_RECORD_KINDS.join(', ')}.`,
        );
      }
      if (typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))) {
        throw new Error('A private record needs a parseable ISO-8601 timestamp.');
      }
      if (record.data === null || typeof record.data !== 'object') {
        throw new Error('A private record needs a data object.');
      }
      records.set(record.id, clone(record));
    },

    get(id: string): PrivateRecord | undefined {
      const found = records.get(id);
      return found ? clone(found) : undefined;
    },

    all(): PrivateRecord[] {
      return [...records.values()].map(clone);
    },

    byKind(kind: PrivateRecordKind): PrivateRecord[] {
      return [...records.values()].filter((record) => record.kind === kind).map(clone);
    },
  };
}

/** Read a whitelisted string field from a record payload. */
function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Produce a de-identified, suppressed aggregate view of the private store.
 *
 * THE DISCLOSURE RULE: a cohort with fewer than `minCohortSize` distinct
 * learners is suppressed ENTIRELY — it does not appear in the cohort list, and
 * none of its records contribute to any region or learning-area total. Merely
 * labelling a small cell "suppressed" is not enough, because the totals around
 * it would allow the suppressed cell to be recovered by subtraction. Removing
 * it from every aggregate is the only version of the rule that actually holds.
 *
 * NO IDENTIFIERS, NO FREE TEXT: only the four whitelisted keys are read, and
 * nothing from `data` is ever copied verbatim.
 */
export function redactForSponsor(
  store: PrivateStore,
  options: SponsorRedactionOptions = {},
): SponsorRedaction {
  const minCohortSize = Math.max(1, Math.trunc(options.minCohortSize ?? DEFAULT_MIN_COHORT_SIZE));
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  interface CohortBucket {
    learnerRefs: Set<string>;
    recordCount: number;
    regions: Map<string, Set<string>>;
    learningAreas: Map<string, Set<string>>;
  }

  const cohorts = new Map<string, CohortBucket>();
  const globalLearnerRefs = new Set<string>();
  let unattributedRecordCount = 0;

  for (const record of store.all()) {
    const data = record.data;
    const cohort = readString(data, REDACTION_READ_KEYS.cohort);
    if (!cohort) {
      unattributedRecordCount += 1;
      continue;
    }
    const learnerRef = readString(data, REDACTION_READ_KEYS.learnerRef);
    const region = readString(data, REDACTION_READ_KEYS.region);
    const learningArea = readString(data, REDACTION_READ_KEYS.learningArea);

    let bucket = cohorts.get(cohort);
    if (!bucket) {
      bucket = {
        learnerRefs: new Set<string>(),
        recordCount: 0,
        regions: new Map<string, Set<string>>(),
        learningAreas: new Map<string, Set<string>>(),
      };
      cohorts.set(cohort, bucket);
    }
    bucket.recordCount += 1;
    if (learnerRef) {
      bucket.learnerRefs.add(learnerRef);
      globalLearnerRefs.add(learnerRef);
    }
    if (region) {
      const set = bucket.regions.get(region) ?? new Set<string>();
      if (learnerRef) set.add(learnerRef);
      bucket.regions.set(region, set);
    }
    if (learningArea) {
      const set = bucket.learningAreas.get(learningArea) ?? new Set<string>();
      if (learnerRef) set.add(learnerRef);
      bucket.learningAreas.set(learningArea, set);
    }
  }

  const surviving: SponsorRedactionCohort[] = [];
  const regionLearners = new Map<string, Set<string>>();
  const regionCohorts = new Map<string, Set<string>>();
  const areaLearners = new Map<string, Set<string>>();
  let suppressedCohortCount = 0;
  let learnerCount = 0;

  for (const cohortName of [...cohorts.keys()].sort()) {
    const bucket = cohorts.get(cohortName);
    if (!bucket) continue;
    if (bucket.learnerRefs.size < minCohortSize) {
      // Suppressed ENTIRELY: it contributes to no aggregate at all.
      suppressedCohortCount += 1;
      continue;
    }
    surviving.push({
      cohort: cohortName,
      learnerCount: bucket.learnerRefs.size,
      recordCount: bucket.recordCount,
    });
    for (const [region, refs] of bucket.regions) {
      const learners = regionLearners.get(region) ?? new Set<string>();
      for (const ref of refs) learners.add(ref);
      regionLearners.set(region, learners);
      const cohortSet = regionCohorts.get(region) ?? new Set<string>();
      cohortSet.add(cohortName);
      regionCohorts.set(region, cohortSet);
    }
    for (const [area, refs] of bucket.learningAreas) {
      const learners = areaLearners.get(area) ?? new Set<string>();
      for (const ref of refs) learners.add(ref);
      areaLearners.set(area, learners);
    }
    learnerCount += bucket.learnerRefs.size;
  }

  const regions: SponsorRedactionRegion[] = [...regionLearners.keys()]
    .sort()
    .map((region) => ({
      region,
      learnerCount: regionLearners.get(region)?.size ?? 0,
      cohortCount: regionCohorts.get(region)?.size ?? 0,
    }));

  const learningAreas: SponsorRedactionLearningArea[] = [...areaLearners.keys()]
    .sort()
    .map((learningArea) => ({
      learningArea,
      learnerCount: areaLearners.get(learningArea)?.size ?? 0,
    }));

  const view: SponsorRedaction = {
    generatedAt,
    minCohortSize,
    learnerCount,
    cohortCount: surviving.length,
    cohorts: surviving,
    regions,
    learningAreas,
    suppressedCohortCount,
    unattributedRecordCount,
    piiScan: { ok: true, violations: [] },
  };

  // Self-check: the artefact about to be shown to a sponsor is scanned for
  // personal data with the same guard that protects the ledger.
  const scan = assertNoPersonalData(view);
  view.piiScan = scan;

  return view;
}
