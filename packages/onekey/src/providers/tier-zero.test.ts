import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTierZeroProvider } from './tier-zero.js';
import { createPolicy, createRequest } from '../testing/support.js';

test('tier zero: serves cached curriculum deterministically', async () => {
  const tz = createTierZeroProvider();
  const policy = createPolicy({ taskClass: 'explain' });
  const req = createRequest({ prompt: 'Explain curriculum:algebra/linear-eq' });
  const first = await tz.serve(policy, req);
  const second = await tz.serve(policy, req);
  assert.ok(first, 'expected a cached curriculum answer');
  assert.equal(first.text, second?.text);
  assert.ok(first.text.length > 0);
  assert.ok(first.sourceLineage.length > 0, 'a cached answer must carry source lineage');
  assert.ok(first.sourceLineage[0]?.licence, 'source lineage must carry a licence');
});

test('tier zero: returns null when it has nothing for the task', async () => {
  const tz = createTierZeroProvider();
  const result = await tz.serve(
    createPolicy({ taskClass: 'research' }),
    createRequest({ prompt: 'Research quantum cryptography' }),
  );
  assert.equal(result, null, 'the gateway must be able to escalate when tier 0 has nothing');
});

test('tier zero: returns null for a curriculum id it does not hold', async () => {
  const tz = createTierZeroProvider();
  const result = await tz.serve(
    createPolicy({ taskClass: 'explain' }),
    createRequest({ prompt: 'Explain curriculum:unknown/atom' }),
  );
  assert.equal(result, null);
});

test('tier zero: lists the offline bundle ids available', () => {
  const tz = createTierZeroProvider();
  const bundles = tz.bundles();
  assert.ok(bundles.length > 0, 'expected at least one offline bundle id');
  assert.equal(new Set(bundles).size, bundles.length, 'bundle ids must be unique');
});

test('tier zero: the message for a lesson on the topic reads like a lesson, not like an apology', async () => {
  // F3-17. The notice must satisfy Doc 16 §6.6 step 6: core learning
  // continues, and sponsors are being notified — with no operations vocabulary
  // and no degraded framing of where the lesson came from.
  const tz = createTierZeroProvider();
  const result = await tz.serveFallback(
    createPolicy(),
    createRequest({ prompt: 'Explain photosynthesis in simple terms' }),
  );

  assert.ok(result !== null, 'the learner must still receive a lesson');
  const notice = result.text.split('\n\n')[0] ?? '';

  assert.match(notice, /core learning continues/i, '§6.6 step 6: core learning continues');
  assert.match(notice, /sponsors?[^.]*notified/i, '§6.6 step 6: sponsors are being notified');
  assert.doesNotMatch(
    notice,
    /provider|quota|credit|outage|\b401\b|\b403\b/i,
    'the learner must never see operations vocabulary',
  );
  assert.doesNotMatch(
    notice,
    /offline|library|fallback|may not answer|apolog|sorry|unfortunately/i,
    'the lesson must not be framed as degraded material, and the message must not apologise',
  );
});

test('tier zero: the message for a lesson with no topical match claims no coverage', async () => {
  // F3-17 and the honesty rule together: the learner gets a lesson, but the
  // message must not claim the lesson covers a topic it does not cover.
  const tz = createTierZeroProvider();
  const result = await tz.serveFallback(
    createPolicy(),
    createRequest({ prompt: 'Explain the water cycle' }),
  );

  assert.ok(result !== null, 'the learner must still receive a lesson');
  const notice = result.text.split('\n\n')[0] ?? '';

  assert.doesNotMatch(
    notice,
    /covers this topic|same topic/i,
    'a lesson that shares no word with the task must not claim it covers the topic',
  );
  assert.match(notice, /core learning continues/i, '§6.6 step 6: core learning continues');
  assert.match(notice, /sponsors?[^.]*notified/i, '§6.6 step 6: sponsors are being notified');
  assert.doesNotMatch(
    notice,
    /provider|quota|credit|outage|offline|library|may not answer|apolog|sorry|unfortunately/i,
    'no operations vocabulary and no apology',
  );
});

test('tier zero: an unrelated question is not answered with an unrelated subject lesson', async () => {
  // The owner's screenshot: "what is an Agent" was answered with the linear
  // equation lesson. A zero relevance score means NO cached lesson covers the
  // topic, so serving one with a disclaimer is a wrong answer, not a fallback.
  // The learner still gets something useful: an honest statement of the gap
  // and the real lessons available, with no false source lineage.
  const tz = createTierZeroProvider();
  const result = await tz.serveFallback(
    createPolicy(),
    createRequest({ prompt: 'what is an Agent' }),
  );

  assert.ok(result !== null, 'core learning is never denied');
  assert.doesNotMatch(
    result.text,
    /linear equation has the form|Plants turn light energy|numerator|denominator/i,
    'no unrelated cached subject lesson may be served as the answer',
  );
  assert.match(result.text, /does not have a lesson on this topic/i, 'the gap is stated plainly');
  assert.match(result.text, /Solving a linear equation/i, 'real available lessons are signposted');
  assert.match(result.text, /Photosynthesis in one step/i);
  assert.match(result.text, /Fractions basics/i);
  assert.match(result.text, /core learning continues/i, '§6.6 step 6 is still satisfied');
  assert.deepEqual(result.sourceLineage, [], 'no source was used - no false lineage');
});

test('tier zero: a stopword match is not a topical match', async () => {
  // The owner's second screenshot: "what is a EduGenesis?" was served the
  // linear-equation lesson with a "same topic" claim because the single
  // letter "a" appears in the entry title. Common words are not evidence of
  // a topic.
  const tz = createTierZeroProvider();
  const result = await tz.serveFallback(
    createPolicy(),
    createRequest({ prompt: 'what is a EduGenesis?' }),
  );

  assert.ok(result !== null);
  assert.doesNotMatch(
    result.text,
    /linear equation has the form|covers this topic|same topic as your question/i,
    'a stopword must not produce a false topical match or a false coverage claim',
  );
  assert.match(result.text, /does not have a lesson on this topic/i);
});

test('tier zero: a question using the singular of a lesson title finds that lesson', async () => {
  // Plural mismatch ("fraction" vs "Fractions basics") must not let a
  // stopword-scored unrelated lesson win the ranking.
  const tz = createTierZeroProvider();
  const result = await tz.serveFallback(
    createPolicy(),
    createRequest({ prompt: 'What is a fraction?' }),
  );

  assert.ok(result !== null);
  assert.equal(
    result.sourceLineage[0]?.locator,
    'curriculum:math/fractions-basics',
    'the fractions lesson is the real answer',
  );
  assert.match(result.text, /same topic as your question/i);
});
