// Pure adapter between Chat Completions and the Antigravity Cloud Code wire
// shape (`v1internal:generateContent` / `streamGenerateContent`). Network,
// credentials, and provider state stay outside this module.
//
// Antigravity speaks Google's `v1internal` envelope: a Gemini request wrapped
// in { project, model, userAgent, requestId, request }. It is picky in ways the
// public Gemini API is not — sampling params are rejected on Gemini 4, tool
// schemas must be stripped down to the protobuf subset, and historical
// functionCall parts need a thought signature — so the conversion is explicit.

import { createHash, randomUUID } from 'node:crypto';

export class AntigravityFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AntigravityFormatError';
    this.status = 400;
  }
}

const MAX_OUTPUT_TOKENS = 64000;

// The official client's agent path omits `requestType` entirely; sending
// `requestType: "agent"` triggers a detail-free 429 even when quota remains.
// It also omits safetySettings on this path.
const USER_AGENT_FIELD = 'antigravity';

// Gemini 3+ validates the thought signature on every historical functionCall.
// Calls replayed from a client that never received one (a session that started
// on another provider) still have to carry something, so the first call in a
// group gets this protocol constant and the rest stay unsigned.
const DEFAULT_THINKING_SIGNATURE = 'EuwGCukGAXLI2nxwZIq54WWSoL/YN0P3TsDZ7zRnLi8g0S4aVr2HUGxvaHKySuY6HAVzcE0GPGjXrytLIldxthSvfxgUlJh6Qa9Z+Oj5QZBlYdg6HaJ6yuY5R7waE6rdwBsRf7Ft2j3DJ9rMi9qhWFqApewYtPhls3VHtuvND3l8Rm09+lbAXQs6KKWEWrxNLKTBkfpMgXhRERc/TQRMZu1twAablm6/Zk1tsYRvfWKLsNbeKF+CCojJdXJKvnR/8Ouuoa+Y2Ti20hcW7aZIIjZDFYPU//k6Ybmhg69J/imbFai2ckhfLaisqdDkdoIiBJScTOUvYqP6AE9d4MsydSC+UlhIMk4hoP76R8vUSCZRMkjOaDXstf/QoVZKbt94wyRZgAJ1G0BqI8L5ow86kLpA4wJEtxsRGymOE4bKUvApveBakYDNM9APkf+LbtbzWSseGjoZcSlycF9iN8Q2XNYKRrHbv3Lr5Y8JjdH/5y/6SHkNehTEZugaeGnSPSyCTWto1kQgHpxdWmhkLfJGNUGLmue7Mesj4TSms4J33mRpYVhNB/J333FCqIP0hr/E7BkkjEn7yZ4X7SQlh+xKPurapsnHRwiKmtsilmEFrnTE9iQr+pMr6M29qqFNv1tr5yumbaJw8JW9sB15tNsRv+dW6BjNanbsKz7HCgKUBc8tGy+7YuhXzAfViyRefcjK7eZW0Fbyt7AbybJTKz78W8NH7ye6LAwzOebXpeZ4D43fNIt8bKh26qgduSQv/7o+pAflkuqHZ99YWgHQ8h8OkZFi3eOiSYjsjhdZ/czWOdoPI/OnqIldzMPF5YlrKBLFX8VhRKVmqgsmWf5PHGulHhMkVlS+XG2UIseGy69ARa93D78Gsa+1n1kJr7EEB7Rh+27vUMxVYLdz1yMSvE5nalTAlg/ZeG8+XQ0cHuAI3KbQpHW2Q++RdXfm5JzD5WdJZUU+Zn8t8UUn85BH4RxZLeE0qJikgSsKoYVBc6YhiMjhPgkR95ReimY4Z0xCJdRo1gjexOFeODZMpQF6Yxnoic7IrdgsFA3iePTbFnPp3IAM1fAThWhXJUn3QInUOTd5o1qmTmn6REbL15g/JQNl+dqUoPkhleeb2V3kjqp1okmO3wMZbPknR3S1LZNmlS72/iBQUm+n2b/RCn4PjmM2';

// A tool-call id is echoed back by the client on the next turn, so the
// signature learned from the response can be replayed with the history. Kept
// module-local and bounded: it is a cache, not durable state.
const SIGNATURE_CACHE_LIMIT = 2000;
const signatureCache = new Map();

function cacheSignature(id, signature) {
  if (!id || typeof signature !== 'string' || !signature) return;
  signatureCache.delete(id);
  signatureCache.set(id, signature);
  while (signatureCache.size > SIGNATURE_CACHE_LIMIT) {
    signatureCache.delete(signatureCache.keys().next().value);
  }
}

function cachedSignature(id) {
  return id ? signatureCache.get(id) || null : null;
}

function isGemini4Model(model) {
  return String(model || '').toLowerCase().includes('gemini-4');
}

// Gemini accepts [a-zA-Z_][a-zA-Z0-9_.:-]{0,63} as a function name.
function sanitizeFunctionName(name) {
  if (!name) return '_unknown';
  let sanitized = String(name).replace(/[^a-zA-Z0-9_.:-]/g, '_');
  if (!/^[a-zA-Z_]/.test(sanitized)) sanitized = `_${sanitized}`;
  return sanitized.substring(0, 64);
}

function tryParseJSON(value) {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function remoteImageMimeType(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return 'image/jpeg';
  }
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.gif')) return 'image/gif';
  if (pathname.endsWith('.bmp')) return 'image/bmp';
  return 'image/jpeg';
}

function dataUriPart(url) {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma === -1) return null;
  const mimeType = url.substring(5, comma).split(';')[0];
  return { inlineData: { mime_type: mimeType, data: url.substring(comma + 1) } };
}

// Chat Completions content -> Gemini parts. Images and audio become inline
// data, remote images become fileData (the gateway fetches them itself).
function contentParts(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) {
    throw new AntigravityFormatError('Message content must be a string or an array of parts.');
  }

  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') throw new AntigravityFormatError('Message content parts must be objects.');
    if (item.type === 'text' || item.type === 'input_text' || item.type === 'output_text') {
      if (typeof item.text === 'string' && item.text) parts.push({ text: item.text });
      continue;
    }
    if (item.type === 'image_url' || item.type === 'input_image') {
      const url = typeof item.image_url === 'string' ? item.image_url : item.image_url?.url;
      if (typeof url === 'string' && url) {
        const inline = dataUriPart(url);
        if (inline) parts.push(inline);
        else if (/^https?:\/\//.test(url)) parts.push({ fileData: { fileUri: url, mimeType: remoteImageMimeType(url) } });
      }
      continue;
    }
    if (item.type === 'input_audio' && item.input_audio?.data) {
      const format = item.input_audio.format || 'wav';
      parts.push({ inlineData: { mime_type: format === 'mp3' ? 'audio/mpeg' : `audio/${format}`, data: item.input_audio.data } });
      continue;
    }
    if (item.type === 'audio_url') {
      const inline = dataUriPart(item.audio_url?.url);
      if (inline) parts.push(inline);
      continue;
    }
    if (item.type === 'file') {
      const inline = dataUriPart(item.file?.file_data);
      if (inline) parts.push(inline);
    }
  }
  return parts;
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

// Schema cleaning -----------------------------------------------------------
// Gemini's Schema proto has no field for most JSON Schema keywords, and one
// unknown key rejects the whole request. These phases mirror what the official
// Antigravity client sends for MCP and editor tools.

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  'minLength', 'maxLength', 'exclusiveMinimum', 'exclusiveMaximum',
  'minItems', 'maxItems', 'format', 'multipleOf', 'uniqueItems', 'contains',
  'unevaluatedProperties', 'unevaluatedItems', 'contentSchema',
  'additionalItems', 'default', 'examples',
  '$schema', '$defs', 'definitions', 'const', '$ref', '$comment',
  'deprecated', 'readOnly', 'writeOnly',
  'additionalProperties', 'propertyNames', 'patternProperties', 'enumDescriptions',
  'anyOf', 'oneOf', 'allOf', 'not',
  'dependencies', 'dependentSchemas', 'dependentRequired',
  'title', 'optional', '~optional', 'if', 'then', 'else', 'contentMediaType', 'contentEncoding',
  'cornerRadius', 'fillColor', 'fontFamily', 'fontSize', 'fontWeight',
  'gap', 'padding', 'strokeColor', 'strokeThickness', 'textColor',
  'errorMessage', 'errorMessages', 'x-errorMessage', 'x-errorMessages',
  'markdownDescription', 'x-intellij-html-description',
  'x-taplo-info', 'x-taplo', 'doNotSuggest', 'suggestSortText',
  'minProperties', 'maxProperties',
]);

function convertConstToEnum(node) {
  if (!node || typeof node !== 'object') return;
  if (node.const !== undefined && !node.enum) {
    node.enum = [node.const];
    delete node.const;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') convertConstToEnum(value);
  }
}

function convertEnumValuesToStrings(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.enum)) {
    node.enum = node.enum.map((value) => String(value));
    if (!node.type) node.type = 'string';
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') convertEnumValuesToStrings(value);
  }
}

function mergeAllOf(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.allOf)) {
    const properties = {};
    const required = [];
    for (const item of node.allOf) {
      if (item?.properties) Object.assign(properties, item.properties);
      if (Array.isArray(item?.required)) {
        for (const field of item.required) if (!required.includes(field)) required.push(field);
      }
    }
    delete node.allOf;
    if (Object.keys(properties).length) node.properties = { ...node.properties, ...properties };
    if (required.length) node.required = [...new Set([...(node.required || []), ...required])];
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') mergeAllOf(value);
  }
}

function bestSchema(items) {
  let best = 0;
  let bestScore = -1;
  items.forEach((item, index) => {
    let score = 0;
    if (item?.type === 'object' || item?.properties) score = 3;
    else if (item?.type === 'array' || item?.items) score = 2;
    else if (item?.type && item.type !== 'null') score = 1;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return items[best];
}

function flattenAnyOfOneOf(node) {
  if (!node || typeof node !== 'object') return;
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(node[key])) {
      const candidates = node[key].filter((item) => item && item.type !== 'null');
      if (candidates.length) {
        const selected = bestSchema(candidates);
        delete node[key];
        Object.assign(node, selected);
      }
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') flattenAnyOfOneOf(value);
  }
}

function flattenTypeArrays(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.type)) {
    const types = node.type.filter((type) => type !== 'null');
    if (!types.length) node.type = 'string';
    else if (types.length === 1) node.type = types[0];
    else if (node.properties && types.includes('object')) node.type = 'object';
    else if (node.items?.type && types.includes('array')) node.type = 'array';
    else if (types.includes('string')) node.type = 'string';
    else if (types.includes('number')) node.type = 'number';
    else if (types.includes('integer')) node.type = 'integer';
    else if (types.includes('boolean')) node.type = 'boolean';
    else node.type = types[0];
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') flattenTypeArrays(value);
  }
}

function ensureObjectType(node) {
  if (!node || typeof node !== 'object') return;
  if (node.properties && !node.type) node.type = 'object';
  for (const [key, value] of Object.entries(node)) {
    if (!value || typeof value !== 'object') continue;
    if (key === 'properties' && !Array.isArray(value)) {
      for (const child of Object.values(value)) ensureObjectType(child);
    } else {
      ensureObjectType(value);
    }
  }
}

function ensureArrayItems(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'array') {
    if (!node.items || typeof node.items !== 'object' || !Object.keys(node.items).length) {
      node.items = { type: 'string' };
    } else if (!node.items.type) {
      node.items.type = node.items.properties ? 'object' : node.items.items ? 'array' : 'string';
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') ensureArrayItems(value);
  }
}

function convertPrefixItems(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.prefixItems) && node.prefixItems.length) {
    const variants = node.prefixItems.filter((item) => item && item.type !== 'null');
    if (!node.items && variants.length === 1) node.items = variants[0];
    else if (!node.items && variants.length > 1) node.items = { anyOf: variants };
    delete node.prefixItems;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') convertPrefixItems(value);
  }
}

function removeUnsupportedKeys(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) removeUnsupportedKeys(item);
    return;
  }
  for (const key of Object.keys(node)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key) || key.startsWith('x-')) {
      delete node[key];
      continue;
    }
    if (node[key] && typeof node[key] === 'object') removeUnsupportedKeys(node[key]);
  }
}

function cleanupRequired(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.required) && node.properties) {
    const valid = node.required.filter((field) => Object.prototype.hasOwnProperty.call(node.properties, field));
    if (valid.length) node.required = valid;
    else delete node.required;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') cleanupRequired(value);
  }
}

const EMPTY_SCHEMA_PLACEHOLDER = {
  reason: { type: 'string', description: 'Brief explanation of why you are calling this tool' },
};

function addPlaceholders(node) {
  if (!node || typeof node !== 'object') return;
  if (!Object.keys(node).length) {
    node.type = 'object';
    node.properties = structuredClone(EMPTY_SCHEMA_PLACEHOLDER);
    node.required = ['reason'];
    return;
  }
  if (node.type === 'object' && (!node.properties || !Object.keys(node.properties).length)) {
    node.properties = structuredClone(EMPTY_SCHEMA_PLACEHOLDER);
    node.required = ['reason'];
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') addPlaceholders(value);
  }
}

function enforceTypeConstraints(node) {
  if (!node || typeof node !== 'object') return;
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') enforceTypeConstraints(value);
  }
  if (node.type === 'array') {
    delete node.properties;
    delete node.required;
    if (!node.items || typeof node.items !== 'object' || !Object.keys(node.items).length) {
      node.items = { type: 'string' };
    } else if (!node.items.type) {
      node.items.type = node.items.properties ? 'object' : node.items.items ? 'array' : 'string';
    }
  } else {
    delete node.items;
  }
  if (node.type !== 'object') {
    delete node.properties;
    delete node.required;
  }
}

export function cleanJSONSchemaForAntigravity(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const cleaned = schema;
  convertConstToEnum(cleaned);
  convertEnumValuesToStrings(cleaned);
  mergeAllOf(cleaned);
  convertPrefixItems(cleaned);
  flattenAnyOfOneOf(cleaned);
  flattenTypeArrays(cleaned);
  ensureObjectType(cleaned);
  ensureArrayItems(cleaned);
  removeUnsupportedKeys(cleaned);
  cleanupRequired(cleaned);
  addPlaceholders(cleaned);
  enforceTypeConstraints(cleaned);
  return cleaned;
}

// Cloud Code reads a `$ref` key inside functionResponse.response as a pointer to
// functionResponse.parts, so a tool result that carries a JSON Schema document
// fails the request. Rename the key instead of dropping the payload.
const RESERVED_RESPONSE_KEYS = { $ref: '_ref' };

function sanitizeResponsePayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeResponsePayload);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[RESERVED_RESPONSE_KEYS[key] || key] = sanitizeResponsePayload(child);
  }
  return out;
}

function sanitizeResponsePart(part) {
  const response = part?.functionResponse?.response;
  if (!response || typeof response !== 'object') return part;
  return { ...part, functionResponse: { ...part.functionResponse, response: sanitizeResponsePayload(response) } };
}

function responsesLast(parts) {
  if (!parts.some((part) => part.functionResponse)) return parts;
  return [...parts.filter((part) => !part.functionResponse), ...parts.filter((part) => part.functionResponse)];
}

// Gemini 4 rejects a merged user turn that does not end with functionResponse,
// and the whole request must start and end with a user role part.
function normalizeContents(contents, model) {
  const lastResponses = isGemini4Model(model);
  const out = [];
  for (const content of contents || []) {
    if (!content?.role || !Array.isArray(content.parts)) continue;
    const parts = content.parts.filter((part) => part && Object.keys(part).length).map(sanitizeResponsePart);
    if (!parts.length) continue;
    const previous = out.at(-1);
    if (previous?.role === content.role) {
      previous.parts.push(...parts);
      if (lastResponses) previous.parts = responsesLast(previous.parts);
    } else {
      out.push({ ...content, parts: [...parts] });
    }
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', parts: [{ text: '...' }] });
  if (out.length && out.at(-1).role === 'model') {
    const calls = (out.at(-1).parts || []).filter((part) => part?.functionCall);
    if (calls.length) {
      out.push({
        role: 'user',
        parts: calls.map((part) => ({
          functionResponse: {
            ...(part.functionCall.id ? { id: part.functionCall.id } : {}),
            name: part.functionCall.name || 'tool',
            response: { result: 'Continue.' },
          },
        })),
      });
    } else {
      out.push({ role: 'user', parts: [{ text: 'Continue.' }] });
    }
  }
  return out;
}

// Gemini 4 removed temperature/topP/topK; forwarding them fails the request.
function generationConfig(body, model) {
  const config = {};
  if (!isGemini4Model(model)) {
    if (body.temperature !== undefined) config.temperature = body.temperature;
    if (body.top_p !== undefined) config.topP = body.top_p;
    if (body.top_k !== undefined) config.topK = body.top_k;
  }
  if (body.max_tokens !== undefined && Number.isFinite(Number(body.max_tokens))) {
    config.maxOutputTokens = Math.min(Number(body.max_tokens), MAX_OUTPUT_TOKENS);
  }
  return config;
}

function toolDeclarations(tools) {
  const declarations = [];
  for (const tool of tools || []) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.name && tool.input_schema) {
      declarations.push({
        name: sanitizeFunctionName(tool.name),
        description: tool.description || '',
        parameters: cleanJSONSchemaForAntigravity(structuredClone(tool.input_schema)),
      });
    } else if (tool.type === 'function' && tool.function?.name) {
      declarations.push({
        name: sanitizeFunctionName(tool.function.name),
        description: tool.function.description || '',
        parameters: cleanJSONSchemaForAntigravity(
          structuredClone(tool.function.parameters || { type: 'object', properties: {} }),
        ),
      });
    }
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : undefined;
}

// Gemini validates functionCall ids across the whole history, while an OpenAI
// tool_call_id is only unique inside its own assistant turn. Duplicates get a
// numeric suffix per occurrence; the mapping is consumed in document order so
// the matching functionResponse reuses the same emitted id.
function createCallIdUniquifier() {
  const used = new Set();
  return (id) => {
    if (!id) return id;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
    let n = 2;
    let candidate = `${id}-${n}`;
    while (used.has(candidate)) candidate = `${id}-${n++}`;
    used.add(candidate);
    return candidate;
  };
}

function buildContents(messages) {
  const contents = [];
  const toolNameById = {};
  const toolResponses = {};
  const cursor = {};
  const uniquify = createCallIdUniquifier();

  for (const message of messages || []) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.id && call.function?.name) toolNameById[call.id] = call.function.name;
      }
    }
    if (message?.role === 'tool' && message.tool_call_id) {
      (toolResponses[message.tool_call_id] ||= []).push(message.content);
    }
  }

  (messages || []).forEach((message, index) => {
    const role = message?.role;
    const content = message?.content;

    if (role === 'system' || role === 'developer') return;
    if (role === 'user') {
      const parts = contentParts(content);
      if (parts.length) contents.push({ role: 'user', parts });
      return;
    }
    if (role === 'tool') {
      // Answered by the assistant turn that requested the call, in order.
      return;
    }
    if (role !== 'assistant') {
      throw new AntigravityFormatError(`Unsupported message role "${role || 'unknown'}" for the Antigravity format.`);
    }

    const parts = [];
    if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
      parts.push({ thought: true, text: message.reasoning_content });
      parts.push({ thoughtSignature: DEFAULT_THINKING_SIGNATURE, text: '' });
    }
    const text = textContent(content);
    if (text) parts.push({ text });

    if (Array.isArray(message.tool_calls)) {
      const calls = [];
      let firstCall = true;
      for (const call of message.tool_calls) {
        if (call?.type && call.type !== 'function') continue;
        const emitId = uniquify(call.id);
        // A cached signature belongs to the original id; a duplicate id keeps
        // its own call/response pair, so only the first call falls back.
        const signature = cachedSignature(call.id) || (firstCall ? DEFAULT_THINKING_SIGNATURE : undefined);
        firstCall = false;
        const part = {
          functionCall: {
            id: emitId,
            name: sanitizeFunctionName(call.function?.name),
            args: tryParseJSON(call.function?.arguments || '{}') ?? {},
          },
        };
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
        calls.push({ originalId: call.id, emitId, name: call.function?.name });
      }

      if (parts.length) contents.push({ role: 'model', parts });

      const intermediate = index < messages.length - 1;
      const hasResponse = calls.some(({ originalId }) => (cursor[originalId] || 0) < (toolResponses[originalId]?.length || 0));
      if (hasResponse || intermediate) {
        const responseParts = [];
        for (const { originalId, emitId, name: callName } of calls) {
          const queue = toolResponses[originalId] || [];
          const at = cursor[originalId] || 0;
          const raw = at < queue.length ? queue[at] : '';
          if (at < queue.length) cursor[originalId] = at + 1;

          let name = callName || toolNameById[originalId];
          if (!name) {
            const pieces = String(originalId || '').split('-');
            name = pieces.length > 2 ? pieces.slice(0, -2).join('-') : originalId;
          }

          let parsed = tryParseJSON(raw);
          if (parsed === null || typeof parsed !== 'object') parsed = { result: parsed ?? raw };

          responseParts.push({
            functionResponse: {
              id: emitId,
              name: sanitizeFunctionName(name),
              response: { result: parsed },
            },
          });
        }
        if (responseParts.length) contents.push({ role: 'user', parts: responseParts });
      }
      return;
    }

    if (parts.length) contents.push({ role: 'model', parts });
  });

  return contents;
}

// Envelope identity ---------------------------------------------------------

function uuidFromSeed(seed) {
  const digest = createHash('sha256').update(String(seed)).digest();
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// request.sessionId is a numeric-looking string (the gateway rejects a JSON
// number with TYPE_STRING), and the tool-call/signature pairing only holds
// together when it stays the same across turns of one session, so derive it
// from the account identity rather than generating it per request.
function numericSessionId(seed) {
  const digest = createHash('sha256').update(`antigravity:session:${seed}`).digest('hex');
  return String(Number.parseInt(digest.slice(0, 12), 16));
}

function requestId(seed, model, contentCount) {
  const step = Math.max(1, contentCount * 2 - 1);
  return `agent/${uuidFromSeed(`antigravity:conversation:${seed}`)}/${Date.now()}/${uuidFromSeed(`antigravity:trajectory:${seed}:${model}:agent`)}/${step}`;
}

export function generateProjectId() {
  const adjectives = ['useful', 'bright', 'swift', 'calm', 'bold'];
  const nouns = ['fuze', 'wave', 'spark', 'flow', 'core'];
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adjective}-${noun}-${randomUUID().slice(0, 5)}`;
}

// Request -------------------------------------------------------------------

export function toAntigravityRequest(body = {}, { model, projectId = '', sessionSeed = 'antigravity' } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AntigravityFormatError('Chat request must be an object.');
  const upstreamModel = model || body.model;
  if (!upstreamModel || typeof upstreamModel !== 'string') throw new AntigravityFormatError('Chat request requires a model.');
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) throw new AntigravityFormatError('Antigravity requests require at least one message.');

  const system = messages
    .filter((message) => message?.role === 'system' || message?.role === 'developer')
    .map((message) => (typeof message.content === 'string' ? message.content : textContent(message.content)))
    .filter(Boolean)
    .join('\n\n');

  // A single system message is sent as ordinary user content: the gateway
  // rejects a request whose contents start with a model turn.
  const conversation = messages.filter((message) => message?.role !== 'system' && message?.role !== 'developer');
  const hasConversation = conversation.length > 0;
  if (!hasConversation && system) conversation.push({ role: 'user', content: system });

  const contents = normalizeContents(buildContents(conversation), upstreamModel);
  const request = {
    sessionId: numericSessionId(sessionSeed),
    contents,
    generationConfig: generationConfig(body, upstreamModel),
  };
  if (system && hasConversation) {
    request.systemInstruction = { role: 'user', parts: [{ text: system }] };
  }

  const tools = toolDeclarations(body.tools);
  if (tools) {
    request.tools = tools;
    request.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
  }

  return {
    project: projectId || generateProjectId(),
    model: upstreamModel,
    userAgent: USER_AGENT_FIELD,
    requestId: requestId(sessionSeed, upstreamModel, contents.length),
    request,
  };
}

// Response ------------------------------------------------------------------

function usageFromMetadata(metadata) {
  if (!metadata) return undefined;
  const prompt = Number(metadata.promptTokenCount ?? 0);
  const completion = Number(metadata.candidatesTokenCount ?? 0) + Number(metadata.thoughtsTokenCount ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(metadata.totalTokenCount ?? prompt + completion),
  };
}

function finishReason(value) {
  switch (value) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function dataUri(mimeType, data) {
  return `data:${mimeType || 'image/jpeg'};base64,${data}`;
}

function partImages(part) {
  const inline = part?.inlineData || part?.inline_data;
  if (!inline?.data) return null;
  return [{
    type: 'image_url',
    image_url: { url: dataUri(inline.mimeType || inline.mime_type, inline.data) },
  }];
}

export function fromAntigravityResponse(json = {}) {
  const response = json?.response || json;
  if (!response || typeof response !== 'object') throw new AntigravityFormatError('Antigravity response must be an object.');
  if (response.error) {
    throw new AntigravityFormatError(response.error.message || 'Antigravity API returned an error.');
  }

  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  const images = [];

  for (const part of parts) {
    const signature = part?.thoughtSignature || part?.thought_signature;
    const hasText = typeof part?.text === 'string' && part.text !== '';
    if (hasText) {
      if (part.thought === true) reasoning += part.text;
      else content += part.text;
    }
    if (part?.functionCall) {
      const call = part.functionCall;
      if (signature && call.id) cacheSignature(call.id, signature);
      toolCalls.push({
        index: toolCalls.length,
        id: call.id || `${call.name || 'tool'}-${Date.now()}-${toolCalls.length}`,
        type: 'function',
        function: { name: call.name || 'tool', arguments: JSON.stringify(call.args || {}) },
      });
    }
    const inline = partImages(part);
    if (inline) images.push(...inline);
  }

  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (images.length) message.images = images;

  const blocked = !candidate && response.promptFeedback?.blockReason;
  return {
    id: response.responseId ? `chatcmpl-${response.responseId}` : `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.modelVersion || '',
    choices: [{
      index: 0,
      message,
      finish_reason: blocked ? 'content_filter' : toolCalls.length ? 'tool_calls' : finishReason(candidate?.finishReason),
    }],
    usage: usageFromMetadata(response.usageMetadata),
  };
}

// Stream --------------------------------------------------------------------

// Antigravity streams one envelope per SSE data frame, each carrying a partial
// candidate. push() returns zero or more ChatCompletion chunks for one frame.
export function createAntigravityStream() {
  const state = {
    id: `chatcmpl-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: '',
    started: false,
    toolIndex: 0,
    toolCalls: 0,
    pendingSignature: null,
    usage: null,
  };

  const header = () => ({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
  });
  const chunk = (delta, extra = {}) => ({
    ...header(),
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  });

  function emitCall(call, signature) {
    const id = call.id || `${call.name || 'tool'}-${Date.now()}-${state.toolIndex}`;
    if (signature) cacheSignature(id, signature);
    state.toolCalls += 1;
    return chunk({
      tool_calls: [{
        index: state.toolIndex++,
        id,
        type: 'function',
        function: { name: call.name || 'tool', arguments: JSON.stringify(call.args || {}) },
      }],
    });
  }

  return {
    push(envelope = {}) {
      const response = envelope?.response || envelope;
      if (response?.error) {
        return [{ error: { message: response.error.message || 'Antigravity API request failed.', type: 'upstream_error' } }];
      }
      const candidate = response?.candidates?.[0];
      if (!candidate) {
        if (response?.promptFeedback?.blockReason) {
          return [{ ...header(), choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }];
        }
        return [];
      }

      const frames = [];
      if (!state.started) {
        state.started = true;
        state.id = response.responseId ? `chatcmpl-${response.responseId}` : state.id;
        state.model = response.modelVersion || state.model;
        frames.push(chunk({ role: 'assistant', content: '' }));
      }

      for (const part of candidate.content?.parts || []) {
        const signature = part?.thoughtSignature || part?.thought_signature;
        if (signature) state.pendingSignature = signature;

        const text = typeof part?.text === 'string' ? part.text : '';
        const call = part?.functionCall;
        // A signature-only part belongs to the next functionCall, not to a
        // visible delta.
        if (signature && !text && !call) continue;
        if (text) {
          frames.push(chunk(part.thought === true ? { reasoning_content: text } : { content: text }));
        }
        if (call) {
          frames.push(emitCall(call, state.pendingSignature));
          state.pendingSignature = null;
        }
        const images = partImages(part);
        if (images) frames.push(chunk({ images }));
      }

      state.usage = usageFromMetadata(response.usageMetadata) || state.usage;
      if (candidate.finishReason) {
        const reason = finishReason(candidate.finishReason);
        const final = chunk({}, {});
        final.choices[0].finish_reason = reason === 'stop' && state.toolCalls > 0 ? 'tool_calls' : reason;
        if (state.usage) final.usage = state.usage;
        frames.push(final);
      }
      return frames;
    },
  };
}
