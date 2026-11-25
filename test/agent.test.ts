import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accounts, eligible, evidence, PRO_REFUND_POLICY, runSupportTurn, type AgentInput, type AgentTools, type Decision } from '../src/agent';
import { chunks, chunkPolicy } from '../src/policies';

const refund = { ...chunks.find(chunk => chunk.id === PRO_REFUND_POLICY)!, score: 0.81 };
const search = { action: 'searchPolicy' };
const prepare = { action: 'prepareRefund', sourceId: refund.id, quote: refund.text };
const defaults: AgentInput = { message: 'Refund my last charge', profile: 'pro', history: [], confirm: false, threshold: 0.55 };

test('tier-only receipt follow-up and Basic refund policy questions explain policy without a ticket', async () => {
  const flow = fixture([]);
  const followUp = await flow.run({ message: 'What about basic users?', history: [{ role: 'user', text: 'How to download my receipt?' }] });
  assert.equal(followUp.kind, 'answer');
  assert.deepEqual(followUp.sources, ['basic-billing/billing-receipts']);
  const refund = await flow.run({ message: 'Can Basic users get a refund?' });
  assert.equal(refund.kind, 'answer');
  assert.match(refund.text, /require human review/);
  assert.deepEqual(flow.calls, []);
});

test('voice playback questions are answered as app help without an escalation', async () => {
  const flow = fixture([]);
  const answer = await flow.run({ message: 'Why are you not speaking out?' });
  assert.equal(answer.kind, 'answer');
  assert.match(answer.text, /Voice turns normally play audio/);
  assert.deepEqual(flow.calls, []);
});

test('Gemini handles greetings and capabilities and declines off-topic requests without escalation', async () => {
  const flow = fixture([
    { action: 'greet', greeting: 'Hello! Good to hear from you.' },
    { action: 'declineOffTopic' },
  ]);
  const greeting = await flow.run({ message: 'Good morning!' });
  assert.deepEqual(greeting, { kind: 'answer', text: 'Hello! Good to hear from you.' });
  const capabilities = await flow.run({ message: 'What can you do?' });
  assert.match(capabilities.text, /billing and receipts/);
  const spokenCapabilities = await flow.run({ message: 'Hi. How can you help me?' });
  assert.deepEqual(spokenCapabilities, capabilities);
  const offTopic = await flow.run({ message: 'Hi! What is 2 + 2?' });
  assert.deepEqual(offTopic, { kind: 'answer', text: 'I can only answer Loopp help desk questions.' });
  assert.equal(flow.contexts.length, 2);
  assert.deepEqual(flow.events.filter(event => !event.startsWith('verifyAccount:')), []);
  assert.deepEqual(flow.calls, []);
});

test('combines independently retrieved passages and verifies them together', async () => {
  const basic = { ...chunks.find(chunk => chunk.id === 'basic-admin/standard-support')!, score: 0.80 };
  const pro = { ...chunks.find(chunk => chunk.id === 'pro-admin/priority-support')!, score: 0.79 };
  const scopes: boolean[] = [];
  const flow = fixture([
    { action: 'searchPolicy', subqueries: [{ query: 'Basic support response time', publicTier: 'Basic' }] },
    { action: 'answer', sourceIds: [basic.id, pro.id] },
  ], {
    search: async (_query, tier, publicOnly = false) => { scopes.push(publicOnly); return tier === 'Basic' ? [basic] : [pro]; },
    supports: async (_input, _account, selected) => {
      assert.deepEqual(selected.map(item => item.id), [basic.id, pro.id]);
      return true;
    },
  });
  const reply = await flow.run({ message: 'How do Basic and Pro support response times differ?' });
  assert.deepEqual(scopes, [false, true]);
  assert.deepEqual(reply.sources, [basic.id, pro.id]);
  assert.match(reply.text, /two-business-day[\s\S]*four-business-hour/);
});

function fixture(decisions: Decision[], overrides: Partial<AgentTools> = {}) {
  const calls: string[] = [];
  const contexts: any[] = [];
  const tools: AgentTools = {
    decide: async context => { contexts.push(context); return decisions.shift()!; },
    search: async () => [refund],
    supports: async () => true,
    prepare: async () => { calls.push('prepared'); },
    refund: async () => { calls.push('refunded'); return 'RF-0001'; },
    escalate: async reason => { calls.push(reason); return 'HD-0001'; },
    ...overrides,
  };
  const events: string[] = [];
  return { calls, contexts, events,
    run: (input?: Partial<AgentInput>) => runSupportTurn({ ...defaults, ...input }, tools, (name, data) => {
      if (name === 'tool') events.push(`${data.name}:${data.status}`);
    }),
  };
}

test('orchestrates verified account → retrieval → evidence → pending refund and feeds back tool results', async () => {
  const flow = fixture([search, prepare]);
  assert.equal((await flow.run()).kind, 'confirmation');
  assert.deepEqual(flow.calls, ['prepared']);
  assert.equal(flow.contexts[0].account.contract, 'active');
  assert.equal(flow.contexts[1].matches[0].id, refund.id);
  assert.deepEqual(flow.events, ['verifyAccount:started', 'verifyAccount:completed', 'searchPolicy:started', 'searchPolicy:completed', 'verifyEvidence:started', 'verifyEvidence:completed', 'prepareRefund:started', 'prepareRefund:completed']);
});

test('cross-mode confirmation uses the pending account and policy; reports only a committed result', async () => {
  const flow = fixture([]);
  const reply = await flow.run({ confirm: true, pending: { id: 'p1', policy: refund.id, profile: 'pro' } });
  assert.equal(reply.kind, 'refunded');
  assert.match(reply.text, /RF-0001/);
  assert.deepEqual(flow.calls, ['refunded']);
});

test('refuses an unsolicited mutation or confirmation for a different account', async () => {
  const unsolicited = fixture([{ action: 'issueRefund' }]);
  assert.equal((await unsolicited.run()).kind, 'escalated');
  assert.deepEqual(unsolicited.calls, ['invalid_transition']);
  const wrongAccount = fixture([]);
  assert.equal((await wrongAccount.run({ confirm: true, pending: { id: 'p1', policy: refund.id, profile: 'basic' } })).kind, 'escalated');
  assert.deepEqual(wrongAccount.calls, ['refund_confirmation_invalid']);
});

test('rejects Basic, expired, annual, over-limit and late refunds', () => {
  assert.equal(eligible(accounts.pro), true);
  for (const account of [accounts.basic, accounts.annual, { ...accounts.pro, contract: 'expired' as const }, { ...accounts.pro, cents: 5001 }, { ...accounts.pro, days: 15 }]) assert.equal(eligible(account), false);
  assert.equal(eligible({ ...accounts.pro, cents: 5000, days: 14 }), true);
});

test('escalates low similarity even when the model rewrites the query toward a matching policy', async () => {
  const flow = fixture([{ action: 'searchPolicy', query: 'refund policy' }], {
    search: async query => [{ ...refund, score: query === 'refund policy' ? 0.88 : 0.24 }],
  });
  assert.equal((await flow.run({ message: 'Where can I see my workspace billing status?' })).kind, 'escalated');
  assert.deepEqual(flow.calls, ['low_retrieval_similarity']);
});

test('blocks fabricated citations and unsupported quotes, including high similarity hits', async () => {
  assert.equal(evidence([refund], 0.55, 'made-up', refund.text), undefined);
  assert.equal(evidence([refund], 0.55, refund.id, 'The policy allows unlimited refunds.'), undefined);
  const flow = fixture([search, { ...prepare, action: 'answer' }], { supports: async () => false });
  assert.equal((await flow.run()).kind, 'escalated');
  assert.deepEqual(flow.calls, ['evidence_not_applicable']);
});

test('supported answer is extractive and cites the exact passage', async () => {
  const flow = fixture([search, { ...prepare, action: 'answer' }]);
  assert.deepEqual(await flow.run(), { kind: 'answer', text: refund.text, sources: [refund.id] });
});

test('search failure emits failed status and never reaches refund execution', async () => {
  const flow = fixture([search], { search: async () => { throw new Error('timeout'); } });
  await assert.rejects(flow.run(), /timeout/);
  assert.deepEqual(flow.events.slice(-2), ['searchPolicy:started', 'searchPolicy:failed']);
  assert.deepEqual(flow.calls, []);
});

test('chunking keeps short conditions and exclusions together and overlaps a long section', () => {
  assert.match(refund.text, /14 days.*Annual contracts/);
  assert.equal(new Set(chunks.map(chunk => chunk.id)).size, chunks.length);
  const words = Array.from({ length: 300 }, (_, index) => `w${index}`).join(' ');
  const chunksFromLong = chunkPolicy({ id: 'long', tier: 'All', markdown: `# Title\n## Concept\n${words}` });
  assert.equal(chunksFromLong.length, 2);
  assert.ok(chunksFromLong[0].text.endsWith('w259'));
  assert.ok(chunksFromLong[1].text.startsWith('w235'));
});
