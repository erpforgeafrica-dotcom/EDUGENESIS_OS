/**
 * The learner surface's provider wiring and its shared, persisted kill switch
 * (gap close-out plan, Seam 2 + Seam 1 wiring - goal 1 and finding F3-11).
 *
 * WHY THESE TESTS EXIST
 *   The route used to register NO provider, so a question outside the offline
 *   bundle could never be answered by the model. The wiring reads the settings
 *   ONCE at start, resolves the API key for the settings' primary provider id,
 *   and registers the qwen adapter. A missing key is not an error. A provider
 *   failure never reaches the learner: the ladder falls through to tier 0 and
 *   the lesson carries no provider name, no key, no quota and no status code.
 *   The kill switch is shared and persisted, so a kill survives a restart.
 *
 * THE ONLY THING FAKED IS THE NETWORK
 *   The REAL gateway, the REAL policy engine, the REAL qwen adapter and the
 *   REAL accessibility guardian run. The injected `fetch` stands in for the
 *   hosted model provider, so a test never touches the network - and so the
 *   test can assert exactly which host the credential was sent to.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AllTiersExhaustedError, type EduGenesisSettings, type TierZeroProvider } from '@edugenesis/contracts';
import { createLedgerStore, createSqliteLedgerJournal, createSqlitePrivateStore } from '@edugenesis/ledger';
import {
  HOSTED_BASE_URL,
  HOSTED_MODEL_ID,
  HOSTED_PROVIDER_ID,
  type FetchLike,
} from '@edugenesis/onekey';
import { createLearnerServices, type LearnerServices } from './learner.js';

/** A marker key: long enough to be unambiguous, never a real credential. */
const KEY = 'sk-test-edugenesis-not-a-real-key-000000';

/** A question with no word in common with the offline bundle. */
const OFF_BUNDLE_QUESTION = 'what is the water cycle';

/** The body a hosted model returns. */
const MODEL_PAYLOAD = {
  model: HOSTED_MODEL_ID,
  choices: [{ message: { content: 'Water moves from the ocean into the clouds and falls back as rain.' } }],
  usage: { prompt_tokens: 12, completion_tokens: 24 },
};

/** A full, valid settings file with the given providers block. */
function settingsWith(providers: Partial<EduGenesisSettings['providers']>): EduGenesisSettings {
  return {
    schemaVersion: 1,
    server: { host: '127.0.0.1', port: 8787 },
    paths: { dataDir: './.edugenesis-data' },
    providers: { primary: 'local-echo', secondary: 'local-echo', apiKeys: {}, ...providers },
    features: { accessibilityGuardian: true, offlineBundle: true, telemetry: false, publicAnchoring: false },
    limits: { budgetUnits: 1_000_000, mediaBudgetBytes: 5_242_880, confidenceThreshold: 0.7 },
  };
}

interface RecordedCall {
  url: string;
  authorization: string | undefined;
}

/** An injectable HTTP client that records where credentials were sent. */
function fakeFetch(response: { status: number; payload?: unknown }): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, authorization: init.headers['Authorization'] });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: 'provider status text',
      headers: { get: () => null },
      json: async () => response.payload,
    };
  };
  return { fetch, calls };
}

/** A tier 0 with nothing in it: the gateway must refuse, never invent. */
function emptyTierZero(): TierZeroProvider {
  return {
    serve: async () => null,
    bundles: () => [],
  };
}

/** One data directory per test, so the durable stores never share a file. */
function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'edugenesis-learner-'));
}

/** Open the learner services and always close the durable stores. */
async function withServices(
  options: Parameters<typeof createLearnerServices>[0],
  run: (services: LearnerServices) => Promise<void> | void,
): Promise<void> {
  const services = createLearnerServices(options);
  try {
    await run(services);
  } finally {
    services.close();
  }
}

test('the settings wire the primary provider, and a question outside the offline bundle is answered by the model', async () => {
  const { fetch, calls } = fakeFetch({ status: 200, payload: MODEL_PAYLOAD });
  await withServices(
    {
      dataDir: dataDir(),
      settings: settingsWith({ primary: HOSTED_PROVIDER_ID, apiKeys: { [HOSTED_PROVIDER_ID]: KEY } }),
      providerFetch: fetch,
    },
    async (services) => {
      const answer = await services.answer(OFF_BUNDLE_QUESTION);
      assert.equal(answer.tier, 1, 'the wired provider must serve the model tier');
      assert.equal(
        answer.text,
        'Water moves from the ocean into the clouds and falls back as rain.',
        'the learner must receive the model answer',
      );
      assert.equal(calls.length, 1, 'exactly one provider call');
      assert.equal(
        calls[0]?.url,
        `${HOSTED_BASE_URL}/chat/completions`,
        'the credential is sent only to the configured provider host',
      );
      assert.equal(calls[0]?.authorization, `Bearer ${KEY}`, 'the settings key is the credential');
    },
  );
});

test('a missing key is not an error: the route runs on tier 0 alone and never dials a provider', async () => {
  const { fetch, calls } = fakeFetch({ status: 200, payload: MODEL_PAYLOAD });
  await withServices(
    {
      dataDir: dataDir(),
      settings: settingsWith({ primary: HOSTED_PROVIDER_ID, apiKeys: {} }),
      providerFetch: fetch,
    },
    async (services) => {
      const answer = await services.answer(OFF_BUNDLE_QUESTION);
      assert.equal(answer.tier, 0, 'without a key the offline tier alone serves');
      assert.ok(answer.text.length > 0, 'the learner still receives a lesson');
      assert.equal(calls.length, 0, 'no credential, no provider call');
    },
  );
});

test('a provider the settings do not name as primary is not wired, whatever keys exist', async () => {
  const { fetch, calls } = fakeFetch({ status: 200, payload: MODEL_PAYLOAD });
  await withServices(
    {
      dataDir: dataDir(),
      settings: settingsWith({ primary: 'local-echo', apiKeys: { [HOSTED_PROVIDER_ID]: KEY } }),
      providerFetch: fetch,
    },
    async (services) => {
      const answer = await services.answer(OFF_BUNDLE_QUESTION);
      assert.equal(answer.tier, 0, 'the primary provider is the one that is wired');
      assert.equal(
        calls.length,
        0,
        'a credential is never sent to a host the settings did not name as primary',
      );
    },
  );
});

test('a provider failure falls through to the offline tier, and the lesson carries no provider evidence', async () => {
  const { fetch } = fakeFetch({
    status: 503,
    payload: { error: { message: 'quota exhausted for project, credit balance is zero' } },
  });
  await withServices(
    {
      dataDir: dataDir(),
      settings: settingsWith({ primary: HOSTED_PROVIDER_ID, apiKeys: { [HOSTED_PROVIDER_ID]: KEY } }),
      providerFetch: fetch,
    },
    async (services) => {
      const answer = await services.answer(OFF_BUNDLE_QUESTION);
      assert.equal(answer.tier, 0, 'a sick provider falls through to the offline tier');
      assert.ok(answer.text.length > 0, 'the learner still receives a lesson');
      assert.doesNotMatch(
        answer.text,
        new RegExp([HOSTED_PROVIDER_ID, '503', 'quota', 'credit', 'outage', 'rate limit', 'unavailable', 'refused'].join('|'), 'i'),
        'a learner lesson never carries an operations event',
      );
      assert.equal(
        answer.text.includes(KEY),
        false,
        'a learner lesson never carries the credential',
      );
    },
  );
});

test('no offline content and a failing provider yields a typed refusal, which the route renders generically', async () => {
  const { fetch } = fakeFetch({ status: 503, payload: { error: { message: 'upstream error HTTP 503' } } });
  await withServices(
    {
      dataDir: dataDir(),
      settings: settingsWith({ primary: HOSTED_PROVIDER_ID, apiKeys: { [HOSTED_PROVIDER_ID]: KEY } }),
      providerFetch: fetch,
      tierZero: emptyTierZero(),
    },
    async (services) => {
      await assert.rejects(
        services.answer(OFF_BUNDLE_QUESTION),
        AllTiersExhaustedError,
        'the gateway refuses with its typed, audit-grade error',
      );
    },
  );
});

test('a kill survives a restart, and a revive does too', async () => {
  const dir = dataDir();
  const { fetch } = fakeFetch({ status: 200, payload: MODEL_PAYLOAD });
  const wiring = {
    settings: settingsWith({ primary: HOSTED_PROVIDER_ID, apiKeys: { [HOSTED_PROVIDER_ID]: KEY } }),
    providerFetch: fetch,
  };

  // First process: kill the provider.
  const first = createLearnerServices({ dataDir: dir, ...wiring });
  first.killProvider(HOSTED_PROVIDER_ID, 'a safety incident');
  first.close();

  // Second process: the kill must still stand.
  const second = createLearnerServices({ dataDir: dir, ...wiring });
  try {
    const killed = await second.answer(OFF_BUNDLE_QUESTION);
    assert.equal(
      killed.tier,
      0,
      'a provider killed in another process must not serve here',
    );
  } finally {
    second.close();
  }

  // Revive in the second process, then a third process must serve again.
  const third = createLearnerServices({ dataDir: dir, ...wiring });
  try {
    third.reviveProvider(HOSTED_PROVIDER_ID, 'the incident was cleared');
    // Close and reopen so the revive itself is read back from the file.
    third.close();
    const fourth = createLearnerServices({ dataDir: dir, ...wiring });
    try {
      const revived = await fourth.answer(OFF_BUNDLE_QUESTION);
      assert.equal(revived.tier, 1, 'a revived provider serves the model tier again');
      assert.equal(revived.text, 'Water moves from the ocean into the clouds and falls back as rain.');
    } finally {
      fourth.close();
    }
  } catch (error) {
    third.close();
    throw error;
  }
});

test('the credential is never written to a durable record', async () => {
  const dir = dataDir();
  const { fetch } = fakeFetch({ status: 200, payload: MODEL_PAYLOAD });
  const first = createLearnerServices({
    dataDir: dir,
    settings: settingsWith({ primary: HOSTED_PROVIDER_ID, apiKeys: { [HOSTED_PROVIDER_ID]: KEY } }),
    providerFetch: fetch,
  });
  // A successful answer, a failed answer and a kill: every write path runs
  // while the credential is configured.
  try {
    await first.answer('explain photosynthesis');
    first.killProvider(HOSTED_PROVIDER_ID, 'a safety incident');
  } finally {
    first.close();
  }

  // The whole durable file must not carry the key, on any record, in any form.
  const file = readFileSync(join(dir, 'private.sqlite'), 'utf8');
  assert.equal(file.includes(KEY), false, 'the private store file never contains the credential');

  // And no structured record carries it either.
  const reopened = createSqlitePrivateStore({ path: join(dir, 'private.sqlite') });
  try {
    for (const record of reopened.all()) {
      assert.equal(
        JSON.stringify(record).includes(KEY),
        false,
        `record "${record.id}" must never carry the credential`,
      );
    }
  } finally {
    reopened.close();
  }
});

test('the learner runtime keeps serving when the public ledger chain is broken at boot', async () => {
  // ADR-0019: the public sponsor ledger is durable now, and its file lives in
  // the SAME data directory as the other durable stores. A tampered ledger
  // must never take the whole runtime down (load, report, don't refuse): the
  // runtime boots, the learner still gets answers, and the broken chain is
  // reported through the ledger's own verification surface for the operator.
  const dir = dataDir();
  const now = (): string => new Date().toISOString();

  const journalA = createSqliteLedgerJournal({ path: join(dir, 'ledger.sqlite') });
  const storeA = createLedgerStore({ now, persist: (entry) => journalA.persist(entry) });
  storeA.append('sponsor_pledge', { amount_cents: 100, sponsor_ref: 'SP-001' });
  storeA.append('sponsor_pledge', { amount_cents: 200, sponsor_ref: 'SP-001' });
  journalA.close();

  const attacker = new DatabaseSync(join(dir, 'ledger.sqlite'));
  attacker
    .prepare('UPDATE ledger_entries SET payload = ? WHERE seq = 2')
    .run(JSON.stringify({ amount_cents: 9_999_999, sponsor_ref: 'EVIL' }));
  attacker.close();

  await withServices({ dataDir: dir }, async (services) => {
    const report = services.publicLedger();
    assert.equal(report.verification.ok, false, 'the broken chain is reported, never hidden');
    assert.equal(report.verification.brokenAtSeq, 2);
    assert.equal(report.entries, 2, 'the evidence stays readable');

    const answer = await services.answer('How do I solve a linear equation?');
    assert.equal(answer.blocked, false, 'the learner is still served');
    assert.ok(answer.text.length > 0);
  });
});
