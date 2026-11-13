// Pure adapter between Chat Completions and the OpenAI Responses shape.
// Network, credentials, provider state, and SSE transport stay outside this module.

export class ResponsesFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResponsesFormatError';
    this.status = 400;
  }
}

function unsupported(field, detail = '') {
  throw new ResponsesFormatError(`Responses API does not support chat field "${field}" safely${detail ? `: ${detail}` : '.'}`);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function inputPart(part, role) {
  if (!part || typeof part !== 'object') {
    throw new ResponsesFormatError('Message content parts must be objects.');
  }
  if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
    if (typeof part.text !== 'string') throw new ResponsesFormatError('Text content parts require a string text field.');
    return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
  }
  if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
    return { type: 'input_image', image_url: part.image_url.url };
  }
  if (part.type === 'input_image' && typeof part.image_url === 'string') return clone(part);
  if (part.type === 'audio' || part.type === 'input_audio') return clone(part);
  throw new ResponsesFormatError(`Unsupported message content part "${part.type || 'unknown'}".`);
}

function messageContent(message, role) {
  return typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => inputPart(part, role))
      : message.content == null ? '' : (() => { throw new ResponsesFormatError(`Message content for ${role} must be a string or array.`); })();
}

function inputMessage(message) {
  if (!message || typeof message !== 'object') throw new ResponsesFormatError('Messages must be objects.');
  const role = String(message.role || '');
  if (role === 'tool') {
    if (!message.tool_call_id) throw new ResponsesFormatError('Tool messages require tool_call_id.');
    return {
      type: 'function_call_output',
      call_id: String(message.tool_call_id),
      output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
    };
  }
  if (!['system', 'user', 'assistant', 'developer'].includes(role)) {
    throw new ResponsesFormatError(`Unsupported message role "${role || 'unknown'}".`);
  }
  const content = messageContent(message, role);
  const output = { role, content };
  if (Array.isArray(message.tool_calls)) {
    if (role !== 'assistant') throw new ResponsesFormatError('tool_calls are only valid on assistant messages.');
    const items = [];
    if (content) items.push(output);
    for (const toolCall of message.tool_calls) {
      if (!toolCall?.function?.name) throw new ResponsesFormatError('Tool calls require a function name.');
      items.push({
        type: 'function_call',
        call_id: String(toolCall.id || toolCall.call_id || ''),
        name: String(toolCall.function.name),
        arguments: typeof toolCall.function.arguments === 'string'
          ? toolCall.function.arguments
          : JSON.stringify(toolCall.function.arguments ?? {}),
      });
    }
    return items;
  }
  return output;
}

function responseTool(tool) {
  if (!tool || typeof tool !== 'object') throw new ResponsesFormatError('Tools must be objects.');
  if (tool.type !== 'function' || !tool.function?.name) {
    throw new ResponsesFormatError('Only function tools are supported by the Responses adapter.');
  }
  return {
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: clone(tool.function.parameters || {}),
    strict: tool.function.strict,
  };
}

function responseToolChoice(choice) {
  if (choice == null || choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (typeof choice === 'object' && choice.type === 'function' && choice.function?.name) {
    return { type: 'function', name: choice.function.name };
  }
  throw new ResponsesFormatError('Unsupported tool_choice value.');
}

export function toResponsesRequest(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ResponsesFormatError('Chat request must be an object.');
  if (body.n !== undefined && Number(body.n) !== 1) unsupported('n', 'only one response is supported');
  if (body.logit_bias !== undefined) unsupported('logit_bias');
  if (body.best_of !== undefined) unsupported('best_of');
  if (body.presence_penalty !== undefined) unsupported('presence_penalty');
  if (body.frequency_penalty !== undefined) unsupported('frequency_penalty');

  const output = {
    model: body.model,
    input: Array.isArray(body.messages) ? body.messages.flatMap(inputMessage) : [],
    stream: body.stream === true,
    // Codex requires non-persistent Responses requests.
    store: false,
  };
  if (!output.model || typeof output.model !== 'string') throw new ResponsesFormatError('Chat request requires a model.');
  if (body.tools !== undefined) output.tools = body.tools.map(responseTool);
  if (body.tool_choice !== undefined) output.tool_choice = responseToolChoice(body.tool_choice);
  if (body.temperature !== undefined) output.temperature = body.temperature;
  if (body.top_p !== undefined) output.top_p = body.top_p;
  if (body.max_tokens !== undefined) output.max_output_tokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined) output.max_output_tokens = body.max_completion_tokens;
  if (body.reasoning_effort !== undefined) output.reasoning = { effort: body.reasoning_effort };
  return output;
}

function outputText(json) {
  if (typeof json?.output_text === 'string') return json.output_text;
  const output = Array.isArray(json?.output) ? json.output : [];
  return output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text).join('');
}

function outputTools(json) {
  const output = Array.isArray(json?.output) ? json.output : [];
  return output.filter((item) => item?.type === 'function_call' && item.name).map((item, index) => ({
    index,
    id: item.call_id || item.id,
    type: 'function',
    function: { name: item.name, arguments: item.arguments || '' },
  }));
}

function usage(json) {
  const value = json?.usage;
  if (!value) return undefined;
  return {
    prompt_tokens: Number(value.input_tokens ?? value.prompt_tokens ?? 0),
    completion_tokens: Number(value.output_tokens ?? value.completion_tokens ?? 0),
    total_tokens: Number(value.total_tokens ?? ((value.input_tokens || 0) + (value.output_tokens || 0))),
  };
}

export function fromResponsesResponse(json = {}) {
  if (!json || typeof json !== 'object') throw new ResponsesFormatError('Responses response must be an object.');
  if (json.error) throw new ResponsesFormatError(json.error.message || 'Responses API returned an error.');
  const content = outputText(json);
  const toolCalls = outputTools(json);
  if (!content && !toolCalls.length && !Array.isArray(json.output)) {
    throw new ResponsesFormatError('Responses response has no recognized output.');
  }
  const message = { role: 'assistant', content: content || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: json.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: json.created_at || Math.floor(Date.now() / 1000),
    model: json.model || '',
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: usage(json),
  };
}

// Responses announces a function call on `output_item` events and then streams
// only its arguments, so a Chat Completions client needs the name captured from
// the item and replayed once. Codex sends the whole argument string on
// `output_item.done` rather than as delta events, and can emit two calls in one
// response, so each item keeps its own id, index and argument state. The state
// lives next to the accumulator, one per request.
export function createResponsesStreamState() {
  return { items: new Map() };
}

function streamItem(chunk, state) {
  const key = String(chunk.item_id || chunk.item?.id || chunk.call_id || chunk.item?.call_id || chunk.output_index || '');
  if (!state.items.has(key)) {
    state.items.set(key, {
      id: chunk.call_id || chunk.item?.call_id || chunk.item_id || chunk.item?.id || chunk.response_id || '',
      index: Number.isInteger(chunk.output_index) ? chunk.output_index : state.items.size,
      name: '',
      emitted: false,
      arguments: '',
      argsStreamed: false,
    });
  }
  return { key, item: state.items.get(key) };
}

function toolDelta(item, name, args) {
  return {
    kind: 'tool_delta',
    frame: {
      id: item.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { tool_calls: [{ index: item.index, id: item.id, type: 'function', function: { name, arguments: args } }] } }],
    },
  };
}

function hasFunctionCall(response) {
  return Array.isArray(response?.output) && response.output.some((item) => item?.type === 'function_call' && item.name);
}

export function fromResponsesStream(chunk = {}, state = createResponsesStreamState()) {
  if (!chunk || typeof chunk !== 'object') return { kind: 'ignore' };
  const type = chunk.type || '';
  if (type === 'response.output_item.added' && chunk.item?.type === 'function_call' && chunk.item.name) {
    const { item } = streamItem(chunk, state);
    item.name = chunk.item.name;
    item.emitted = true;
    return toolDelta(item, item.name, '');
  }
  if (type === 'response.output_item.done' && chunk.item?.type === 'function_call') {
    const { item } = streamItem(chunk, state);
    const name = item.emitted ? '' : chunk.item.name || '';
    if (name) {
      item.name = name;
      item.emitted = true;
    }
    // Codex may deliver the complete arguments here, with no delta events.
    const args = !item.argsStreamed && !item.arguments ? chunk.item.arguments || '' : '';
    if (args) {
      item.arguments = args;
      item.argsStreamed = true;
    }
    if (!name && !args) return { kind: 'ignore' };
    return toolDelta(item, name, args);
  }
  if (type === 'response.function_call_arguments.delta') {
    const { item } = streamItem(chunk, state);
    item.arguments += chunk.delta || '';
    item.argsStreamed = true;
    const name = item.name && !item.emitted ? item.name : '';
    if (name) item.emitted = true;
    return toolDelta(item, name, chunk.delta || '');
  }
  if (type === 'response.function_call_arguments.done') {
    const { item } = streamItem(chunk, state);
    const name = item.name && !item.emitted ? item.name : '';
    if (name) item.emitted = true;
    const args = !item.argsStreamed && chunk.arguments ? chunk.arguments : '';
    if (args) {
      item.arguments = args;
      item.argsStreamed = true;
    }
    if (!name && !args) return { kind: 'ignore' };
    return toolDelta(item, name, args);
  }
  if (type === 'response.output_text.delta') {
    return {
      kind: 'delta',
      frame: {
        id: chunk.item_id || chunk.response_id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: chunk.delta || '' } }],
      },
    };
  }
  if (type === 'response.completed') {
    const response = chunk.response || chunk;
    return {
      kind: 'complete',
      frame: {
        id: response.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        model: response.model,
        choices: [{ index: 0, delta: {}, finish_reason: hasFunctionCall(response) || state.items.size ? 'tool_calls' : 'stop' }],
        usage: usage(response),
      },
    };
  }
  if (type === 'response.failed') {
    const error = chunk.error || chunk.response?.error || { message: 'Responses API request failed.', type: 'upstream_error' };
    return { kind: 'error', frame: { error: { message: error.message || 'Responses API request failed.', type: error.type || 'upstream_error' } } };
  }
  return { kind: 'ignore' };
}

// ---------------------------------------------------------------------------
// Inbound Responses: a Responses client in front of the Chat Completions core.
// The request is converted down to chat messages and the reply is rebuilt up
// from chat chunks, so routing, pooling, fallback and vision stay in one place.
// ---------------------------------------------------------------------------

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function chatRequestPart(part) {
  if (!part || typeof part !== 'object') throw new ResponsesFormatError('Message content parts must be objects.');
  if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
    if (typeof part.text !== 'string') throw new ResponsesFormatError('Text content parts require a string text field.');
    return { type: 'text', text: part.text };
  }
  if (part.type === 'refusal') {
    return { type: 'text', text: typeof part.refusal === 'string' ? part.refusal : '' };
  }
  if (part.type === 'input_image') {
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    if (!url) throw new ResponsesFormatError('Image parts require an image_url; file uploads are not supported.');
    return { type: 'image_url', image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } };
  }
  throw new ResponsesFormatError(`Unsupported content part "${part.type || 'unknown'}".`);
}

function chatContent(content, role) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) throw new ResponsesFormatError(`Message content for ${role || 'message'} must be a string or array.`);
  const parts = content.map(chatRequestPart);
  // Chat upstreams accept a plain string everywhere; keep the structured array
  // only when it carries an image part, which cannot be flattened.
  if (parts.some((part) => part.type === 'image_url')) return parts;
  return parts.map((part) => part.text).join('\n');
}

function chatArguments(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {});
}

function chatToolOutput(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((part) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part ?? null))).join('\n');
  }
  return JSON.stringify(output ?? '');
}

function chatTool(tool) {
  if (!tool || typeof tool !== 'object') throw new ResponsesFormatError('Tools must be objects.');
  const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool;
  const type = fn.type || 'function';
  if (type !== 'function' || !fn.name) {
    throw new ResponsesFormatError(`Only function tools can be forwarded to a chat upstream; "${type}" is not supported.`);
  }
  const output = {
    type: 'function',
    function: {
      name: String(fn.name),
      parameters: clone(fn.parameters || { type: 'object', properties: {} }),
    },
  };
  if (fn.description !== undefined) output.function.description = String(fn.description);
  if (fn.strict !== undefined) output.function.strict = fn.strict === true;
  return output;
}

function chatToolChoice(choice) {
  if (choice == null) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (typeof choice === 'object') {
    const name = choice.name || choice.function?.name;
    if (choice.type === 'function' && name) return { type: 'function', function: { name: String(name) } };
  }
  throw new ResponsesFormatError('Unsupported tool_choice value.');
}

function chatResponseFormat(format) {
  if (!format || typeof format !== 'object' || format.type === 'text') return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema' && format.schema) {
    const jsonSchema = { name: format.name || 'response', schema: clone(format.schema) };
    if (format.strict !== undefined) jsonSchema.strict = format.strict === true;
    return { type: 'json_schema', json_schema: jsonSchema };
  }
  throw new ResponsesFormatError(`Unsupported text format "${format.type || 'unknown'}".`);
}

function appendInputItem(item, messages) {
  if (typeof item === 'string') {
    messages.push({ role: 'user', content: item });
    return;
  }
  if (!item || typeof item !== 'object') throw new ResponsesFormatError('Input items must be objects.');
  const type = item.type || (item.role ? 'message' : '');
  if (type === 'message') {
    const role = String(item.role || 'user');
    if (!['user', 'assistant', 'system', 'developer'].includes(role)) {
      throw new ResponsesFormatError(`Unsupported message role "${role}".`);
    }
    messages.push({ role: role === 'developer' ? 'system' : role, content: chatContent(item.content, role) });
    return;
  }
  if (type === 'function_call') {
    if (!item.name) throw new ResponsesFormatError('Function call items require a name.');
    const call = {
      id: String(item.call_id || item.id || newId('call')),
      type: 'function',
      function: { name: String(item.name), arguments: chatArguments(item.arguments) },
    };
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && Array.isArray(last.tool_calls)) last.tool_calls.push(call);
    else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    return;
  }
  if (type === 'function_call_output') {
    if (!item.call_id) throw new ResponsesFormatError('function_call_output items require a call_id.');
    messages.push({ role: 'tool', tool_call_id: String(item.call_id), content: chatToolOutput(item.output) });
    return;
  }
  // Reasoning items hold provider-private state that chat completions cannot
  // replay, and item references point at stored responses this router never keeps.
  if (type === 'reasoning' || type === 'item_reference') return;
  throw new ResponsesFormatError(`Unsupported input item type "${type || 'unknown'}".`);
}

export function fromResponsesRequest(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ResponsesFormatError('Responses request must be an object.');
  if (typeof body.model !== 'string' || !body.model.trim()) throw new ResponsesFormatError('Responses request requires a model.');
  if (body.previous_response_id) {
    throw new ResponsesFormatError('previous_response_id is not supported; send the full conversation in input each turn.');
  }
  if (body.input === undefined || body.input === null || body.input === '') throw new ResponsesFormatError('Responses request requires input.');

  const messages = [];
  if (typeof body.instructions === 'string') {
    if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  } else if (Array.isArray(body.instructions)) {
    messages.push({ role: 'system', content: chatContent(body.instructions, 'system') });
  } else if (body.instructions != null) {
    throw new ResponsesFormatError('instructions must be a string or array.');
  }

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    if (!body.input.length) throw new ResponsesFormatError('Responses request requires input.');
    for (const item of body.input) appendInputItem(item, messages);
  } else {
    throw new ResponsesFormatError('input must be a string or an array of items.');
  }

  const output = { model: body.model.trim(), messages };
  if (body.stream === true) output.stream = true;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new ResponsesFormatError('tools must be an array.');
    if (body.tools.length) output.tools = body.tools.map(chatTool);
  }
  const toolChoice = chatToolChoice(body.tool_choice);
  if (toolChoice !== undefined) output.tool_choice = toolChoice;
  if (body.parallel_tool_calls !== undefined) output.parallel_tool_calls = body.parallel_tool_calls === true;
  if (body.temperature !== undefined) output.temperature = body.temperature;
  if (body.top_p !== undefined) output.top_p = body.top_p;
  const maxTokens = body.max_output_tokens !== undefined ? body.max_output_tokens : body.max_tokens;
  if (maxTokens !== undefined) output.max_tokens = maxTokens;
  if (body.reasoning?.effort !== undefined) output.reasoning_effort = body.reasoning.effort;
  const format = chatResponseFormat(body.text?.format);
  if (format) output.response_format = format;
  return output;
}

export function createResponsesOutState() {
  return {
    id: newId('resp'),
    createdAt: Math.floor(Date.now() / 1000),
    model: '',
    started: false,
    nextIndex: 0,
    message: { id: newId('msg'), index: null, open: false },
    text: '',
    tools: new Map(),
    usage: undefined,
    finishReason: null,
    completed: false,
    failed: false,
  };
}

function responseEnvelope(state, status, output, extra = {}) {
  return {
    id: state.id,
    object: 'response',
    created_at: state.createdAt,
    status,
    model: state.model || '',
    output,
    ...extra,
  };
}

function createdEvents(state) {
  if (state.started) return [];
  state.started = true;
  return [{ type: 'response.created', response: responseEnvelope(state, 'in_progress', []) }];
}

function responsesUsage(value) {
  if (!value || typeof value !== 'object') return undefined;
  const input = finite(value.prompt_tokens ?? value.input_tokens);
  const output = finite(value.completion_tokens ?? value.output_tokens);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: finite(value.prompt_tokens_details?.cached_tokens ?? value.input_tokens_details?.cached_tokens) },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: finite(value.completion_tokens_details?.reasoning_tokens ?? value.output_tokens_details?.reasoning_tokens) },
    total_tokens: finite(value.total_tokens, input + output),
  };
}

function toolState(state, call) {
  const index = Number.isInteger(call.index) ? call.index : 0;
  let tool = state.tools.get(index);
  if (!tool) {
    tool = { index: null, id: newId('fc'), callId: '', name: '', arguments: '', announced: false };
    state.tools.set(index, tool);
  }
  if (!tool.callId && typeof call.id === 'string' && call.id) tool.callId = call.id;
  const name = call.function?.name;
  if (!tool.name && typeof name === 'string' && name) tool.name = name;
  return tool;
}

function announceTool(state, tool) {
  tool.index = state.nextIndex++;
  tool.announced = true;
  return {
    type: 'response.output_item.added',
    output_index: tool.index,
    item: {
      id: tool.id,
      type: 'function_call',
      status: 'in_progress',
      call_id: tool.callId || tool.id,
      name: tool.name || '',
      arguments: '',
    },
  };
}

function functionCallItem(tool) {
  return {
    id: tool.id,
    type: 'function_call',
    status: 'completed',
    call_id: tool.callId || tool.id,
    name: tool.name || '',
    arguments: tool.arguments || '{}',
  };
}

function messageItem(state) {
  return {
    id: state.message.id,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: state.text, annotations: [] }],
  };
}

function messageEvents(state, delta) {
  const events = [];
  if (!state.message.open) {
    state.message.index = state.nextIndex++;
    state.message.open = true;
    events.push({
      type: 'response.output_item.added',
      output_index: state.message.index,
      item: { id: state.message.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    });
    events.push({
      type: 'response.content_part.added',
      item_id: state.message.id,
      output_index: state.message.index,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }
  state.text += delta;
  events.push({
    type: 'response.output_text.delta',
    item_id: state.message.id,
    output_index: state.message.index,
    content_index: 0,
    delta,
  });
  return events;
}

function streamToolEvents(state, call) {
  const tool = toolState(state, call);
  const fragment = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
  const events = [];
  if (!tool.announced) {
    // The item cannot be announced without a name; keep the leading argument
    // fragments until the provider names the call.
    if (!tool.name) {
      tool.arguments += fragment;
      return events;
    }
    events.push(announceTool(state, tool));
    if (tool.arguments || fragment) {
      tool.arguments += fragment;
      events.push({ type: 'response.function_call_arguments.delta', item_id: tool.id, output_index: tool.index, delta: tool.arguments });
    }
    return events;
  }
  if (fragment) {
    tool.arguments += fragment;
    events.push({ type: 'response.function_call_arguments.delta', item_id: tool.id, output_index: tool.index, delta: fragment });
  }
  return events;
}

export function toResponsesStream(chunk = {}, state = createResponsesOutState()) {
  if (!chunk || typeof chunk !== 'object' || state.completed || state.failed) return [];
  if (chunk.error) return responsesStreamFailure(state, chunk.error);
  if (typeof chunk.model === 'string' && chunk.model && !state.model) state.model = chunk.model;
  if (chunk.usage) state.usage = chunk.usage;
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!choice) return [];
  if (choice.finish_reason) state.finishReason = choice.finish_reason;
  const delta = choice.delta || choice.message || {};
  const events = createdEvents(state);
  if (typeof delta.content === 'string' && delta.content) events.push(...messageEvents(state, delta.content));
  for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    events.push(...streamToolEvents(state, call));
  }
  return events;
}

export function responsesStreamFailure(state, error = {}) {
  if (state.completed || state.failed) return [];
  state.failed = true;
  const message = typeof error === 'string' ? error : error?.message || 'Upstream request failed.';
  const payload = { message, type: error?.type || 'upstream_error' };
  if (error?.code) payload.code = String(error.code);
  const events = createdEvents(state);
  events.push({ type: 'response.failed', error: payload, response: responseEnvelope(state, 'failed', [], { error: payload }) });
  return events;
}

export function closeResponsesStream(state) {
  if (state.completed || state.failed) return [];
  state.completed = true;
  const events = createdEvents(state);
  const output = [];

  if (state.message.open) {
    const part = { type: 'output_text', text: state.text, annotations: [] };
    events.push({ type: 'response.output_text.done', item_id: state.message.id, output_index: state.message.index, content_index: 0, text: state.text });
    events.push({ type: 'response.content_part.done', item_id: state.message.id, output_index: state.message.index, content_index: 0, part });
    events.push({ type: 'response.output_item.done', output_index: state.message.index, item: messageItem(state) });
    output.push({ index: state.message.index, item: messageItem(state) });
  }

  const tools = [...state.tools.values()].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  for (const tool of tools) {
    if (!tool.announced) {
      events.push(announceTool(state, tool));
      if (tool.arguments) events.push({ type: 'response.function_call_arguments.delta', item_id: tool.id, output_index: tool.index, delta: tool.arguments });
    }
    const item = functionCallItem(tool);
    events.push({ type: 'response.function_call_arguments.done', item_id: tool.id, output_index: tool.index, arguments: item.arguments });
    events.push({ type: 'response.output_item.done', output_index: tool.index, item });
    output.push({ index: tool.index, item });
  }

  output.sort((left, right) => left.index - right.index);
  const truncated = state.finishReason === 'length' || state.finishReason === 'content_filter';
  const extra = {};
  const mappedUsage = responsesUsage(state.usage);
  if (mappedUsage) extra.usage = mappedUsage;
  if (truncated) extra.incomplete_details = { reason: state.finishReason === 'length' ? 'max_output_tokens' : 'content_filter' };
  // `response.completed` stays the terminal event even when the status is
  // `incomplete`: clients treat it as "stream over" and read the status.
  events.push({
    type: 'response.completed',
    response: responseEnvelope(state, truncated ? 'incomplete' : 'completed', output.map((entry) => entry.item), extra),
  });
  return events;
}

export function toResponsesResponse(json = {}) {
  if (!json || typeof json !== 'object') throw new ResponsesFormatError('Chat response must be an object.');
  if (json.error) throw new ResponsesFormatError(json.error.message || 'Chat upstream returned an error.');
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  if (!choice) throw new ResponsesFormatError('Chat response has no choices.');

  const message = choice.message || {};
  const state = createResponsesOutState();
  if (Number.isFinite(Number(json.created))) state.createdAt = Number(json.created);
  state.model = typeof json.model === 'string' ? json.model : '';
  const output = [];
  const text = typeof message.content === 'string' ? message.content : '';
  if (text) {
    output.push({
      id: newId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    output.push({
      id: newId('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: String(call.id || newId('call')),
      name: String(call.function?.name || ''),
      arguments: chatArguments(call.function?.arguments),
    });
  }

  const truncated = choice.finish_reason === 'length' || choice.finish_reason === 'content_filter';
  const extra = {};
  const mappedUsage = responsesUsage(json.usage);
  if (mappedUsage) extra.usage = mappedUsage;
  if (truncated) extra.incomplete_details = { reason: choice.finish_reason === 'length' ? 'max_output_tokens' : 'content_filter' };
  return responseEnvelope(state, truncated ? 'incomplete' : 'completed', output, extra);
}
