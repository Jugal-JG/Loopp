import { config } from 'dotenv';
import { createServer } from 'node:http';
import { createHandler } from '../api/support';

config({ path: ['.env.local', '.env'], quiet: true });

const handler = createHandler(undefined, { localOrigin: 'http://localhost:5173' });
createServer(handler).listen(3001, '127.0.0.1', () => {
  console.log('Support API listening on http://127.0.0.1:3001');
  const tts = process.env.TTS_OUTPUT || 'auto';
  console.log(`Voice output mode: ${tts}. Groq key loaded: ${process.env.GROQ_API_KEY?.trim() ? 'yes' : 'no'}.`);
});
