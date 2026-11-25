import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { db, issueRefund, searchPolicy, takeBudget, type Turn } from '../src/store.js';
import { decide, isRateLimit, ServiceError, speech, voiceToken, textModel, verifyEvidence } from '../src/provider.js';
import { accounts, runSupportTurn, type Pending, type Profile, type Reply } from '../src/agent.js';
import { adminEmail, cookie, googleEnabled, googleFinish, googleProfile, googleStart, isAdmin, readCookie, secretMatches } from '../src/identity.js';
import { deliverEmail } from '../src/notifications.js';
import { orpheusSpeech } from '../src/orpheus.js';
import { playSpeechWithFallback } from '../src/speech-output.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const errors: Record<string, string> = {
  rate_limited: 'The demo is temporarily rate limited. Try again in a minute.',
  upstream_timeout: 'The AI service took too long. Try this turn again.',
  tool_failure: 'The simulated tool failed. Your conversation is saved. Try this turn again.',
  turn_busy: 'Another turn is still running. Wait for it to finish.',
  database_not_configured: 'Connect Neon and seed the policy database to start.',
  wrong_origin: 'Open the Loopp app at the URL printed by Vite and try again.',
  upstream_busy: 'Gemini is temporarily at capacity. Retry this turn in a moment.',
  groq_speech_failed: 'Orpheus could not generate the audio reply.',
  gemini_not_configured: 'Set GEMINI_API_KEY on the server to start.',
  unavailable: 'Support is temporarily unavailable. Try again.',
};

function classify(error: unknown) {
  if (error instanceof ServiceError) return error;
  const failure = error as { code?: string; status?: number; name?: string; message?: string };
  if (isRateLimit(error)) return new ServiceError('rate_limited', 429);
  if (failure.status === 504 || failure.name === 'TimeoutError' || failure.name === 'AbortError' || /timed? ?out|timeout|deadline/i.test(failure.message ?? '')) {
    return new ServiceError('upstream_timeout', 504);
  }
  if (failure.status === 503) return new ServiceError('upstream_busy', 503);
  return new ServiceError('unavailable', 503);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage & { body?: unknown }): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    if (JSON.stringify(req.body).length > 8192) throw new ServiceError('request_too_large', 413);
    return req.body as Record<string, unknown>;
  }
  let body = typeof req.body === 'string' ? req.body : '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) throw new ServiceError('request_too_large', 413);
  }
  try {
    const parsed = JSON.parse(body || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new ServiceError('invalid_json', 400); }
}

async function getSession(req: IncomingMessage) {
  const id = (req.headers.cookie ?? '').match(/(?:^|;\s*)loopp=([^;]+)/)?.[1];
  if (!id || !uuid.test(id)) throw new ServiceError('sign_in_required', 401);
  const result = await db().query('SELECT pending,email,auth_kind,account_profile FROM demo_sessions WHERE id=$1 AND created_at>now()-interval \'1 day\'', [id]);
  if (!result.rowCount) throw new ServiceError('sign_in_required', 401);
  const row = result.rows[0];
  return { id, pending: row.pending as Pending | undefined, email: row.email as string | null,
    kind: row.auth_kind as string | null, profile: row.account_profile as Profile | null, admin: isAdmin(row.email, row.auth_kind) };
}

async function createSession(email: string | null, kind: string, profile: Profile | null) {
  const id = randomUUID();
  await db().query('INSERT INTO demo_sessions(id,email,auth_kind,account_profile) VALUES($1,$2,$3,$4)', [id, email, kind, profile]);
  return id;
}

const providers = { decide, verifyEvidence, searchPolicy, speech, voiceToken };

async function handle(req: IncomingMessage, res: ServerResponse, services: typeof providers, localOrigin?: string) {
  const requestId = randomUUID();
  const url = new URL(req.url ?? '/', 'http://loopp.local');
  const action = url.searchParams.get('action') ?? 'session';
  const secure = !localOrigin;
  res.setHeader('X-Request-Id', requestId);
  try {
    if (action === 'health' && req.method === 'GET') return json(res, 200, { status: 'ok' });
    if (action === 'auth-options' && req.method === 'GET') return json(res, 200, { google: googleEnabled(), admin: Boolean(adminEmail() && process.env.ADMIN_PASSWORD) });
    if (action === 'google' && req.method === 'GET') {
      const flow = googleStart();
      res.writeHead(302, { Location: flow.url, 'Set-Cookie': cookie('loopp_oauth', flow.stateCookie, 600, secure), 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (action === 'session' && req.method === 'GET' && url.searchParams.has('state')) {
      const cookies = [cookie('loopp_oauth', '', 0, secure)];
      let location = '/';
      try {
        const email = await googleFinish(url, readCookie(req.headers.cookie, 'loopp_oauth'));
        cookies.push(cookie('loopp', await createSession(email, 'google', googleProfile(email)), 86400, secure));
      } catch { location = '/?auth=failed'; }
      res.writeHead(303, { Location: location, 'Set-Cookie': cookies, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin) {
        const scheme = localOrigin ? 'http' : 'https';
        const sameOrigin = origin === `${scheme}://${req.headers.host}`;
        const loopbackProxy = req.socket.remoteAddress === '127.0.0.1' && origin === localOrigin;
        if (!sameOrigin && !loopbackProxy) throw new ServiceError('wrong_origin', 403);
      }
    }
    if (action === 'login' && req.method === 'POST') {
      const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
      await takeBudget(`login:${ip}`, 8);
      const body = await readBody(req);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;
      const admin = !!email && email === adminEmail() && secretMatches(String(body.passcode ?? ''), process.env.ADMIN_PASSWORD);
      if (!admin && (email || !secretMatches(String(body.passcode ?? ''), process.env.DEMO_PASSCODE))) throw new ServiceError('incorrect_credentials', 401);
      const id = await createSession(admin ? email : null, admin ? 'admin' : 'demo', null);
      res.setHeader('Set-Cookie', cookie('loopp', id, 86400, secure));
      return json(res, 200, { ok: true });
    }
    const session = await getSession(req);
    if (action === 'logout' && req.method === 'POST') {
      await db().query('UPDATE demo_sessions SET created_at=now()-interval \'2 days\' WHERE id=$1', [session.id]);
      res.setHeader('Set-Cookie', cookie('loopp', '', 0, secure));
      return json(res, 200, { ok: true });
    }
    if (['tickets', 'review-ticket', 'reply-ticket', 'retry-email'].includes(action) && !session.admin) throw new ServiceError('admin_required', 403);
    if (action === 'tickets' && req.method === 'GET') {
      const result = await db().query(`SELECT t.reference,t.reason,t.profile,t.status,t.created_at,t.reviewed_at,t.request_text,s.email,
          COALESCE((SELECT json_agg(m ORDER BY m.created_at) FROM ticket_messages m WHERE m.reference=t.reference),'[]') AS messages,
          (SELECT count(*)::int FROM ticket_email e WHERE e.reference=t.reference AND sent_at IS NULL) AS queued
        FROM tickets t JOIN demo_sessions s ON s.id=t.session_id ORDER BY t.created_at DESC LIMIT 100`);
      return json(res, 200, { tickets: result.rows });
    }
    if (action === 'review-ticket' && req.method === 'POST') {
      const { reference, status } = await readBody(req);
      if (typeof reference !== 'string' || !/^HD-[A-F0-9]{8}$/.test(reference) || !['accepted', 'rejected'].includes(String(status))) {
        throw new ServiceError('invalid_review', 400);
      }
      const result = await db().query(`UPDATE tickets SET status=$2,reviewed_at=now()
        WHERE reference=$1 AND status='pending'
        RETURNING reference,reason,profile,status,created_at,reviewed_at,request_text`, [reference, status]);
      if (!result.rowCount) throw new ServiceError('ticket_already_reviewed_or_unavailable', 409);
      return json(res, 200, { ticket: result.rows[0] });
    }
    if (action === 'reply-ticket' && req.method === 'POST') {
      const { reference, message, id } = await readBody(req);
      if (typeof reference !== 'string' || typeof id !== 'string' || !uuid.test(id) || typeof message !== 'string' || !message.trim() || message.length > 2000) throw new ServiceError('invalid_reply', 400);
      const emailId = `reply-${id}`;
      const result = await db().query(`WITH added AS (
        INSERT INTO ticket_messages(id,reference,body) SELECT $1,reference,$3 FROM tickets WHERE reference=$2
        ON CONFLICT(id) DO NOTHING RETURNING *
      ), mail AS (
        INSERT INTO ticket_email(id,reference,recipient,subject,body)
        SELECT $4,a.reference,s.email,'Loopp support reply ' || a.reference,a.body
        FROM added a JOIN tickets t ON t.reference=a.reference JOIN demo_sessions s ON s.id=t.session_id
        WHERE s.auth_kind='google' AND s.email IS NOT NULL ON CONFLICT DO NOTHING
      ) SELECT * FROM added UNION ALL SELECT * FROM ticket_messages WHERE id=$1 AND reference=$2 AND body=$3`, [id, reference, message.trim(), emailId]);
      if (!result.rowCount) throw new ServiceError('ticket_unavailable', 404);
      return json(res, 200, { message: result.rows[0], delivery: await deliverEmail(emailId) });
    }
    if (action === 'retry-email' && req.method === 'POST') {
      const { reference } = await readBody(req);
      const rows = await db().query('SELECT id FROM ticket_email WHERE reference=$1 AND sent_at IS NULL ORDER BY created_at LIMIT 5', [reference]);
      await Promise.all(rows.rows.map(row => deliverEmail(row.id)));
      return json(res, 200, { ok: true });
    }
    if (action === 'clear' && req.method === 'POST') {
      const cleared = await db().query(`WITH reset AS (
        UPDATE demo_sessions SET pending=NULL WHERE id=$1 AND (lease_until IS NULL OR lease_until<now()) RETURNING id
      ), removed AS (
        DELETE FROM support_turns WHERE session_id IN (SELECT id FROM reset)
      ) SELECT id FROM reset`, [session.id]);
      if (!cleared.rowCount) throw new ServiceError('turn_busy', 409);
      return json(res, 200, { ok: true });
    }
    if (action === 'session' && req.method === 'GET') {
      const result = await db().query<Turn>(`SELECT * FROM (SELECT id,message,mode,profile,reply,traces,created_at
        FROM support_turns WHERE session_id=$1 ORDER BY created_at DESC LIMIT 40) history ORDER BY created_at`, [session.id]);
      return json(res, 200, { turns: result.rows, pending: session.pending?.profile, identity: { admin: session.admin, profile: session.profile } });
    }
    if (action === 'voice' && req.method === 'POST') {
      await takeBudget(`voice:${session.id}`, 3);
      await takeBudget('voice:global', 10);
      return json(res, 200, { token: await services.voiceToken() });
    }
    if (action !== 'turn' || req.method !== 'POST') throw new ServiceError('not_found', 404);
    const body = await readBody(req);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const id = String(body.id ?? '');
    const profile = String(body.profile ?? '') as Profile;
    if (!uuid.test(id) || !Object.hasOwn(accounts, profile) || (session.profile && profile !== session.profile) || !message || message.length > 1000 || !['chat', 'voice'].includes(String(body.mode))) {
      throw new ServiceError('invalid_turn', 400);
    }
    const mode = body.mode;
    await takeBudget(`turn:${session.id}`, 8);
    await takeBudget('turn:global', 20);
    const claimed = await db().query(`UPDATE demo_sessions SET active_turn=$2,lease_until=now()+interval '65 seconds'
      WHERE id=$1 AND (lease_until IS NULL OR lease_until<now()) RETURNING pending`, [session.id, id]);
    if (!claimed.rowCount) throw new ServiceError('turn_busy', 409);
    let released = false;
    async function release() {
      await db().query('UPDATE demo_sessions SET active_turn=NULL,lease_until=NULL WHERE id=$1 AND active_turn=$2', [session.id, id]);
      released = true;
    }
    try {
      await db().query('INSERT INTO support_turns(session_id,id,message,mode,profile) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [session.id, id, message, mode, profile]);
      const existing = (await db().query<Turn>('SELECT message,mode,profile,reply,traces FROM support_turns WHERE session_id=$1 AND id=$2', [session.id, id])).rows[0];
      if (existing.message !== message || existing.mode !== mode || existing.profile !== profile) throw new ServiceError('turn_mismatch', 409);
      const history = (await db().query<Pick<Turn, 'message' | 'reply'>>(`SELECT message,reply FROM support_turns
        WHERE session_id=$1 AND profile=$2 AND id<>$3 AND reply IS NOT NULL ORDER BY created_at DESC LIMIT 4`, [session.id, profile, id])).rows.reverse()
        .flatMap(row => [{ role: 'user', text: row.message }, { role: 'assistant', text: row.reply!.text }]);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const started = performance.now();
      const traces: unknown[] = [];
      const emit = (event: string, data: Record<string, unknown>) => {
        const item = { ...data, elapsedMs: Math.round(performance.now() - started) };
        if (['trace', 'tool', 'usage'].includes(event)) traces.push({ event, ...item });
        if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(item)}\n\n`);
      };
      const keepalive = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 8000);
      let reply: Reply;
      let notification: Promise<string> | undefined;
      try {
        emit('trace', { stage: 'turn', requestId, model: textModel(), profile, mode, messageLength: message.length });
        const threshold = Number(process.env.RAG_THRESHOLD ?? '0.55');
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new ServiceError('invalid_threshold', 503);
        const pending = claimed.rows[0].pending as Pending | undefined;
        const confirm = /^(?:(?:yes)[, ]+)?confirm(?: the)? refund[.!]?$/i.test(message);
        const recovered = confirm && (await db().query('SELECT reference FROM refunds WHERE session_id=$1 AND profile=$2 AND turn_id=$3',
          [session.id, profile, id])).rows[0]?.reference;
        const deadline = () => {
          if (performance.now() - started > 35_000) throw new ServiceError('upstream_timeout', 504);
        };
        const usageTrace = (service: string) => (usage: unknown, model?: string) => emit('usage', { service, model, usage: usage ?? null, estimatedCostUsd: process.env.GEMINI_BILLING === 'paid' ? null : 0 });
        reply = existing.reply?.kind !== 'error' && existing.reply ? existing.reply : recovered
          ? { kind: 'refunded', text: `Your mock refund was issued. Reference ${recovered}.` }
          : confirm && !pending ? { kind: 'clarify', text: 'There is no refund awaiting confirmation. Ask for a refund first.' }
          : await runSupportTurn({ message, profile, pending, confirm, history, threshold }, {
            decide: context => { deadline(); return services.decide(context, usageTrace('planner')); },
            supports: (input, account, selected, matches) => { deadline(); return services.verifyEvidence(input, account, selected, matches, usageTrace('evidence verifier')); },
            search: (query, tier, publicOnly) => {
              if (body.simulate === 'tool') throw new ServiceError('tool_failure', 503);
              if (body.simulate === 'timeout') throw new ServiceError('upstream_timeout', 504);
              if (body.simulate === 'rate') throw new ServiceError('rate_limited', 429);
              deadline();
              return services.searchPolicy(query, tier, publicOnly);
            },
            prepare: async (activeProfile, policy) => {
              await db().query('UPDATE demo_sessions SET pending=$2 WHERE id=$1', [session.id, { id: randomUUID(), profile: activeProfile, policy }]);
            },
            refund: value => issueRefund(session.id, value, id),
            escalate: async reason => {
              const result = await db().query(`WITH ticket AS (
                INSERT INTO tickets(session_id,turn_id,reference,reason,profile,request_text)
                VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,turn_id) DO UPDATE SET reason=tickets.reason RETURNING reference
              ), mail AS (
                INSERT INTO ticket_email(id,reference,recipient,subject,body)
                SELECT 'created-' || reference,reference,$7,'Loopp support ticket ' || reference,'Your support ticket ' || reference || ' was created.'
                FROM ticket WHERE $7::text IS NOT NULL ON CONFLICT DO NOTHING
              ) SELECT reference FROM ticket`, [session.id, id, `HD-${randomUUID().slice(0, 8).toUpperCase()}`, reason, profile, message, session.kind === 'google' ? session.email : null]);
              const reference = result.rows[0].reference;
              if (session.kind === 'google' && session.email && process.env.RESEND_API_KEY && process.env.NOTIFICATION_FROM) {
                notification = deliverEmail(`created-${reference}`);
              }
              return reference;
            },
          }, emit);
        if (existing.reply && existing.reply.kind !== 'error') emit('trace', { stage: 'replay' });
      } catch (error) {
        const failure = classify(error);
        console.warn(JSON.stringify({ requestId, code: failure.code }));
        emit('trace', { stage: 'failure', code: failure.code });
        reply = { kind: 'error', text: errors[failure.code] ?? errors.unavailable };
      } finally {
        clearInterval(keepalive);
      }
      // Only split where sentence punctuation is followed by a space; preserve decimal amounts.
      const sentences = reply.text.split(/(?<=[.!?])\s+/);
      for (const [index, sentence] of sentences.entries()) emit('text', { text: `${index ? ' ' : ''}${sentence}` });
      await db().query('UPDATE support_turns SET reply=$3,traces=$4 WHERE session_id=$1 AND id=$2', [session.id, id, reply, JSON.stringify(traces)]);
      emit('reply', { reply });
      if (mode === 'voice' && !res.destroyed && reply.kind !== 'error') {
        const voiceOutput = process.env.TTS_OUTPUT || 'auto';
        try {
          const gemini = { name: 'gemini', speak: (onAudio: (data: string, mime: string) => boolean) =>
            services.speech(reply.text, onAudio, usage => emit('usage', { service: 'tts', usage: usage ?? null, estimatedCostUsd: 0 })) };
          const groq = { name: 'groq', speak: (onAudio: (data: string, mime: string) => boolean) => orpheusSpeech(reply.text, onAudio) };
          const attempts = voiceOutput === 'browser' ? [] : voiceOutput === 'groq' ? [groq]
            : voiceOutput === 'gemini' ? [gemini] : [gemini, groq];
          await playSpeechWithFallback(attempts, (data, mime) => {
            if (res.destroyed) return false;
            emit('audio', { data, mime });
            return true;
          }, () => {
            emit('trace', { stage: 'voice playback', provider: 'browser' });
            emit('browserAudio', {});
          }, (provider, error) => emit('trace', { stage: 'voice failure', provider, code: classify(error).code }), () => res.destroyed);
        } catch (error) {
          const failure = classify(error);
          emit('trace', { stage: 'voice failure', code: failure.code });
          const message = failure.code === 'groq_not_configured' ? 'Orpheus is waiting for a Groq API key.'
            : failure.code === 'rate_limited'
            ? 'The voice provider is rate limiting audio replies. Text replies are still available.'
            : errors[failure.code] ?? 'Speech synthesis did not complete.';
          emit('voiceError', { code: failure.code, message });
        }
        await db().query('UPDATE support_turns SET traces=$3 WHERE session_id=$1 AND id=$2', [session.id, id, JSON.stringify(traces)]);
      }
      const state = (await db().query('SELECT pending FROM demo_sessions WHERE id=$1', [session.id])).rows[0];
      await release();
      emit('done', { pending: state.pending?.profile });
      await notification;
      res.end();
    } finally {
      if (!released) await release();
    }
  } catch (error) {
    const failure = classify(error);
    console.warn(JSON.stringify({ requestId, code: failure.code }));
    if (res.headersSent) {
      if (!res.destroyed) res.end(`event: failure\ndata: ${JSON.stringify({ message: errors[failure.code] ?? errors.unavailable })}\n\n`);
    } else json(res, failure.status, { code: failure.code, message: errors[failure.code] ?? failure.code.replaceAll('_', ' ') });
  }
}

export function createHandler(services = providers, options: { localOrigin?: string } = {}) {
  return (req: IncomingMessage, res: ServerResponse) => handle(req, res, services, options.localOrigin);
}

export default createHandler();
