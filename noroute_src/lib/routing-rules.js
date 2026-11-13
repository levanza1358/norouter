// General routing rules: model aliases and conditional fallback chains. Settings
// live in the meta table like vision routing, so they survive a restart without
// a schema migration. Aliases rewrite one client-facing name; rules replace the
// requested model with a chain when a header, API key, context size, or tool
// presence matches. Matching is ordered: the first enabled rule wins.
import { randomUUID } from 'node:crypto';

import { comboModels, isComboName } from './combos.js';
import { getDb } from './db.js';
import { resolveModel } from './model.js';

const CONFIG_KEY = 'routing_rules';
const MAX_ALIASES = 50;
const MAX_RULES = 20;
const MAX_RULE_MODELS = 20;
const NAME_MAX = 60;
const ALIAS_MAX = 120;

const EMPTY = { aliases: {}, rules: [] };

function readRaw() {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(CONFIG_KEY);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function cleanAliases(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const aliases = {};
  for (const [from, to] of Object.entries(raw)) {
    if (typeof from !== 'string' || !from.trim()) continue;
    if (typeof to !== 'string' || !to.trim()) continue;
    aliases[from.trim()] = to.trim();
  }
  return aliases;
}

function cleanMatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const match = {};
  if (raw.header && typeof raw.header === 'object') {
    match.header = { name: String(raw.header.name || ''), value: String(raw.header.value || '') };
  }
  if (typeof raw.apiKeyId === 'string' && raw.apiKeyId) match.apiKeyId = raw.apiKeyId;
  if (Number.isSafeInteger(raw.minContextTokens) && raw.minContextTokens > 0) match.minContextTokens = raw.minContextTokens;
  if (typeof raw.hasTools === 'boolean') match.hasTools = raw.hasTools;
  return match;
}

function cleanRule(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `rule-${index + 1}`,
    name: String(raw.name || '').trim(),
    enabled: raw.enabled !== false,
    match: cleanMatch(raw.match),
    models: Array.isArray(raw.models)
      ? raw.models.filter((model) => typeof model === 'string' && model.trim()).map((model) => model.trim())
      : [],
  };
}

export function getRoutingRules() {
  const raw = readRaw();
  if (!raw || typeof raw !== 'object') return { aliases: {}, rules: [] };
  return {
    aliases: cleanAliases(raw.aliases),
    rules: Array.isArray(raw.rules) ? raw.rules.map(cleanRule).filter(Boolean) : [],
  };
}

// A model target is any enabled provider model; a route target may also be an
// existing combo name, because an alias may point at a whole fallback chain.
function modelTarget(value) {
  const text = String(value || '').trim();
  if (!text) return { error: 'Model must be a non-empty string.' };
  const resolved = resolveModel(text);
  if (resolved.error) return { error: `Invalid model "${text}": ${resolved.error}` };
  return { value: `${resolved.provider.prefix}/${resolved.model}` };
}

export function routeTarget(value) {
  const text = String(value || '').trim();
  if (!text) return { error: 'Model must be a non-empty string.' };
  if (isComboName(text) && comboModels(text)) return { value: text };
  return modelTarget(text);
}

function sameModel(a, b) {
  const left = modelTarget(a);
  const right = modelTarget(b);
  return !left.error && !right.error && left.value === right.value;
}

function matchError(match) {
  if (!match || typeof match !== 'object' || Array.isArray(match)) return 'match must be a JSON object.';
  const unknown = Object.keys(match).find((key) => !['header', 'apiKeyId', 'minContextTokens', 'hasTools'].includes(key));
  if (unknown) return `Unknown match field "${unknown}".`;
  const conditions = Object.keys(match).length;
  if (!conditions) return 'A rule needs at least one match condition.';
  if (match.header !== undefined) {
    if (!match.header || typeof match.header !== 'object' || Array.isArray(match.header)) return 'match.header must be an object with name and value.';
    const unknownHeader = Object.keys(match.header).find((key) => key !== 'name' && key !== 'value');
    if (unknownHeader) return `Unknown header match field "${unknownHeader}".`;
    if (typeof match.header.name !== 'string' || !/^[A-Za-z0-9-]+$/.test(match.header.name)) {
      return 'match.header.name must be a header name without spaces.';
    }
    if (typeof match.header.value !== 'string' || !match.header.value) {
      return 'match.header.value must be a non-empty string.';
    }
  }
  if (match.apiKeyId !== undefined) {
    if (typeof match.apiKeyId !== 'string' || !match.apiKeyId) return 'match.apiKeyId must be an API key id.';
    if (!getDb().prepare('SELECT id FROM api_keys WHERE id = ?').get(match.apiKeyId)) {
      return `Unknown API key "${match.apiKeyId}".`;
    }
  }
  if (match.minContextTokens !== undefined && (!Number.isSafeInteger(match.minContextTokens) || match.minContextTokens <= 0)) {
    return 'match.minContextTokens must be a positive integer.';
  }
  if (match.hasTools !== undefined && typeof match.hasTools !== 'boolean') {
    return 'match.hasTools must be boolean.';
  }
  return null;
}

export function validateRoutingRulesPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Routing rules update must be a JSON object.';
  }
  const unknown = Object.keys(body).find((key) => key !== 'aliases' && key !== 'rules');
  if (unknown) return `Unknown routing rules field "${unknown}".`;

  if (body.aliases !== undefined) {
    if (!body.aliases || typeof body.aliases !== 'object' || Array.isArray(body.aliases)) {
      return 'aliases must be a JSON object mapping a name to a model or combo.';
    }
    const entries = Object.entries(body.aliases);
    if (entries.length > MAX_ALIASES) return `At most ${MAX_ALIASES} aliases are supported.`;
    for (const [from, to] of entries) {
      const name = typeof from === 'string' ? from.trim() : '';
      if (!name || name.length > ALIAS_MAX) return `An alias name must be 1-${ALIAS_MAX} characters.`;
      const target = routeTarget(to);
      if (target.error) return `Alias "${name}": ${target.error}`;
      // An alias that shadows a real model or combo is almost always a typo and
      // would make that name unreachable, so refuse it up front.
      if (!resolveModel(name).error || (isComboName(name) && comboModels(name))) {
        return `Alias "${name}" would shadow an existing model or combo.`;
      }
    }
  }

  if (body.rules !== undefined) {
    if (!Array.isArray(body.rules)) return 'rules must be an array.';
    if (body.rules.length > MAX_RULES) return `At most ${MAX_RULES} routing rules are supported.`;
    const names = new Set();
    const ids = new Set();
    for (const rule of body.rules) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return 'Every rule must be a JSON object.';
      const unknownRule = Object.keys(rule).find((key) => !['id', 'name', 'enabled', 'match', 'models'].includes(key));
      if (unknownRule) return `Unknown rule field "${unknownRule}".`;
      const name = typeof rule.name === 'string' ? rule.name.trim() : '';
      if (!name || name.length > NAME_MAX) return `A rule name must be 1-${NAME_MAX} characters.`;
      const folded = name.toLowerCase();
      if (names.has(folded)) return `A rule named "${name}" already exists.`;
      names.add(folded);
      if (rule.id !== undefined) {
        if (typeof rule.id !== 'string' || !rule.id) return 'A rule id must be a non-empty string.';
        if (ids.has(rule.id)) return `Rule id "${rule.id}" is listed twice.`;
        ids.add(rule.id);
      }
      if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') return 'enabled must be boolean.';
      const badMatch = matchError(rule.match);
      if (badMatch) return `Rule "${name}": ${badMatch}`;
      if (rule.models !== undefined && !Array.isArray(rule.models)) return `Rule "${name}": models must be an array.`;
      const models = rule.models || [];
      if (models.length > MAX_RULE_MODELS) return `Rule "${name}" supports at most ${MAX_RULE_MODELS} models.`;
      if (rule.enabled !== false && !models.length) return `Rule "${name}" needs at least one model before it can be enabled.`;
      for (const entry of models) {
        const target = modelTarget(entry);
        if (target.error) return `Rule "${name}": ${target.error}`;
        if (models.filter((other) => sameModel(other, entry)).length > 1) {
          return `Rule "${name}" lists "${target.value}" twice.`;
        }
      }
    }
  }
  return null;
}

function normalizeAliases(aliases) {
  const next = {};
  for (const [from, to] of Object.entries(aliases || {})) {
    const name = String(from || '').trim();
    if (!name) continue;
    next[name] = routeTarget(to).value;
  }
  return next;
}

function normalizeRules(rules) {
  return (rules || []).map((rule) => ({
    id: typeof rule.id === 'string' && rule.id ? rule.id : randomUUID(),
    name: String(rule.name || '').trim(),
    enabled: rule.enabled !== false,
    match: cleanMatch(rule.match),
    models: (rule.models || []).map((entry) => modelTarget(entry).value),
  }));
}

export function updateRoutingRules(patch = {}) {
  const current = getRoutingRules();
  const next = {
    aliases: patch.aliases === undefined ? current.aliases : normalizeAliases(patch.aliases),
    rules: patch.rules === undefined ? current.rules : normalizeRules(patch.rules),
  };
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(CONFIG_KEY, JSON.stringify(next));
  return { settings: next };
}

// One alias lookup; targets are canonical model names or combo names. Chaining
// is rejected when the settings are saved, so one lookup is enough.
export function resolveAlias(settings, model) {
  if (typeof model !== 'string') return null;
  const name = model.trim();
  if (!name) return null;
  const target = settings?.aliases?.[name];
  return target ? { name, target } : null;
}

// Chat clients send text in a few shapes: a plain string, an array of typed
// parts, or tool call arguments. Images get a flat allowance because their
// payload length says nothing about the visual token budget.
function partText(part) {
  if (!part || typeof part !== 'object') return '';
  if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  if (Array.isArray(part.content)) return part.content.map(partText).join('');
  return '';
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(partText).join('');
}

function countImageParts(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part && (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image')).length;
}

// Roughly four characters per token. This only needs to separate "small" from
// "large" contexts for rule matching; it is not billing-grade accounting.
export function estimateContextTokens(body) {
  let chars = 0;
  let images = 0;
  const system = body?.system;
  if (typeof system === 'string') chars += system.length;
  else if (Array.isArray(system)) system.forEach((part) => { chars += partText(part).length; });
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of messages) {
    images += countImageParts(message?.content);
    chars += contentText(message?.content).length;
    if (Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls) {
        chars += String(call?.function?.name || '').length + String(call?.function?.arguments || '').length;
      }
    }
  }
  if (Array.isArray(body?.tools)) chars += JSON.stringify(body.tools).length;
  return Math.ceil(chars / 4) + images * 1000;
}

function headerValue(headers, name) {
  const raw = headers?.[String(name || '').toLowerCase()];
  if (raw === undefined) return '';
  return Array.isArray(raw) ? raw.join(', ') : String(raw);
}

function ruleMatches(match, body, req, auth, contextTokens) {
  if (match.header) {
    const actual = headerValue(req?.headers, match.header.name);
    if (!actual.toLowerCase().includes(match.header.value.toLowerCase())) return false;
  }
  if (match.apiKeyId && auth?.managedId !== match.apiKeyId) return false;
  if (match.hasTools !== undefined) {
    const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
    if (hasTools !== match.hasTools) return false;
  }
  if (match.minContextTokens && contextTokens() < match.minContextTokens) return false;
  return true;
}

// Returns the ordered chain for the first enabled rule that matches, or null.
// Targets that no longer resolve are skipped; a rule whose targets all vanished
// is ignored so a stale rule cannot break every request.
export function matchRoutingRule(settings, body, req, auth = {}) {
  const rules = settings?.rules || [];
  let tokens = null;
  const contextTokens = () => {
    if (tokens === null) tokens = estimateContextTokens(body);
    return tokens;
  };
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!ruleMatches(rule.match, body, req, auth, contextTokens)) continue;
    const chain = [];
    const seen = new Set();
    for (const entry of rule.models) {
      const resolved = modelTarget(entry);
      if (resolved.error || seen.has(resolved.value)) continue;
      seen.add(resolved.value);
      chain.push(resolved.value);
    }
    if (!chain.length) continue;
    return { name: rule.name, chain };
  }
  return null;
}

// Per-API-key default model. It is stored raw (combo names stay names), so the
// value is validated once when the key is saved and resolved per request.
export function defaultModelValue(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  const target = routeTarget(value);
  if (target.error) return { error: `defaultModel: ${target.error}` };
  return { value: target.value };
}
