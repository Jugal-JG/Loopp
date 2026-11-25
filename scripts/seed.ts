import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { chunks, POLICY_VERSION } from '../src/policies';
import { embedding } from '../src/provider';
import { db } from '../src/store';

try {
  await db().query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  if (process.argv.includes('--schema-only')) {
    console.log('Database schema updated.');
  } else {
    const existing = await db().query<{ id: string; title: string; body: string; embedding: string }>(
      'SELECT DISTINCT ON (id) id,title,body,embedding::text FROM policy_chunks ORDER BY id,version DESC');
    const byId = new Map(existing.rows.map(row => [row.id, row]));
    const vectors = [];
    for (const chunk of chunks) {
      const prior = byId.get(chunk.id);
      const vector = prior && prior.title === chunk.title && prior.body === chunk.text
        ? prior.embedding : JSON.stringify(await embedding(chunk.text, chunk.title));
      vectors.push({ ...chunk, vector });
    }
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM policy_chunks WHERE version=$1', [POLICY_VERSION]);
      for (const chunk of vectors) {
        await client.query('INSERT INTO policy_chunks VALUES($1,$2,$3,$4,$5,$6::vector)',
          [chunk.id, chunk.version, chunk.tier, chunk.title, chunk.text, chunk.vector]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    console.log(`Seeded ${vectors.length} policy chunks.`);
  }
} finally { await db().end(); }
