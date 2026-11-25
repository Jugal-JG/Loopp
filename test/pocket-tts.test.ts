import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pocketSpeech } from '../src/pocket-tts';

test('Pocket TTS forwards PCM across split WAV headers and sample boundaries', async context => {
  const wav = Buffer.from('52494646ffffffff57415645666d74201000000001000100c05d000080bb00000200100064617461ffffffff01020304', 'hex');
  context.mock.method(globalThis, 'fetch', async (_url: string, options: { body: URLSearchParams }) => {
    assert.equal(options.body.get('text'), 'Your order is ready.');
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of [wav.subarray(0, 9), wav.subarray(9, 45), wav.subarray(45)]) controller.enqueue(chunk);
        controller.close();
      },
    }), { headers: { 'content-type': 'audio/wav' } });
  });
  const chunks: Buffer[] = [];
  await pocketSpeech('Your order is ready.', (data, mime) => {
    assert.equal(mime, 'audio/pcm;rate=24000');
    chunks.push(Buffer.from(data, 'base64'));
    return true;
  }, new AbortController().signal);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3, 4]));
});
