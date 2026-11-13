/**
 * Fixture tests.
 *
 * The fixtures are the shared ground every ARC invariant test stands on. If
 * the base emission is not stable, or if the snapshot helper cannot tell a
 * changed emission from an unchanged one, then every test built on top of it
 * can pass for the wrong reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAccessibilityGuardian } from './guardian.js';
import { createAccessibilityValidator } from './validator.js';
import { BASE_CANONICAL_CONTENT, buildEmission, snapshotEmission } from './fixtures.js';

test('fixtures: two emissions built the same way snapshot identically', () => {
  const first = buildEmission();
  const second = buildEmission();

  assert.equal(snapshotEmission(first), snapshotEmission(second));
});

test('fixtures: the snapshot detects a single-character change in the content', () => {
  const base = buildEmission();
  const changed = buildEmission({
    canonical_content: { ...BASE_CANONICAL_CONTENT, body: `${BASE_CANONICAL_CONTENT.body} ` },
  });

  assert.notEqual(
    snapshotEmission(base),
    snapshotEmission(changed),
    'a snapshot that cannot see a one-character change cannot prove the content was not mutated',
  );
});

test('fixtures: the guardian does not rewrite an emission it delivers', async () => {
  const emission = buildEmission();
  const before = snapshotEmission(emission);

  const result = await createAccessibilityGuardian(createAccessibilityValidator()).intercept(emission);

  assert.equal(result.deliver, true);
  assert.equal(
    snapshotEmission(emission),
    before,
    'a delivered emission must reach the learner exactly as the provider produced it',
  );
});
