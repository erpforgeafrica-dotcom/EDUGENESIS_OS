/**
 * The settings server's access policy.
 *
 * These tests exist because the policy is the only thing standing between a
 * learner's laptop and the open network. The server is loopback-only by
 * default; hosted mode exists solely for the Render deployment, where the
 * platform proxy is never a loopback peer.
 *
 * The policy is tested as a pure function rather than over a socket: a test
 * that binds 0.0.0.0 and connects from the same machine still arrives from
 * 127.0.0.1 and would prove nothing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizePeer, isHostedWriteRefused, isLoopback } from './serve.js';

test('loopback detection accepts the IPv4, IPv6 and mapped loopback forms', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('127.0.0.9'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
});

test('loopback detection refuses a private network peer and an absent address', () => {
  assert.equal(isLoopback('10.0.0.5'), false);
  assert.equal(isLoopback('192.168.1.20'), false);
  assert.equal(isLoopback(undefined), false);
});

test('local mode refuses a non-loopback peer and says why', () => {
  const verdict = authorizePeer('10.0.0.5', false);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? '', /loopback/);
});

test('local mode admits a loopback peer', () => {
  assert.deepEqual(authorizePeer('127.0.0.1', false), { allowed: true });
});

test('hosted mode admits the platform proxy, which is never loopback', () => {
  assert.deepEqual(authorizePeer('10.0.0.5', true), { allowed: true });
});

test('hosted mode refuses every settings write, and local mode does not', () => {
  assert.equal(isHostedWriteRefused(true, 'POST', '/api/settings'), true);
  assert.equal(isHostedWriteRefused(true, 'PUT', '/api/settings'), true);
  assert.equal(isHostedWriteRefused(false, 'POST', '/api/settings'), false);
});

test('the hosted write refusal never blocks a read', () => {
  assert.equal(isHostedWriteRefused(true, 'GET', '/api/settings'), false);
  assert.equal(isHostedWriteRefused(true, 'GET', '/api/health'), false);
});

test('the hosted write refusal does not reach beyond the API surface', () => {
  assert.equal(isHostedWriteRefused(true, 'POST', '/app.js'), false);
});
