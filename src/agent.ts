import { chunks, type Match } from './policies.js';

export const PROMPT_VERSION = 'support-v4';
export const MAX_STEPS = 6;
export const PRO_REFUND_POLICY = 'pro-billing/refund-eligibility';
const capabilities: Reply = {
  kind: 'answer',
  text: 'I can help with Loopp billing and receipts, subscriptions, sign-in and workspace access, and data exports or recovery. I can also check a mock refund request or open a support ticket. What would you like help with?',
};
export type Profile = 'pro' | 'basic' | 'annual';
export type Account = { profile: Profile; tier: 'Pro' | 'Basic'; contract: 'active' | 'expired'; billing: 'monthly' | 'annual'; cents: number; days: number };
export const accounts: Record<Profile, Account> = {
  pro: { profile: 'pro', tier: 'Pro', contract: 'active', billing: 'monthly', cents: 2900, days: 3 },
  basic: { profile: 'basic', tier: 'Basic', contract: 'active', billing: 'monthly', cents: 900, days: 3 },
  annual: { profile: 'annual', tier: 'Pro', contract: 'expired', billing: 'annual', cents: 4900, days: 3 },
};

export type Reply = { text: string; kind: 'answer' | 'clarify' | 'confirmation' | 'refunded' | 'escalated' | 'error'; sources?: string[] };
export type Decision = {
  action: string; greeting?: string; query?: string; sourceId?: string; quote?: string; sourceIds?: string[];
  subqueries?: { query: string; publicTier?: Account['tier'] }[];
};
export type PlannerContext = { message: string; history: AgentInput['history']; account: Account; matches?: Match[]; allowed: string[] };
export type Trace = (event: string, data: Record<string, unknown>) => void;
export type Pending = { id: string; profile: Profile; policy: string };
export type AgentInput = { message: string; profile: Profile; history: Array<{ role: string; text: string }>; pending?: Pending; confirm: boolean; threshold: number };
export type AgentTools = {
  decide: (context: PlannerContext) => Promise<Decision>;
  search: (query: string, tier: Account['tier'], publicOnly?: boolean) => Promise<Match[]>;
  supports: (input: AgentInput, account: Account, selected: Match[], matches: Match[]) => Promise<boolean>;
  prepare: (profile: Profile, policy: string) => Promise<void>;
  refund: (pending: Pending) => Promise<string>;
  escalate: (reason: string) => Promise<string>;
};

export const eligible = (account: Account) =>
  account.tier === 'Pro' && account.contract === 'active' && account.billing === 'monthly'
  && account.days >= 0 && account.days <= 14 && account.cents > 0 && account.cents <= 5000;

export function evidence(matches: Match[], threshold: number, sourceId?: string, quote?: string) {
  const match = matches.find(item => item.id === sourceId);
  return match && match.score >= threshold && typeof quote === 'string' && quote.trim().length >= 20
    && match.text.includes(quote.trim()) ? match : undefined;
}

const offTopicReply = 'I can only answer Loopp help desk questions.';

export async function runSupportTurn(input: AgentInput, tools: AgentTools, emit: Trace): Promise<Reply> {
  const question = input.message.trim();
  if (/^(?:(?:hi|hello|hey)[,!?. ]+)?(?:how can you help(?: me)?|what can you (?:do|help(?: me)? with)|what do you do)[?.! ]*$/i.test(question)) {
    emit('trace', { stage: 'app help', topic: 'capabilities' });
    return capabilities;
  }
  if (/^(?:why (?:are you (?:not|aren.t you)|aren.t you|didn.t you|did you not) (?:speak|speaking|read|say)|(?:why (?:is there|was there) )?no (?:voice|audio|sound)|(?:i )?can.t hear you|why (?:isn.t|is not) (?:the |your )?(?:voice|audio|sound) working)/i.test(question)) {
    emit('trace', { stage: 'app help', topic: 'voice playback' });
    return { kind: 'answer', text: 'Typed messages get a text reply. Voice turns normally play audio. If a voice reply is silent, check your browser volume and output device. An audio error will appear above the composer if synthesis fails.' };
  }
  const priorReply = input.history.findLast(item => item.role === 'assistant')?.text;
  if (/^why(?: is that)?[?.! ]*$/i.test(question) && priorReply === offTopicReply) {
    emit('trace', { stage: 'app help', topic: 'support scope' });
    return { kind: 'answer', text: 'This assistant is set up for Loopp support, so it can help with things like billing, signing in, and managing your workspace.' };
  }
  const mentionedTier = question.match(/\b(basic|pro)\s+(?:users?|customers?|plan|members?|accounts?)\b/i)?.[1]
    ?? question.match(/^(?:what|how) about (basic|pro)[?.!]*$/i)?.[1];
  const informational = /^(?:what|how|can|do|does|is|are|where|which)\b/i.test(question);
  const comparesPlans = /\bbasic\b/i.test(question) && /\bpro\b/i.test(question);
  const priorQuestion = input.history.findLast(item => item.role === 'user')?.text ?? '';
  const topic = /\breceipts?\b/i.test(question) ? 'billing-receipts' : /\brefunds?\b/i.test(question) ? 'refund-eligibility'
    : /^(?:what|how) about\b/i.test(question) ? (/\breceipts?\b/i.test(priorQuestion) ? 'billing-receipts' : /\brefunds?\b/i.test(priorQuestion) ? 'refund-eligibility' : undefined) : undefined;
  if (informational && mentionedTier && topic && !comparesPlans && !/\b(?:refund|reimburse) (?:me|my)\b/i.test(question)) {
    const policy = chunks.find(chunk => chunk.id === `${mentionedTier.toLowerCase()}-billing/${topic}`)!;
    emit('trace', { stage: 'published policy', source: policy.id });
    return { kind: 'answer', text: policy.text, sources: [policy.id] };
  }
  let account: Account | undefined;
  let matches: Match[] | undefined;
  async function tool<T>(name: string, work: () => Promise<T> | T): Promise<T> {
    const start = performance.now();
    emit('tool', { name, status: 'started' });
    try {
      const result = await work();
      emit('tool', { name, status: 'completed', ms: Math.round(performance.now() - start) });
      return result;
    } catch (error) {
      emit('tool', { name, status: 'failed', ms: Math.round(performance.now() - start) });
      throw error;
    }
  }
  async function handoff(reason: string): Promise<Reply> {
    emit('trace', { stage: 'escalation', reason });
    const id = await tool('createEscalation', () => tools.escalate(reason));
    return { kind: 'escalated', text: `I’ve sent this to human support for review. Your ticket is ${id}.` };
  }
  for (let step = 0; step < MAX_STEPS; step++) {
    const allowed = !account ? ['verifyAccount'] : [
      'clarify', 'createEscalation', ...(!matches ? ['searchPolicy', 'greet', 'explainCapabilities', 'declineOffTopic'] : ['answer', 'prepareRefund']),
      ...(input.confirm && input.pending ? ['issueRefund'] : []),
    ];
    emit('trace', { stage: 'decision', promptVersion: PROMPT_VERSION, step: step + 1, allowed });
    const result = !account
      ? { action: 'verifyAccount' }
      : input.confirm && input.pending
        ? { action: 'issueRefund' }
        : await tools.decide({ message: input.message, history: input.history, account, matches, allowed });
    emit('trace', { stage: 'selected', step: step + 1, action: result.action });
    if (!allowed.includes(result.action)) return handoff('invalid_transition');
    switch (result.action) {
      case 'verifyAccount':
        account = await tool('verifyAccount', () => accounts[input.profile]);
        break;
      case 'searchPolicy': {
        const tier = account!.tier;
        const followUp = !!priorQuestion && /^(?:why[?.! ]*$|how[?.! ]*$|and\b|what about\b|how about\b|does (?:that|it)\b|is (?:that|it)\b)/i.test(input.message);
        const original = followUp ? `${priorQuestion} ${input.message}`.trim() : input.message;
        // Rewriting a standalone question can accidentally drop identifying details.
        const query = (followUp && result.query?.trim().slice(0, 300)) || original;
        const subqueries = (result.subqueries ?? []).slice(0, 2).filter(item => typeof item.query === 'string' && item.query.trim() &&
          (!item.publicTier || ['Basic','Pro'].includes(item.publicTier)));
        matches = await tool('searchPolicy', async () => {
          const direct = await tools.search(original, tier);
          const rewritten = query.toLowerCase() === original.toLowerCase() ? [] : await tools.search(query, tier);
          const supplemental = await Promise.all(subqueries.map(item =>
            tools.search(item.query.trim().slice(0, 300), item.publicTier ?? tier, !!item.publicTier)));
          if (!comparesPlans && !direct.some(match => match.score >= input.threshold)) return direct;
          if (comparesPlans) {
            const available = [...direct, ...supplemental.flat()];
            const missingTiers = (['Basic', 'Pro'] as const).filter(plan =>
              !available.some(match => match.tier === plan && match.score >= input.threshold));
            supplemental.push(...await Promise.all(missingTiers.map(plan => tools.search(original, plan, true))));
          }
          const merged = new Map<string, Match>();
          for (const match of [...direct, ...rewritten.filter(match => direct.some(item => item.id === match.id)), ...supplemental.flat()]) {
            if ((merged.get(match.id)?.score ?? -Infinity) < match.score) merged.set(match.id, match);
          }
          return [...merged.values()].sort((a,b) => b.score - a.score);
        });
        emit('trace', { stage: 'retrieval', threshold: input.threshold, matches: matches.map(({ id, score }) => ({ id, score })) });
        matches = matches.filter(match => match.score >= input.threshold);
        if (!matches.length) return handoff('low_retrieval_similarity');
        break;
      }
      case 'answer':
      case 'prepareRefund': {
        const selected = result.action === 'answer' && result.sourceIds?.length
          ? result.sourceIds.slice(0, 5).map(id => matches?.find(match => match.id === id && match.score >= input.threshold))
          : [evidence(matches ?? [], input.threshold, result.sourceId, result.quote)];
        if (selected.some(match => !match)) {
          return handoff(result.action === 'answer' ? 'invalid_answer_citation' : 'missing_verbatim_evidence');
        }
        const passages = [...new Map((selected as Match[]).map(match => [match.id, match])).values()];
        const supported = await tool('verifyEvidence', () => tools.supports(input, account!, passages, matches!));
        emit('trace', { stage: 'evidence', sources: passages.map(({ id, score }) => ({ id, score })), passed: supported });
        if (!supported) return handoff('evidence_not_applicable');
        if (result.action === 'answer') {
          return { kind: 'answer', text: passages.map(passage => passage.text).join('\n\n'), sources: passages.map(passage => passage.id) };
        }
        const [match] = passages;
        if (match.id !== PRO_REFUND_POLICY || !eligible(account!)) return handoff('refund_ineligible');
        await tool('prepareRefund', () => tools.prepare(input.profile, match.id));
        return { kind: 'confirmation', text: `Your most recent charge of $${(account!.cents / 100).toFixed(2)} qualifies for a mock refund. Say “confirm refund” or use the confirmation button.`, sources: [match.id] };
      }
      case 'issueRefund': {
        if (!input.pending || input.pending.profile !== input.profile || input.pending.policy !== PRO_REFUND_POLICY || !eligible(account!)) return handoff('refund_confirmation_invalid');
        const id = await tool('issueRefund', () => tools.refund(input.pending!));
        return { kind: 'refunded', text: `Your mock refund was issued. Reference ${id}.`, sources: [PRO_REFUND_POLICY] };
      }
      case 'clarify':
        return { kind: 'clarify', text: 'Could you tell me a little more about what you need? For example, are you asking about billing, signing in, or managing your workspace?' };
      case 'explainCapabilities':
        return capabilities;
      case 'greet':
        return { kind: 'answer', text: result.greeting?.trim().slice(0, 200) || 'Hello!' };
      case 'declineOffTopic':
        return { kind: 'answer', text: offTopicReply };
      default:
        return handoff('unsupported_or_requested');
    }
  }
  return handoff('step_limit');
}
