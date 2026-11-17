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
  /**
   * Learner vocabulary this lesson accepts, scored exactly like title words.
   * It exists because a learner does not use the catalogue's words: "solve for
   * x" never says "linear" or "equation". Keep the aliases STRONG terms only -
   * a generic verb such as "solve" would pull unrelated questions into the
   * lesson (the false-coverage bug class this file already guards against).
   */
  keywords?: string[];
  /**
   * Regular-expression sources that identify a question about this lesson by
   * its FORM rather than its words - "2x + 3 = 11" is an algebra question
   * without naming algebra. Scored above a single word match. Invalid sources
   * are ignored rather than thrown, because content data must never crash a
   * learner request.
   */
  promptPatterns?: string[];
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
 *
 * WHY it says learning CONTINUES and that sponsors are notified: that is
 * §6.6 step 6 — the learner-facing message must state that core learning
 * continues and that sponsors are being notified, never that credits ran out
 * or that a provider failed (audit finding F3-17). The old wording ("Here is
 * a lesson from your offline library that covers this topic") said neither,
 * and it framed the answer as material pulled from a fallback store — the
 * degraded framing the spec forbids.
 */
export const TIER_ZERO_FALLBACK_NOTICE =
  'Core learning continues. Here is a lesson on the same topic as your question. The sponsors of this programme have been notified.';

/**
 * The notice for a fallback whose best candidate shares NO word with the task.
 *
 * WHY TWO NOTICES: the original notice asserted topical coverage
 * unconditionally, so a learner who asked about the water cycle could be
 * served an algebra lesson that CLAIMED to cover their question. The claim is
 * now made only when the relevance score says there is a topical match.
 *
 * WHY THIS NOTICE PROMISES NO LESSON: it opens the curriculum-gap answer, which
 * then says there is no lesson on the topic yet. The first live deploy after
 * the stopword fix opened that answer with "Here is a lesson from this
 * programme to work through" and contradicted itself in the next sentence.
 * A precise message says only what is true: learning continues, and sponsors
 * are notified (Doc 16 §6.6 step 6).
 */
export const TIER_ZERO_FALLBACK_UNRELATED_NOTICE =
  'Core learning continues. The sponsors of this programme have been notified.';

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
    keywords: ['algebra', 'equation', 'variable', 'unknown', 'x'],
    // "2x + 3 = 11" and "x = 5" are algebra questions that never say "algebra".
    promptPatterns: ['\\d\\s*[a-z](?![a-z])', '[a-z]\\s*=\\s*[-+]?\\d'],
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
 * Common words are not evidence of a topic. "what is a EduGenesis?" shares
 * "a" with "Solving a linear equation"; counting that as a match is how an
 * unrelated lesson was served with a "same topic" claim (owner screenshots,
 * 2026-11-16). Both sides of the comparison are filtered.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'to', 'of', 'in', 'on', 'at', 'by', 'for',
  'with', 'from', 'about', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'what', 'which',
  'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'do', 'does', 'did', 'can', 'could', 'would',
  'should', 'will', 'shall', 'may', 'might', 'must', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me',
  'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'this', 'that', 'these',
  'those', 'there', 'here', 'one', 'two', 'three', 'some', 'any', 'all', 'each', 'every', 'more',
  'most', 'other', 'another', 'same', 'as', 'into', 'over', 'under', 'again', 'very', 'just', 'also',
  'explain', 'describe', 'tell', 'lesson', 'lessons', 'question', 'questions', 'mean', 'means',
]);

/** A deliberately simple singular form: "fractions" and "fraction" must meet. */
function normalizeWord(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? [])
    .filter((word) => !STOPWORDS.has(word))
    .map(normalizeWord);
}

/**
 * How well a cached lesson matches the learner's words.
 *
 * WHY RELEVANCE AND NOT "FIRST ENTRY": serving an unrelated lesson is not a
 * fallback, it is a wrong answer. Only CONTENT words count — a stopword match
 * is not a topic match (the "a" bug), and singular/plural forms are equal, so
 * "What is a fraction?" reaches "Fractions basics" instead of whichever
 * lesson happens to carry an "a". A score of ZERO now selects the honest
 * curriculum-gap lesson in `serveFallback`, never a cached subject lesson.
 */
function relevanceScore(entry: TierZeroEntry, prompt: string): number {
  const wanted = new Set(contentWords(prompt));
  const aliases = (entry.keywords ?? []).join(' ');
  const offered = contentWords(`${entry.id} ${entry.title} ${aliases}`);
  let score = 0;
  for (const word of offered) {
    if (wanted.has(word)) {
      score += 1;
    }
  }
  // A form match is stronger evidence than one shared word: "2x + 3 = 11" is
  // about this lesson even though it shares no title word with it.
  for (const source of entry.promptPatterns ?? []) {
    try {
      if (new RegExp(source, 'i').test(prompt)) {
        score += 2;
      }
    } catch {
      // Content data must never break a learner request.
    }
  }
  return score;
}

/**
 * The honest answer when NO cached lesson is on the learner's topic.
 *
 * "Core learning is never denied" must not become "serve an unrelated maths
 * lesson with a disclaimer" (gap-register F3-04; owner screenshots). This is
 * a usable lesson in its own right: it states the gap plainly, names the
 * topics that ARE available, and gives the learner a next step. It claims no
 * false lineage — no source was used, so `sourceLineage` is empty. The notice
 * keeps Doc 16 §6.6 step 6: core learning continues, sponsors are notified.
 */
function curriculumGapLesson(candidates: readonly TierZeroEntry[]): CompletionResult {
  const titles = candidates.map((candidate) => candidate.title).join('; ');
  return {
    text:
      `${TIER_ZERO_FALLBACK_UNRELATED_NOTICE}\n\n` +
      `This programme's lesson collection does not have a lesson on this topic yet. ` +
      `These lessons are available now: ${titles}. ` +
      `Ask about one of them, or try a more specific question.`,
    providerId: TIER_ZERO_ID,
    modelId: TIER_ZERO_MODEL,
    usage: { inputTokens: 0, outputTokens: 0 },
    latencyMs: 0,
    sourceLineage: [],
  };
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
      // A zero score means NO cached lesson is on this topic. Serving one
      // anyway with a disclaimer is a wrong answer (F3-04), so the honest
      // curriculum-gap lesson is served instead: the learner still learns
      // something true and useful, and is never denied.
      if (bestScore === 0) {
        return curriculumGapLesson(candidates);
      }
      return { ...result, text: `${TIER_ZERO_FALLBACK_NOTICE}\n\n${result.text}` };
    },

    bundles(): string[] {
      return [...bundleIds];
    },
  };
}
