import { setTimeout as delay } from 'node:timers/promises';

export function hostedPocketHealthUrl() {
  const synthesisUrl = process.env.POCKET_TTS_URL;
  if (!synthesisUrl) return undefined;
  const url = new URL(synthesisUrl);
  return url.protocol === 'https:' ? new URL('/health', url.origin) : undefined;
}

export async function waitForPocketSpeech(url: URL) {
  const signal = AbortSignal.timeout(40_000);
  while (!signal.aborted) {
    try {
      const response = await fetch(url, { signal, redirect: 'error', cache: 'no-store' });
      if (response.ok) {
        const result = await response.json();
        if (result?.status === 'ready' || result?.status === 'healthy') return true;
      } else {
        await response.body?.cancel();
      }
    } catch {
      // Free hosts can return an error while their container starts.
    }
    await delay(2_000, undefined, { signal }).catch(() => {});
  }
  return false;
}

export async function pocketSpeech(text: string, onAudio: (data: string, mime: string) => boolean, signal: AbortSignal) {
  const url = process.env.POCKET_TTS_URL || 'http://127.0.0.1:8000/tts';
  const body = new URLSearchParams({ text });
  const response = await fetch(url, { method: 'POST', body, signal });
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('audio/wav')) {
    await response.body?.cancel();
    throw new Error('Pocket TTS returned invalid or incomplete audio.');
  }

  // Pocket TTS streams WAV with an open-ended data chunk. Forward complete PCM samples.
  const reader = response.body.getReader();
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let riffVerified = false;
  let header = true;
  let formatVerified = false;
  let sent = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending = Buffer.concat([pending, value]);
      while (header && pending.length >= 8) {
        const chunk = pending.toString('ascii', 0, 4);
        const size = pending.readUInt32LE(4);
        if (!riffVerified) {
          if (pending.length < 12) break;
          if (chunk !== 'RIFF' || pending.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Pocket TTS returned invalid or incomplete audio.');
          riffVerified = true;
          pending = pending.subarray(12);
          continue;
        }
        if (chunk === 'data') {
          if (!formatVerified) throw new Error('Pocket TTS returned invalid or incomplete audio.');
          pending = pending.subarray(8);
          header = false;
          break;
        }
        const end = 8 + size + (size % 2);
        if (end > 4096) throw new Error('Pocket TTS returned invalid or incomplete audio.');
        if (pending.length < end) break;
        if (chunk === 'fmt ') {
          if (size < 16 || pending.readUInt16LE(8) !== 1 || pending.readUInt16LE(10) !== 1
            || pending.readUInt32LE(12) !== 24000 || pending.readUInt16LE(22) !== 16) {
            throw new Error('Pocket TTS returned invalid or incomplete audio.');
          }
          formatVerified = true;
        }
        pending = pending.subarray(end);
      }
      if (!header && pending.length >= 2) {
        const end = pending.length - (pending.length % 2);
        if (!onAudio(pending.subarray(0, end).toString('base64'), 'audio/pcm;rate=24000')) return;
        sent = true;
        pending = pending.subarray(end);
      }
    }
    if (!sent || pending.length) throw new Error('Pocket TTS returned invalid or incomplete audio.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
