import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderUnavailableError } from '@edugenesis/contracts';
import { createQwenAdapter, QWEN_BASE_URL, QWEN_DEFAULT_MODEL, QWEN_MAINLAND_BASE_URL } from './qwen-adapter.js';
import { createContext, createRequest } from '../testing/support.js';
import type { FetchLike, FetchRequestInit } from './qwen-adapter.js';

const FAKE_KEY = 'test-key-not-real';

interface RecordedCall {
  url: string;
  init: FetchRequestInit;
}

function recordingFetch(
  calls: RecordedCall[],
  response: { status: number; body: unknown; headers?: Record<string, string> },
): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: 'stub',
      headers: {
        get: (name: string) => response.headers?.[name.toLowerCase()] ?? null,
      },
      json: async () => response.body,
    };
  };
}

const OPENAI_COMPATIBLE_RESPONSE = {
  id: 'chatcmpl-stub',
  object: 'chat.completion',
  created: 1_767_225_600,
  model: 'qwen-plus',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Photosynthesis converts light into chemical energy.' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
};

test('qwen: with no API key it refuses to run and never throws a raw credential error', async () => {
  const adapter = createQwenAdapter();
  await assert.rejects(
    () => adapter.complete(createRequest(), createContext()),
    (err: unknown) => {
      assert.ok(err instanceof ProviderUnavailableError, 'expected a typed ProviderUnavailableError');
      assert.match(err.detail ?? '', /api key/i);
      assert.doesNotMatch(err.message, /test-key-not-real/);
      return true;
    },
  );
});

test('qwen: with a fake key it builds a correct OpenAI-compatible request body', async () => {
  const calls: RecordedCall[] = [];
  const adapter = createQwenAdapter({
    apiKey: FAKE_KEY,
    modelId: 'qwen-plus',
    fetchImpl: recordingFetch(calls, { status: 200, body: OPENAI_COMPATIBLE_RESPONSE }),
  });

  const result = await adapter.complete(
    createRequest({ prompt: 'Explain photosynthesis', maxOutputTokens: 256 }),
    createContext(),
  );

  const call = calls[0];
  assert.ok(call, 'expected exactly one HTTP call');
  assert.equal(
    call.url,
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    'the OpenAI-compatible chat completions endpoint must be used',
  );

  const headers = call.init.headers;
  // HTTP header names are case-insensitive, so look the header up that way.
  const authHeader = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization');
  assert.ok(authHeader, 'expected an Authorization header');
  assert.equal(authHeader[1], `Bearer ${FAKE_KEY}`, 'the key travels in the Authorization header');

  const body: unknown = JSON.parse(call.init.body);
  assert.ok(body && typeof body === 'object');
  const payload = body as Record<string, unknown>;
  assert.equal(payload.model, 'qwen-plus');
  assert.equal(payload.max_tokens, 256, 'req.maxOutputTokens must map to max_tokens');
  assert.equal(payload.stream, false);
  const messages = payload.messages;
  assert.ok(Array.isArray(messages));
  const firstMessage = messages[0] as Record<string, unknown>;
  assert.equal(firstMessage.role, 'user');
  assert.equal(firstMessage.content, 'Explain photosynthesis');

  // The key must appear in the Authorization header and NOWHERE else.
  const occurrences = (JSON.stringify(call.init).match(/test-key-not-real/g) ?? []).length;
  assert.equal(occurrences, 1, 'the credential must not leak into the body or any other header');
});

test('qwen: the response is mapped onto the contract result', async () => {
  const calls: RecordedCall[] = [];
  const adapter = createQwenAdapter({
    apiKey: FAKE_KEY,
    fetchImpl: recordingFetch(calls, { status: 200, body: OPENAI_COMPATIBLE_RESPONSE }),
  });

  const result = await adapter.complete(createRequest(), createContext());

  assert.equal(result.text, 'Photosynthesis converts light into chemical energy.');
  assert.equal(result.providerId, adapter.id);
  assert.equal(result.modelId, 'qwen-plus');
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 24);
});

test('qwen: a 401 is mapped to ProviderUnavailableError with a detail', async () => {
  const calls: RecordedCall[] = [];
  const adapter = createQwenAdapter({
    apiKey: FAKE_KEY,
    fetchImpl: recordingFetch(calls, { status: 401, body: { error: { message: 'invalid api key' } } }),
  });

  await assert.rejects(
    () => adapter.complete(createRequest(), createContext()),
    (err: unknown) => {
      assert.ok(err instanceof ProviderUnavailableError);
      assert.match(err.detail ?? '', /401/);
      assert.doesNotMatch(err.detail ?? '', /test-key-not-real/);
      return true;
    },
  );
});

test('qwen: a 403 is mapped to ProviderUnavailableError with a detail', async () => {
  const calls: RecordedCall[] = [];
  const adapter = createQwenAdapter({
    apiKey: FAKE_KEY,
    fetchImpl: recordingFetch(calls, { status: 403, body: { error: { message: 'no permission' } } }),
  });

  await assert.rejects(
    () => adapter.complete(createRequest(), createContext()),
    (err: unknown) => {
      assert.ok(err instanceof ProviderUnavailableError);
      assert.match(err.detail ?? '', /403/);
      return true;
    },
  );
});

test('qwen: a 429 is mapped to ProviderUnavailableError with a retry-after hint', async () => {
  const calls: RecordedCall[] = [];
  const adapter = createQwenAdapter({
    apiKey: FAKE_KEY,
    fetchImpl: recordingFetch(calls, {
      status: 429,
      body: { error: { message: 'rate limited' } },
      headers: { 'retry-after': '30' },
    }),
  });

  await assert.rejects(
    () => adapter.complete(createRequest(), createContext()),
    (err: unknown) => {
      assert.ok(err instanceof ProviderUnavailableError);
      assert.match(err.detail ?? '', /429/);
      assert.match(err.detail ?? '', /retry after 30s/i);
      return true;
    },
  );
});

test('qwen: the timeout comes from the request deadline', async () => {
  const calls: RecordedCall[] = [];
  const adapter = createQwenAdapter({
    apiKey: FAKE_KEY,
    fetchImpl: recordingFetch(calls, { status: 200, body: OPENAI_COMPATIBLE_RESPONSE }),
  });
  const ctx = createContext({ deadlineAt: Date.now() - 1 });

  await assert.rejects(
    () => adapter.complete(createRequest(), ctx),
    (err: unknown) => {
      assert.ok(err instanceof ProviderUnavailableError);
      assert.match(err.detail ?? '', /deadline/i);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'an expired deadline must not reach the network');
});

test('qwen: dispose releases the credential and the adapter stops working', async () => {
  const adapter = createQwenAdapter({ apiKey: FAKE_KEY });
  await adapter.dispose();
  await assert.rejects(
    () => adapter.complete(createRequest(), createContext()),
    (err: unknown) => {
      assert.ok(err instanceof ProviderUnavailableError);
      assert.match(err.detail ?? '', /api key/i);
      return true;
    },
  );
});

test('qwen: the two regional endpoints are distinct, both https, and both end the same way', () => {
  // The pilot is international (DashScope intl) but a mainland deployment must
  // be able to switch without editing source. Two URLs that accidentally
  // collapsed into one would send every request to the wrong region.
  assert.notEqual(QWEN_BASE_URL, QWEN_MAINLAND_BASE_URL);
  assert.match(QWEN_BASE_URL, /^https:\/\//);
  assert.match(QWEN_MAINLAND_BASE_URL, /^https:\/\//);
  assert.match(QWEN_BASE_URL, /\/compatible-mode\/v1$/);
  assert.match(QWEN_MAINLAND_BASE_URL, /\/compatible-mode\/v1$/);
  assert.match(QWEN_BASE_URL, /^https:\/\/dashscope-intl\.aliyuncs\.com\//);
  assert.match(QWEN_MAINLAND_BASE_URL, /^https:\/\/dashscope\.aliyuncs\.com\//);
  assert.equal(QWEN_DEFAULT_MODEL, 'qwen-plus');
});

test('qwen: the adapter calls whichever endpoint it was given', async () => {
  const calls: RecordedCall[] = [];
  const adapter = createQwenAdapter({
    apiKey: FAKE_KEY,
    baseUrl: QWEN_MAINLAND_BASE_URL,
    fetchImpl: recordingFetch(calls, { status: 200, body: OPENAI_COMPATIBLE_RESPONSE }),
  });

  await adapter.complete(createRequest(), createContext());

  assert.equal(calls[0]?.url, `${QWEN_MAINLAND_BASE_URL}/chat/completions`);
});
