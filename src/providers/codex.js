// OpenAI Codex provider definition. OAuth/refresh integration is added in later
// phases; this file only declares the provider contract and observed catalog.
const CODEX_CLI_VERSION = '0.159.0';

export default {
  id: 'codex',
  prefix: 'cx',
  display: {
    name: 'OpenAI Codex',
    website: 'https://chatgpt.com/codex',
  },
  baseUrl: 'https://chatgpt.com/backend-api',
  chatPath: '/codex/responses',
  format: 'responses',
  forceStream: true,
  requiresAccount: true,
  modelDiscovery: true,
  modelsPath: '/codex/models',
  clientVersion: CODEX_CLI_VERSION,
  baseUrlEnv: 'CODEX_BASE_URL',
  headers: {
    originator: 'codex_cli_rs',
    'User-Agent': `codex_cli_rs/${CODEX_CLI_VERSION}`,
    version: CODEX_CLI_VERSION,
  },
  quota: {
    parser: 'codex',
    url: 'https://chatgpt.com/backend-api/wham/usage',
    urlEnv: 'CODEX_QUOTA_URL',
    resetCreditsUrl: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
  },
  tokenEnv: [],
  oauth: {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    scope: 'openid profile email offline_access',
    codeChallengeMethod: 'S256',
    fixedPort: 1455,
    callbackPath: '/auth/callback',
    extraParams: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    },
    refreshLeadMs: 600000,
    trackRefreshAt: true,
    maxRefreshAgeMs: 691200000,
  },
  // Catalog is account-derived after the first Codex account is added.
  models: [],
};
