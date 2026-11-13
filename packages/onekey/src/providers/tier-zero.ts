import type {
  CompletionRequest,
  CompletionResult,
  SourceLineage,
  TaskClass,
  TaskPolicy,
} from '@edugenesis/contracts';
import type { TierZeroFallbackProvider } from '../tier-zero-fallback.js';

/**
 * Tier 0 — deterministic learning that requires NO model provider (Doc 16 §6.4).
 *
 * WHY this is the floor: a learner must never lose access because a provider
 * is down, a sponsor credit ran out, or every hosted model was suspended.
 * `serve()` returns null whenever the bundle has nothing for the task, which
 * is the signal for the gateway to escalate up the ladder.
 */

/** One cached curriculum atom. */
export interface TierZeroEntry {
  /** Curriculum id, e.g. `algebra/linear-eq`. */
  id: string;
  /** Task classes this cached lesson can serve. */
  taskClasses: TaskClass[];
  title: string;
  body: string;
  /** Licence id — the Licence Clearance Service gates on this. */
  licence: string;
  /** ISO-8601 retrieval timestamp. */
  retrievedAt: string;
  /** Locales this lesson is cleared for. Omit for "no locale restriction". */
  locales?: string[];
}

export interface TierZeroOptions {
  /** The offline curriculum bundle. */
  entries?: TierZeroEntry[];
  /** Bundle ids advertised to the offline bundle service. */
  bundleIds?: string[];
}

/** A TierZeroProvider that also carries a stable id, for routing decisions. */
export interface TierZeroProviderImpl extends TierZeroFallbackProvider {
  readonly id: string;
  readonly modelId: string;
}

export const TIER_ZERO_ID = 'tier-zero';
export const TIER_ZERO_MODEL = 'offline-curriculum';

/**
 * The neutral learner-facing notice on a last-resort lesson.
 *
 * WHY it says nothing about providers: a provider outage is an operations
 * event, not a learner event (Doc 16 §6.6). The learner is told what they are
 * reading, not why the usual path was unavailable.
 */
export const TIER_ZERO_FALLBACK_NOTICE = 'Here is a lesson from your offline library that covers this topic.';

/**
 * The notice for a fallback whose best candidate shares NO word with the task.
 *
 * WHY TWO NOTICES: the original notice asserted topical coverage
 * unconditionally, so a learner who asked about the water cycle could be
 * served an algebra lesson that CLAIMED to cover their question. The claim is
 * now made only when the relevance score says there is a topical match. The
 * learner still receives a lesson — the product promise is that a learner is
 * never denied — but the text no longer says something the build cannot know.
 */
export const TIER_ZERO_FALLBACK_UNRELATED_NOTICE =
  'Our offline library has no lesson on this exact topic. Here is the closest lesson we have — it may not answer your question.';

const DEFAULT_ENTRIES: TierZeroEntry[] = [
  {
    id: 'algebra/linear-eq',
    taskClasses: ['explain', 'quiz'],
    title: 'Solving a linear equation',
    body:
      'A linear equation has the form ax + b = c. Subtract b from both sides, then divide both sides by a. Always substitute your solution back in to check it.',
    licence: 'CC-BY-4.0',
    retrievedAt: '2026-01-05T00:00:00.000Z',
    locales: ['en'],
  },
  {
    id: 'science/photosynthesis',
    taskClasses: ['explain', 'quiz'],
    title: 'Photosynthesis in one step',
    body:
      'Plants turn light energy into chemical energy: carbon dioxide plus water becomes glucose plus oxygen. Chlorophyll in the leaves captures the light.',
    licence: 'CC-BY-4.0',
    retrievedAt: '2026-01-05T00:00:00.000Z',
    locales: ['en'],
  },
  {
    id: 'math/fractions-basics',
    taskClasses: ['explain'],
    title: 'Fractions basics',
    body:
      'A fraction has a numerator (the top number) and a denominator (the bottom number). To compare two fractions with the same denominator, compare the numerators.',
    licence: 'CC-BY-4.0',
    retrievedAt: '2026-01-05T00:00:00.000Z',
    locales: ['en'],
  },
];

const DEFAULT_BUNDLE_IDS = ['curriculum-core-v1'];

/** Matches `curriculum:<id>` in a prompt or in a source locator. */
const CURRICULUM_REF = /curriculum:([A-Za-z0-9_\-/.]+)/g;

function referencedCurriculumIds(req: CompletionRequest): string[] {
  const found: string[] = [];
  const collect = (text: string): void => {
    for (const match of text.matchAll(CURRICULUM_REF)) {
      const id = match[1];
      if (id && !found.includes(id)) {
        found.push(id);
      }
    }
  };
  collect(req.prompt);
  for (const contextEntry of req.context ?? []) {
    collect(contextEntry.source.locator);
  }
  return found;
}

function localeAllowed(entry: TierZeroEntry, locale: string | undefined): boolean {
  if (!entry.locales || entry.locales.length === 0) {
    return true;
  }
  if (!locale) {
    return true;
  }
  const wanted = locale.toLowerCase();
  const primary = (wanted.split('-')[0] ?? wanted).toLowerCase();
  return entry.locales.some((candidate) => {
    const value = candidate.toLowerCase();
    return value === '*' || value === wanted || value === primary;
  });
}

/** The result shape for one cached lesson. Offline content costs no tokens. */
function toResult(entry: TierZeroEntry): CompletionResult {
  const lineage: SourceLineage[] = [
    {
      sourceId: entry.id,
      locator: `curriculum:${entry.id}`,
      licence: entry.licence,
      retrievedAt: entry.retrievedAt,
      tier: 1,
    },
  ];
  return {
    text: entry.body,
    providerId: TIER_ZERO_ID,
    modelId: TIER_ZERO_MODEL,
    usage: { inputTokens: 0, outputTokens: 0 },
    latencyMs: 0,
    sourceLineage: lineage,
  };
}

const WORD = /[a-z0-9]+/g;

/**
 * How well a cached lesson matches the learner's words.
 *
 * WHY relevance and not "first entry": serving an unrelated lesson is not a
 * fallback, it is a wrong answer. A zero score still returns a lesson (the
 * deterministic floor), but a topical match wins.
 */
function relevanceScore(entry: TierZeroEntry, prompt: string): number {
  const wanted = new Set(prompt.toLowerCase().match(WORD) ?? []);
  const offered = `${entry.id} ${entry.title}`.toLowerCase().match(WORD) ?? [];
  let score = 0;
  for (const word of offered) {
    if (wanted.has(word)) {
      score += 1;
    }
  }
  return score;
}

export function createTierZeroProvider(opts: TierZeroOptions = {}): TierZeroProviderImpl {
  const entries = opts.entries ?? DEFAULT_ENTRIES;
  const bundleIds = opts.bundleIds ?? DEFAULT_BUNDLE_IDS;

  /** Exact match on an explicit `curriculum:<id>` reference. */
  async function serveExact(
    policy: TaskPolicy,
    req: CompletionRequest,
  ): Promise<CompletionResult | null> {
    for (const id of referencedCurriculumIds(req)) {
      const entry = entries.find(
        (candidate) =>
          candidate.id === id &&
          candidate.taskClasses.includes(policy.taskClass) &&
          localeAllowed(candidate, req.locale ?? policy.locale),
      );
      if (entry) {
        return toResult(entry);
      }
    }
    return null;
  }

  return {
    id: TIER_ZERO_ID,
    modelId: TIER_ZERO_MODEL,

    async serve(policy: TaskPolicy, req: CompletionRequest): Promise<CompletionResult | null> {
      // Nothing cached for this task: the gateway must escalate.
      return serveExact(policy, req);
    },

    /**
     * Last resort, called by the gateway only after every model tier failed.
     * It re-tries the exact reference (cheap, and a caller may have added
     * context), then serves the most relevant cached lesson for the task class.
     */
    async serveFallback(
      policy: TaskPolicy,
      req: CompletionRequest,
    ): Promise<CompletionResult | null> {
      const exact = await serveExact(policy, req);
      if (exact) {
        return exact;
      }

      const candidates = entries.filter(
        (entry) =>
          entry.taskClasses.includes(policy.taskClass) &&
          localeAllowed(entry, req.locale ?? policy.locale),
      );
      if (candidates.length === 0) {
        return null;
      }

      const prompt = [req.prompt, ...(req.context ?? []).map((item) => item.source.locator)].join(' ');
      let best = candidates[0];
      let bestScore = -1;
      for (const entry of candidates) {
        const score = relevanceScore(entry, prompt);
        if (score > bestScore) {
          best = entry;
          bestScore = score;
        }
      }
      if (best === undefined) {
        return null;
      }

      const result = toResult(best);
      // The notice must not claim topical coverage the score does not support.
      const notice = bestScore > 0 ? TIER_ZERO_FALLBACK_NOTICE : TIER_ZERO_FALLBACK_UNRELATED_NOTICE;
      return { ...result, text: `${notice}\n\n${result.text}` };
    },

    bundles(): string[] {
      return [...bundleIds];
    },
  };
}
