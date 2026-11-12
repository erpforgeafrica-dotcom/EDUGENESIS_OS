/**
 * Canonical content hashing — RED-phase specification.
 *
 * ARC-I9 is a tamper and drift check: `metadata.content_hash` must match the
 * canonical content bytes (07 §5.3). A hash that depends on key insertion
 * order would raise false drift alarms, so the content is canonicalised
 * (sorted keys, stable array order) before hashing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { CanonicalContent } from '@edugenesis/contracts';

import { canonicaliseContent, hashCanonicalContent } from './content-hash.js';

const CONTENT: CanonicalContent = {
  contentId: 'ct-0001',
  body: 'Current leaves the battery and returns to it.',
  modality: 'text',
  media_bytes_total: 41_200,
  payload: { unit: 'ampere', steps: ['a', 'b'] },
};

describe('canonical content hashing', () => {
  test('produces a sha256 digest in the documented shape', () => {
    const hash = hashCanonicalContent(CONTENT);
    assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  });

  test('is stable across key insertion order', () => {
    const reordered: CanonicalContent = {
      payload: { steps: ['a', 'b'], unit: 'ampere' },
      media_bytes_total: 41_200,
      modality: 'text',
      body: 'Current leaves the battery and returns to it.',
      contentId: 'ct-0001',
    };
    assert.equal(hashCanonicalContent(reordered), hashCanonicalContent(CONTENT));
  });

  test('is stable across key order inside the payload', () => {
    const a: CanonicalContent = { ...CONTENT, payload: { x: 1, y: { p: 1, q: 2 } } };
    const b: CanonicalContent = { ...CONTENT, payload: { y: { q: 2, p: 1 }, x: 1 } };
    assert.equal(hashCanonicalContent(a), hashCanonicalContent(b));
  });

  test('keeps array order significant', () => {
    const a: CanonicalContent = { ...CONTENT, payload: { steps: ['a', 'b'] } };
    const b: CanonicalContent = { ...CONTENT, payload: { steps: ['b', 'a'] } };
    assert.notEqual(hashCanonicalContent(a), hashCanonicalContent(b));
  });

  test('changes the digest when the content is tampered with', () => {
    const tampered: CanonicalContent = { ...CONTENT, body: 'Current leaves the battery and stops.' };
    assert.notEqual(hashCanonicalContent(tampered), hashCanonicalContent(CONTENT));
  });

  test('changes the digest when the media size drifts', () => {
    const drifted: CanonicalContent = { ...CONTENT, media_bytes_total: 41_201 };
    assert.notEqual(hashCanonicalContent(drifted), hashCanonicalContent(CONTENT));
  });

  test('ignores undefined properties rather than hashing them', () => {
    const withUndefined: CanonicalContent = { ...CONTENT, payload: { unit: 'ampere', steps: ['a', 'b'], extra: undefined } };
    assert.equal(hashCanonicalContent(withUndefined), hashCanonicalContent(CONTENT));
  });

  test('canonicalises to a deterministic text form', () => {
    const text = canonicaliseContent(CONTENT);
    assert.equal(text, canonicaliseContent({ ...CONTENT }));
    assert.ok(text.startsWith('{'));
    assert.ok(text.includes('"contentId":"ct-0001"'));
  });

  test('refuses to hash a value that cannot be serialised canonically', () => {
    const broken: CanonicalContent = {
      ...CONTENT,
      payload: { handler: (() => 'not serialisable') as unknown },
    };
    assert.throws(() => hashCanonicalContent(broken), /cannot be canonicalised/i);
  });
});
