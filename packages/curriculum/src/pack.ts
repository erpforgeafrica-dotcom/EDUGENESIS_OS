/**
 * Versioned curriculum-pack types.
 *
 * This package deliberately has NO dependency on `@edugenesis/onekey`:
 * `TierZeroEntryLike` is a local structural twin of onekey's `TierZeroEntry`,
 * so a validated pack can be converted at the integration boundary without
 * pulling the provider (and its contracts dependency) into this package.
 */

/** One lesson inside a curriculum pack. */
export interface CurriculumLesson {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly taskClasses: readonly string[];
  readonly keywords: readonly string[];
  readonly promptPatterns?: readonly string[];
  readonly licence: string;
  readonly retrievedAt: string;
  readonly locales?: readonly string[];
}

/** A versioned, optionally signed collection of lessons. */
export interface CurriculumPack {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly locale: string;
  readonly status: 'draft' | 'reviewed';
  readonly reviewRequired: boolean;
  readonly lessons: readonly CurriculumLesson[];
  readonly signature?: string;
}

/** One problem found while validating a pack. */
export type ValidationIssue = { readonly path: string; readonly message: string };

export type ValidationResult =
  | { ok: true; pack: CurriculumPack }
  | { ok: false; issues: readonly ValidationIssue[] };

/**
 * Structurally compatible with onekey's `TierZeroEntry`. Kept local so
 * curriculum stays dependency-free; the integration layer may pass these
 * straight into `createTierZeroProvider({ entries })`.
 */
export interface TierZeroEntryLike {
  id: string;
  taskClasses: readonly string[];
  title: string;
  body: string;
  licence: string;
  retrievedAt: string;
  locales?: readonly string[];
  keywords?: readonly string[];
  promptPatterns?: readonly string[];
}

/** Convert every lesson in a validated pack to a Tier 0 entry, preserving all fields. */
export function toTierZeroEntries(pack: CurriculumPack): readonly TierZeroEntryLike[] {
  return pack.lessons.map((lesson) => {
    const entry: TierZeroEntryLike = {
      id: lesson.id,
      taskClasses: [...lesson.taskClasses],
      title: lesson.title,
      body: lesson.body,
      licence: lesson.licence,
      retrievedAt: lesson.retrievedAt,
      keywords: [...lesson.keywords],
    };
    // Only emit optional keys that are actually present, so structural
    // equality with onekey entries (which omit them) holds.
    if (lesson.locales !== undefined) {
      entry.locales = [...lesson.locales];
    }
    if (lesson.promptPatterns !== undefined) {
      entry.promptPatterns = [...lesson.promptPatterns];
    }
    return entry;
  });
}
