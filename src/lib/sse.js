// Minimal [OI]-style SSE reader plus an accumulator that collapses a stream
// into a single ChatCompletion. Kept dependency-free on purpose.

export async function* readSSEEvents(stream) {
  const decoder = new TextDecoder();
  let buffer = '';

  const takeLine = () => {
    const idx = buffer.indexOf('\n');
    if (idx === -1) return null;
    const line = buffer.slice(0, idx).replace(/\r$/, '');
    buffer = buffer.slice(idx + 1);
    return line;
  };

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let line;
    while ((line = takeLine()) !== null) {
      const event = parseLine(line);
      if (event === 'done') return;
      if (event) yield event;
    }
  }

  buffer += decoder.decode();
  for (const line of buffer.split('\n')) {
    const event = parseLine(line.replace(/\r$/, ''));
    if (event === 'done') return;
    if (event) yield event;
  }
}

function parseLine(line) {
  if (!line || line.startsWith(':')) return null;
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (payload === '[DONE]') return 'done';
  try {
    return { data: JSON.parse(payload) };
  } catch {
    return null;
  }
}

// Some OpenAI-compatible upstreams put `"tool_calls": []` on ordinary content
// and reasoning deltas. OpenAI-compatible SDKs test `tool_calls != null`, so an
// empty array reads as a tool-call frame: it closes the active reasoning block
// on every delta and turns one chain of thought into one "Thought" row per
// token. Strip empty arrays from any provider chunk before relaying it.
// Returns true when the chunk was changed.
export function stripEmptyToolCalls(chunk) {
  if (!Array.isArray(chunk?.choices)) return false;
  let changed = false;
  for (const choice of chunk.choices) {
    if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length === 0) {
      delete choice.delta.tool_calls;
      changed = true;
    }
  }
  return changed;
}

export function createAccumulator() {
  const state = {
    id: '',
    created: 0,
    model: '',
    content: '',
    reasoning: '',
    toolCalls: [],
    finishReason: null,
    usage: null,
    // Gateways can report failure inside the stream with a 200 status, so the
    // first error frame is kept to surface instead of an empty completion.
    error: null,
  };

  function applyDelta(delta) {
    if (!delta) return;
    if (typeof delta.content === 'string') state.content += delta.content;
    if (typeof delta.reasoning_content === 'string') {
      state.reasoning += delta.reasoning_content;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = call.index ?? state.toolCalls.length;
        if (!state.toolCalls[index]) {
          state.toolCalls[index] = {
            id: '',
            type: 'function',
            function: { name: '', arguments: '' },
          };
        }
        const slot = state.toolCalls[index];
        if (call.id) slot.id = call.id;
        if (call.type) slot.type = call.type;
        if (call.function?.name) slot.function.name += call.function.name;
        if (call.function?.arguments) slot.function.arguments += call.function.arguments;
      }
    }
  }

  return {
    state,
    feed(chunk) {
      if (!chunk) return;
      if (chunk.error && !state.error) state.error = chunk.error;
      if (chunk.id) state.id = chunk.id;
      if (chunk.created) state.created = chunk.created;
      if (chunk.model) state.model = chunk.model;
      if (chunk.usage) state.usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      applyDelta(choice.delta);
      if (choice.finish_reason) state.finishReason = choice.finish_reason;
    },
    toCompletion(fallbackModel) {
      const message = { role: 'assistant', content: state.content || null };
      if (state.reasoning) message.reasoning_content = state.reasoning;
      if (state.toolCalls.length > 0) {
        message.tool_calls = state.toolCalls.filter(Boolean);
        message.content = state.content || null;
      }
      return {
        id: state.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: state.created || Math.floor(Date.now() / 1000),
        model: state.model || fallbackModel,
        choices: [
          {
            index: 0,
            message,
            finish_reason: state.finishReason || 'stop',
          },
        ],
        usage: state.usage || undefined,
      };
    },
  };
}
