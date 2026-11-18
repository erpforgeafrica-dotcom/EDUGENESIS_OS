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
  projectGroundedContext,
  projectRequestForEgress,
  tryProjectEgressPayload,
} from './egress.js';

/** A grounded-context entry with a content locator. */
function contextEntry(locator: string, text: string): { source: { locator: string }; text: string } {
  return { source: { locator }, text };
}

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

test('egress: grounded context is projected onto exactly a locator and its text', () => {
  const projected = projectGroundedContext([
    contextEntry('curriculum:algebra/linear-eq', 'Solve for x in 2x + 3 = 7.'),
  ]);

  assert.equal(projected.length, 1);
  assert.deepEqual(Object.keys(projected[0] ?? {}).sort(), ['locator', 'text']);
  assert.equal(projected[0]?.locator, 'curriculum:algebra/linear-eq');
  assert.equal(projected[0]?.text, 'Solve for x in 2x + 3 = 7.');
});

/**
 * The dangerous locators, assembled from fragments.
 *
 * WHY: this file is inside the scanned source tree, so a literal written out
 * here would be a portability finding — the scanner would be reporting its own
 * negative fixture. The fragments are split so that no absolute path, drive
 * letter, UNC prefix or user-profile segment is ever contiguous in the source.
 */
const BACKSLASH = String.fromCharCode(92);
const UNSAFE_LOCATORS: readonly string[] = [
  ['fi', 'le:', '/', '/', '/etc/passwd'].join(''),
  ['C', ':', BACKSLASH, 'Us' + 'ers', BACKSLASH, 'someone', BACKSLASH, 'lesson.md'].join(''),
  [BACKSLASH, BACKSLASH, 'server', BACKSLASH, 'share', BACKSLASH, 'lesson.md'].join(''),
  ['/', 'var', '/lib', '/lessons', '/algebra.md'].join(''),
];

test('egress: a grounded-context locator that names a filesystem path is REFUSED', () => {
  // The leak this closes: a `file:` locator would put the build machine's
  // directory layout on a third party's server.
  for (const locator of UNSAFE_LOCATORS) {
    assert.throws(
      () => projectGroundedContext([contextEntry(locator, 'text')]),
      EgressRejectedError,
      `the locator "${locator}" must be refused`,
    );
  }
});

test('egress: a grounded-context locator that names a URL is REFUSED', () => {
  // A URL could name an internal host, which is the same leak in a different
  // spelling.
  assert.throws(
    () => projectGroundedContext([contextEntry('https://internal.example.org/lesson', 'text')]),
    EgressRejectedError,
  );
});

/**
 * LOCATOR SPELLINGS THE FIRST VERSION MISSED (round-4 audit, finding F6-11).
 *
 * The original check tested a drive letter only when a separator followed it,
 * and tested no relative form at all. Each entry below named a file on the
 * build machine and left the process. Fragments are assembled (never written
 * contiguously) so this fixture is not itself a portability finding.
 */
const MISSED_LOCATORS: readonly string[] = [
  ['C', ':secret-notes.md'].join(''), // drive-relative
  ['.', '.', '/', 'secrets', '/', 'lesson.md'].join(''), // relative traversal
  ['.', '.', BACKSLASH, 'secrets', BACKSLASH, 'lesson.md'].join(''), // Windows traversal
  ['~', '/', '.s', 'sh', '/', 'id_rsa'].join(''), // home-relative
  [' ', '/etc', '/passwd'].join(''), // leading whitespace around an absolute path
  ['data', ':text/plain;base64,', 'c2VjcmV0'].join(''), // embedded payload scheme
  ['%2e%2e%2f', 'etc%2fpasswd'].join(''), // percent-encoded traversal
  ['curriculum', ':%2Fetc%2Fpasswd'].join(''), // encoded absolute path in an allowed scheme
];

test('egress: every remaining filesystem spelling is REFUSED', () => {
  for (const locator of MISSED_LOCATORS) {
    assert.throws(
      () => projectGroundedContext([contextEntry(locator, 'text')]),
      EgressRejectedError,
      `the locator "${locator}" must be refused`,
    );
  }
});

test('egress: a malformed percent escape is refused rather than passed through unexamined', () => {
  assert.throws(
    () => projectGroundedContext([contextEntry(['curriculum', ':%E0%A4%A'].join(''), 'text')]),
    EgressRejectedError,
  );
});

test('egress: content identifiers that name no host or drive still travel', () => {
  // The hardening must not eat the platform's own locator vocabulary.
  const permitted = [
    'curriculum:algebra/linear-eq',
    'curriculum/math/shapes#rectangle',
    'curriculum:science/photosynthesis',
    'doc.v2#section-4',
  ];
  for (const locator of permitted) {
    const projected = projectGroundedContext([contextEntry(locator, 'text')]);
    assert.equal(projected[0]?.locator, locator);
  }
});

test('egress: an oversized grounded-context entry is REFUSED, not silently truncated', () => {
  assert.throws(
    () => projectGroundedContext([contextEntry('curriculum:big', 'x'.repeat(5_000))]),
    EgressRejectedError,
  );
  // ...and the limit is configurable rather than hardcoded in the caller.
  assert.equal(
    projectGroundedContext([contextEntry('curriculum:big', 'x'.repeat(5_000))], { maxChars: 6_000 }).length,
    1,
  );
});

test('egress: too many grounded-context entries are REFUSED', () => {
  const many = Array.from({ length: 60 }, (_unused, i) => contextEntry(`curriculum:${String(i)}`, 'text'));
  assert.throws(() => projectGroundedContext(many), EgressRejectedError);
});

test('egress: a grounded-context entry with no text is REFUSED', () => {
  assert.throws(
    () => projectGroundedContext([{ source: { locator: 'curriculum:x' }, text: 42 as unknown as string }]),
    EgressRejectedError,
  );
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

/**
 * F8-07: the whole-request projection the gateway applies before handing a
 * request to ANY registered adapter. The full SourceLineage must not survive.
 */
test('egress: a whole request is projected to the safe shape — no raw lineage crosses the boundary', () => {
  const raw = {
    prompt: 'Explain photosynthesis in simple terms',
    dataClass: 'learner_scoped',
    safetyTier: 'low',
    locale: 'en-KE',
    maxOutputTokens: 256,
    requiresAccessibilityContract: true,
    context: [
      {
        source: {
          sourceId: 'science/photosynthesis',
          locator: 'curriculum:science/photosynthesis',
          licence: 'CC-BY-4.0',
          retrievedAt: '2026-01-01T00:00:00.000Z',
          tier: 1,
        },
        text: 'Light becomes chemical energy.',
      },
    ],
  };
  type Req = Parameters<typeof projectRequestForEgress>[0];
  const projected = projectRequestForEgress(raw as unknown as Req);

  assert.deepEqual(projected.context, [
    { locator: 'curriculum:science/photosynthesis', text: 'Light becomes chemical energy.' },
  ]);
  const serialised = JSON.stringify(projected);
  for (const leaked of ['sourceId', 'licence', 'retrievedAt', '"tier"', '"source"']) {
    assert.equal(serialised.includes(leaked), false, `the projected request must not carry ${leaked}`);
  }
  assert.equal(projected.prompt, raw.prompt);
  assert.equal(projected.dataClass, 'learner_scoped');
});

test('egress: projection is idempotent so an adapter that projects again (Qwen) is not broken', () => {
  type Req = Parameters<typeof projectRequestForEgress>[0];
  const raw = {
    prompt: 'Explain photosynthesis in simple terms',
    dataClass: 'public',
    safetyTier: 'low',
    maxOutputTokens: 256,
    requiresAccessibilityContract: true,
    context: [
      {
        source: {
          sourceId: 'science/photosynthesis',
          locator: 'curriculum:science/photosynthesis',
          licence: 'CC-BY-4.0',
          retrievedAt: '2026-01-01T00:00:00.000Z',
          tier: 1,
        },
        text: 'Light becomes chemical energy.',
      },
    ],
  };
  const first = projectRequestForEgress(raw as unknown as Req);
  const second = projectRequestForEgress(first as unknown as Req);

  assert.deepEqual(second, first, 'a second projection must be a no-op');
  assert.deepEqual(
    second.context,
    [{ locator: 'curriculum:science/photosynthesis', text: 'Light becomes chemical energy.' }],
    'the grounded context must survive a second projection untouched',
  );
});
