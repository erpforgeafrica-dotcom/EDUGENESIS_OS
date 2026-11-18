import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRegionAllowed, createRegionAllowlist } from './regions.js';

// F1-09: the adapter regions allowlist is deny-by-default — an approved region
// is admitted, an absent/empty/unknown region is refused.
test('regions: the adapter allowlist is deny-by-default', () => {
  const list = createRegionAllowlist(['EU', 'us-east', '  ']);

  assert.deepEqual([...list.allowed], ['eu', 'us-east']);
  assert.equal(list.allows('eu'), true);
  assert.equal(list.allows('US-EAST'), true, 'matching is case-insensitive');
  assert.equal(list.allows('ap-south'), false);
  assert.equal(list.allows(undefined), false, 'an absent region is refused');
  assert.equal(list.allows('   '), false, 'an empty region is refused');

  assert.doesNotThrow(() => assertRegionAllowed(list, 'eu'));
  assert.throws(() => assertRegionAllowed(list, 'ap-south'), /not in the adapter allowlist/i);
  assert.throws(() => assertRegionAllowed(list, undefined), /unspecified/i);
});
