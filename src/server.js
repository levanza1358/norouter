import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { config } from './config.js';
import { authorizeManagedKey, getRequireApiKey } from './lib/api-keys.js';
import { CORS_HEADERS, readJson, sendError, sendJson } from './lib/http.js';
import { providers } from './providers/index.js';
import {
  handleAccountCheckin,
  handleAccountQuota,
  handleCreateAccounts,
  handleQuotaAccountList,
  handleRefreshQuotaOrder,
  handleDeleteAccount,
  handleListAccounts,
  handlePreviewAccounts,
  handleTestAccount,
  handleUpdateAccount,
} from './routes/accounts.js';
import { handleChat } from './routes/chat.js';
import { handleCodexOAuthCancel, handleCodexOAuthStart, handleCodexOAuthStatus } from './routes/codex-oauth.js';
import {
  handleAppendChatMessage,
  handleCreateChatSession,
  handleDeleteChatSession,
  handleGetChatSession,
  handleListChatSessions,
  handleUpdateChatSession,
} from './routes/chat-history.js';
import {
  handleCreateCombo,
  handleDeleteCombo,
  handleGetCombo,
  handleListCombos,
  handleUpdateCombo,
} from './routes/combos.js';
import { handleAsset, handleDashboard } from './routes/dashboard.js';
import { handleModels } from './routes/models.js';
import { handleAddModel, handleCreateProvider, handleDeleteProvider, handleFetchModels, handleProviderDetail, handleRemoveModel, handleSetModelEnabled, handleTestModels, handleUpdateProvider } from './routes/provider.js';
import { handleStatus } from './routes/status.js';
import { handleAutostartGet, handleAutostartUpdate, handlePortGet, handlePortUpdate } from './routes/settings.js';
import { writeLocalConfig } from './lib/local-config.js';
import { handleUsage } from './routes/usage.js';
import { handleGetTokenSaver, handleUpdateTokenSaver } from './routes/token-saver.js';
import { handleGetReplyFilters, handleUpdateReplyFilters } from './routes/reply-filters.js';
import {
  handleDashboardAuthGetSettings,
  handleDashboardAuthLogin,
  handleDashboardAuthLogout,
  handleDashboardAuthStatus,
  handleDashboardAuthUpdatePassword,
  handleDashboardAuthUpdateSettings,
  hasDashboardSession,
} from './routes/dashboard-auth.js';
import { isDashboardPasswordEnabled } from './lib/dashboard-auth.js';
import { clearManagedPid, writeManagedPid } from './lib/process-control.js';
import { closeDb } from './lib/db.js';
import {
  handleCreateApiKey,
  handleDeleteApiKey,
  handleApiKeyUsage,
  handleGetAuthSettings,
  handleListApiKeys,
  handleRotateApiKey,
  handleUpdateApiKey,
  handleUpdateAuthSettings,
} from './routes/api-keys.js';

const PAGES = new Set(['/', '/dashboard', '/providers', '/usage', '/chat', '/settings', '/api-keys', '/combos']);

function authorizationContext(req, settings, consume = true) {
  if (!getRequireApiKey(settings.requireApiKey)) return { managedId: null };
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  if (token === settings.apiKey) return { managedId: null };
  return authorizeManagedKey(token, { consume });
}

export function createServer(overrides = {}) {
  const settings = { ...config, ...overrides };

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (settings.logRequests) {
      res.on('finish', () => {
        console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
      });
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }

    const dashboardPage = PAGES.has(path) || /^\/providers\/[^/]+$/.test(path);
    if (isDashboardPasswordEnabled() && dashboardPage && !hasDashboardSession(req)) {
      return handleDashboard(req, res, 401);
    }

    try {
      if (path === '/health') {
        return sendJson(res, 200, { status: 'ok' });
      }
      if (path === '/api/auth/status' && req.method === 'GET') return handleDashboardAuthStatus(req, res);
      if (path === '/api/auth/login' && req.method === 'POST') return await handleDashboardAuthLogin(req, res);
      if (path === '/api/auth/logout' && req.method === 'POST') return handleDashboardAuthLogout(req, res);
      if (path === '/api/auth/settings' && req.method === 'GET') return handleDashboardAuthGetSettings(req, res);
      if (path === '/api/auth/settings' && req.method === 'PATCH') return await handleDashboardAuthUpdateSettings(req, res);
      if (path === '/api/auth/password' && req.method === 'PATCH') return await handleDashboardAuthUpdatePassword(req, res);
      // A provider detail page shares the dashboard shell and routes client-side.
      if (PAGES.has(path) || /^\/providers\/[^/]+$/.test(path)) {
        return handleDashboard(req, res);
      }
      if (path === '/api/status') {
        return handleStatus(req, res);
      }
      if (path === '/api/settings/autostart' && req.method === 'GET') {
        return handleAutostartGet(req, res);
      }
      if (path === '/api/settings/autostart' && req.method === 'PATCH') {
        return await handleAutostartUpdate(req, res, readJson);
      }
      if (path === '/api/settings/port' && req.method === 'GET') {
        return handlePortGet(req, res, settings);
      }
      if (path === '/api/settings/port' && req.method === 'PATCH') {
        return await handlePortUpdate(req, res, settings, readJson, async (port) => {
          const previous = settings.port;
          await new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) return reject(error);
              settings.port = port;
              server.listen(settings.port, settings.host, () => {
                config.port = port;
                writeManagedPid();
                resolve();
              });
            });
          }).catch((error) => {
            settings.port = previous;
            throw error;
          });
          writeLocalConfig({ port });
          writeManagedPid();
        });
      }
      if (path === '/api/usage' && req.method === 'GET') {
        return handleUsage(req, res, url);
      }
      if (path === '/api/token-saver' && req.method === 'GET') return handleGetTokenSaver(req, res);
      if (path === '/api/token-saver' && req.method === 'PATCH') return await handleUpdateTokenSaver(req, res);
      if (path === '/api/reply-filters' && req.method === 'GET') return handleGetReplyFilters(req, res);
      if (path === '/api/reply-filters' && req.method === 'PATCH') return await handleUpdateReplyFilters(req, res);
      if (path === '/api/keys' && req.method === 'GET') return handleListApiKeys(req, res);
      if (path === '/api/keys' && req.method === 'POST') return await handleCreateApiKey(req, res);
      const apiKeyUsageMatch = path.match(/^\/api\/keys\/([^/]+)\/usage$/);
      if (apiKeyUsageMatch && req.method === 'GET') return handleApiKeyUsage(req, res, apiKeyUsageMatch[1], url);
      const apiKeyRotateMatch = path.match(/^\/api\/keys\/([^/]+)\/rotate$/);
      if (apiKeyRotateMatch && req.method === 'POST') return await handleRotateApiKey(req, res, apiKeyRotateMatch[1]);
      const apiKeyMatch = path.match(/^\/api\/keys\/([^/]+)$/);
      if (apiKeyMatch && req.method === 'PATCH') return await handleUpdateApiKey(req, res, apiKeyMatch[1]);
      if (apiKeyMatch && req.method === 'DELETE') return handleDeleteApiKey(req, res, apiKeyMatch[1]);
      if (path === '/api/auth-settings' && req.method === 'GET') return handleGetAuthSettings(req, res, config.requireApiKey);
      if (path === '/api/auth-settings' && req.method === 'PATCH') return await handleUpdateAuthSettings(req, res);
      if (path === '/api/chat/completions' && req.method === 'POST') {
        return await handleChat(req, res, settings, { managedId: null });
      }
      if (path === '/api/providers/codex/oauth/start' && req.method === 'POST') {
        return await handleCodexOAuthStart(req, res);
      }
      const codexOAuthStatus = path.match(/^\/api\/providers\/codex\/oauth\/status\/([^/]+)$/);
      if (codexOAuthStatus && req.method === 'GET') return handleCodexOAuthStatus(req, res, decodeURIComponent(codexOAuthStatus[1]));
      const codexOAuthCancel = path.match(/^\/api\/providers\/codex\/oauth\/cancel\/([^/]+)$/);
      if (codexOAuthCancel && req.method === 'POST') return handleCodexOAuthCancel(req, res, decodeURIComponent(codexOAuthCancel[1]));
      if (path === '/api/chat/sessions' && req.method === 'GET') return handleListChatSessions(req, res);
      if (path === '/api/chat/sessions' && req.method === 'POST') return await handleCreateChatSession(req, res);
      const chatSessionMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)$/);
      if (chatSessionMatch) {
        if (req.method === 'GET') return handleGetChatSession(req, res, chatSessionMatch[1]);
        if (req.method === 'PATCH') return await handleUpdateChatSession(req, res, chatSessionMatch[1]);
        if (req.method === 'DELETE') return handleDeleteChatSession(req, res, chatSessionMatch[1]);
      }
      const chatMessageMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/);
      if (chatMessageMatch && req.method === 'POST') {
        return await handleAppendChatMessage(req, res, chatMessageMatch[1]);
      }

      if (path === '/api/combos' && req.method === 'GET') return handleListCombos(req, res);
      if (path === '/api/combos' && req.method === 'POST') return await handleCreateCombo(req, res);
      const comboMatch = path.match(/^\/api\/combos\/([^/]+)$/);
      if (comboMatch) {
        const comboId = decodeURIComponent(comboMatch[1]);
        if (req.method === 'GET') return handleGetCombo(req, res, comboId);
        if (req.method === 'PATCH') return await handleUpdateCombo(req, res, comboId);
        if (req.method === 'DELETE') return handleDeleteCombo(req, res, comboId);
      }

      const detailMatch = path.match(/^\/api\/providers\/([^/]+)$/);
      if (detailMatch && req.method === 'GET') {
        return handleProviderDetail(req, res, detailMatch[1]);
      }
      if (detailMatch && req.method === 'PATCH') {
        return await handleUpdateProvider(req, res, detailMatch[1]);
      }
      if (detailMatch && req.method === 'DELETE') {
        return handleDeleteProvider(req, res, detailMatch[1]);
      }
      if (path === '/api/providers' && req.method === 'POST') {
        return await handleCreateProvider(req, res);
      }
      const testMatch = path.match(/^\/api\/providers\/([^/]+)\/models\/test$/);
      if (testMatch && req.method === 'POST') {
        return await handleTestModels(req, res, testMatch[1]);
      }
      const fetchMatch = path.match(/^\/api\/providers\/([^/]+)\/models\/fetch$/);
      if (fetchMatch && req.method === 'POST') {
        return await handleFetchModels(req, res, fetchMatch[1]);
      }
      const addMatch = path.match(/^\/api\/providers\/([^/]+)\/models$/);
      if (addMatch && req.method === 'POST') {
        return await handleAddModel(req, res, addMatch[1]);
      }
      const modelStateMatch = path.match(/^\/api\/providers\/([^/]+)\/models\/(.+)$/);
      if (modelStateMatch && req.method === 'PATCH') {
        return await handleSetModelEnabled(req, res, modelStateMatch[1], modelStateMatch[2]);
      }
      const removeMatch = path.match(/^\/api\/providers\/([^/]+)\/models\/(.+)$/);
      if (removeMatch && req.method === 'DELETE') {
        return handleRemoveModel(req, res, removeMatch[1], removeMatch[2]);
      }

      // ---- account pool ----
      const accountAction = path.match(
        /^\/api\/providers\/([^/]+)\/accounts\/([^/]+)\/(test|quota|checkin)$/,
      );
      if (accountAction && req.method === 'POST') {
        const accountId = decodeURIComponent(accountAction[2]);
        if (accountAction[3] === 'test') return handleTestAccount(res, accountAction[1], accountId);
        if (accountAction[3] === 'quota') return handleAccountQuota(res, accountAction[1], accountId);
        return handleAccountCheckin(res, accountAction[1], accountId);
      }

      const accountMatch = path.match(/^\/api\/providers\/([^/]+)\/accounts\/([^/]+)$/);
      if (accountMatch) {
        const providerId = decodeURIComponent(accountMatch[1]);
        const accountId = decodeURIComponent(accountMatch[2]);
        if (req.method === 'PATCH') {
          return await handleUpdateAccount(req, res, providerId, accountId);
        }
        if (req.method === 'DELETE') {
          return handleDeleteAccount(res, providerId, accountId);
        }
      }

      const quotaListMatch = path.match(/^\/api\/providers\/([^/]+)\/accounts\/quota-list$/);
      if (quotaListMatch && req.method === 'GET') {
        return handleQuotaAccountList(res, quotaListMatch[1], url);
      }
      const quotaRefreshMatch = path.match(/^\/api\/providers\/([^/]+)\/accounts\/quota-order\/refresh$/);
      if (quotaRefreshMatch && req.method === 'POST') {
        return await handleRefreshQuotaOrder(res, quotaRefreshMatch[1]);
      }

      const accountPreviewMatch = path.match(/^\/api\/providers\/([^/]+)\/accounts\/preview$/);
      if (accountPreviewMatch && req.method === 'POST') {
        return await handlePreviewAccounts(req, res, accountPreviewMatch[1]);
      }

      const accountsMatch = path.match(/^\/api\/providers\/([^/]+)\/accounts$/);
      if (accountsMatch) {
        if (req.method === 'GET') {
          return handleListAccounts(req, res, accountsMatch[1], url);
        }
        if (req.method === 'POST') {
          return await handleCreateAccounts(req, res, accountsMatch[1], url);
        }
      }

      if (path.startsWith('/assets/') && handleAsset(path, req, res)) {
        return undefined;
      }

      if (path === '/v1' || path.startsWith('/v1/')) {
        const auth = authorizationContext(req, settings, path !== '/v1/models' || req.method !== 'GET');
        if (!auth) return sendError(res, 401, 'Invalid or missing router API key');
        if (path === '/v1/models' && req.method === 'GET') {
          return handleModels(req, res);
        }
        if (path === '/v1/chat/completions' && req.method === 'POST') {
          return await handleChat(req, res, settings, auth);
        }
      }

      return sendError(res, 404, `No route for ${req.method} ${path}`);
    } catch (err) {
      console.error('Unhandled error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  });

  return { server, settings };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { server, settings } = createServer();

  server.on('error', (err) => {
    clearManagedPid();
    if (err.code === 'EADDRINUSE') {
      console.error(
        `Port ${settings.port} is already in use. Set PORT to something else in .env.`,
      );
      process.exit(1);
    }
    throw err;
  });

  server.listen(settings.port, settings.host, () => {
    writeManagedPid();
    const base = `http://${settings.host}:${settings.port}`;
    console.log(`norouter listening on ${base}`);
    for (const provider of providers) {
      const state = provider.requiresAccount ? 'account pool required' : 'open endpoint';
      console.log(
        `  ${provider.display.name} (${provider.prefix}) - ${provider.models.length} models - ${state}`,
      );
    }
    console.log(`  dashboard: ${base}/`);
    console.log(`  base URL:  ${base}/v1`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearManagedPid();
    closeDb();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
