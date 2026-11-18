import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password.js';

test('hashPassword produces a parseable scrypt envelope with default parameters', () => {
  const stored = hashPassword('correct horse battery staple');
  const parts = stored.split('$');
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'scrypt');
  assert.equal(parts[1], '16384');
  assert.equal(parts[2], '8');
  assert.equal(parts[3], '1');
  assert.ok((parts[4] ?? '').length > 0, 'salt is present');
  assert.ok((parts[5] ?? '').length > 0, 'hash is present');
});

test('hashPassword salts: the same password twice yields different stored strings', () => {
  const a = hashPassword('same-password');
  const b = hashPassword('same-password');
  assert.notEqual(a, b);
});

test('verifyPassword accepts the correct password', () => {
  const stored = hashPassword('s3cret');
  assert.equal(verifyPassword('s3cret', stored), true);
});

test('verifyPassword rejects a wrong password', () => {
  const stored = hashPassword('s3cret');
  assert.equal(verifyPassword('wrong', stored), false);
});

test('verifyPassword returns false for malformed stored values without throwing', () => {
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', 'not-a-hash'), false);
  assert.equal(verifyPassword('x', 'bcrypt$16384$8$1$c2FsdA==$aGFzaA=='), false);
  assert.equal(verifyPassword('x', 'scrypt$abc$8$1$c2FsdA==$aGFzaA=='), false);
  assert.equal(verifyPassword('x', 'scrypt$16384$8$1$not-base64!$also-bad'), false);
});
