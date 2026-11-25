import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { POLICY_VERSION, publicPlanDocuments, type Match } from './policies';
import { embedding, ServiceError } from './provider';
import type { Pending, Profile, Reply } from './agent';

let pool: pg.Pool | undefined;
export function db() {
  if (!process.env.DATABASE_URL) throw new ServiceError('database_not_configured', 503);
  return pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 4500, query_timeout: 6000, statement_timeout: 5000, idleTimeoutMillis: 10000 });
}

export async function searchPolicy(query: string, tier: string, publicOnly = false): Promise<Match[]> {
  return searchByVector(await embedding(query), tier, publicOnly);
}

export async function searchByVector(vector: number[], tier: string, publicOnly = false): Promise<Match[]> {
  const result = await db().query<Match>(
    `SELECT id,title,body AS text,tier,version,1-(embedding <=> $1::vector) AS score
       FROM policy_chunks WHERE version=$2
       AND (($4::boolean AND tier=$3 AND split_part(id,'/',1)=ANY($5::text[]))
        OR (NOT $4::boolean AND tier IN ($3,'All'))) ORDER BY embedding <=> $1::vector,id LIMIT 5`,
    [JSON.stringify(vector), POLICY_VERSION, tier, publicOnly, publicPlanDocuments],
  );
  return result.rows;
}

export async function takeBudget(scope: string, limit: number) {
  const result = await db().query(`INSERT INTO demo_limits(scope,bucket,hits)
    VALUES($1,date_trunc('minute', now()),1)
    ON CONFLICT(scope,bucket) DO UPDATE SET hits=demo_limits.hits+1 WHERE demo_limits.hits<$2 RETURNING hits`, [scope, limit]);
  if (!result.rowCount) throw new ServiceError('rate_limited', 429);
}

export async function issueRefund(session: string, pending: Pending, turn: string) {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const found = (await client.query('SELECT pending FROM demo_sessions WHERE id=$1 FOR UPDATE', [session])).rows[0]?.pending as Pending | undefined;
    const previous = (await client.query('SELECT reference FROM refunds WHERE session_id=$1 AND profile=$2', [session, pending.profile])).rows[0];
    if (previous) {
      await client.query('UPDATE demo_sessions SET pending=NULL WHERE id=$1 AND pending->>\'id\'=$2', [session, pending.id]);
      await client.query('COMMIT');
      return previous.reference as string;
    }
    if (found?.id !== pending.id || found.profile !== pending.profile || found.policy !== pending.policy) {
      throw new ServiceError('confirmation_expired', 409);
    }
    const reference = `RF-${randomUUID().slice(0, 8).toUpperCase()}`;
    await client.query('INSERT INTO refunds(session_id,profile,reference,turn_id,created_at) VALUES($1,$2,$3,$4,now())', [session, pending.profile, reference, turn]);
    await client.query('UPDATE demo_sessions SET pending=NULL WHERE id=$1', [session]);
    await client.query('COMMIT');
    return reference;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export type Turn = { id: string; message: string; mode: 'chat' | 'voice'; profile: Profile; reply: Reply | null; traces: unknown[] };
