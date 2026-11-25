import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createHandler } from '../api/support';
import { db, searchByVector } from '../src/store';
import { chunks } from '../src/policies';
import { PRO_REFUND_POLICY, type Reply } from '../src/agent';
import { readEvents } from '../src/stream';
import { ServiceError } from '../src/provider';

const axis = (dimension: number) => Array.from({ length: 768 }, (_, index) => Number(index === dimension));
const refundVector = axis(chunks.findIndex(chunk => chunk.id === PRO_REFUND_POLICY));
const receiptVector = axis(chunks.findIndex(chunk => chunk.id === 'pro-billing/billing-receipts'));

test('local HTTP, SSE, pgvector ranking, session reload, recovery, tickets and exactly-once refunds', async () => {
  const postgres = await PGlite.create({ extensions: { vector } });
  await postgres.exec(await readFile(new URL('../scripts/schema.sql', import.meta.url), 'utf8'));
  const socket = new PGLiteSocketServer({ db: postgres, port: 0 });
  await socket.start();
  process.env.DATABASE_URL = `postgres://postgres:local@${socket.getServerConn()}/postgres?sslmode=disable`;
  process.env.DEMO_PASSCODE = 'test-passcode';
  process.env.ADMIN_EMAIL = 'admin@loopp.example';
  process.env.ADMIN_PASSWORD = 'test-admin-passcode';
  const api = createServer(createHandler({
    decide: async context => {
      if (context.message === 'Simulate planner capacity') throw new ServiceError('upstream_busy', 503, 'gemini-3.1-flash-lite');
      const state = context as { message: string; allowed: string[]; matches?: typeof chunks };
      if (state.allowed[0] === 'verifyAccount') return { action: 'verifyAccount' };
      if (!state.matches) return { action: 'searchPolicy' };
      const match = state.matches[0];
      return { action: state.message.includes('refund') ? 'prepareRefund' : 'answer', sourceId: match.id, quote: match.text };
    },
    verifyEvidence: async () => true,
    searchPolicy: (query, tier) => searchByVector(query.includes('refund') ? refundVector : query.includes('receipt') ? receiptVector : axis(767), tier),
    voiceToken: async () => 'fixture-token',
    speech: async (_text, onAudio) => { onAudio('AAAAAA==', 'audio/l16'); },
  }, { localOrigin: 'http://localhost:5173' }));
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const address = api.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/api/support?action=`;
  const fetchPost = (action: string, body: object, cookie?: string, origin = 'http://localhost:5173') => fetch(endpoint + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie && { Cookie: cookie }) }, body: JSON.stringify(body),
  });
  try {
    for (const [index, chunk] of chunks.entries()) {
      await db().query('INSERT INTO policy_chunks VALUES($1,$2,$3,$4,$5,$6::vector)',
        [chunk.id, chunk.version, chunk.tier, chunk.title, chunk.text, JSON.stringify(axis(index))]);
    }
    await db().query('INSERT INTO policy_chunks VALUES($1,$2,$3,$4,$5,$6::vector)',
      ['stale', 'old', 'Pro', 'outdated', 'outdated policy', JSON.stringify(refundVector)]);
    const proMatches = await searchByVector(refundVector, 'Pro');
    assert.equal(proMatches[0].id, PRO_REFUND_POLICY);
    assert.equal(proMatches[0].score, 1);
    assert.ok(proMatches.every(item => item.tier !== 'Basic' && item.id !== 'stale'));
    const basicMatches = await searchByVector(refundVector, 'Basic');
    assert.ok(!basicMatches.some(item => item.id === PRO_REFUND_POLICY));
    const publicBasic = await searchByVector(refundVector, 'Basic', true);
    assert.ok(publicBasic.length > 0 && publicBasic.every(item => item.tier === 'Basic' && /^(basic-admin|basic-billing)\//.test(item.id)));
    assert.equal((await fetch(endpoint + 'session')).status, 401);
    process.env.GOOGLE_CLIENT_ID = 'test-client';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    process.env.APP_ORIGIN = 'http://localhost:5173';
    const google = await fetch(endpoint + 'google', { redirect: 'manual' });
    const auth = new URL(google.headers.get('location')!);
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('redirect_uri'), 'http://localhost:5173/api/support');
    const badCallback = await fetch(new URL('/api/support?code=test&state=wrong', endpoint), {
      redirect: 'manual', headers: { Cookie: google.headers.get('set-cookie')!.split(';')[0] },
    });
    assert.equal(badCallback.headers.get('location'), '/?auth=failed');
    assert.equal((await fetchPost('login', { passcode: 'test-passcode' }, undefined, 'http://unrelated.example')).status, 403);
    assert.equal((await fetchPost('login', { passcode: 'wrong' })).status, 401);
    const login = await fetchPost('login', { passcode: 'test-passcode' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.ok(login.headers.get('set-cookie')?.includes('HttpOnly'));
    await db().query('UPDATE demo_sessions SET email=$1,auth_kind=$2,account_profile=$3 WHERE id=$4',
      ['customer@example.test', 'google', 'pro', cookie.split('=')[1]]);
    const forgedProfile = await fetchPost('turn', { id: randomUUID(), message: 'Hello', mode: 'chat', profile: 'basic' }, cookie);
    assert.equal(forgedProfile.status, 400);
    async function turn(message: string, mode = 'chat', id = randomUUID(), simulate = '') {
      let reply!: Reply;
      const events: string[] = [];
      const response = await fetchPost('turn', { id, message, mode, profile: 'pro', simulate }, cookie);
      assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
      await readEvents(response, (event, data) => {
        events.push(event);
        if (event === 'trace' && data.stage === 'voice failure') events.push(data.provider + ' failed');
        if (event === 'reply') reply = data.reply;
      });
      assert.ok(events.includes('done'));
      return { reply, events };
    }
    assert.equal((await turn('Please refund my last charge')).reply.kind, 'confirmation');
    const id = randomUUID();
    process.env.TTS_OUTPUT = 'browser';
    const confirmed = await turn('confirm refund', 'voice', id);
    assert.equal(confirmed.reply.kind, 'refunded');
    assert.ok(confirmed.events.includes('browserAudio'));
    assert.ok(confirmed.events.indexOf('browserAudio') < confirmed.events.indexOf('reply'));
    assert.ok(!confirmed.events.includes('audio'));
    process.env.TTS_OUTPUT = 'auto';
    delete process.env.GROQ_API_KEY;
    const replay = await turn('confirm refund', 'voice', id);
    assert.deepEqual(replay.reply, confirmed.reply);
    assert.ok(replay.events.includes('groq failed'));
    assert.ok(replay.events.indexOf('audio') > replay.events.indexOf('groq failed'));
    assert.equal((await db().query('SELECT count(*)::int AS count FROM refunds')).rows[0].count, 1);
    const retry = randomUUID();
    assert.equal((await turn('Where is my receipt?', 'chat', retry, 'timeout')).reply.kind, 'error');
    assert.equal((await turn('Where is my receipt?', 'chat', retry)).reply.kind, 'answer');
    assert.equal((await turn('Recommend a hotel near the airport.')).reply.kind, 'escalated');
    const state = await (await fetch(endpoint + 'session', { headers: { Cookie: cookie } })).json();
    assert.equal(state.turns.length, 4);
    assert.equal(state.turns[1].mode, 'voice');
    assert.equal(state.turns[1].reply.kind, 'refunded');
    assert.equal((await db().query('SELECT count(*)::int AS count FROM tickets')).rows[0].count, 1);
    assert.equal((await fetch(endpoint + 'tickets', { headers: { Cookie: cookie } })).status, 403);
    const admin = await fetchPost('login', { email: 'admin@loopp.example', passcode: 'test-admin-passcode' });
    assert.equal(admin.status, 200);
    const adminCookie = admin.headers.get('set-cookie')!.split(';')[0];
    const inbox = await (await fetch(endpoint + 'tickets', { headers: { Cookie: adminCookie } })).json();
    const [ticket] = inbox.tickets;
    assert.equal(ticket.status, 'pending');
    assert.match(ticket.request_text, /hotel/);
    assert.equal(ticket.queued, 1);
    const review = await fetchPost('review-ticket', { reference: ticket.reference, status: 'accepted' }, adminCookie);
    assert.equal(review.status, 200);
    assert.equal((await review.json()).ticket.status, 'accepted');
    assert.equal((await fetchPost('review-ticket', { reference: ticket.reference, status: 'rejected' }, adminCookie)).status, 409);
    const answer = { reference: ticket.reference, message: 'Please contact billing.', id: randomUUID() };
    assert.equal((await fetchPost('reply-ticket', answer, cookie)).status, 403);
    assert.equal((await fetchPost('reply-ticket', answer, adminCookie)).status, 200);
    assert.equal((await fetchPost('reply-ticket', answer, adminCookie)).status, 200);
    assert.equal((await db().query('SELECT count(*)::int AS count FROM ticket_messages')).rows[0].count, 1);
    assert.equal((await db().query('SELECT count(*)::int AS count FROM ticket_email')).rows[0].count, 2);
    assert.equal((await fetchPost('delete-ticket', { reference: ticket.reference }, cookie)).status, 403);
    assert.equal((await fetchPost('delete-ticket', { reference: ticket.reference }, adminCookie)).status, 200);
    const afterDelete = await (await fetch(endpoint + 'tickets', { headers: { Cookie: adminCookie } })).json();
    assert.deepEqual(afterDelete.tickets, []);
    assert.equal((await fetchPost('reply-ticket', { ...answer, id: randomUUID() }, adminCookie)).status, 404);
    assert.match((await turn('Where is my receipt?', 'chat', randomUUID(), 'rate')).reply.text, /rate limited/);
    assert.match((await turn('Simulate planner capacity')).reply.text, /gemini-3\.1-flash-lite.*HTTP 503/);
    const rejected = await fetchPost('turn', { id: randomUUID(), message: 'Where is my receipt?', mode: 'chat', profile: 'pro' }, cookie);
    assert.equal(rejected.status, 429);
    await db().query('UPDATE demo_sessions SET pending=$1', [{ id: randomUUID(), profile: 'pro', policy: PRO_REFUND_POLICY }]);
    assert.equal((await fetchPost('clear', {}, cookie)).status, 200);
    const cleared = await (await fetch(endpoint + 'session', { headers: { Cookie: cookie } })).json();
    assert.deepEqual(cleared.turns, []);
    assert.equal(cleared.pending, undefined);
    assert.equal((await db().query('SELECT count(*)::int AS count FROM refunds')).rows[0].count, 1);
    assert.equal((await db().query('SELECT count(*)::int AS count FROM tickets')).rows[0].count, 1);
  } finally {
    api.close();
    await db().end();
    await socket.stop();
    await postgres.close();
  }
});
