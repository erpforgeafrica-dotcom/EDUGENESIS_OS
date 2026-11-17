import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HOSTED_PROVIDER_ID, wireConfiguredProvider } from './provider-wiring.js';

test('provider wiring: a configured primary provider resolves to its registered adapter', () => {
  const adapter = wireConfiguredProvider({
    primary: HOSTED_PROVIDER_ID,
    apiKeys: { [HOSTED_PROVIDER_ID]: 'test-key' },
  });
  assert.ok(adapter, 'a configured adapter must be returned');
  assert.equal(adapter.id, HOSTED_PROVIDER_ID);
});

test('provider wiring: a missing or empty key is not an error', () => {
  assert.equal(
    wireConfiguredProvider({ primary: HOSTED_PROVIDER_ID, apiKeys: {} }),
    undefined,
    'the route must fall back to tier 0 with no key',
  );
  assert.equal(
    wireConfiguredProvider({ primary: HOSTED_PROVIDER_ID, apiKeys: { [HOSTED_PROVIDER_ID]: '   ' } }),
    undefined,
    'a blank key is no key',
  );
});

test('provider wiring: a key named for another provider is never wired to this one', () => {
  const adapter = wireConfiguredProvider({
    primary: HOSTED_PROVIDER_ID,
    apiKeys: { 'some-other-provider': 'test-key' },
  });
  assert.equal(adapter, undefined, 'a credential must never travel to a host it does not belong to');
});

test('provider wiring: an unregistered primary provider is not an error', () => {
  assert.equal(
    wireConfiguredProvider({ primary: 'local-echo', apiKeys: { 'local-echo': 'k' } }),
    undefined,
    'the tier-0 route stays available',
  );
});
