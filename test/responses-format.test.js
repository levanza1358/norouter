import assert from 'node:assert/strict';
import { fromResponsesResponse, fromResponsesStream, ResponsesFormatError, toResponsesRequest } from '../src/lib/responses-format.js';

const request = toResponsesRequest({
  model: 'gpt-codex',
  messages: [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
    { role: 'assistant', content: 'Hi.' },
  ],
  tools: [{ type: 'function', function: { name: 'lookup', description: 'Look up', parameters: { type: 'object' } } }],
  tool_choice: { type: 'function', function: { name: 'lookup' } },
  temperature: 0.2,
  top_p: 0.8,
  max_tokens: 300,
  stream: true,
});
assert.equal(request.input[0].role, 'system');
assert.equal(request.input[1].content[1].type, 'input_image');
assert.equal(request.tools[0].name, 'lookup');
assert.deepEqual(request.tool_choice, { type: 'function', name: 'lookup' });
assert.equal(request.max_output_tokens, 300);
assert.equal(request.store, false);

assert.throws(() => toResponsesRequest({ model: 'x', messages: [], n: 2 }), (err) => err instanceof ResponsesFormatError && err.status === 400 && /n/.test(err.message));
assert.throws(() => toResponsesRequest({ model: 'x', messages: [], logit_bias: {} }), /logit_bias/);

const completion = fromResponsesResponse({
  id: 'resp_1', model: 'gpt-codex', output_text: 'Done',
  usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }, output: [],
});
assert.equal(completion.choices[0].message.content, 'Done');
assert.equal(completion.usage.prompt_tokens, 4);

const toolCompletion = fromResponsesResponse({
  id: 'resp_2', model: 'gpt-codex', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' }],
});
assert.equal(toolCompletion.choices[0].message.tool_calls[0].function.name, 'lookup');

const delta = fromResponsesStream({ type: 'response.output_text.delta', item_id: 'resp_3', delta: 'Hi' });
assert.equal(delta.kind, 'delta');
assert.equal(delta.frame.choices[0].delta.content, 'Hi');
const complete = fromResponsesStream({ type: 'response.completed', response: { id: 'resp_3', model: 'gpt-codex', usage: { input_tokens: 1, output_tokens: 2 } } });
assert.equal(complete.kind, 'complete');
assert.equal(complete.frame.choices[0].finish_reason, 'stop');
const failed = fromResponsesStream({ type: 'response.failed', error: { message: 'quota', type: 'rate_limit' } });
assert.equal(failed.kind, 'error');
assert.equal(failed.frame.error.type, 'rate_limit');
assert.equal(fromResponsesStream({ type: 'response.created' }).kind, 'ignore');

console.log('responses-format pure tests passed');
