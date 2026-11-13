// One vocabulary for the subscription tier of a pooled account. Providers name
// their plans differently (ChatGPT says `pro`, Cloud Code says `standard-tier`,
// Google One says `g1-plus-tier`), and the dashboard shows a single badge per
// account, so every caller normalizes onto this list before storing.
export const ACCOUNT_PLANS = [
  'free',
  'plus',
  'pro',
  'ultra',
  'team',
  'business',
  'enterprise',
  'unknown',
];

const PLAN_LABELS = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  ultra: 'Ultra',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  unknown: 'Unknown',
};

// An unrecognized value becomes `unknown` instead of leaking a provider's
// internal tier name into the pool. Callers skip `unknown` on update, so a
// quota read that cannot see the plan never erases the last known one.
export function normalizePlan(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (ACCOUNT_PLANS.includes(raw)) return raw;
  if (raw.includes('ultra')) return 'ultra';
  if (raw.includes('enterprise')) return 'enterprise';
  if (raw.includes('business')) return 'business';
  if (raw.includes('team')) return 'team';
  if (raw.includes('plus')) return 'plus';
  // ChatGPT's paid plan is `pro`; Google's paid Code Assist tier is
  // `standard-tier`. Both are the provider's top individual plan.
  if (raw.includes('pro') || raw.includes('standard')) return 'pro';
  // `free-tier` and the older `legacy-tier` both mean no paid subscription.
  if (raw.includes('free') || raw.includes('legacy')) return 'free';
  return 'unknown';
}

export function isKnownPlan(value) {
  return normalizePlan(value) !== 'unknown';
}

export function planLabel(value) {
  return PLAN_LABELS[normalizePlan(value)];
}
