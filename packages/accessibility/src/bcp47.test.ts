/**
 * BCP-47 tag validation — RED-phase specification.
 *
 * ARC-I5 requires `language.primary` to be a *valid* BCP-47 tag, so the
 * validator must reject nonsense rather than accept it with a loose pattern
 * (07 §5.3 ARC-I5; RFC 5646).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalizeBcp47, isValidBcp47, parseBcp47 } from './bcp47.js';

const VALID_TAGS: readonly string[] = [
  'en',
  'fr',
  'en-US',
  'en-GB',
  'es-419',
  'zh-Hans',
  'zh-Hant',
  'zh-Hans-CN',
  'zh-Hant-TW',
  'sr-Latn-RS',
  'de-CH-1901',
  'en-GB-oxendict',
  'zh-cmn-Hans-CN',
  'en-US-u-islamcal',
  'de-DE-x-goethe',
  'x-private',
  'i-klingon',
  'en-GB-oed',
];

const INVALID_TAGS: readonly string[] = [
  '',
  '   ',
  'e',
  'en-',
  '-en',
  'en--US',
  'en-GB-',
  'englishish',
  'abcdefghijk',
  'en-GB-abcdefghi',
  'en-GB-abc',
  'en-GB-abcd',
  'en-4',
  'en-U',
  'en-US-x',
  '123',
  'en@US',
  'en US',
  'en-US-',
];

describe('BCP-47 validation', () => {
  test('accepts every well-formed tag in the valid table', () => {
    for (const tag of VALID_TAGS) {
      assert.equal(isValidBcp47(tag), true, `expected "${tag}" to be valid`);
      const parsed = parseBcp47(tag);
      assert.equal(parsed.ok, true, `expected "${tag}" to parse`);
    }
  });

  test('rejects every malformed tag in the invalid table', () => {
    for (const tag of INVALID_TAGS) {
      assert.equal(isValidBcp47(tag), false, `expected "${tag}" to be rejected`);
      const parsed = parseBcp47(tag);
      assert.equal(parsed.ok, false, `expected "${tag}" to fail parsing`);
      if (!parsed.ok) {
        assert.ok(parsed.error.length > 0, 'a rejection must explain itself');
      }
    }
  });

  test('rejects an empty tag outright', () => {
    assert.equal(isValidBcp47(''), false);
    const parsed = parseBcp47('');
    assert.equal(parsed.ok, false);
  });

  test('rejects an over-long language subtag', () => {
    // RFC 5646 caps a language subtag at 8 characters.
    assert.equal(isValidBcp47('englishish'), false);
    assert.equal(isValidBcp47('abcdefgh'), true, '8 characters is the maximum');
  });

  test('rejects an over-long variant subtag', () => {
    assert.equal(isValidBcp47('en-GB-abcdefghi'), false, '9 characters is over the limit');
    assert.equal(isValidBcp47('en-GB-oxendict'), true, '8 characters is allowed');
  });

  test('rejects malformed subtags rather than repairing them', () => {
    for (const tag of ['en-4', 'en-U', 'en-GB-abcd', 'en@US', 'en US']) {
      assert.equal(isValidBcp47(tag), false, `expected "${tag}" to be rejected`);
    }
  });

  test('parses the structural parts of a langtag', () => {
    const parsed = parseBcp47('zh-Hant-TW');
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.tag.language, 'zh');
    assert.equal(parsed.tag.script, 'Hant');
    assert.equal(parsed.tag.region, 'TW');
    assert.deepEqual(parsed.tag.variants, []);
  });

  test('parses a numeric region and a variant', () => {
    const parsed = parseBcp47('es-419');
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.tag.region, '419');

    const withVariant = parseBcp47('de-CH-1901');
    assert.equal(withVariant.ok, true);
    if (!withVariant.ok) return;
    assert.deepEqual(withVariant.tag.variants, ['1901']);
  });

  test('parses an extension and a private-use sequence', () => {
    const extended = parseBcp47('en-US-u-islamcal');
    assert.equal(extended.ok, true);
    if (!extended.ok) return;
    assert.equal(extended.tag.extensions.length, 1);
    assert.equal(extended.tag.extensions[0]?.singleton, 'u');
    assert.deepEqual(extended.tag.extensions[0]?.subtags, ['islamcal']);

    const privateUse = parseBcp47('de-DE-x-goethe');
    assert.equal(privateUse.ok, true);
    if (!privateUse.ok) return;
    assert.deepEqual(privateUse.tag.privateUse, ['goethe']);
  });

  test('canonicalises case without changing the tag identity', () => {
    assert.equal(canonicalizeBcp47('EN-us'), 'en-US');
    assert.equal(canonicalizeBcp47('zh-hans-cn'), 'zh-Hans-CN');
    assert.equal(canonicalizeBcp47('sr-latn-rs'), 'sr-Latn-RS');
    assert.equal(canonicalizeBcp47('en-us-u-islamcal'), 'en-US-u-islamcal');
  });

  test('returns null when a tag cannot be canonicalised', () => {
    assert.equal(canonicalizeBcp47('not a tag'), null);
    assert.equal(canonicalizeBcp47(''), null);
  });

  test('accepts grandfathered tags that do not match the langtag grammar', () => {
    assert.equal(isValidBcp47('i-klingon'), true);
    assert.equal(isValidBcp47('en-GB-oed'), true);
    assert.equal(isValidBcp47('zh-min-nan'), true);
  });
});
