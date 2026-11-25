import { ServiceError } from './provider.js';

export const orpheusModel = 'canopylabs/orpheus-v1-english';

export async function orpheusSpeech(text: string, onAudio: (data: string, mime: string) => boolean) {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) throw new ServiceError('groq_not_configured', 503);
  const deadline = AbortSignal.timeout(12000);
  const audio: string[] = [];
  let remaining = Array.from(text.trim());
  while (remaining.length) {
    const head = remaining.slice(0, 200).join('');
    const lastSpace = head.lastIndexOf(' ');
    const boundary = remaining.length > 200 && lastSpace >= 0 ? Array.from(head.slice(0, lastSpace)).length : 0;
    const size = boundary >= 100 ? boundary : 200;
    const input = remaining.slice(0, size).join('').trim();
    remaining = Array.from(remaining.slice(size).join('').trimStart());
    const response = await fetch('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST', signal: deadline,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: orpheusModel, voice: process.env.GROQ_TTS_VOICE || 'hannah', input, response_format: 'wav' }),
    });
    if (!response.ok) throw new ServiceError(response.status === 429 ? 'rate_limited' : 'groq_speech_failed', response.status);
    const wav = Buffer.from(await response.arrayBuffer());
    if (wav.length <= 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
      throw new ServiceError('groq_speech_failed', 502);
    }
    audio.push(wav.toString('base64'));
  }
  for (const chunk of audio) if (!onAudio(chunk, 'audio/wav')) break;
}
