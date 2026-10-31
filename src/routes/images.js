// OpenAI-compatible image generation: POST /v1/images/generations.
//
// The account pool is shared with chat, so a request resolves the model against
// the provider that advertises it, walks the same healthy accounts, and parks
// accounts that the upstream rejects — exactly like the chat failover. The only
// provider-specific part is unwrapping the response into the OpenAI shape.

import { readJson, sendError, sendJson } from '../lib/http.js';
import { resolveCredential, buildHeaders } from './chat.js';
import { getProvider, providers } from '../providers/index.js';
import {
  accountAttemptLimit,
  markFailure,
  markSuccess,
  refreshAccountNow,
} from '../lib/accounts.js';
import { recordRequest, recordError } from '../lib/stats.js';
import { recordRequestLog, redact } from '../lib/request-log.js';
import { notifyWebhook } from '../lib/webhook.js';

const AUTH_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;

// Image models are not chat models, so they resolve against provider.image.models
// instead of the chat catalog. Accepts "cbcn/hunyuan-image-alpha" and the bare id.
function resolveImageModel(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'Field "model" must be a non-empty string' };
  }
  const name = raw.trim();
  const slash = name.indexOf('/');
  if (slash > 0) {
    const provider = getProvider(name.slice(0, slash));
    const rest = name.slice(slash + 1);
    if (provider?.image?.models?.includes(rest)) return { provider, model: rest };
    if (provider?.image) return { error: `Provider "${provider.id}" does not generate images for model "${rest}".` };
    return { error: `Unknown provider "${name.slice(0, slash)}".` };
  }
  for (const provider of providers) {
    if (provider.image?.models?.includes(name)) return { provider, model: name };
  }
  return { error: `Unknown image model "${name}".` };
}

function imageUrl(provider) {
  const override = provider.baseUrlEnv ? process.env[provider.baseUrlEnv]?.trim() : '';
  // The image route is separate from chat; a test override on the chat base URL
  // should also cover image so hermetic tests never touch the real gateway.
  if (override) {
    return override.replace(/\/+$/, '') + '/images/generations';
  }
  return provider.image.url;
}

function normalize(provider, payload) {
  // Tencent wraps the result: { data: { data: [{ url }] } }. Some routes may
  // answer flat; accept both. Output is the OpenAI { created, data: [...] }.
  const inner = payload?.data?.data ?? payload?.data ?? [];
  const items = Array.isArray(inner) ? inner : [];
  const data = items.map((item) => {
    if (typeof item === 'string') return { url: item };
    const url = item?.url || item?.image_url || null;
    const b64 = item?.b64_json || item?.image_base64 || null;
    return b64 ? { b64_json: b64 } : { url };
  });
  const created = payload?.data?.created || payload?.created || Math.floor(Date.now() / 1000);
  return { created, data };
}

export async function handleImageGeneration(req, res) {
  let body;
  try {
    body = await readJson(req, 32 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }

  if (typeof body?.prompt !== 'string' || !body.prompt.trim()) {
    return sendError(res, 400, 'Field "prompt" is required.');
  }

  const resolved = resolveImageModel(body.model);
  if (resolved.error) return sendError(res, 400, resolved.error);
  const { provider, model } = resolved;

  const started = Date.now();
  const payload = { model, prompt: body.prompt.trim() };
  if (Number.isFinite(Number(body.n)) && Number(body.n) > 0) payload.n = Number(body.n);
  if (typeof body.size === 'string' && body.size) payload.size = body.size;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let lastStatus = null;
  let lastError = 'Image generation failed.';

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
        response = await fetch(imageUrl(provider), {
          method: 'POST',
          headers: { ...buildHeaders(provider, credential.token), accept: 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err) {
        if (err.name === 'AbortError') {
          recordError('Image generation timed out', { upstream: true, model, provider: provider.id });
          return sendError(res, 502, 'Image generation timed out.');
        }
        markFailure(credential.row.id, { message: err.message, cooldownMs: DEFAULT_COOLDOWN_MS });
        lastStatus = 502;
        lastError = err.message;
        continue;
      }

      if (response.ok) {
        let parsed;
        try {
          parsed = await response.json();
        } catch {
          return sendError(res, 502, 'Upstream returned an invalid image response.');
        }
        markSuccess(credential.row.id, { tokensIn: 0, tokensOut: 0 });
        recordRequest({ provider: provider.id, model });
        recordRequestLog({ provider: provider.id, model, account: credential.row.label, ms: Date.now() - started, status: 200 });
        notifyWebhook('request', { provider: provider.id, model, account: credential.row.label, ms: Date.now() - started, status: 200 });
        return sendJson(res, 200, normalize(provider, parsed));
      }

      const text = await response.text().catch(() => '');
      lastStatus = response.status;
      lastError = redact(text).slice(0, 300) || `Upstream returned ${response.status}.`;

      if ((response.status === 401 || response.status === 403) && credential.row) {
        const fresh = await refreshAccountNow(provider, credential.row);
        if (fresh?.accessToken) {
          const retry = await fetch(imageUrl(provider), {
            method: 'POST',
            headers: { ...buildHeaders(provider, fresh.accessToken), accept: 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
          if (retry.ok) {
            markSuccess(credential.row.id, { tokensIn: 0, tokensOut: 0 });
            const parsed = await retry.json().catch(() => ({}));
            const elapsed = Date.now() - started;
            recordRequest({ provider: provider.id, model, ms: elapsed });
            recordRequestLog({ provider: provider.id, model, account: credential.row.label, ms: elapsed, status: 200 });
            notifyWebhook('request', { provider: provider.id, model, account: credential.row.label, ms: elapsed, status: 200 });
            return sendJson(res, 200, normalize(provider, parsed));
          }
        }
        markFailure(credential.row.id, { message: 'Upstream rejected the credential.', cooldownMs: AUTH_COOLDOWN_MS });
        continue;
      }

      markFailure(credential.row.id, {
        message: lastError.slice(0, 200),
        cooldownMs: response.status === 429 ? 60_000 : DEFAULT_COOLDOWN_MS,
      });
      continue;
    }

    recordError(lastError, { upstream: true, model, provider: provider.id });
    recordRequestLog({ provider: provider.id, model, status: lastStatus, error: lastError });
    notifyWebhook('error', { provider: provider.id, model, status: lastStatus, message: lastError });
    return sendError(res, lastStatus || 502, lastError);
  } finally {
    clearTimeout(timer);
  }
}
