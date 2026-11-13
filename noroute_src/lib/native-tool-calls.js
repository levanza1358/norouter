// Upstage Solar and a few other OpenAI-compatible upstreams occasionally emit
// their native tool-call tokens as plain `content` instead of structured
// `tool_calls`. A harness sees prose, runs no tool, and the turn ends early.
// Recover the call inside the relay, where the client's declared tools are
// known; anything that does not parse cleanly is relayed back unchanged.
//
// Grammar observed in the wild:
//   <|tool_callstart|>Read <|tool_orgstart|>file_path<|tool_argvalue|>C:\a.rs<|tool_argend|> <|tool_callend|>

import { randomUUID } from 'node:crypto';

const CALL_START = '<|tool_callstart|>';
const CALL_END = '<|tool_callend|>';
const ARG_START = /<\|tool_(?:org|arg)start\|>/;
const ARG_VALUE = '<|tool_argvalue|>';
const ARG_END = '<|tool_argend|>';

// True when a completion still carries the raw marker after recovery ran (an
// incomplete block or an unknown tool name). Callers use this for a log line
// naming only the provider/model; the content itself is never logged.
export function containsNativeToolMarker(text) {
  return typeof text === 'string' && text.includes(CALL_START);
}

function toolRegistry(tools) {
  const names = new Set();
  const schemas = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = tool?.function?.name;
    if (!name) continue;
    names.add(name);
    schemas.set(name, tool.function.parameters || null);
  }
  return { names, schemas };
}

function unquote(raw) {
  if (!raw.startsWith('"')) return raw;
  try {
    const value = JSON.parse(raw);
    return typeof value === 'string' ? value : raw;
  } catch {
    return raw;
  }
}

// Native token values are untyped text, so use the tool's JSON schema to turn
// numbers and booleans back into JSON values. Without a schema, only values
// that are unambiguous JSON scalars are coerced; everything else stays a
// string (paths, dates, free text).
function coerceValue(raw, property) {
  const type = property?.type;
  if (type === 'integer' || type === 'number') {
    const num = Number(raw);
    return raw !== '' && Number.isFinite(num) ? num : raw;
  }
  if (type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : raw;
  if (type === 'string') return unquote(raw);
  if (type === 'array' || type === 'object') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) return Number(raw);
  return unquote(raw);
}

function parseBlock(body, registry) {
  const match = /^\s*([A-Za-z0-9_.:-]+)/.exec(body);
  if (!match) return null;
  const name = match[1];
  const schema = registry.schemas.get(name);
  const args = {};
  let rest = body.slice(match[0].length);
  for (;;) {
    const start = rest.search(ARG_START);
    if (start === -1) break;
    rest = rest.slice(start).replace(ARG_START, '');
    const eq = rest.indexOf(ARG_VALUE);
    if (eq === -1) break;
    const key = rest.slice(0, eq).trim();
    const afterEq = rest.slice(eq + ARG_VALUE.length);
    const end = afterEq.indexOf(ARG_END);
    if (!key || end === -1) return null;
    args[key] = coerceValue(afterEq.slice(0, end).trim(), schema?.properties?.[key]);
    rest = afterEq.slice(end + ARG_END.length);
  }
  return { name, arguments: JSON.stringify(args) };
}

function newCall(index, parsed) {
  return {
    index,
    id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: parsed,
  };
}

// Longest suffix of `text` that is a prefix of `token`; that much has to stay
// buffered so a token split across chunks is still recognized.
function partialLength(text, token) {
  const max = Math.min(text.length, token.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (text.endsWith(token.slice(0, len))) return len;
  }
  return 0;
}

// Converts every complete native block in `text` into a Chat Completions tool
// call. Returns null when nothing is recoverable (no block, an unknown tool
// name, or malformed arguments) so the caller keeps the original text.
export function parseNativeToolCalls(text, tools) {
  if (typeof text !== 'string' || !text.includes(CALL_START)) return null;
  const registry = toolRegistry(tools);
  const calls = [];
  let cursor = 0;
  let leftover = '';
  for (;;) {
    const start = text.indexOf(CALL_START, cursor);
    if (start === -1) break;
    const end = text.indexOf(CALL_END, start + CALL_START.length);
    if (end === -1) return null;
    const parsed = parseBlock(text.slice(start + CALL_START.length, end), registry);
    if (!parsed) return null;
    if (registry.names.size > 0 && !registry.names.has(parsed.name)) return null;
    leftover += text.slice(cursor, start);
    calls.push(newCall(calls.length, parsed));
    cursor = end + CALL_END.length;
  }
  if (calls.length === 0) return null;
  leftover += text.slice(cursor);
  return { calls, text: leftover };
}

// Non-stream path: move recovered calls onto `message.tool_calls` and make the
// finish reason match, so a client that asked for a JSON completion also runs
// the tool. Mutates `payload`; returns true when it changed.
export function recoverNativeToolCalls(payload, tools) {
  if (!Array.isArray(payload?.choices)) return false;
  let changed = false;
  for (const choice of payload.choices) {
    const message = choice?.message;
    if (!message || typeof message.content !== 'string') continue;
    const parsed = parseNativeToolCalls(message.content, tools);
    if (!parsed) continue;
    const existing = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    message.tool_calls = [...existing, ...parsed.calls];
    message.content = parsed.text.trim() ? parsed.text : null;
    if (!choice.finish_reason || choice.finish_reason === 'stop') choice.finish_reason = 'tool_calls';
    changed = true;
  }
  return changed;
}

// Streaming path: buffers content per choice, recovers blocks as soon as the
// closing token arrives, and emits text/calls through the normal delta fields.
export function createNativeToolStream(tools) {
  const registry = toolRegistry(tools);
  const states = new Map();

  function stateFor(index) {
    if (!states.has(index)) {
      states.set(index, { mode: 'text', pending: '', raw: '', nextIndex: 0, recovered: 0 });
    }
    return states.get(index);
  }

  function push(state, content, final) {
    const text = [];
    const calls = [];
    if (state.mode === 'call') state.raw += content;
    else state.pending += content;

    for (;;) {
      if (state.mode === 'text') {
        const start = state.pending.indexOf(CALL_START);
        if (start === -1) {
          const keep = final ? 0 : partialLength(state.pending, CALL_START);
          text.push(state.pending.slice(0, state.pending.length - keep));
          state.pending = state.pending.slice(state.pending.length - keep);
          break;
        }
        text.push(state.pending.slice(0, start));
        state.raw = state.pending.slice(start);
        state.pending = '';
        state.mode = 'call';
      }

      const end = state.raw.indexOf(CALL_END);
      if (end === -1) {
        // A block can span chunks; wait for the closing token. At end of
        // stream an unterminated block is not a tool call, so relay it as text.
        if (final) {
          text.push(state.raw);
          state.raw = '';
          state.mode = 'text';
        }
        break;
      }

      const block = state.raw.slice(0, end + CALL_END.length);
      const after = state.raw.slice(end + CALL_END.length);
      const parsed = parseBlock(state.raw.slice(CALL_START.length, end), registry);
      state.raw = '';
      state.mode = 'text';
      state.pending = after;
      if (!parsed || (registry.names.size > 0 && !registry.names.has(parsed.name))) {
        text.push(block);
      } else {
        calls.push(newCall(state.nextIndex, parsed));
        state.nextIndex += 1;
        state.recovered += 1;
      }
    }

    return { text: text.join(''), calls };
  }

  return {
    apply(chunk) {
      if (!Array.isArray(chunk?.choices)) return false;
      let changed = false;
      for (const choice of chunk.choices) {
        const state = stateFor(choice.index ?? 0);
        choice.delta ||= {};
        const delta = choice.delta;
        if (typeof delta.content === 'string' && delta.content) {
          const out = push(state, delta.content, false);
          if (out.text !== delta.content) {
            if (out.text) delta.content = out.text;
            else delete delta.content;
            changed = true;
          }
          if (out.calls.length) {
            delta.tool_calls = [...(delta.tool_calls || []), ...out.calls];
            changed = true;
          }
        }
        if (choice.finish_reason) {
          const out = push(state, '', true);
          if (out.text) {
            delta.content = `${delta.content || ''}${out.text}`;
            changed = true;
          }
          if (out.calls.length) {
            delta.tool_calls = [...(delta.tool_calls || []), ...out.calls];
            changed = true;
          }
          if (state.recovered > 0 && choice.finish_reason === 'stop') {
            choice.finish_reason = 'tool_calls';
            changed = true;
          }
        }
      }
      return changed;
    },
    // Emits a final chunk only when the upstream never sent finish_reason but
    // buffered text remains; otherwise the upstream's own finish frame closed
    // every state and this returns nothing.
    finish() {
      const frames = [];
      for (const [index, state] of states) {
        const out = push(state, '', true);
        if (!out.text && out.calls.length === 0) continue;
        frames.push({
          index,
          delta: {
            ...(out.text ? { content: out.text } : {}),
            ...(out.calls.length ? { tool_calls: out.calls } : {}),
          },
          finish_reason: state.recovered > 0 ? 'tool_calls' : 'stop',
        });
      }
      return frames;
    },
  };
}
