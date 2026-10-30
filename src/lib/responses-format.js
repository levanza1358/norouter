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

function inputMessage(message) {
  if (!message || typeof message !== 'object') throw new ResponsesFormatError('Messages must be objects.');
  const role = String(message.role || '');
  if (!['system', 'user', 'assistant', 'developer'].includes(role)) {
    throw new ResponsesFormatError(`Unsupported message role "${role || 'unknown'}".`);
  }
  const content = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => inputPart(part, role))
      : message.content == null ? '' : (() => { throw new ResponsesFormatError(`Message content for ${role} must be a string or array.`); })();
  const output = { role, content };
  if (Array.isArray(message.tool_calls)) {
    output.type = 'message';
    output.tool_calls = clone(message.tool_calls);
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
    input: Array.isArray(body.messages) ? body.messages.map(inputMessage) : [],
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

export function fromResponsesStream(chunk = {}) {
  if (!chunk || typeof chunk !== 'object') return { kind: 'ignore' };
  const type = chunk.type || '';
  if (type === 'response.function_call_arguments.delta') {
    return {
      kind: 'tool_delta',
      frame: {
        id: chunk.item_id || chunk.response_id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: chunk.call_id || chunk.item_id, type: 'function', function: { name: chunk.name || '', arguments: chunk.delta || '' } }] } }],
      },
    };
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
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
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
