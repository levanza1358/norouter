// Per-model pricing for cost estimation, in USD per 1M tokens.
//
// This is a comparison/savings figure only: norouter never bills anyone, and
// the numbers drift as upstreams change. Models without a price estimate to
// null so the dashboard can show "—" instead of inventing a number.

const PRICES = {
  // CodeBuddy CN (Tencent). Rates are the canonical upstream list prices.
  'glm-5.3': { input: 1.0, output: 4.0 },
  'glm-5.3-flash': { input: 1.0, output: 4.0 },
  'glm-5.2': { input: 1.4, output: 4.4 },
  'glm-5.1': { input: 1.05, output: 3.5 },
  'minimax-m3': { input: 0.3, output: 1.2 },
  'hy3': { input: 0.066, output: 0.26 },
  'kimi-k3-1': { input: 3.0, output: 15.0 },
  'kimi-k2.8-preview': { input: 1.2, output: 4.8 },
  'deepseek-v4-pro': { input: 0.435, output: 0.87 },
  'deepseek-v4.1-flash': { input: 0.14, output: 0.28 },
};

export function modelPricing(model) {
  if (typeof model !== 'string') return null;
  const key = model.toLowerCase();
  // Combos and custom models inherit no rate.
  return PRICES[key] ? { ...PRICES[key] } : null;
}

// Cost in USD for a token pair. Returns null when there is no rate to bill.
export function estimateCost(tokensIn, tokensOut, pricing = null) {
  if (!pricing) return null;
  const inUsd = (Number(tokensIn) || 0) * (Number(pricing.input) || 0) / 1_000_000;
  const outUsd = (Number(tokensOut) || 0) * (Number(pricing.output) || 0) / 1_000_000;
  return inUsd + outUsd;
}
