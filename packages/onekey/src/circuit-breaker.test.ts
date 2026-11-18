import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCircuitBreaker } from './circuit-breaker.js';

test('circuit breaker: opens after N consecutive failures', () => {
  let now = 1_000;
  const cb = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, now: () => now });
  assert.equal(cb.state('p1'), 'closed');
  cb.recordFailure('p1');
  cb.recordFailure('p1');
  assert.equal(cb.state('p1'), 'closed', 'two failures must not open a 3-failure circuit');
  cb.recordFailure('p1');
  assert.equal(cb.state('p1'), 'open');
  assert.equal(cb.isTripped('p1'), true);
});

test('circuit breaker: a success resets the consecutive failure count', () => {
  let now = 1_000;
  const cb = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, now: () => now });
  cb.recordFailure('p1');
  cb.recordFailure('p1');
  cb.recordSuccess('p1');
  cb.recordFailure('p1');
  cb.recordFailure('p1');
  assert.equal(cb.state('p1'), 'closed');
});

test('circuit breaker: moves to half_open after the cooldown', () => {
  let now = 1_000;
  const cb = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, now: () => now });
  cb.recordFailure('p1');
  cb.recordFailure('p1');
  cb.recordFailure('p1');
  assert.equal(cb.state('p1'), 'open');
  now += 29_999;
  assert.equal(cb.state('p1'), 'open', 'the circuit must stay open until the cooldown elapses');
  now += 1;
  assert.equal(cb.state('p1'), 'half_open');
  assert.equal(cb.isTripped('p1'), false);
});

test('circuit breaker: closes again on a success after half-open', () => {
  let now = 1_000;
  const cb = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, now: () => now });
  cb.recordFailure('p1');
  cb.recordFailure('p1');
  cb.recordFailure('p1');
  now += 30_000;
  assert.equal(cb.state('p1'), 'half_open');
  cb.recordSuccess('p1');
  assert.equal(cb.state('p1'), 'closed');
});

test('circuit breaker: a failure while half_open re-opens the circuit', () => {
  let now = 1_000;
  const cb = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, now: () => now });
  cb.recordFailure('p1');
  cb.recordFailure('p1');
  cb.recordFailure('p1');
  now += 30_000;
  assert.equal(cb.state('p1'), 'half_open');
  cb.recordFailure('p1');
  assert.equal(cb.state('p1'), 'open');
  now += 30_000;
  assert.equal(cb.state('p1'), 'half_open', 'the cooldown restarts from the last failure');
});

test('circuit breaker: an unknown provider is closed and resettable', () => {
  const cb = createCircuitBreaker();
  assert.equal(cb.state('never-seen'), 'closed');
  cb.reset('never-seen');
  assert.equal(cb.state('never-seen'), 'closed');
});

test('circuit breaker: default threshold is 3 failures and 30s cooldown', () => {
  let now = 0;
  const cb = createCircuitBreaker({ now: () => now });
  cb.recordFailure('p1');
  cb.recordFailure('p1');
  assert.equal(cb.state('p1'), 'closed');
  cb.recordFailure('p1');
  assert.equal(cb.state('p1'), 'open');
  now += 30_000;
  assert.equal(cb.state('p1'), 'half_open');
});

test('circuit breaker: half-open admits exactly one probe and promotes on outcome, not on read', () => {
  // F3-28. Reading state() must never grant probe permission: a burst of
  // concurrent readers must not all reach the failing provider. Only the
  // single caller that wins tryAcquireProbe may probe, and the provider is
  // promoted back to closed only by that probe's SUCCESS.
  let now = 1_000;
  const cb = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: () => now });
  cb.recordFailure('p1');
  assert.equal(cb.state('p1'), 'open');
  now += 30_000;
  assert.equal(cb.state('p1'), 'half_open');
  assert.equal(cb.state('p1'), 'half_open', 'repeated reads must not admit probes');
  assert.equal(cb.tryAcquireProbe('p1'), true, 'exactly one caller may probe');
  assert.equal(cb.tryAcquireProbe('p1'), false, 'a second caller is refused while the probe is in flight');
  assert.equal(cb.state('p1'), 'half_open', 'a read while the probe is in flight does not promote');
  cb.recordSuccess('p1');
  assert.equal(cb.state('p1'), 'closed', 'promotion happens on the probe OUTCOME, not on a read');
  assert.equal(cb.tryAcquireProbe('p1'), true, 'a closed circuit needs no probe latch');
});

test('circuit breaker: a failed probe re-opens the circuit and releases the probe latch', () => {
  // F3-28. The complementary outcome: a failed probe re-opens with a fresh
  // cooldown, and the latch is released so the NEXT cooldown admits one probe.
  let now = 1_000;
  const cb = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: () => now });
  cb.recordFailure('p1');
  now += 30_000;
  assert.equal(cb.tryAcquireProbe('p1'), true);
  assert.equal(cb.tryAcquireProbe('p1'), false);
  cb.recordFailure('p1');
  assert.equal(cb.state('p1'), 'open', 'a failed probe re-opens the circuit');
  cb.releaseProbe('p1'); // idempotent: recordFailure already released it
  now += 30_000;
  assert.equal(cb.tryAcquireProbe('p1'), true, 'a new cooldown admits a fresh probe');
});
