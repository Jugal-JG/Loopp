import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orpheusSpeech } from '../src/orpheus';

test('Orpheus uses Hannah, keeps each request within 200 characters, and preserves playback order', async context => {
  process.env.GROQ_API_KEY = 'test-key';
  delete process.env.GROQ_TTS_VOICE;
  const inputs: string[] = [];
  const played: number[] = [];
  context.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    assert.equal(body.voice, 'hannah');
    assert.equal(body.model, 'canopylabs/orpheus-v1-english');
    inputs.push(body.input);
    const wave = Buffer.alloc(46);
    wave.write('RIFF');
    wave.write('WAVE', 8);
    wave[45] = inputs.length;
    return new Response(wave);
  });
  const reply = 'Your receipt is available under Settings and Billing. '.repeat(6).trim();
  await orpheusSpeech(reply, (audio, mime) => {
    assert.equal(mime, 'audio/wav');
    played.push(Buffer.from(audio, 'base64')[45]);
    return true;
  });
  assert.ok(inputs.every(input => input.length <= 200));
  assert.equal(inputs.join(' '), reply);
  assert.deepEqual(played, [1, 2]);
});
