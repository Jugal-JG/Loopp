import { config } from 'dotenv';
import { createServer } from 'node:http';
import { createHandler } from '../api/support';

config({ path: ['.env.local', '.env'], quiet: true });

const handler = createHandler(undefined, { localOrigin: 'http://localhost:5173' });
createServer(handler).listen(3001, '127.0.0.1', () => {
  console.log('Support API listening on http://127.0.0.1:3001');
  console.log('Local requests from http://localhost:5173 will log turn, database, and speech timings here.');
});
