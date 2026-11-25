import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { accounts, runSupportTurn } from '../src/agent';
import { POLICY_VERSION } from '../src/policies';
import { decide, embedding, verifyEvidence } from '../src/provider';
import { db, searchByVector, searchPolicy } from '../src/store';
import { cases } from './eval-cases';

const threshold = Number(process.env.RAG_THRESHOLD ?? '0.55');
const only = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
const calibrateOnly = process.argv.includes('--calibrate');
const stage = process.argv.find(arg => arg.startsWith('--stage='))?.slice(8) ?? 'all';
if (!['all', 'embedding', 'retrieval', 'output'].includes(stage)) throw new Error('Choose --stage=embedding, retrieval, output, or all.');
const checkEmbedding = stage === 'all' || stage === 'embedding';
const checkRetrieval = stage === 'all' || stage === 'retrieval';
const checkOutput = stage === 'all' || stage === 'output';
const selected = cases.filter(item => (!only || item.id === only) && (!calibrateOnly || item.split === 'calibration'));
if (!selected.length) throw new Error('Unknown case ID');
if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY) throw new Error('Set DATABASE_URL and GEMINI_API_KEY, then run npm run seed.');
const cosine = (a: number[], b: number[]) =>
  a.reduce((dot, value, index) => dot + value * b[index], 0) / (Math.hypot(...a) * Math.hypot(...b));
const round = (value: number) => Number(value.toFixed(3));
const average = (values: number[]) => values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;

async function withQuotaRetry<T>(work: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); }
    catch (error) {
      const failure = error as { status?: number; message?: string };
      if (![429, 503].includes(failure.status ?? 0) || attempt >= 2) throw error;
      const seconds = Number(failure.message?.match(/retry in ([\d.]+)s/i)?.[1] ?? (failure.status === 503 ? 3 * (attempt + 1) : 15));
      console.warn(`Retrying after Gemini returned ${failure.status}.`);
      await delay((Math.min(seconds, 60) + 1) * 1000);
    }
  }
}

try {
  const stored = await db().query<{ id: string; vector: number[] }>(
    'SELECT id, embedding::text::json AS vector FROM policy_chunks WHERE version=$1', [POLICY_VERSION]);
  const vectors = new Map(stored.rows.map(row => [row.id, row.vector]));
  if (!vectors.size) throw new Error('The current policy version is missing. Run npm run seed.');
  const heldOut: Array<{ id: string; embedding: boolean | null; rank: number; precision: number | null; answer: boolean | null }> = [];
  const calibration: Array<{ id: string; relevant: boolean; score: number }> = [];
  for (const item of selected) {
    if (!calibrateOnly && !checkRetrieval && item.split === 'calibration') continue;
    if (!checkOutput && item.split === 'evaluation' && !item.source) continue;
    const query = (checkEmbedding && item.source && item.hardNegative) || checkRetrieval || calibrateOnly
      ? await withQuotaRetry(() => embedding(item.question)) : undefined;
    const matches = query && (checkRetrieval || calibrateOnly) ? await searchByVector(query, accounts[item.profile].tier) : [];
    const rank = item.source ? matches.findIndex(match => match.id === item.source) + 1 : 0;
    const topScore = matches[0]?.score ?? -1;
    if (item.split === 'calibration') {
      calibration.push({ id: item.id, relevant: Boolean(item.source), score: item.source ? (matches[rank - 1]?.score ?? -1) : topScore });
      continue;
    }
    let embeddingPass = null;
    let margin = null;
    if (checkEmbedding && query && item.source && item.hardNegative) {
      const positive = vectors.get(item.source);
      const negative = vectors.get(item.hardNegative);
      if (!positive || !negative) throw new Error(`Missing seeded policy for ${item.id}`);
      margin = cosine(query, positive) - cosine(query, negative);
      embeddingPass = margin > 0;
    }
    let prepared = false;
    let escalationReason: string | undefined;
    const reply = checkOutput ? await runSupportTurn({ message: item.question, profile: item.profile, history: [], confirm: false, threshold }, {
      search: (question, tier, publicOnly) => !publicOnly && question === item.question && matches.length ? Promise.resolve(matches) : withQuotaRetry(() => searchPolicy(question, tier, publicOnly)),
      decide: context => withQuotaRetry(() => decide(context, () => {})),
      supports: (input, account, match, alternatives) => withQuotaRetry(() => verifyEvidence(input, account, match, alternatives, () => {})),
      prepare: async () => { prepared = true; },
      refund: async () => { throw new Error('Unexpected refund during evaluation'); },
      escalate: async reason => { escalationReason = reason; return 'HD-EVAL'; },
    }, () => {}) : undefined;
    const needsCitation = item.outcome === 'answer' || item.outcome === 'confirmation';
    const answer = reply ? reply.kind === item.outcome && (item.facts ?? []).every(fact => reply.text.toLowerCase().includes(fact.toLowerCase()))
      && (!needsCitation || (item.requiredSources ?? (item.source ? [item.source] : [])).every(source => reply.sources?.includes(source)))
      && prepared === (item.outcome === 'confirmation') : null;
    heldOut.push({ id: item.id, embedding: embeddingPass, rank, precision: checkRetrieval && item.source ? (rank ? 1 / matches.length : 0) : null, answer });
    console.log(JSON.stringify({ id: item.id, cosineMargin: margin === null ? null : round(margin), expectedRank: rank || null,
      topCosine: matches.length ? round(topScore) : null, expectedOutcome: item.outcome, actualOutcome: reply?.kind,
      actualSources: reply?.sources, answerPass: answer, escalationReason }));
  }
  if (calibration.length) {
    const candidates = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75];
    const sweep = candidates.map(cutoff => ({
      cutoff, falseAccepts: calibration.filter(item => !item.relevant && item.score >= cutoff).length,
      falseRejects: calibration.filter(item => item.relevant && item.score < cutoff).length,
    })).sort((a, b) => a.falseAccepts - b.falseAccepts || a.falseRejects - b.falseRejects || a.cutoff - b.cutoff);
    console.log(JSON.stringify({ configuredThreshold: threshold, calibration, suggestedThreshold: sweep[0], sweep }));
  }
  if (heldOut.length) {
    const retrieval = heldOut.filter(item => item.precision !== null);
    console.log(JSON.stringify({
      embeddingPairwiseAccuracy: average(heldOut.flatMap(item => item.embedding === null ? [] : [Number(item.embedding)])),
      retrievalHitsAt1: average(retrieval.map(item => Number(item.rank === 1))),
      retrievalRecallAt5: average(retrieval.map(item => Number(item.rank > 0))),
      retrievalPrecisionAt5: average(retrieval.map(item => item.precision!)),
      retrievalMRRAt5: average(retrieval.map(item => item.rank ? 1 / item.rank : 0)),
      answerAccuracy: average(heldOut.flatMap(item => item.answer === null ? [] : [Number(item.answer)])),
      answerCases: heldOut.filter(item => item.answer !== null).length,
    }));
    if (heldOut.some(item => item.answer === false || item.embedding === false || (item.precision !== null && item.rank === 0))) process.exitCode = 1;
  }
} finally { await db().end(); }
