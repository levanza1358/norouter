// Pure adapter between Chat Completions and the Anthropic Messages shape.
// Network, credentials, provider state, and SSE transport stay outside this module.

export class AnthropicFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnthropicFormatError';
    this.status = 400;
  }
}

const DEFAULT_MAX_TOKENS = 4096;

// Anthropic has no equivalent for these chat fields; failing loudly beats
// silently dropping a setting the caller expects to be honoured.
function unsupported(field, detail = '') {
  throw new AnthropicFormatError(`Anthropic Messages does not support chat field "${field}"${detail ? `: ${detail}` : '.'}`);
}

function imageBlock(part) {
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  if (typeof url !== 'string' || !url) {
    throw new AnthropicFormatError('Image content parts require a url.');
  }
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match) throw new AnthropicFormatError('Base64 image data URLs must use data:<media-type>;base64,<data>.');
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

// Anthropic takes content as blocks. Empty text blocks are dropped because the
// Messages API rejects them, and a message that ends up empty is skipped.
function contentBlocks(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw new AnthropicFormatError('Message content must be a string or an array of parts.');

  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') throw new AnthropicFormatError('Message content parts must be objects.');
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      if (typeof part.text !== 'string') throw new AnthropicFormatError('Text content parts require a string text field.');
      if (part.text) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url' || part.type === 'input_image') {
      blocks.push(imageBlock(part));
      continue;
    }
    throw new AnthropicFormatError(`Unsupported message content part "${part.type || 'unknown'}" for the Anthropic format.`);
  }
  return blocks;
}

function systemText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((part) => {
    if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') {
      return typeof part.text === 'string' ? part.text : '';
    }
    throw new AnthropicFormatError('Anthropic system messages only support text content.');
  }).filter(Boolean).join('\n\n');
}

function toolInput(argumentsValue, name) {
  if (argumentsValue == null || argumentsValue === '') return {};
  if (typeof argumentsValue === 'object') return argumentsValue;
  try {
    const parsed = JSON.parse(String(argumentsValue));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new AnthropicFormatError(`Tool call arguments for "${name}" are not valid JSON.`);
  }
}

function toolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const blocks = contentBlocks(content);
    return blocks.length ? blocks : '';
  }
  return JSON.stringify(content ?? '');
}

function requestTool(tool) {
  if (!tool || typeof tool !== 'object') throw new AnthropicFormatError('Tools must be objects.');
  if (tool.type !== 'function' || !tool.function?.name) {
    throw new AnthropicFormatError('Only function tools are supported by the Anthropic adapter.');
  }
  return {
    name: String(tool.function.name),
    description: tool.function.description,
    input_schema: tool.function.parameters || { type: 'object', properties: {} },
  };
}

function requestToolChoice(choice) {
  if (choice == null) return undefined;
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  if (typeof choice === 'object' && choice.type === 'function' && choice.function?.name) {
    return { type: 'tool', name: String(choice.function.name) };
  }
  throw new AnthropicFormatError('Unsupported tool_choice value.');
}

export function toAnthropicRequest(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AnthropicFormatError('Chat request must be an object.');
  if (!body.model || typeof body.model !== 'string') throw new AnthropicFormatError('Chat request requires a model.');
  if (body.n !== undefined && Number(body.n) !== 1) unsupported('n', 'only one response is supported');
  if (body.logit_bias !== undefined) unsupported('logit_bias');
  if (body.best_of !== undefined) unsupported('best_of');
  if (body.presence_penalty !== undefined) unsupported('presence_penalty');
  if (body.frequency_penalty !== undefined) unsupported('frequency_penalty');

  const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(Number(maxTokens)) || Number(maxTokens) <= 0) {
    throw new AnthropicFormatError('Anthropic requests require a positive integer max_tokens.');
  }

  const system = [];
  const messages = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    if (last?.role === role) {
      // Tool results must lead the user turn, even when a text part was merged
      // into the same message.
      const results = blocks.filter((block) => block.type === 'tool_result');
      const rest = blocks.filter((block) => block.type !== 'tool_result');
      last.content = role === 'user'
        ? [...results, ...last.content, ...rest]
        : [...last.content, ...rest];
      return;
    }
    messages.push({ role, content: blocks });
  };

  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const message of source) {
    if (!message || typeof message !== 'object') throw new AnthropicFormatError('Messages must be objects.');
    const role = String(message.role || '');
    if (role === 'system' || role === 'developer') {
      const text = systemText(message.content).trim();
      if (text) system.push(text);
      continue;
    }
    if (role === 'tool') {
      if (!message.tool_call_id) throw new AnthropicFormatError('Tool messages require tool_call_id.');
      push('user', [{
        type: 'tool_result',
        tool_use_id: String(message.tool_call_id),
        content: toolResultContent(message.content),
      }]);
      continue;
    }
    if (role !== 'user' && role !== 'assistant') {
      throw new AnthropicFormatError(`Unsupported message role "${role || 'unknown'}".`);
    }

    const blocks = contentBlocks(message.content);
    if (Array.isArray(message.tool_calls)) {
      if (role !== 'assistant') throw new AnthropicFormatError('tool_calls are only valid on assistant messages.');
      for (const call of message.tool_calls) {
        if (!call?.function?.name) throw new AnthropicFormatError('Tool calls require a function name.');
        blocks.push({
          type: 'tool_use',
          id: String(call.id || call.call_id || `toolu_${blocks.length}`),
          name: String(call.function.name),
          input: toolInput(call.function.arguments, call.function.name),
        });
      }
    }
    push(role, blocks);
  }

  if (!messages.length) throw new AnthropicFormatError('Anthropic requests require at least one message.');

  const output = {
    model: body.model,
    max_tokens: Number(maxTokens),
    messages,
    stream: body.stream === true,
  };
  if (system.length) output.system = system.join('\n\n');
  if (body.temperature !== undefined) output.temperature = body.temperature;
  if (body.top_p !== undefined) output.top_p = body.top_p;
  if (body.top_k !== undefined) output.top_k = body.top_k;
  if (body.stop !== undefined) output.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  if (Array.isArray(body.tools) && body.tools.length) {
    output.tools = body.tools.map(requestTool);
    const choice = requestToolChoice(body.tool_choice);
    if (choice) output.tool_choice = choice;
  }
  // reasoning_effort, stream_options, and the OpenAI-only penalties have no
  // Messages equivalent; they are intentionally not forwarded.
  return output;
}

function stopReason(value) {
  if (value === 'tool_use') return 'tool_calls';
  if (value === 'max_tokens') return 'length';
  if (value === 'refusal') return 'content_filter';
  if (value === 'end_turn' || value === 'stop_sequence' || value === 'pause_turn') return 'stop';
  return 'stop';
}

function usage(json) {
  const value = json?.usage;
  if (!value) return undefined;
  const prompt = Number(value.input_tokens ?? value.prompt_tokens ?? 0);
  const completion = Number(value.output_tokens ?? value.completion_tokens ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(value.total_tokens ?? prompt + completion),
  };
}

export function fromAnthropicResponse(json = {}) {
  if (!json || typeof json !== 'object') throw new AnthropicFormatError('Anthropic response must be an object.');
  if (json.type === 'error' || json.error) {
    throw new AnthropicFormatError(json.error?.message || 'Anthropic API returned an error.');
  }
  const blocks = Array.isArray(json.content) ? json.content : [];
  const content = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
  const thinking = blocks
    .filter((block) => block?.type === 'thinking' && typeof block.thinking === 'string')
    .map((block) => block.thinking)
    .join('');
  const toolCalls = blocks
    .filter((block) => block?.type === 'tool_use' && block.name)
    .map((block, index) => ({
      index,
      id: block.id || `toolu_${index}`,
      type: 'function',
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
    }));

  const message = { role: 'assistant', content: content || null };
  if (thinking) message.reasoning_content = thinking;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: json.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: json.model || '',
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length ? 'tool_calls' : stopReason(json.stop_reason),
    }],
    usage: usage(json),
  };
}

// ---------------------------------------------------------------------------
// Inbound Messages API: an Anthropic client is translated down to a chat body
// and its reply is rebuilt in the Messages shape. The outbound helpers above
// stay untouched; these are the inverse direction.

function inboundImage(block) {
  const source = block.source || {};
  if (source.type === 'base64') {
    if (!source.media_type || !source.data) {
      throw new AnthropicFormatError('Base64 image blocks require media_type and data.');
    }
    return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  }
  if (source.type === 'url') {
    if (typeof source.url !== 'string' || !source.url) throw new AnthropicFormatError('URL image blocks require a url.');
    return { type: 'image_url', image_url: { url: source.url } };
  }
  throw new AnthropicFormatError('Image blocks require a base64 or url source.');
}

function inboundToolResult(content) {
  if (content == null) return { text: '', images: [] };
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) throw new AnthropicFormatError('tool_result content must be a string or an array of blocks.');
  const texts = [];
  const images = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block?.type === 'image') images.push(inboundImage(block));
    else throw new AnthropicFormatError(`Unsupported tool_result content block "${block?.type || 'unknown'}".`);
  }
  return { text: texts.join(''), images };
}

function inboundTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object' || !tool.name) throw new AnthropicFormatError('Anthropic tools require a name.');
    if (tool.type && tool.type !== 'custom') {
      throw new AnthropicFormatError(`Only function tools can be forwarded to a chat upstream; "${tool.type}" is not supported.`);
    }
    return {
      type: 'function',
      function: {
        name: String(tool.name),
        description: tool.description,
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    };
  });
}

function inboundToolChoice(choice) {
  if (choice == null) return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool' && choice.name) return { type: 'function', function: { name: String(choice.name) } };
  throw new AnthropicFormatError('Unsupported tool_choice value.');
}

function inboundAssistant(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(blocks)) throw new AnthropicFormatError('Message content must be a string or an array of blocks.');
  let text = '';
  const toolCalls = [];
  for (const block of blocks) {
    if (block?.type === 'text') {
      if (typeof block.text !== 'string') throw new AnthropicFormatError('Text blocks require a string text field.');
      text += block.text;
      continue;
    }
    if (block?.type === 'tool_use') {
      if (!block.name) throw new AnthropicFormatError('tool_use blocks require a name.');
      toolCalls.push({
        id: String(block.id || `toolu_${toolCalls.length}`),
        type: 'function',
        function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) },
      });
      continue;
    }
    // Thinking and server-side tool blocks cannot be replayed through a chat
    // upstream; dropping them keeps the visible conversation intact.
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') continue;
    throw new AnthropicFormatError(`Unsupported assistant content block "${block?.type || 'unknown'}".`);
  }
  if (!text && !toolCalls.length) return null;
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return message;
}

export function fromAnthropicRequest(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AnthropicFormatError('Anthropic request must be an object.');
  if (!body.model || typeof body.model !== 'string') throw new AnthropicFormatError('Anthropic requests require a model.');
  const source = Array.isArray(body.messages) ? body.messages : [];
  if (!source.length) throw new AnthropicFormatError('Anthropic requests require at least one message.');

  const maxTokens = body.max_tokens ?? DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(Number(maxTokens)) || Number(maxTokens) <= 0) {
    throw new AnthropicFormatError('Anthropic requests require a positive integer max_tokens.');
  }

  const messages = [];
  const system = systemText(body.system).trim();
  if (system) messages.push({ role: 'system', content: system });

  for (const message of source) {
    if (!message || typeof message !== 'object') throw new AnthropicFormatError('Messages must be objects.');
    const role = String(message.role || '');
    if (role === 'assistant') {
      const converted = inboundAssistant(message.content);
      if (converted) messages.push(converted);
      continue;
    }
    if (role !== 'user') throw new AnthropicFormatError(`Unsupported message role "${role || 'unknown'}".`);

    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(blocks)) throw new AnthropicFormatError('Message content must be a string or an array of blocks.');
    const parts = [];
    const toolMessages = [];
    const toolImages = [];
    for (const block of blocks) {
      if (block?.type === 'text') {
        if (typeof block.text !== 'string') throw new AnthropicFormatError('Text blocks require a string text field.');
        if (block.text) parts.push({ type: 'text', text: block.text });
        continue;
      }
      if (block?.type === 'image') {
        parts.push(inboundImage(block));
        continue;
      }
      if (block?.type === 'tool_result') {
        if (!block.tool_use_id) throw new AnthropicFormatError('tool_result blocks require tool_use_id.');
        const result = inboundToolResult(block.content);
        toolMessages.push({ role: 'tool', tool_call_id: String(block.tool_use_id), content: result.text });
        toolImages.push(...result.images);
        continue;
      }
      throw new AnthropicFormatError(`Unsupported user content block "${block?.type || 'unknown'}".`);
    }
    // Tool results must directly follow the assistant tool_calls turn, so they
    // go before any text that shared the same Anthropic message.
    messages.push(...toolMessages);
    if (toolImages.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'Tool result images:' }, ...toolImages] });
    if (parts.length) messages.push({ role: 'user', content: parts });
  }

  const output = {
    model: body.model,
    messages,
    max_tokens: Number(maxTokens),
    stream: body.stream === true,
  };
  if (body.temperature !== undefined) output.temperature = body.temperature;
  if (body.top_p !== undefined) output.top_p = body.top_p;
  if (body.stop_sequences !== undefined) output.stop = body.stop_sequences;
  const tools = inboundTools(body.tools);
  if (tools) {
    output.tools = tools;
    const choice = inboundToolChoice(body.tool_choice);
    if (choice) output.tool_choice = choice;
  }
  return output;
}

function outStopReason(finishReason, hasTools) {
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'content_filter') return 'refusal';
  if (finishReason === 'tool_calls' || (hasTools && !finishReason)) return 'tool_use';
  return 'end_turn';
}

function outUsage(value) {
  if (!value || typeof value !== 'object') return undefined;
  const input = Number(value.input_tokens ?? value.prompt_tokens ?? 0);
  const output = Number(value.output_tokens ?? value.completion_tokens ?? 0);
  return {
    input_tokens: Number.isFinite(input) ? input : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
  };
}

function outMessageId() {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function toAnthropicResponse(json = {}) {
  if (!json || typeof json !== 'object') throw new AnthropicFormatError('Chat response must be an object.');
  if (json.error) throw new AnthropicFormatError(json.error.message || 'Chat upstream returned an error.');
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  if (!choice) throw new AnthropicFormatError('Chat response has no choices.');

  const message = choice.message || {};
  const content = [];
  if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (!call?.function?.name) continue;
    content.push({
      type: 'tool_use',
      id: String(call.id || `toolu_${content.length}`),
      name: String(call.function.name),
      input: toolInput(call.function.arguments, call.function.name),
    });
  }

  return {
    id: outMessageId(),
    type: 'message',
    role: 'assistant',
    model: json.model || '',
    content,
    stop_reason: outStopReason(choice.finish_reason, content.some((block) => block.type === 'tool_use')),
    stop_sequence: null,
    usage: outUsage(json.usage) || { input_tokens: 0, output_tokens: 0 },
  };
}

export function createAnthropicOutState() {
  return {
    id: outMessageId(),
    model: '',
    started: false,
    nextIndex: 0,
    open: null,
    text: '',
    usage: undefined,
    finishReason: null,
    tools: new Map(),
    completed: false,
    failed: false,
  };
}

function outEnvelope(state, stopReason, usage) {
  return {
    id: state.id,
    type: 'message',
    role: 'assistant',
    model: state.model || '',
    content: [],
    stop_reason: stopReason ?? null,
    stop_sequence: null,
    usage,
  };
}

function outStart(state) {
  if (state.started) return [];
  state.started = true;
  return [{ type: 'message_start', message: outEnvelope(state, null, outUsage(state.usage) || { input_tokens: 0, output_tokens: 0 }) }];
}

function outCloseOpen(state) {
  if (!state.open) return [];
  const index = state.open.index;
  state.open = null;
  return [{ type: 'content_block_stop', index }];
}

function outOpenBlock(state, type) {
  const events = outCloseOpen(state);
  const index = state.nextIndex++;
  state.open = { type, index };
  if (type === 'thinking') {
    events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
  } else {
    events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
  }
  return events;
}

export function toAnthropicStream(chunk = {}, state = createAnthropicOutState()) {
  if (!chunk || typeof chunk !== 'object' || state.completed || state.failed) return [];
  if (chunk.error) return anthropicStreamFailure(state, chunk.error);
  if (typeof chunk.model === 'string' && chunk.model && !state.model) state.model = chunk.model;
  if (chunk.usage) state.usage = chunk.usage;
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!choice) return [];
  if (choice.finish_reason) state.finishReason = choice.finish_reason;
  const delta = choice.delta || choice.message || {};
  const events = outStart(state);

  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
    if (!state.open || state.open.type !== 'thinking') events.push(...outOpenBlock(state, 'thinking'));
    events.push({ type: 'content_block_delta', index: state.open.index, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } });
  }
  if (typeof delta.content === 'string' && delta.content) {
    if (!state.open || state.open.type !== 'text') events.push(...outOpenBlock(state, 'text'));
    state.text += delta.content;
    events.push({ type: 'content_block_delta', index: state.open.index, delta: { type: 'text_delta', text: delta.content } });
  }
  for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    const key = Number.isInteger(call.index) ? call.index : 0;
    let tool = state.tools.get(key);
    if (!tool) {
      tool = { id: String(call.id || `toolu_${state.tools.size}`), name: '', arguments: '' };
      state.tools.set(key, tool);
    }
    if (!tool.name && typeof call.function?.name === 'string' && call.function.name) tool.name = call.function.name;
    if (typeof call.function?.arguments === 'string') tool.arguments += call.function.arguments;
  }
  return events;
}

export function anthropicStreamFailure(state, error = {}) {
  if (state.completed || state.failed) return [];
  state.failed = true;
  const message = typeof error === 'string' ? error : error?.message || 'Upstream request failed.';
  const type = error?.type === 'rate_limit' || error?.type === 'rate_limit_error' ? 'rate_limit_error' : 'api_error';
  return [
    ...outStart(state),
    { type: 'error', error: { type, message } },
  ];
}

export function closeAnthropicStream(state) {
  if (state.completed || state.failed) return [];
  state.completed = true;
  const events = outStart(state);
  events.push(...outCloseOpen(state));

  // Chat tool calls may interleave, but Anthropic content blocks are
  // sequential; emitting complete blocks keeps the stream valid.
  const tools = [...state.tools.values()].filter((tool) => tool.name);
  for (const tool of tools) {
    const index = state.nextIndex++;
    events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
    if (tool.arguments) {
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: tool.arguments } });
    }
    events.push({ type: 'content_block_stop', index });
  }

  const usage = outUsage(state.usage) || { input_tokens: 0, output_tokens: 0 };
  events.push({
    type: 'message_delta',
    delta: { stop_reason: outStopReason(state.finishReason, tools.length > 0), stop_sequence: null },
    usage,
  });
  events.push({ type: 'message_stop' });
  return events;
}

// Anthropic emits a fixed event sequence (message_start, content blocks,
// message_delta, message_stop), so the translation needs state across pulls.
// push() returns zero or more ChatCompletion chunks for one parsed event.
export function createAnthropicStream() {
  const state = {
    id: `chatcmpl-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: '',
    inputTokens: 0,
    outputTokens: 0,
    finishReason: null,
    toolIndexes: new Map(),
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

  return {
    push(event = {}) {
      switch (event.type) {
        case 'message_start': {
          state.id = event.message?.id || state.id;
          state.model = event.message?.model || state.model;
          state.inputTokens = Number(event.message?.usage?.input_tokens) || 0;
          return [chunk({ role: 'assistant', content: '' })];
        }
        case 'content_block_start': {
          const block = event.content_block || {};
          if (block.type !== 'tool_use') return [];
          const index = state.toolIndexes.size;
          state.toolIndexes.set(event.index, index);
          return [chunk({
            tool_calls: [{
              index,
              id: block.id || `toolu_${index}`,
              type: 'function',
              function: { name: block.name || '', arguments: '' },
            }],
          })];
        }
        case 'content_block_delta': {
          const delta = event.delta || {};
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            return [chunk({ content: delta.text })];
          }
          if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            return [chunk({ reasoning_content: delta.thinking })];
          }
          if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const index = state.toolIndexes.get(event.index) ?? 0;
            return [chunk({ tool_calls: [{ index, function: { arguments: delta.partial_json } }] })];
          }
          return [];
        }
        case 'message_delta': {
          state.outputTokens = Number(event.usage?.output_tokens) || state.outputTokens;
          if (event.delta?.stop_reason) state.finishReason = stopReason(event.delta.stop_reason);
          return [{
            ...header(),
            choices: [{ index: 0, delta: {}, finish_reason: state.finishReason || 'stop' }],
            usage: {
              prompt_tokens: state.inputTokens,
              completion_tokens: state.outputTokens,
              total_tokens: state.inputTokens + state.outputTokens,
            },
          }];
        }
        case 'error': {
          const error = event.error || {};
          return [{
            error: {
              message: error.message || 'Anthropic API request failed.',
              type: error.type || 'upstream_error',
            },
          }];
        }
        default:
          return [];
      }
    },
  };
}
