// Antigravity (Google) — https://antigravity.google
//
// Antigravity is Google's IDE agent; its model gateway is the Cloud Code
// `v1internal` API, which is *not* the public Gemini API: requests are wrapped
// in { project, model, userAgent, requestId, request }, the model id is the
// gateway's own id (for example `gemini-3.8-flash-high`), and the agent path
// must not carry a `requestType`. lib/antigravity-format.js owns all of that;
// this file only declares the contract.
//
// Accounts are Google OAuth (authorization code + PKCE-less offline refresh).
// The OAuth client belongs to the Antigravity IDE, not to us, so it is read
// from ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET at runtime and never
// embedded here.
//
// Upstream marks this integration deprecated with a RISK_NOTICE: the endpoint
// is undocumented and Google can change or block it without warning.
const USER_AGENT = 'antigravity/hub/2.24.0 darwin/arm64';

export default {
  id: 'antigravity',
  prefix: 'ag',
  display: {
    name: 'Antigravity',
    website: 'https://antigravity.google',
  },

  baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
  chatPath: '/v1internal:generateContent',
  streamPath: '/v1internal:streamGenerateContent?alt=sse',
  format: 'antigravity',
  requiresAccount: true,
  modelDiscovery: false,
  baseUrlEnv: 'ANTIGRAVITY_BASE_URL',
  headers: {
    'User-Agent': USER_AGENT,
  },

  tokenEnv: [],

  // Catalog ids are the public names NoRouter routes on; upstreamModels maps
  // the bare aliases to the gateway ids. The list mirrors what
  // v1internal:fetchAvailableModels reports; a plan that lacks one of these
  // models answers 404 instead of running it.
  models: [
    'gemini-3.8-flash',
    'gemini-3.8-flash-low',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-high',
    'gemini-3.8-flash-tiered',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3-flash',
    'gemini-2.5-pro',
    'gemini-3.1-flash-image',
    'claude-sonnet-4-6',
    'claude-opus-4-6-thinking',
    'gpt-oss-120b-medium',
  ],
  upstreamModels: {
    'gemini-3.8-flash': 'gemini-3.8-flash-medium',
  },

  // Quota lives on the Cloud Code API, not a billing host. The summary is the
  // only source that reports the shared weekly/5h pools; free-tier per-model
  // quotaInfo carries a reset time but no remaining fraction, so the model
  // endpoint is only a paid-tier fallback. Paths are appended to
  // ANTIGRAVITY_BASE_URL when that override is set (tests, local gateways).
  quota: {
    parser: 'antigravity',
    url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    modelsUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    projectUrl: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    clientVersion: '2.24.0',
  },

  // The Antigravity IDE's Google OAuth client. Read from the environment so no
  // third-party client secret ships in this repository.
  oauth: {
    clientIdEnv: 'ANTIGRAVITY_CLIENT_ID',
    clientSecretEnv: 'ANTIGRAVITY_CLIENT_SECRET',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v1/userinfo',
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ],
    loadCodeAssistUrl: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    onboardUserUrl: 'https://cloudcode-pa.googleapis.com/v1internal:onboardUser',
    loadCodeAssistUserAgent: USER_AGENT,
    fixedPort: 1456,
    // The loopback path the Antigravity client is known to accept.
    callbackPath: '/callback',
    refreshLeadMs: 300000,
  },
};
