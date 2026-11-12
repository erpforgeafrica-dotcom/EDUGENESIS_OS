/**
 * Session risk — behaviour tests.
 *
 * Authority: Doc 2 §4.2 (session risk); Doc 1 v1.2 (non-discrimination and
 * the protection of minors). The platform serves children, so a risk score
 * that leaned on a protected attribute would be both unlawful and
 * indefensible. The denylist below is therefore a HARD boundary: a protected
 * attribute can never become a risk factor.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  PROHIBITED_SIGNAL_KEYS,
  createSessionRiskService,
  isProhibitedSignalKey,
} from './session-risk.js';

describe('session risk — protected attribute denylist', () => {
  test('the denylist names the protected characteristics the mission names', () => {
    for (const key of ['disability', 'health', 'nationality', 'ethnicity']) {
      assert.ok(PROHIBITED_SIGNAL_KEYS.includes(key), `${key} must be prohibited`);
      assert.equal(isProhibitedSignalKey(key), true);
    }
  });

  test('compound and camelCase spellings are caught', () => {
    for (const key of [
      'disability_status',
      'hasDisability',
      'national_origin',
      'country_of_birth',
      'ethnic_group',
      'religious_belief',
      'sexual_orientation',
      'gender_identity',
      'medical_condition',
      'biometric_data',
      'age_band',
    ]) {
      assert.equal(isProhibitedSignalKey(key), true, `${key} must be prohibited`);
    }
  });

  test('legitimate risk signals are not caught', () => {
    for (const key of ['new_device', 'new_ip', 'off_hours', 'trace_id', 'session_reuse', 'rapid_requests']) {
      assert.equal(isProhibitedSignalKey(key), false, `${key} must not be prohibited`);
    }
  });
});

describe('session risk — scoring', () => {
  test('no signals produce a zero score and a low band', () => {
    const service = createSessionRiskService();

    const result = service.assess('subject-1', {});

    assert.equal(result.score, 0);
    assert.equal(result.band, 'low');
    assert.deepEqual(result.factors, []);
  });

  test('the same signals always produce the same result', () => {
    const service = createSessionRiskService();
    const signals = { new_device: true, impossible_travel: 1, rapid_requests: 0.5 };

    const first = service.assess('subject-1', signals);
    const second = service.assess('subject-1', signals);

    assert.deepEqual(first, second);
  });

  test('a different subject with the same signals gets the same result', () => {
    // The subject id is carried for audit; it must not leak into the score.
    const service = createSessionRiskService();

    const a = service.assess('subject-1', { new_device: true });
    const b = service.assess('subject-2', { new_device: true });

    assert.equal(a.score, b.score);
    assert.equal(a.band, b.band);
  });

  test('the contributing factors are returned', () => {
    const service = createSessionRiskService();

    const result = service.assess('subject-1', { new_device: true, impossible_travel: 1 });

    assert.equal(result.factors.length, 2);
    assert.ok(result.factors.some((factor) => factor.startsWith('new_device')));
    assert.ok(result.factors.some((factor) => factor.startsWith('impossible_travel')));
  });

  test('a factor that is not present contributes nothing', () => {
    const service = createSessionRiskService();

    const result = service.assess('subject-1', { new_device: false });

    assert.equal(result.score, 0);
    assert.deepEqual(result.factors, []);
  });

  test('the score never exceeds 1', () => {
    const service = createSessionRiskService();

    const result = service.assess('subject-1', {
      new_device: 1,
      new_ip: 1,
      impossible_travel: 1,
      failed_authentication: 1,
      rapid_requests: 1,
      off_hours: 1,
      anomalous_payload_size: 1,
      session_reuse: 1,
    });

    assert.equal(result.score, 1);
    assert.equal(result.band, 'high');
  });

  test('a high score is banded as high', () => {
    const service = createSessionRiskService();

    const result = service.assess('subject-1', { impossible_travel: 1, new_device: 1, failed_authentication: 1 });

    assert.equal(result.band, 'high');
  });

  test('a mid score is banded as medium', () => {
    const service = createSessionRiskService();

    const result = service.assess('subject-1', { new_device: 1, new_ip: 1 });

    assert.equal(result.band, 'medium');
  });

  test('weights are configurable', () => {
    const service = createSessionRiskService({ weights: { new_device: 0.9 } });

    const result = service.assess('subject-1', { new_device: 1 });

    assert.equal(result.score, 0.9);
  });

  test('the band thresholds are configurable', () => {
    const service = createSessionRiskService({ thresholds: { medium: 0.1, high: 0.95 } });

    const result = service.assess('subject-1', { new_device: 1 });

    assert.equal(result.band, 'medium');
  });

  test('unknown signal keys do not contribute', () => {
    const service = createSessionRiskService();

    const result = service.assess('subject-1', { something_unknown: 1 });

    assert.equal(result.score, 0);
    assert.deepEqual(result.factors, []);
  });

  test('a non-numeric value for a known factor is ignored, not coerced', () => {
    const service = createSessionRiskService();

    const result = service.assess('subject-1', { new_device: 'yes' });

    assert.equal(result.score, 0);
  });

  test('garbage input never throws', () => {
    const service = createSessionRiskService();
    const garbage: unknown[] = [null, undefined, 'signals', 42, []];

    for (const signals of garbage) {
      const result = service.assess('subject-1', signals as Record<string, unknown>);
      assert.equal(result.score, 0);
      assert.equal(result.band, 'low');
    }
  });
});

describe('session risk — protected attributes cannot influence the score', () => {
  test('a prohibited signal is ignored and changes nothing', () => {
    const service = createSessionRiskService();

    const clean = service.assess('subject-1', { new_device: 1 });
    const polluted = service.assess('subject-1', { new_device: 1, disability: 1, ethnicity: 'X' });

    assert.equal(polluted.score, clean.score);
    assert.equal(polluted.band, clean.band);
    assert.deepEqual(polluted.factors, clean.factors);
  });

  test('a prohibited signal alone cannot raise the band', () => {
    const service = createSessionRiskService();

    const result = service.assess('subject-1', { disability: 100, nationality: 'x', health: true });

    assert.equal(result.score, 0);
    assert.equal(result.band, 'low');
    assert.deepEqual(result.factors, []);
  });

  test('the ignored prohibited keys are reported for audit', () => {
    const service = createSessionRiskService();

    const detail = service.assessDetailed('subject-1', { new_device: 1, disability: 1 });

    assert.deepEqual(detail.ignoredProhibited, ['disability']);
    assert.deepEqual(detail.ignoredUnknown, []);
  });

  test('a prohibited key cannot be smuggled in through the weight map', () => {
    // Weights only apply to declared factors, so a protected attribute cannot
    // be introduced as a factor even by configuration.
    const service = createSessionRiskService({ weights: { disability: 1 } });

    const result = service.assess('subject-1', { disability: 1 });

    assert.equal(result.score, 0);
    assert.deepEqual(result.factors, []);
  });
});
