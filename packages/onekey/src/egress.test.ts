/**
 * The egress boundary's tests.
 *
 * These are the tests that decide whether a learner's data can be sent to a
 * third-party model provider by accident. Each one is written as an attack or a
 * mistake, not as a happy path with an assertion bolted on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EGRESS_ALLOWLIST,
  EgressRejectedError,
  projectEgressPayload,
  tryProjectEgressPayload,
} from './egress.js';

/** A request that should be legal for a hosted provider. */
function cleanPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: 'Explain photosynthesis in simple terms',
    dataClass: 'learner_scoped',
    safetyTier: 'low',
    locale: 'en-KE',
    maxOutputTokens: 256,
    requiresAccessibilityContract: true,
    ...overrides,
  };
}

test('egress: a clean request is projected onto exactly the allowlisted fields', () => {
  const projected = projectEgressPayload(cleanPayload());

  assert.deepEqual(Object.keys(projected).sort(), [...DEFAULT_EGRESS_ALLOWLIST].filter((f) => f in cleanPayload()).sort());
  assert.equal(projected['prompt'], 'Explain photosynthesis in simple terms');
  assert.equal(projected['locale'], 'en-KE');
});

test('egress: an unknown field is refused by default, and every offender is named', () => {
  // The values announce themselves as synthetic. The gate scans source for
  // personal data, and a fixture that looks real is indistinguishable from a
  // leak — so the fixture carries the documented synthetic marker instead of
  // an exclusion being added to the gate.
  const payload = cleanPayload({ learnerName: 'Synthetic Learner', guardianPhone: '+000 000 0000' });

  assert.throws(
    () => projectEgressPayload(payload),
    (error: unknown) => {
      assert.ok(error instanceof EgressRejectedError, 'expected a typed EgressRejectedError');
      assert.deepEqual([...error.fields].sort(), ['guardianPhone', 'learnerName']);
      assert.match(error.message, /allowlist/);
      return true;
    },
  );
});

test('egress: a nested value is refused even when its field name is allowlisted', () => {
  // The name is allowed; the shape is not. An allowlist can vouch for a name,
  // never for everything hidden inside it.
  const payload = cleanPayload({ prompt: { body: 'nested', hidden: 'safeguarding note' } });

  assert.throws(
    () => projectEgressPayload(payload),
    (error: unknown) => {
      assert.ok(error instanceof EgressRejectedError);
      assert.deepEqual(error.fields, ['prompt']);
      assert.match(error.reason, /nested/);
      return true;
    },
  );
});

test('egress: a sensitive payload never leaves, even when the allowlist is widened', () => {
  // A caller cannot opt out of the data-class rule by editing the allowlist.
  const payload = cleanPayload({ dataClass: 'sensitive', disabilityNote: 'requires a screen reader' });

  assert.throws(
    () => projectEgressPayload(payload, { allowlist: [...DEFAULT_EGRESS_ALLOWLIST, 'disabilityNote'] }),
    (error: unknown) => {
      assert.ok(error instanceof EgressRejectedError);
      assert.deepEqual(error.fields, ['dataClass']);
      assert.match(error.message, /never leaves the private store/);
      return true;
    },
  );
});

test('egress: a secret payload is refused', () => {
  assert.throws(
    () => projectEgressPayload(cleanPayload({ dataClass: 'secret' })),
    (error: unknown) => error instanceof EgressRejectedError && /secret/.test(error.message),
  );
});

test('egress: the destination ceiling refuses a class it is not cleared for', () => {
  const payload = cleanPayload({ dataClass: 'learner_scoped' });

  assert.throws(
    () => projectEgressPayload(payload, { maxDataClass: 'public' }),
    (error: unknown) => error instanceof EgressRejectedError && /ceiling/.test(error.message),
  );

  // The same payload is fine at the default ceiling.
  assert.equal(projectEgressPayload(payload)['dataClass'], 'learner_scoped');
});

test('egress: an unrecognised data class is refused rather than passed through', () => {
  assert.throws(
    () => projectEgressPayload(cleanPayload({ dataClass: 'probably-fine' })),
    (error: unknown) => error instanceof EgressRejectedError && /not a recognised class/.test(error.message),
  );
});

test('egress: an absent optional field is omitted, not sent as undefined', () => {
  const projected = projectEgressPayload(cleanPayload({ system: undefined }));

  assert.equal('system' in projected, false, 'an undefined field must not appear in the payload at all');
});

test('egress: the input object is never mutated by a rejection', () => {
  const payload = cleanPayload({ learnerName: 'Synthetic Learner' });
  const before = JSON.stringify(payload);

  assert.throws(() => projectEgressPayload(payload), EgressRejectedError);
  assert.equal(JSON.stringify(payload), before, 'a rejected call must not partially strip the caller object');
});

test('egress: the non-throwing form reports the refusal without raising', () => {
  const verdict = tryProjectEgressPayload(cleanPayload({ learnerName: 'Synthetic Learner' }));

  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.deepEqual(verdict.error.fields, ['learnerName']);

  const allowed = tryProjectEgressPayload(cleanPayload());
  assert.equal(allowed.ok, true);
  if (!allowed.ok) return;
  assert.equal(allowed.payload['dataClass'], 'learner_scoped');
});
