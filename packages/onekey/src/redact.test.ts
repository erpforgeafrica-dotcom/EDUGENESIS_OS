import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecret } from './redact.js';

test('redact: a bearer token is masked', () => {
  const redacted = redactSecret('request failed with header Authorization: Bearer abc123def456ghi');
  assert.doesNotMatch(redacted, /abc123def456ghi/);
  assert.match(redacted, /\[redacted\]/);
});

test('redact: a key assignment is masked', () => {
  const redacted = redactSecret('config api_key=sk-notreal-1234567890 for the provider');
  assert.doesNotMatch(redacted, /sk-notreal-1234567890/);
});

test('redact: a vendor prefixed key is masked', () => {
  const redacted = redactSecret('failed with key sk-proj-ABCDEFGH12345678');
  assert.doesNotMatch(redacted, /sk-proj-ABCDEFGH12345678/);
});

test('redact: a token field is masked', () => {
  const redacted = redactSecret('{"token": "abcdef1234567890"}');
  assert.doesNotMatch(redacted, /abcdef1234567890/);
});

test('redact: ordinary audit text is left intact', () => {
  const original = 'the provider failed: connection reset by peer after 3 retries';
  assert.equal(redactSecret(original), original);
});
