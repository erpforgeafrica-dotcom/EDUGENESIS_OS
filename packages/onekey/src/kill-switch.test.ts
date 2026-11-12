import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKillSwitch } from './kill-switch.js';

test('kill switch: kills a provider and records the reason for the audit trail', () => {
  const ks = createKillSwitch();
  ks.killSwitch('p1', 'data residency incident INC-42');
  assert.equal(ks.isKilled('p1'), true);
  assert.equal(ks.reasonFor('p1'), 'data residency incident INC-42');
  assert.equal(ks.isKilled('p2'), false);
  assert.equal(ks.reasonFor('p2'), undefined);
});

test('kill switch: the audit trail keeps every kill with a timestamp', () => {
  const ks = createKillSwitch();
  ks.killSwitch('p1', 'safety incident');
  ks.killSwitch('p2', 'budget abuse');
  const records = ks.records();
  assert.equal(records.length, 2);
  const first = records[0];
  const second = records[1];
  assert.ok(first && second);
  assert.equal(first.providerId, 'p1');
  assert.equal(first.reason, 'safety incident');
  assert.equal(second.providerId, 'p2');
  assert.ok(!Number.isNaN(Date.parse(first.at)), 'kill records must carry an ISO timestamp');
});

test('kill switch: killing a provider twice keeps the latest reason', () => {
  const ks = createKillSwitch();
  ks.killSwitch('p1', 'first reason');
  ks.killSwitch('p1', 'second reason');
  assert.equal(ks.reasonFor('p1'), 'second reason');
  assert.equal(ks.records().length, 2, 'both kills stay in the audit trail');
});

test('kill switch: a provider can be revived', () => {
  const ks = createKillSwitch();
  ks.killSwitch('p1', 'temporary hold');
  assert.equal(ks.isKilled('p1'), true);
  ks.revive('p1', 'hold lifted');
  assert.equal(ks.isKilled('p1'), false);
  assert.equal(ks.reasonFor('p1'), undefined);
});
