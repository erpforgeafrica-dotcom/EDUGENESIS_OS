/**
 * Unit tests for the gate registry and the summariser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise, runAllGates, GATE_REGISTRY } from './gates.js';
import type { Gate, GateContext, GateResult } from './types.js';

const ctx: GateContext = { root: process.cwd() };

function result(partial: Partial<GateResult> & Pick<GateResult, 'id' | 'passed' | 'severity'>): GateResult {
  return { detail: 'detail', evidence: [], ...partial };
}

test('summarise passes an empty result set', () => {
  const summary = summarise([]);
  assert.equal(summary.passed, true);
  assert.equal(summary.total, 0);
});

test('summarise passes when every gate passed', () => {
  const summary = summarise([result({ id: 'a', passed: true, severity: 'blocker' })]);
  assert.equal(summary.passed, true);
  assert.equal(summary.passedCount, 1);
  assert.equal(summary.failedCount, 0);
});

test('a single blocker failure fails the overall run', () => {
  const summary = summarise([
    result({ id: 'ok', passed: true, severity: 'blocker' }),
    result({ id: 'bad', passed: false, severity: 'blocker', detail: 'boom' }),
  ]);
  assert.equal(summary.passed, false);
  assert.equal(summary.blockerFailures.length, 1);
  assert.equal(summary.blockerFailures[0]?.id, 'bad');
  assert.equal(summary.blockerFailures[0]?.detail, 'boom');
});

test('a warning failure does not fail the overall run', () => {
  const summary = summarise([result({ id: 'absent', passed: false, severity: 'warning' })]);
  assert.equal(summary.passed, true);
  assert.equal(summary.warningFailures.length, 1);
  assert.equal(summary.blockerFailures.length, 0);
  assert.equal(summary.failedCount, 1);
});

test('runAllGates runs the supplied gates and preserves order', async () => {
  const gate = (id: string, passed: boolean): Gate => ({
    id,
    title: id,
    severity: 'blocker',
    run: async (): Promise<GateResult> => result({ id, passed, severity: 'blocker' }),
  });
  const results = await runAllGates([gate('one', true), gate('two', false)], ctx);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.id, 'one');
  assert.equal(results[0]?.passed, true);
  assert.equal(results[1]?.id, 'two');
  assert.equal(results[1]?.passed, false);
});

test('a gate that throws becomes a failed gate, never a silent pass', async () => {
  const exploding: Gate = {
    id: 'boom',
    title: 'boom',
    severity: 'blocker',
    run: async (): Promise<GateResult> => {
      throw new Error('kaboom');
    },
  };
  const results = await runAllGates([exploding], ctx);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.passed, false);
  assert.equal(results[0]?.severity, 'blocker');
  assert.match(results[0]?.detail ?? '', /kaboom/);
});

test('every registered gate has a unique id, a title and a severity', () => {
  const ids = new Set<string>();
  for (const gate of GATE_REGISTRY) {
    assert.ok(gate.id.length > 0, 'gate id must not be empty');
    assert.ok(gate.title.length > 0, `gate ${gate.id} must have a title`);
    assert.ok(gate.severity === 'blocker' || gate.severity === 'warning');
    assert.equal(ids.has(gate.id), false, `duplicate gate id ${gate.id}`);
    ids.add(gate.id);
  }
});
