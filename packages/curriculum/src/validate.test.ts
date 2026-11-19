import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePack, type ValidationIssue } from './index.js';

/**
 * A body that satisfies every content rule: over 120 characters, two paragraphs
 * separated by a blank line, no HTML, no internal ids, no personal data.
 * The first sentence carries the draft warning — the pack may not add a
 * top-level `note` field, so the warning lives in the lesson itself.
 */
const VALID_BODY =
  'A linear equation places an equals sign between two expressions that hold the same value. ' +
  'To find the unknown, undo each operation in reverse order, subtracting or dividing on both sides so the balance is kept.' +
  '\n\n' +
  'Once a value is found, substitute it into the original equation and check that both sides agree. ' +
  'That check catches arithmetic slips and confirms the result is genuine rather than assumed.';

const SINGLE_PARAGRAPH_BODY =
  'This body has enough characters to satisfy the minimum length rule but it contains only one paragraph with no blank line separating anything at all.';

function makeLesson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'algebra/linear-eq',
    title: 'Solving a linear equation',
    body: VALID_BODY,
    taskClasses: ['explain', 'solve'],
    keywords: ['algebra', 'equation', 'variable', 'unknown'],
    licence: 'CC-BY-4.0',
    retrievedAt: '2026-01-05T00:00:00.000Z',
    locales: ['en'],
    promptPatterns: ['\\d\\s*[a-z](?![a-z])'],
    ...overrides,
  };
}

function makePack(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    id: 'starter-core',
    version: '0.1.0-draft',
    locale: 'en',
    status: 'draft',
    reviewRequired: true,
    lessons: [makeLesson()],
    ...overrides,
  };
}

function paths(result: ReturnType<typeof validatePack>): readonly string[] {
  return result.ok ? [] : result.issues.map((issue: ValidationIssue) => issue.path);
}

function assertInvalid(result: ReturnType<typeof validatePack>, expectedPath: string): void {
  assert.equal(result.ok, false, 'expected the pack to be rejected');
  assert.ok(
    paths(result).includes(expectedPath),
    `expected an issue at "${expectedPath}", got ${JSON.stringify(paths(result))}`,
  );
}

// ---------------------------------------------------------------------------
// Top-level schema fields — each has a passing and a failing case.
// ---------------------------------------------------------------------------

test('validatePack: accepts a well-formed draft pack', () => {
  const result = validatePack(makePack());
  assert.equal(result.ok, true, JSON.stringify(paths(result)));
  if (result.ok) {
    assert.equal(result.pack.schemaVersion, 1);
    assert.equal(result.pack.lessons.length, 1);
  }
});

test('validatePack: rejects a non-object input', () => {
  assertInvalid(validatePack(null), 'input');
  assertInvalid(validatePack('not a pack'), 'input');
});

test('validatePack: rejects a schemaVersion other than 1', () => {
  assertInvalid(validatePack(makePack({ schemaVersion: 2 })), 'schemaVersion');
});

test('validatePack: rejects an empty id', () => {
  assertInvalid(validatePack(makePack({ id: '' })), 'id');
});

test('validatePack: rejects an empty version', () => {
  assertInvalid(validatePack(makePack({ version: '   ' })), 'version');
});

test('validatePack: rejects an empty locale', () => {
  assertInvalid(validatePack(makePack({ locale: '' })), 'locale');
});

test('validatePack: rejects an invalid status', () => {
  assertInvalid(validatePack(makePack({ status: 'published' })), 'status');
});

test('validatePack: rejects a non-boolean reviewRequired', () => {
  assertInvalid(validatePack(makePack({ reviewRequired: 'yes' })), 'reviewRequired');
});

test('validatePack: rejects an empty lessons array', () => {
  assertInvalid(validatePack(makePack({ lessons: [] })), 'lessons');
});

test('validatePack: rejects a non-array lessons value', () => {
  assertInvalid(validatePack(makePack({ lessons: {} })), 'lessons');
});

// ---------------------------------------------------------------------------
// Lesson identity.
// ---------------------------------------------------------------------------

test('validatePack: accepts a valid lesson id', () => {
  assert.equal(validatePack(makePack()).ok, true);
});

test('validatePack: rejects a malformed lesson id', () => {
  assertInvalid(validatePack(makePack({ lessons: [makeLesson({ id: 'AB' })] })), 'lessons[0].id');
  assertInvalid(validatePack(makePack({ lessons: [makeLesson({ id: 'a!' })] })), 'lessons[0].id');
});

test('validatePack: rejects duplicate lesson ids', () => {
  const duplicate = makeLesson({ id: 'algebra/linear-eq' });
  const result = validatePack(makePack({ lessons: [makeLesson(), duplicate] }));
  assert.equal(result.ok, false);
  assert.ok(paths(result).includes('lessons[1].id'), JSON.stringify(paths(result)));
});

test('validatePack: rejects a lesson that is not an object', () => {
  assertInvalid(validatePack(makePack({ lessons: [null] })), 'lessons[0]');
});

// ---------------------------------------------------------------------------
// Title and body.
// ---------------------------------------------------------------------------

test('validatePack: rejects an empty title', () => {
  assertInvalid(validatePack(makePack({ lessons: [makeLesson({ title: '' })] })), 'lessons[0].title');
});

test('validatePack: rejects a body shorter than 120 characters', () => {
  assertInvalid(
    validatePack(makePack({ lessons: [makeLesson({ body: 'Too short to be a real lesson.' })] })),
    'lessons[0].body',
  );
});

test('validatePack: accepts a body of at least 120 characters', () => {
  assert.ok(VALID_BODY.length >= 120);
  assert.equal(validatePack(makePack()).ok, true);
});

// ---------------------------------------------------------------------------
// Task classes.
// ---------------------------------------------------------------------------

test('validatePack: accepts all seven known task classes', () => {
  const known = ['explain', 'describe', 'summarise', 'solve', 'compare', 'list', 'define'];
  const result = validatePack(makePack({ lessons: [makeLesson({ taskClasses: known })] }));
  assert.equal(result.ok, true, JSON.stringify(paths(result)));
});

test('validatePack: rejects an empty taskClasses array', () => {
  assertInvalid(
    validatePack(makePack({ lessons: [makeLesson({ taskClasses: [] })] })),
    'lessons[0].taskClasses',
  );
});

test('validatePack: rejects an unknown task class', () => {
  assertInvalid(
    validatePack(makePack({ lessons: [makeLesson({ taskClasses: ['explain', 'quiz'] })] })),
    'lessons[0].taskClasses[1]',
  );
});

// ---------------------------------------------------------------------------
// Keywords.
// ---------------------------------------------------------------------------

test('validatePack: accepts strong single-term keywords', () => {
  const result = validatePack(
    makePack({ lessons: [makeLesson({ keywords: ['algebra', 'equation', 'coefficient'] })] }),
  );
  assert.equal(result.ok, true, JSON.stringify(paths(result)));
});

test('validatePack: rejects an empty keywords array', () => {
  assertInvalid(
    validatePack(makePack({ lessons: [makeLesson({ keywords: [] })] })),
    'lessons[0].keywords',
  );
});

test('validatePack: rejects a generic keyword', () => {
  for (const generic of ['solve', 'what', 'how', 'is', 'the']) {
    assertInvalid(
      validatePack(makePack({ lessons: [makeLesson({ keywords: [generic] })] })),
      'lessons[0].keywords[0]',
    );
  }
});

test('validatePack: rejects a keyword that is not a single term', () => {
  assertInvalid(
    validatePack(makePack({ lessons: [makeLesson({ keywords: ['linear equation'] })] })),
    'lessons[0].keywords[0]',
  );
});

// ---------------------------------------------------------------------------
// Prompt patterns.
// ---------------------------------------------------------------------------

test('validatePack: accepts compilable promptPatterns', () => {
  const result = validatePack(
    makePack({ lessons: [makeLesson({ promptPatterns: ['\\d+\\s*/\\s*\\d+', '^what is'] })] }),
  );
  assert.equal(result.ok, true, JSON.stringify(paths(result)));
});

test('validatePack: rejects an invalid promptPattern instead of ignoring it', () => {
  const result = validatePack(
    makePack({ lessons: [makeLesson({ promptPatterns: ['['] })] }),
  );
  assert.equal(result.ok, false);
  assert.ok(paths(result).includes('lessons[0].promptPatterns[0]'), JSON.stringify(paths(result)));
});

// ---------------------------------------------------------------------------
// Licence and retrieval timestamp.
// ---------------------------------------------------------------------------

test('validatePack: accepts a real licence', () => {
  assert.equal(validatePack(makePack()).ok, true);
});

test('validatePack: rejects an empty licence', () => {
  assertInvalid(validatePack(makePack({ lessons: [makeLesson({ licence: '' })] })), 'lessons[0].licence');
});

test('validatePack: rejects an unknown licence', () => {
  assertInvalid(
    validatePack(makePack({ lessons: [makeLesson({ licence: 'UNKNOWN' })] })),
    'lessons[0].licence',
  );
});

test('validatePack: accepts a parseable ISO retrievedAt', () => {
  assert.equal(validatePack(makePack()).ok, true);
});

test('validatePack: rejects an unparseable retrievedAt', () => {
  assertInvalid(
    validatePack(makePack({ lessons: [makeLesson({ retrievedAt: 'yesterday' })] })),
    'lessons[0].retrievedAt',
  );
});

// ---------------------------------------------------------------------------
// Locales.
// ---------------------------------------------------------------------------

test('validatePack: accepts valid BCP-47-like locale tags', () => {
  const result = validatePack(
    makePack({ lessons: [makeLesson({ locales: ['en', 'en-US', 'fr'] })] }),
  );
  assert.equal(result.ok, true, JSON.stringify(paths(result)));
});

test('validatePack: rejects an empty locales array when present', () => {
  assertInvalid(
    validatePack(makePack({ lessons: [makeLesson({ locales: [] })] })),
    'lessons[0].locales',
  );
});

test('validatePack: rejects a malformed locale tag', () => {
  assertInvalid(
    validatePack(makePack({ lessons: [makeLesson({ locales: ['not a tag'] })] })),
    'lessons[0].locales[0]',
  );
});

// ---------------------------------------------------------------------------
// Accessibility completeness of the body.
// ---------------------------------------------------------------------------

test('validatePack: rejects a body containing raw HTML tags', () => {
  assertInvalid(
    validatePack(makePack({ lessons: [makeLesson({ body: VALID_BODY + ' <b>note</b>' })] })),
    'lessons[0].body',
  );
});

test('validatePack: rejects a body containing an internal curriculum id', () => {
  assertInvalid(
    validatePack(
      makePack({ lessons: [makeLesson({ body: VALID_BODY + ' See curriculum:algebra/linear-eq.' })] }),
    ),
    'lessons[0].body',
  );
});

test('validatePack: rejects a body without two paragraphs', () => {
  assertInvalid(
    validatePack(makePack({ lessons: [makeLesson({ body: SINGLE_PARAGRAPH_BODY })] })),
    'lessons[0].body',
  );
});

test('validatePack: accepts a two-paragraph body', () => {
  assert.ok(VALID_BODY.split(/\n\s*\n/).filter((part) => part.trim().length > 0).length >= 2);
  assert.equal(validatePack(makePack()).ok, true);
});

// ---------------------------------------------------------------------------
// No personal data (strings built at runtime — no literal secrets in this file).
// ---------------------------------------------------------------------------

test('validatePack: rejects a pack containing an email address', () => {
  const email = ['reader', '@', 'school', '.', 'org'].join('');
  assertInvalid(
    validatePack(makePack({ lessons: [makeLesson({ body: VALID_BODY + ' Write to ' + email + '.' })] })),
    '$.email',
  );
});

test('validatePack: rejects a pack containing an API-key-shaped string built at runtime', () => {
  const secret = ['sk', '-', 'proj', 'A1b2C3d4E5f6G7h8I9j0'].join('');
  assertInvalid(
    validatePack(makePack({ lessons: [makeLesson({ body: VALID_BODY + ' Token ' + secret + '.' })] })),
    '$.secretKey',
  );
});

// ---------------------------------------------------------------------------
// Signature presence/shape (cryptographic verification stays in onekey).
// ---------------------------------------------------------------------------

test('validatePack: accepts an unsigned draft pack', () => {
  const result = validatePack(makePack());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.pack.signature, undefined);
});

test('validatePack: accepts a reviewed pack that carries a signature', () => {
  const result = validatePack(makePack({ status: 'reviewed', signature: 'c2lnbmF0dXJlLQ=='.repeat(2) }));
  assert.equal(result.ok, true, JSON.stringify(paths(result)));
  if (result.ok) assert.equal(result.pack.status, 'reviewed');
});

test('validatePack: rejects a reviewed pack with no signature', () => {
  assertInvalid(validatePack(makePack({ status: 'reviewed' })), 'signature');
});

test('validatePack: rejects a non-string signature when one is present', () => {
  assertInvalid(validatePack(makePack({ signature: 12345 })), 'signature');
});
