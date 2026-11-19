import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadPack,
  validatePack,
  toTierZeroEntries,
  type CurriculumPack,
  type CurriculumLesson,
} from './index.js';

const PACK_PATH = fileURLToPath(new URL('../packs/starter-core-v1.json', import.meta.url));
const rawPack = readFileSync(PACK_PATH, 'utf8');

const BODY =
  'A cell is the smallest unit that carries out the processes of life. Animal and plant cells share a membrane, cytoplasm, and a nucleus that holds instructions.' +
  '\n\n' +
  'Plant cells also have a rigid cell wall and chloroplasts that capture light. These parts work together so the cell can take in nutrients and release energy.';

test('validatePack: accepts the shipped starter pack', () => {
  const result = validatePack(JSON.parse(rawPack));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.issues));
  if (result.ok) {
    assert.equal(result.pack.schemaVersion, 1);
    assert.equal(result.pack.status, 'draft');
    assert.equal(result.pack.reviewRequired, true);
    assert.ok(result.pack.lessons.length >= 8, 'the starter pack must cover the pilot subjects');
  }
});

test('loadPack: loads the shipped starter pack into a valid pack', () => {
  const result = loadPack(rawPack);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.issues));
  if (result.ok) {
    assert.equal(result.pack.lessons.length >= 8, true);
    assert.equal(result.pack.locale, 'en');
  }
});

test('loadPack: rejects malformed JSON with a path issue', () => {
  const result = loadPack('{ this is not json');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.length >= 1);
    assert.equal(typeof result.issues[0]?.path, 'string');
    assert.ok((result.issues[0]?.path ?? '').length > 0, 'a parse issue must carry a path');
    assert.match(result.issues[0]?.message ?? '', /json/i);
  }
});

test('loadPack: rejects an empty string with a path issue', () => {
  const result = loadPack('');
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok((result.issues[0]?.path ?? '').length > 0);
});

test('loadPack: applies pack validation after parsing', () => {
  const invalid = { ...JSON.parse(rawPack), schemaVersion: 9 };
  const result = loadPack(JSON.stringify(invalid));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.path === 'schemaVersion'));
  }
});

test('toTierZeroEntries: maps every field including promptPatterns', () => {
  const loaded = loadPack(rawPack);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const entries = toTierZeroEntries(loaded.pack);
  assert.equal(entries.length, loaded.pack.lessons.length);

  for (let i = 0; i < loaded.pack.lessons.length; i += 1) {
    const lesson: CurriculumLesson | undefined = loaded.pack.lessons[i];
    const entry = entries[i];
    assert.equal(entry?.id, lesson?.id);
    assert.equal(entry?.title, lesson?.title);
    assert.equal(entry?.body, lesson?.body);
    assert.equal(entry?.licence, lesson?.licence);
    assert.equal(entry?.retrievedAt, lesson?.retrievedAt);
    assert.deepEqual(entry?.taskClasses, lesson?.taskClasses);
    assert.deepEqual(entry?.keywords, lesson?.keywords);
    assert.deepEqual(entry?.locales, lesson?.locales);
    assert.deepEqual(entry?.promptPatterns, lesson?.promptPatterns);
  }

  const algebra = entries.find((entry) => entry.id === 'algebra/linear-eq');
  assert.ok(algebra?.promptPatterns && algebra.promptPatterns.length >= 2);
  const fractions = entries.find((entry) => entry.id === 'math/fractions-basics');
  assert.ok(fractions?.promptPatterns && fractions.promptPatterns.length >= 2);
});

test('toTierZeroEntries: omits optional fields when the lesson has none', () => {
  const pack: CurriculumPack = {
    schemaVersion: 1,
    id: 'minimal',
    version: '0.1.0',
    locale: 'en',
    status: 'draft',
    reviewRequired: false,
    lessons: [
      {
        id: 'biology/cell-test',
        title: 'Cell structure',
        body: BODY,
        taskClasses: ['describe'],
        keywords: ['cell', 'nucleus', 'membrane'],
        licence: 'CC-BY-4.0',
        retrievedAt: '2026-01-05T00:00:00.000Z',
      },
    ],
  };

  const entry = toTierZeroEntries(pack)[0];
  assert.ok(entry !== undefined);
  assert.equal('locales' in entry, false);
  assert.equal('promptPatterns' in entry, false);
  assert.deepEqual(entry.keywords, ['cell', 'nucleus', 'membrane']);
});
