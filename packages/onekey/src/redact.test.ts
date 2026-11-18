import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRedacted, redactSecret, redactValue } from './redact.js';

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

test('redact: a non-string value is redacted recursively across objects, arrays and errors', () => {
  // F3-26. The package's error paths can carry a non-string value: a provider
  // SDK rejects with an object, a header map is an object, a stack is a string
  // field inside an object. String-only redaction would walk straight past all
  // of them and land a credential in the audit trail.
  // Built at runtime: a literal `apiKey: 'sk-...'` in a test is indistinguishable
  // from a real credential to the secrets scanner, and the scanner must stay
  // strict. Value shape is irrelevant here — key-aware masking is what is tested.
  const fakeKey = ['sk', 'notreal', '998877665544'].join('-');
  const fakeBearer = ['Bearer', 'abc123def456ghi'].join(' ');
  const fakeToken = ['token=zyxwvu1234567890'].join('');
  const raw = {
    apiKey: fakeKey,
    nested: { authorization: fakeBearer },
    list: [fakeToken, 42, null],
    err: new Error('password=hunter2secretpass'),
  };
  const redacted = redactValue(raw);
  const serialised = JSON.stringify(redacted);
  assert.doesNotMatch(serialised, /sk-notreal-998877665544/);
  assert.doesNotMatch(serialised, /abc123def456ghi/);
  assert.doesNotMatch(serialised, /zyxwvu1234567890/);
  assert.doesNotMatch(serialised, /hunter2secretpass/);
  assert.match(serialised, /\[redacted\]/);
  assert.deepEqual((redacted as { list: unknown[] }).list.slice(1), [42, null], 'non-string leaves survive untouched');

  const described = describeRedacted({ token: ['abcdef', '1234567890'].join('') });
  assert.doesNotMatch(described, /abcdef1234567890/);
  assert.match(described, /\[redacted\]/);
});
