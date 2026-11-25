import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTextFallback } from '../src/provider';
import { playSpeechWithFallback } from '../src/speech-output';

test('Gemini text switches to 3.1 Flash-Lite on a quota failure and preserves other errors', async () => {
  const models: string[] = [];
  process.env.GEMINI_TEXT_MODEL = 'gemini-3.5-flash-lite';
  process.env.GEMINI_TEXT_FALLBACK_MODEL = 'gemini-3.1-flash-lite';
  const answer = await withTextFallback(async model => {
    models.push(model);
    if (models.length === 1) throw { status: 429 };
    return 'answer';
  });
  assert.deepEqual(models, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
  assert.deepEqual(answer, { model: 'gemini-3.1-flash-lite', result: 'answer' });
  let calls = 0;
  await assert.rejects(withTextFallback(async () => { calls++; throw new Error('Invalid request'); }), /Invalid request/);
  assert.equal(calls, 1);
});

test('voice uses Groq after Gemini and browser only after both providers fail', async () => {
  const failures: string[] = [];
  const audio: string[] = [];
  const gemini = { name: 'gemini', speak: async () => { throw { status: 429 }; } };
  await playSpeechWithFallback([gemini, { name: 'groq', speak: async write => { write('groq audio', 'audio/wav'); } }],
    data => { audio.push(data); return true; }, () => audio.push('browser'), provider => failures.push(provider), () => false);
  assert.deepEqual(audio, ['groq audio']);
  await playSpeechWithFallback([gemini, { name: 'groq', speak: async () => { throw { status: 429 }; } }],
    () => true, () => audio.push('browser'), provider => failures.push(provider), () => false);
  assert.deepEqual(failures, ['gemini', 'gemini', 'groq']);
  assert.deepEqual(audio, ['groq audio', 'browser']);
});

test('a partial cloud reply does not restart in another voice', async () => {
  const failure = new Error('Interrupted after audio began');
  await assert.rejects(playSpeechWithFallback([
    { name: 'gemini', speak: async write => { write('pcm', 'audio/l16'); throw failure; } },
    { name: 'groq', speak: async () => assert.fail('Groq should not replay the reply') },
  ], () => true, () => assert.fail('Browser should not replay the reply'), () => {}, () => false), failure);
});

test('a provider that stalls before audio is canceled and cannot play a late chunk', async () => {
  let lateAudio: (() => boolean) | undefined;
  const audio: string[] = [];
  await playSpeechWithFallback([
    { name: 'gemini', firstAudioMs: 10, speak: (write, signal) => new Promise<void>(resolve => {
      lateAudio = () => write('late audio', 'audio/l16');
      signal.addEventListener('abort', () => resolve(), { once: true });
    }) },
    { name: 'groq', speak: async write => { write('groq audio', 'audio/wav'); } },
  ], data => { audio.push(data); return true; }, () => assert.fail('Groq succeeded'),
  (provider, error) => {
    assert.equal(provider, 'gemini');
    assert.equal((error as Error).name, 'TimeoutError');
  }, () => false);
  assert.equal(lateAudio?.(), false);
  assert.deepEqual(audio, ['groq audio']);
});
