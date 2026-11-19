import type { CurriculumPack, ValidationIssue, ValidationResult } from './pack.js';

/** The only task classes a pack may declare (the Tier 0 vocabulary). */
const KNOWN_TASK_CLASSES = new Set([
  'explain',
  'describe',
  'summarise',
  'solve',
  'compare',
  'list',
  'define',
]);

/**
 * Generic verbs, articles and question words are not "strong" keywords: they
 * pull unrelated questions into a lesson (the false-coverage bug onekey's
 * tier-zero already guards against). Kept consistent with its stopword list.
 */
const GENERIC_TERMS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'to', 'of', 'in', 'on', 'at', 'by',
  'for', 'with', 'from', 'about', 'into', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'am', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'do', 'does', 'did',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'i', 'you', 'he',
  'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our',
  'their', 'this', 'that', 'these', 'those', 'there', 'here', 'one', 'two', 'three', 'some', 'any',
  'all', 'each', 'every', 'more', 'most', 'other', 'another', 'same', 'again', 'very', 'just',
  'also', 'solve', 'explain', 'describe', 'tell', 'lesson', 'lessons', 'question', 'questions',
  'mean', 'means',
]);

const LESSON_ID_RE = /^[a-z0-9][a-z0-9/_-]{2,63}$/;
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const SECRET_RE = /sk-[A-Za-z0-9_-]{4,}/i;
const HTML_TAG_RE = /<\/?[A-Za-z][^>]*>/;
const INTERNAL_ID_RE = /curriculum\s*:/i;
const WHITESPACE_RE = /\s/;

type IssueSink = (path: string, message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Collect every string in a JSON-shaped value (keys and values) for the PII scan. */
function collectStrings(value: unknown, sink: string[], seen: WeakSet<object>): void {
  if (typeof value === 'string') {
    sink.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, sink, seen);
    }
    return;
  }
  if (isRecord(value)) {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      sink.push(key);
      collectStrings(child, sink, seen);
    }
  }
}

/** Accessibility/content-shape checks the pack validator owns. */
function validateBody(body: unknown, basePath: string, add: IssueSink): void {
  const path = `${basePath}.body`;
  if (!isNonEmptyString(body)) {
    add(path, 'body must be a non-empty string');
    return;
  }
  if (body.length < 120) {
    add(path, 'body must be at least 120 characters (a real lesson, not a placeholder)');
    return;
  }
  if (HTML_TAG_RE.test(body)) {
    add(path, 'body must not contain raw HTML tags');
  }
  if (INTERNAL_ID_RE.test(body)) {
    add(path, 'body must not contain internal ids such as "curriculum:"');
  }
  const paragraphs = body.split(/\n\s*\n/).filter((part) => part.trim().length > 0);
  if (paragraphs.length < 2) {
    add(path, 'body must have at least two paragraphs separated by a blank line');
  }
}

/** Validate one lesson; all discovered issues are reported, not fail-fast. */
function validateLesson(rawLesson: unknown, index: number, seenIds: Set<string>, add: IssueSink): void {
  const base = `lessons[${index}]`;
  if (!isRecord(rawLesson)) {
    add(base, 'lesson must be an object');
    return;
  }

  const id = rawLesson.id;
  if (!isNonEmptyString(id) || !LESSON_ID_RE.test(id)) {
    add(`${base}.id`, 'id must match /^[a-z0-9][a-z0-9/_-]{2,63}$/');
  } else {
    if (seenIds.has(id)) {
      add(`${base}.id`, 'lesson ids must be unique');
    }
    seenIds.add(id);
  }

  if (!isNonEmptyString(rawLesson.title)) {
    add(`${base}.title`, 'title must be a non-empty string');
  }

  validateBody(rawLesson.body, base, add);

  if (!Array.isArray(rawLesson.taskClasses) || rawLesson.taskClasses.length === 0) {
    add(`${base}.taskClasses`, 'taskClasses must be a non-empty array');
  } else {
    rawLesson.taskClasses.forEach((taskClass, position) => {
      if (typeof taskClass !== 'string' || !KNOWN_TASK_CLASSES.has(taskClass)) {
        add(`${base}.taskClasses[${position}]`, `unknown task class: ${String(taskClass)}`);
      }
    });
  }

  if (!Array.isArray(rawLesson.keywords) || rawLesson.keywords.length === 0) {
    add(`${base}.keywords`, 'keywords must be a non-empty array');
  } else {
    rawLesson.keywords.forEach((keyword, position) => {
      const path = `${base}.keywords[${position}]`;
      if (!isNonEmptyString(keyword)) {
        add(path, 'keyword must be a non-empty string');
        return;
      }
      if (WHITESPACE_RE.test(keyword)) {
        add(path, 'keyword must be a single term');
        return;
      }
      if (GENERIC_TERMS.has(keyword.toLowerCase())) {
        add(path, `generic keyword is not a strong term: ${keyword}`);
      }
    });
  }

  if (rawLesson.promptPatterns !== undefined) {
    if (!Array.isArray(rawLesson.promptPatterns)) {
      add(`${base}.promptPatterns`, 'promptPatterns must be an array of RegExp sources');
    } else {
      rawLesson.promptPatterns.forEach((pattern, position) => {
        const path = `${base}.promptPatterns[${position}]`;
        if (typeof pattern !== 'string') {
          add(path, 'promptPattern must be a string');
          return;
        }
        try {
          new RegExp(pattern);
        } catch {
          add(path, 'promptPattern is not a valid RegExp source');
        }
      });
    }
  }

  const licence = rawLesson.licence;
  if (!isNonEmptyString(licence) || licence.toLowerCase() === 'unknown') {
    add(`${base}.licence`, 'licence must be a non-empty value other than "unknown"');
  }

  const retrievedAt = rawLesson.retrievedAt;
  if (
    !isNonEmptyString(retrievedAt) ||
    !ISO_DATE_RE.test(retrievedAt) ||
    Number.isNaN(Date.parse(retrievedAt))
  ) {
    add(`${base}.retrievedAt`, 'retrievedAt must be a parseable ISO date');
  }

  if (rawLesson.locales !== undefined) {
    if (!Array.isArray(rawLesson.locales) || rawLesson.locales.length === 0) {
      add(`${base}.locales`, 'locales must be a non-empty array when present');
    } else {
      rawLesson.locales.forEach((locale, position) => {
        if (typeof locale !== 'string' || !LOCALE_RE.test(locale)) {
          add(`${base}.locales[${position}]`, 'locale must be a non-empty BCP-47-like tag');
        }
      });
    }
  }
}

/**
 * Validate an unknown value as a curriculum pack.
 *
 * Cryptographic signature VERIFICATION remains in onekey's Ed25519 verifier;
 * this validator only checks that a reviewed pack carries a non-empty string
 * signature and that a signature, when present, has the right shape.
 */
export function validatePack(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add: IssueSink = (path, message) => {
    issues.push({ path, message });
  };

  // Personal-data / secret scan across the whole JSON structure. Test fixtures
  // build these strings at runtime, so no literal secret lives in the source.
  const strings: string[] = [];
  collectStrings(input, strings, new WeakSet<object>());
  if (strings.some((text) => EMAIL_RE.test(text))) {
    add('$.email', 'pack must not contain email addresses (personal data)');
  }
  if (strings.some((text) => SECRET_RE.test(text))) {
    add('$.secretKey', 'pack must not contain API-key-shaped strings (sk-...)');
  }

  if (!isRecord(input)) {
    add('input', 'pack must be an object');
    return { ok: false, issues };
  }

  if (input.schemaVersion !== 1) {
    add('schemaVersion', 'schemaVersion must be exactly 1');
  }
  if (!isNonEmptyString(input.id)) {
    add('id', 'id must be a non-empty string');
  }
  if (!isNonEmptyString(input.version)) {
    add('version', 'version must be a non-empty string');
  }
  if (!isNonEmptyString(input.locale)) {
    add('locale', 'locale must be a non-empty string');
  }
  if (input.status !== 'draft' && input.status !== 'reviewed') {
    add('status', 'status must be "draft" or "reviewed"');
  }
  if (typeof input.reviewRequired !== 'boolean') {
    add('reviewRequired', 'reviewRequired must be a boolean');
  }

  if (input.signature !== undefined && !isNonEmptyString(input.signature)) {
    add('signature', 'signature, when present, must be a non-empty string');
  }
  if (input.status === 'reviewed' && !isNonEmptyString(input.signature)) {
    add('signature', 'a reviewed pack must carry a non-empty signature');
  }

  if (!Array.isArray(input.lessons) || input.lessons.length === 0) {
    add('lessons', 'lessons must be a non-empty array');
  } else {
    const seenIds = new Set<string>();
    input.lessons.forEach((lesson, index) => {
      validateLesson(lesson, index, seenIds, add);
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, pack: input as unknown as CurriculumPack };
}
