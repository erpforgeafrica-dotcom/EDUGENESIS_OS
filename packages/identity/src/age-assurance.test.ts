/**
 * Age assurance — behaviour tests.
 *
 * Authority: Doc 2 §4.2 (age assurance); Doc 1 v1.2 (minors, guardian
 * consent); the platform serves minors in regions where a government ID is
 * often unavailable, so the service must be honest about uncertainty rather
 * than confident about a guess.
 *
 * The governing property: an INCONCLUSIVE evidence set returns null. It never
 * returns a band it cannot justify.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createAgeAssuranceService } from './age-assurance.js';
import type { Principal } from '@edugenesis/contracts';

const CLOCK = () => new Date('2026-06-01T00:00:00.000Z');

describe('age assurance', () => {
  test('a trusted attestation resolves the band', async () => {
    const service = createAgeAssuranceService({ now: CLOCK });

    const band = await service.assure('subject-1', { attestedBand: '13_15' });

    assert.equal(band, '13_15');
  });

  test('a verified date of birth resolves the band', async () => {
    const service = createAgeAssuranceService({ now: CLOCK });

    // 2016-03-01 against a 2026 clock -> 10 years old.
    const band = await service.assure('subject-1', { verifiedDateOfBirth: '2016-03-01' });

    assert.equal(band, 'under_13');
  });

  test('a verified date of birth resolves each band correctly', async () => {
    const service = createAgeAssuranceService({ now: CLOCK });

    assert.equal(await service.assure('s', { verifiedDateOfBirth: '2013-01-01' }), '13_15');
    assert.equal(await service.assure('s', { verifiedDateOfBirth: '2010-01-01' }), '16_17');
    assert.equal(await service.assure('s', { verifiedDateOfBirth: '2007-01-01' }), 'adult');
  });

  test('an inconclusive evidence set returns null and never a guess', async () => {
    const service = createAgeAssuranceService({ now: CLOCK });

    // A self-declared age alone proves nothing. The service must say so.
    const band = await service.assure('subject-1', { declaredAge: 10 });

    assert.equal(band, null);
  });

  test('empty evidence returns null', async () => {
    const service = createAgeAssuranceService({ now: CLOCK });

    assert.equal(await service.assure('subject-1', {}), null);
  });

  test('a failed identity check with a declared age returns null', async () => {
    const service = createAgeAssuranceService({ now: CLOCK });

    const band = await service.assure('subject-1', { declaredAge: 10, idCheckOutcome: 'fail' });

    assert.equal(band, null);
  });

  test('a declared age corroborated by a passed identity check resolves the band', async () => {
    const service = createAgeAssuranceService({ now: CLOCK });

    const band = await service.assure('subject-1', { declaredAge: 10, idCheckOutcome: 'pass' });

    assert.equal(band, 'under_13');
  });

  test('a future date of birth is inconclusive, not an adult band', async () => {
    const service = createAgeAssuranceService({ now: CLOCK });

    const band = await service.assure('subject-1', { verifiedDateOfBirth: '2030-01-01' });

    assert.equal(band, null);
  });

  test('an implausible date of birth is inconclusive', async () => {
    const service = createAgeAssuranceService({ now: CLOCK });

    const band = await service.assure('subject-1', { verifiedDateOfBirth: '1850-01-01' });

    assert.equal(band, null);
  });

  test('garbage evidence never throws and never resolves a band', async () => {
    const service = createAgeAssuranceService({ now: CLOCK });
    const garbage: unknown[] = [
      null,
      undefined,
      'a string',
      42,
      [],
      { declaredAge: 'ten' },
      { verifiedDateOfBirth: 'not-a-date' },
      { attestedBand: 'twenty' },
    ];

    for (const evidence of garbage) {
      const band = await service.assure('subject-1', evidence);
      assert.equal(band, null, `expected null for evidence ${JSON.stringify(evidence)}`);
    }
  });

  test('the decision is traceable: the deciding rule is named', async () => {
    const service = createAgeAssuranceService({ now: CLOCK });

    const decision = service.assureDetailed('subject-1', { attestedBand: 'adult' });

    assert.equal(decision.band, 'adult');
    assert.equal(decision.decidedBy, 'attested_band');
    assert.ok(decision.trace.length > 0);
  });

  test('an inconclusive decision says which rule could not conclude', () => {
    const service = createAgeAssuranceService({ now: CLOCK });

    const decision = service.assureDetailed('subject-1', { declaredAge: 10 });

    assert.equal(decision.band, null);
    assert.equal(decision.decidedBy, undefined);
    const last = decision.trace[decision.trace.length - 1];
    assert.ok(last);
    assert.equal(last.outcome, 'insufficient');
  });
});

describe('guardian requirement by age band', () => {
  const service = createAgeAssuranceService({ now: CLOCK });

  test('under_13 and 13_15 require a guardian', () => {
    assert.equal(service.requiresGuardian('under_13'), true);
    assert.equal(service.requiresGuardian('13_15'), true);
  });

  test('16_17 and adult do not require a guardian', () => {
    assert.equal(service.requiresGuardian('16_17'), false);
    assert.equal(service.requiresGuardian('adult'), false);
  });

  test('an unknown band fails closed and requires a guardian', () => {
    // The platform serves minors. An unresolved age must never be treated as
    // an adult, so a guardian is required until the band is known.
    assert.equal(service.requiresGuardian(undefined), true);
  });

  test('the guardian requirement matches the contract’s band type', () => {
    const bands: Array<Principal['ageBand']> = ['under_13', '13_15', '16_17', 'adult', undefined];
    for (const band of bands) {
      assert.equal(typeof service.requiresGuardian(band), 'boolean');
    }
  });
});
