/**
 * Deterministic hashing tests.
 *
 * WHY THESE ASSERTIONS EXIST
 * The ledger hash is a public promise: an auditor must be able to recompute it
 * with a stock SHA-256 tool. These tests pin the two properties that promise
 * rests on: a known answer for a known input, and a canonical form that does
 * not depend on JavaScript object key insertion order.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson, sha256Bytes, sha256Canonical, sha256Hex } from './hash.js';

test('sha256Hex matches the published SHA-256 test vectors', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('canonicalJson sorts object keys recursively', () => {
  const first = { b: 1, a: { d: 4, c: 3 }, z: [{ y: 2, x: 1 }] };
  assert.equal(
    canonicalJson(first),
    '{"a":{"c":3,"d":4},"b":1,"z":[{"x":1,"y":2}]}',
  );
});

test('canonicalJson is insertion-order independent', () => {
  const one = { alpha: 1, beta: 2, gamma: 3 };
  const two = { gamma: 3, alpha: 1, beta: 2 };
  assert.equal(canonicalJson(one), canonicalJson(two));
  assert.equal(sha256Canonical(one), sha256Canonical(two));
});

test('canonicalJson preserves array order because order is meaningful in a ledger', () => {
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
});

test('canonicalJson refuses non-finite numbers instead of colliding them with null', () => {
  assert.throws(() => canonicalJson({ amount: Number.NaN }), /non-finite number/);
  assert.throws(() => canonicalJson({ amount: Number.POSITIVE_INFINITY }), /non-finite number/);
});

test('canonicalJson drops undefined properties, as JSON has no representation for them', () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

test('sha256Bytes hashes the concatenation of its parts', () => {
  const combined = sha256Bytes(Buffer.from('ab'), Buffer.from('c'));
  assert.equal(combined.toString('hex'), sha256Hex('abc'));
});
