import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEvents } from '../src/stream';

test('decodes split SSE packets and ignores keepalives', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of [': keepalive\n\neve', 'nt: text\ndata: {"text":"Hello"}\n', '\nevent: done\ndata: {}\n\n']) {
        controller.enqueue(new TextEncoder().encode(part));
      }
      controller.close();
    },
  });
  const events: unknown[] = [];
  await readEvents(new Response(stream), (event, data) => events.push([event, data]));
  assert.deepEqual(events, [['text', { text: 'Hello' }], ['done', {}]]);
});

test('reads a friendly upstream error for a rejected request', async () => {
  await assert.rejects(readEvents(new Response(JSON.stringify({ message: 'Try again shortly.' }), { status: 429 }), () => {}), /Try again shortly/);
});
