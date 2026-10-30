// CodeBuddy CN (Tencent) — https://copilot.tencent.com
//
// The upstream is a unified [OI]-compatible gateway, so request and response
// bodies pass through untouched. Only the endpoint, the CLI-ish headers and
// the credential need to be supplied by us.
//
// Two credential shapes are accepted, matching the official CLI:
//   - access token  -> Authorization: Bearer <token>
//   - refresh token -> X-Refresh-Token, exchanged for an access token
// OAuth login itself is never automated: the accounts page only stores tokens
// the operator pasted in.

export default {
  id: 'codebuddy-cn',
  prefix: 'cbcn',
  display: {
    name: 'CodeBuddy CN',
    website: 'https://copilot.tencent.com',
  },

  baseUrl: 'https://copilot.tencent.com/v2',
  chatPath: '/chat/completions',
  format: 'openai',
  modelDiscovery: false,
  reasoning: {
    enabled: true,
    levels: ['low', 'medium', 'high', 'xhigh'],
    mapping: { reasoning_effort: '$level' },
    summary: { key: 'reasoning_summary', value: 'auto' },
  },

  // The gateway only answers on a stream; non-streaming clients are served by
  // buffering the SSE upstream and collapsing it into one completion.
  forceStream: true,

  headers: {
    'User-Agent': 'CLI/2.108.1 CodeBuddy/2.108.1',
    'X-Product': 'SaaS',
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'x-requested-with': 'XMLHttpRequest',
    'x-codebuddy-request': '1',
  },

  // Upstream credentials are stored only in the SQLite account pool.
  tokenEnv: [],
  requiresAccount: true,

  // Test-only override. When this is set the dashboard flags the provider as
  // pointing at a non-production gateway (see providerSnapshot).
  baseUrlEnv: 'CODEBUDDY_CN_BASE_URL',

  // The refresh endpoint is separate from the chat gateway and expects the
  // refresh token in a header, not a form body.
  refresh: {
    url: 'https://copilot.tencent.com/v2/plugin/auth/token/refresh',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Domain': 'copilot.tencent.com',
      'X-Auth-Refresh-Source': 'plugin',
      'X-Product': 'SaaS',
    },
  },

  // Tencent billing endpoint behind the real quota. It answers with a nested
  // payload: data.Response.Data.Accounts[].
  quota: {
    url: 'https://copilot.tencent.com/v2/billing/meter/get-user-resource',
    parse: 'codebuddy',
  },

  // Reverse-engineered web flow; separate host from chat and quota.
  checkin: {
    url: 'https://www.codebuddy.cn/v2/billing/meter/daily-checkin',
  },

  // Mirrors the catalog the server publishes. Drop ids the server stops
  // serving rather than keeping historical ones around.
  models: [
    'glm-5.3',
    'glm-5.3-flash',
    'glm-5.2',
    'glm-5.1',
    'minimax-m3',
    'hy3',
    'hy4-preview',
    'kimi-k3-1',
    'kimi-k2.8-preview',
    'deepseek-v4-pro',
    'deepseek-v4.1-flash',
  ],};
