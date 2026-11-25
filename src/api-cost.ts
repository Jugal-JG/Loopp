import type { Usage } from './provider.js';

// Standard USD per million tokens for this branch's text-only requests.
export function estimateApiCost(model?: string, usage?: Usage): number | null {
  const input = usage?.promptTokenCount;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) return null;
  if (model === 'gemini-embedding-2') return input * 0.20 / 1_000_000;
  if (model !== 'voxtral-small-2507') return null;

  const output = usage?.candidatesTokenCount;
  if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) return null;
  return (input * 0.10 + output * 0.40) / 1_000_000;
}
