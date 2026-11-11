import codebuddyCn from './codebuddy-cn.js';
import codex from './codex.js';
import { invalidateProvider, normalizeStrategy } from '../lib/accounts.js';
import { customModels, modelEnabled } from '../lib/custom-models.js';
import { codexCatalog } from '../lib/codex-account.js';
import {
  createCustomProvider,
  deleteCustomProvider,
  prepareProviderConfig,
  savedOverrides,
  savedProviders,
  saveProviderConfig,
  toProvider,
} from '../lib/custom-providers.js';

const shippedProviders = [codebuddyCn, codex];
export const providers = [];
const byPrefix = new Map();

function applyEntry(provider, entry) {
  return {
    ...provider,
    sourceId: entry.sourceId,
    id: entry.id,
    prefix: entry.prefix || entry.id,
    display: { name: entry.name, website: entry.website },
    baseUrl: entry.baseUrl,
    chatPath: entry.chatPath,
    headers: { ...entry.headers },
    models: [...entry.models],
    format: entry.format || provider.format,
    forceStream: Boolean(entry.forceStream),
    requiresAccount: Boolean(entry.requiresAccount),
    baseUrlEnv: entry.baseUrlEnv || '',
    refresh: entry.refresh || undefined,
    quota: entry.quota || undefined,
    checkin: entry.checkin || undefined,
    image: entry.image || provider.image || undefined,
    embedding: entry.embedding || provider.embedding || undefined,
    reasoning: entry.reasoning || undefined,
    accountStrategy: normalizeStrategy(entry.accountStrategy),
  };
}

function replaceRegistry(next) {
  providers.splice(0, providers.length, ...next);
  byPrefix.clear();
  for (const provider of providers) {
    byPrefix.set(provider.id, provider);
    byPrefix.set(provider.prefix, provider);
  }
}

function loadProviders() {
  const overrides = new Map(savedOverrides().map((entry) => [entry.sourceId, entry]));
  const builtins = shippedProviders.map((provider) => {
    const entry = overrides.get(provider.id);
    return entry
      ? applyEntry(provider, entry)
      : { ...provider, sourceId: provider.id, prefix: provider.prefix || provider.id, accountStrategy: normalizeStrategy(provider.accountStrategy) };
  });
  replaceRegistry([...builtins, ...savedProviders().map(toProvider)]);
}

loadProviders();

export function getProvider(name) {
  return byPrefix.get(name) || null;
}

export function allModels(provider) {
  if (provider.id === 'codex') return codexCatalog();
  const extra = customModels(provider.id);
  const models = extra.length ? [...provider.models, ...extra] : provider.models;
  return models.filter((model) => modelEnabled(provider.id, model));
}

export function catalogModels(provider) {
  const bundled = provider.id === 'codex' ? codexCatalog() : provider.models;
  const extra = customModels(provider.id);
  const unique = [...new Set([...bundled, ...extra])];
  return unique;
}

function conflicts(entry, provider) {
  for (const name of [entry.id, entry.prefix]) {
    const hit = getProvider(name);
    if (hit && hit !== provider) return `Provider id or prefix "${name}" is already in use.`;
  }
  return '';
}

export function addProvider(input) {
  const prepared = prepareProviderConfig(null, input, { creating: true });
  if (prepared.error) return prepared;
  const conflict = conflicts(prepared.entry, null);
  if (conflict) return { status: 409, error: conflict };
  const result = createCustomProvider(input);
  if (result.error) return result;
  const provider = toProvider(result.entry);
  replaceRegistry([...providers, provider]);
  return { provider };
}

export function updateProvider(id, patch) {
  const provider = getProvider(id);
  if (!provider) return { status: 404, error: `Unknown provider "${id}"` };
  const prepared = prepareProviderConfig(provider, patch);
  if (prepared.error) return prepared;
  const conflict = conflicts(prepared.entry, provider);
  if (conflict) return { status: 409, error: conflict };
  saveProviderConfig(provider, prepared.entry);
  if (prepared.entry.id !== provider.id) {
    invalidateProvider(provider.id);
    invalidateProvider(prepared.entry.id);
  }
  loadProviders();
  return { provider: getProvider(prepared.entry.id) };
}

export function removeProvider(id) {
  const provider = getProvider(id);
  if (!provider?.custom) return false;
  if (!deleteCustomProvider(provider.id)) return false;
  invalidateProvider(provider.id);
  loadProviders();
  return true;
}

export function chatUrl(provider) {
  const override = provider.baseUrlEnv ? process.env[provider.baseUrlEnv]?.trim() : '';
  const base = override ? override.replace(/\/+$/, '') : provider.baseUrl;
  if (override) return /\/chat\/completions$/.test(base) ? base : base + provider.chatPath;
  return base + provider.chatPath;
}

// A Codex account stored as an OpenAI API key talks to the public Chat
// Completions endpoint; an OAuth account uses the ChatGPT Responses endpoint.
// /v1 and the dashboard model tester both read this so they cannot drift and
// send a Chat Completions body to the Responses route.
export function wireFor(provider, account = null) {
  if (provider.id === 'codex' && account?.kind === 'api_key') {
    return { format: 'openai', url: 'https://api.openai.com/v1/chat/completions' };
  }
  return { format: provider.format || 'openai', url: chatUrl(provider) };
}
