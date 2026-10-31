// OpenAI-compatible embeddings: POST /v1/embeddings.
// CodeBuddy's media route is account-backed and uses the same bearer/refresh/
// cooldown flow as chat and image generation. Inputs are forwarded only as
// model + input; vectors and input text never enter request logs or usage logs.

import { readJson, sendError, sendJson } from '../lib/http.js';
import { resolveCredential, buildHeaders } from './chat.js';
import { getProvider, providers } from '../providers/index.js';
import {
  accountAttemptLimit,
  markFailure,
  markSuccess,
  refreshAccountNow,
} from '../lib/accounts.js';
import { recordError, recordRequest } from '../lib/stats.js';
import { redact, recordRequestLog } from '../lib/request-log.js';
import { notifyWebhook } from '../lib/webhook.js';

const AUTH_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;

function resolveEmbeddingModel(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'Field "model" must be a non-empty string' };
  }
  const name = raw.trim();
  const slash = name.indexOf('/');
  if (slash > 0) {
    const provider = getProvider(name.slice(0, slash));
    const model = name.slice(slash + 1);
    if (provider?.embedding?.models?.includes(model)) return { provider, model };
    if (provider?.embedding) return { error: `Provider "${provider.id}" does not provide embeddings for model "${model}".` };
    return { error: `Unknown provider "${name.slice(0, slash)}".` };
  }
  for (const provider of providers) {
    if (provider.embedding?.models?.includes(name)) return { provider, model: name };
  }
  return { error: `Unknown embedding model "${name}".` };
}

function embeddingUrl(provider) {
  const override = provider.baseUrlEnv ? process.env[provider.baseUrlEnv]?.trim() : '';
  if (override) return `${override.replace(/\/+$/, '')}/embeddings`;
  return provider.embedding.url;
}

function validInput(input) {
  return typeof input === 'string'
    ? input.length > 0
    : Array.isArray(input) && input.length > 0 && input.every((item) => typeof item === 'string' && item.length > 0);
}

function normalize(payload, model) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return {
    object: 'list',
    data: data.map((item, index) => ({
      object: 'embedding',
      index: Number.isInteger(item?.index) ? item.index : index,
      embedding: Array.isArray(item?.embedding) ? item.embedding : [],
    })),
    model: payload?.model || model,
    ...(payload?.usage ? { usage: payload.usage } : {}),
  };
}

export async function handleEmbeddings(req, res) {
  let body;
  try {
    body = await readJson(req, 2 * 1024 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  if (!validInput(body?.input)) return sendError(res, 400, 'Field "input" must be a non-empty string or array of strings.');

  const resolved = resolveEmbeddingModel(body.model);
  if (resolved.error) return sendError(res, 400, resolved.error);
  const { provider, model } = resolved;
  const payload = { model, input: body.input };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let lastStatus = null;
  let lastError = 'Embedding request failed.';

  try {
    for (let round = 0; round < accountAttemptLimit(provider.id); round += 1) {
      const credential = await resolveCredential(provider);
      if (!credential.token) {
        lastStatus = credential.pooled ? 429 : 401;
        lastError = credential.pooled
          ? `Every account for ${provider.id} is cooling down or out of tokens.`
          : `No account credential for ${provider.id}.`;
        break;
      }

      let response;
      try {
        response = await fetch(embeddingUrl(provider), {
          method: 'POST',
          headers: { ...buildHeaders(provider, credential.token), accept: 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err) {
        if (err.name === 'AbortError') return sendError(res, 502, 'Embedding request timed out.');
        markFailure(credential.row.id, { message: err.message, cooldownMs: DEFAULT_COOLDOWN_MS });
        lastStatus = 502;
        lastError = redact(err.message);
        continue;
      }

      if (response.ok) {
        const parsed = await response.json().catch(() => null);
        if (!parsed || !Array.isArray(parsed.data)) return sendError(res, 502, 'Upstream returned an invalid embedding response.');
        const elapsed = Date.now() - started;
        markSuccess(credential.row.id, { tokensIn: parsed.usage?.prompt_tokens || 0, tokensOut: 0 });
        recordRequest({ provider: provider.id, model, usage: parsed.usage, ms: elapsed });
        recordRequestLog({ provider: provider.id, model, account: credential.row.label, ms: elapsed, status: 200 });
        notifyWebhook('request', { provider: provider.id, model, account: credential.row.label, ms: elapsed, status: 200 });
        return sendJson(res, 200, normalize(parsed, model));
      }

      lastStatus = response.status;
      lastError = redact((await response.text().catch(() => ''))).slice(0, 300) || `Upstream returned ${response.status}.`;
      if (response.status === 401 || response.status === 403) {
        const fresh = await refreshAccountNow(provider, credential.row);
        if (fresh?.accessToken) {
          const retry = await fetch(embeddingUrl(provider), {
            method: 'POST',
            headers: { ...buildHeaders(provider, fresh.accessToken), accept: 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
          if (retry.ok) {
            const parsed = await retry.json().catch(() => null);
            if (parsed?.data && Array.isArray(parsed.data)) {
              const elapsed = Date.now() - started;
              markSuccess(credential.row.id, { tokensIn: parsed.usage?.prompt_tokens || 0, tokensOut: 0 });
              recordRequest({ provider: provider.id, model, usage: parsed.usage, ms: elapsed });
              recordRequestLog({ provider: provider.id, model, account: credential.row.label, ms: elapsed, status: 200 });
              notifyWebhook('request', { provider: provider.id, model, account: credential.row.label, ms: elapsed, status: 200 });
              return sendJson(res, 200, normalize(parsed, model));
            }
          }
        }
        markFailure(credential.row.id, { message: 'Upstream rejected the credential.', cooldownMs: AUTH_COOLDOWN_MS });
        continue;
      }
      markFailure(credential.row.id, { message: lastError, cooldownMs: response.status === 429 ? 60_000 : DEFAULT_COOLDOWN_MS });
    }

    recordError(lastError, { upstream: true, model, provider: provider.id });
    recordRequestLog({ provider: provider.id, model, status: lastStatus, error: lastError });
    notifyWebhook('error', { provider: provider.id, model, status: lastStatus, message: lastError });
    return sendError(res, lastStatus || 502, lastError);
  } finally {
    clearTimeout(timer);
  }
}
