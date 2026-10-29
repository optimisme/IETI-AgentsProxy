const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const request = require('supertest');

let app;
let db;
let mockServer;
let keyService;
let lastChatPayload;

const REASONING = 'The user wants a short answer.';

function lastUserText(payload) {
  const user = [...(payload.messages || [])].reverse().find((message) => message.role === 'user' || message.role === 'tool');
  return typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content || '');
}

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
}

test.before(async () => {
  mockServer = http.createServer((req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      lastChatPayload = payload;
      const wantsTool = lastUserText(payload).includes('Use the tool');
      if (payload.stream && lastUserText(payload) === 'Answer slowly.') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"STILL"}}]}\n\n');
        setTimeout(() => res.end('data: {"choices":[{"delta":{"content":" OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), 200);
        return;
      }
      if (payload.stream && wantsTool) {
        sse(res, [
          { choices: [{ delta: { reasoning_content: 'Need the weather.' } }] },
          { choices: [{ delta: { content: 'Checking.' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_01', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Barcelona"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } }
        ]);
        return;
      }
      if (payload.stream) {
        sse(res, [
          { choices: [{ delta: { role: 'assistant', reasoning_content: 'The user wants ' } }] },
          { choices: [{ delta: { reasoning_content: 'a short answer.' } }] },
          { choices: [{ delta: { content: 'O' } }] },
          { choices: [{ delta: { content: 'K' }, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26, prompt_tokens_details: { cached_tokens: 8 } } }
        ]);
        return;
      }
      const message = wantsTool
        ? { role: 'assistant', content: null, reasoning_content: 'Need the weather.', tool_calls: [{ id: 'call_02', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Girona"}' } }] }
        : { role: 'assistant', content: 'OK', reasoning_content: REASONING };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{ index: 0, message, finish_reason: wantsTool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 4 } }
      }));
    });
  });
  await new Promise((resolve) => mockServer.listen(0, resolve));

  process.env.DATABASE_PATH = path.join(os.tmpdir(), `agents-proxy-anthropic-test-${Date.now()}.sqlite`);
  process.env.DEFAULT_PROVIDER_BASE_URL = `http://127.0.0.1:${mockServer.address().port}`;
  process.env.DEFAULT_PROVIDER_API_KEY = 'test-provider-key';
  process.env.DEFAULT_UPSTREAM_MODEL = 'deepseek-chat';
  process.env.PUBLIC_MODEL_NAME = 'active-model';
  process.env.ADMIN_PASSWORD = 'secret';
  process.env.SESSION_SECRET = 'test-session-secret-with-enough-length';
  process.env.PUBLIC_BASE_URL = '';
  process.env.MAX_REQUESTS_PER_MINUTE = '1000';
  process.env.DEFAULT_DAILY_TOKEN_LIMIT = '10000000';
  process.env.MAX_TOKENS_PER_REQUEST = '16384';

  const { createApp } = require('../src/app');
  const { getDb } = require('../src/db');
  keyService = require('../src/services/keyService');
  app = createApp();
  db = getDb();
});

test.after(async () => {
  const { closeDb } = require('../src/db');
  closeDb();
  await new Promise((resolve) => mockServer.close(resolve));
});

function createStudent() {
  const key = keyService.generateStudentKey();
  const { prefix, suffix } = keyService.keyPrefixSuffix(key);
  const provider = db.prepare('SELECT id FROM providers WHERE slug = ?').get('deepseek');
  const group = db.prepare(`
    INSERT INTO groups (name, provider_id, daily_call_limit, daily_token_limit, hourly_call_limit, hourly_token_limit)
    VALUES (?, ?, NULL, 1000000000, NULL, NULL)
  `).run(`Group ${Date.now()} ${Math.random()}`, provider.id);
  const result = db.prepare(`
    INSERT INTO users (name, email, api_key_hash, api_key_lookup_hash, api_key_prefix, api_key_suffix, enabled, role)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'student')
  `).run('Student', `student-${Date.now()}-${Math.random()}@example.test`, keyService.hashApiKey(key), keyService.lookupHashApiKey(key), prefix, suffix);
  db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)').run(result.lastInsertRowid, group.lastInsertRowid);
  return { id: result.lastInsertRowid, key };
}

function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((raw) => {
    const event = raw.match(/^event: (.+)$/m)?.[1];
    const data = JSON.parse(raw.match(/^data: (.+)$/m)[1]);
    assert.equal(data.type, event, 'event name matches data.type');
    return data;
  });
}

const weatherTool = {
  name: 'get_weather',
  description: 'Get the weather.',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  cache_control: { type: 'ephemeral' }
};

test('anthropic requests translate system, text, images, tools and tool results to chat completions', () => {
  const { anthropicToChatPayload, encodeThinkingSignature } = require('../src/services/anthropicService');
  const payload = anthropicToChatPayload({
    model: 'active-model',
    max_tokens: 64000,
    temperature: 0.2,
    top_p: 0.9,
    stop_sequences: ['END'],
    metadata: { user_id: 'someone' },
    thinking: { type: 'enabled', budget_tokens: 2048 },
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.0' },
      { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Be brief.' }
    ],
    tools: [weatherTool, { type: 'web_search_20250305', name: 'web_search' }],
    tool_choice: { type: 'any', disable_parallel_tool_use: true },
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'What is in ' },
        { type: 'text', text: 'this image?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        { type: 'mystery_block', value: 1 }
      ] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Look it up.', signature: encodeThinkingSignature('Look it up.') },
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Lleida' } }
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny' },
        { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: [
          { type: 'text', text: 'Not found' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } }
        ] },
        { type: 'text', text: 'Continue.' }
      ] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'Plain turn.', signature: 'opaque' }, { type: 'text', text: 'Done.' }] },
      { role: 'user', content: 'Thanks' }
    ]
  });

  assert.equal(payload.max_tokens, 16384, 'max_tokens is clamped to the server limit');
  assert.equal(payload.temperature, 0.2);
  assert.equal(payload.top_p, 0.9);
  assert.deepEqual(payload.stop, ['END']);
  assert.equal(payload.tool_choice, 'required');
  assert.equal(payload.parallel_tool_calls, false);
  assert.deepEqual(payload.tools, [{
    type: 'function',
    function: { name: 'get_weather', description: 'Get the weather.', parameters: weatherTool.input_schema }
  }]);
  assert.equal(payload.metadata, undefined);
  assert.equal(payload.thinking, undefined);
  assert.deepEqual(payload.messages, [
    { role: 'system', content: 'You are helpful.\n\nBe brief.' },
    { role: 'user', content: [
      { type: 'text', text: 'What is in ' },
      { type: 'text', text: 'this image?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
    ] },
    {
      role: 'assistant',
      content: 'Let me check.',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Lleida"}' } }],
      reasoning_content: 'Look it up.'
    },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'Sunny' },
    { role: 'tool', tool_call_id: 'toolu_2', content: 'Error: Not found' },
    { role: 'user', content: [
      { type: 'text', text: 'Image output from the previous tool call:' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/' } }
    ] },
    { role: 'user', content: 'Continue.' },
    { role: 'assistant', content: 'Done.' },
    { role: 'user', content: 'Thanks' }
  ]);
});

test('anthropic tool_choice maps auto, none and a named tool', () => {
  const { anthropicToChatPayload } = require('../src/services/anthropicService');
  const choice = (tool_choice) => anthropicToChatPayload({ model: 'm', messages: [], tools: [weatherTool], tool_choice }).tool_choice;
  assert.equal(choice({ type: 'auto' }), 'auto');
  assert.equal(choice({ type: 'none' }), 'none');
  assert.deepEqual(choice({ type: 'tool', name: 'get_weather' }), { type: 'function', function: { name: 'get_weather' } });
  assert.equal(choice(undefined), undefined);
});

test('non-streaming messages return an anthropic message with a signed thinking block', async () => {
  const { decodeThinkingSignature } = require('../src/services/anthropicService');
  const student = createStudent();
  const res = await request(app)
    .post('/v1/messages')
    .set('x-api-key', student.key)
    .set('anthropic-version', '2023-06-01')
    .set('anthropic-beta', 'interleaved-thinking-2025-05-14')
    .send({ model: 'active-model', max_tokens: 256, messages: [{ role: 'user', content: 'Say OK.' }] })
    .expect(200);

  assert.match(res.body.id, /^msg_/);
  assert.equal(res.body.type, 'message');
  assert.equal(res.body.role, 'assistant');
  assert.equal(res.body.model, 'active-model');
  assert.equal(res.body.stop_reason, 'end_turn');
  assert.equal(res.body.stop_sequence, null);
  assert.equal(res.body.content.length, 2);
  assert.equal(res.body.content[0].type, 'thinking');
  assert.equal(res.body.content[0].thinking, REASONING);
  assert.equal(decodeThinkingSignature(res.body.content[0].signature), REASONING);
  assert.deepEqual(res.body.content[1], { type: 'text', text: 'OK' });
  assert.deepEqual(res.body.usage, { input_tokens: 16, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 4 });
  assert.equal(lastChatPayload.max_tokens, 256);

  const usage = db.prepare('SELECT input_tokens, output_tokens, total_tokens, was_streaming, status FROM usage_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(student.id);
  assert.deepEqual(usage, { input_tokens: 20, output_tokens: 5, total_tokens: 25, was_streaming: 0, status: 'success' });
});

test('non-streaming tool calls become tool_use blocks with parsed input', async () => {
  const student = createStudent();
  const res = await request(app)
    .post('/v1/messages')
    .set('Authorization', `Bearer ${student.key}`)
    .send({ model: 'active-model', max_tokens: 256, tools: [weatherTool], messages: [{ role: 'user', content: 'Use the tool.' }] })
    .expect(200);

  assert.equal(res.body.stop_reason, 'tool_use');
  assert.deepEqual(res.body.content.map((block) => block.type), ['thinking', 'tool_use']);
  assert.deepEqual(res.body.content[1], { type: 'tool_use', id: 'call_02', name: 'get_weather', input: { city: 'Girona' } });
});

test('streaming emits anthropic events for thinking and text in order', async () => {
  const { decodeThinkingSignature } = require('../src/services/anthropicService');
  const student = createStudent();
  const res = await request(app)
    .post('/v1/messages')
    .set('x-api-key', student.key)
    .send({ model: 'active-model', max_tokens: 256, stream: true, messages: [{ role: 'user', content: 'Say OK.' }] })
    .expect(200);

  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.equal(lastChatPayload.stream, true);
  assert.deepEqual(lastChatPayload.stream_options, { include_usage: true });
  const events = parseSse(res.text);
  const describe = (event) => [event.type, event.content_block?.type || event.delta?.type].filter(Boolean).join(':');
  assert.deepEqual(events.map(describe), [
    'message_start',
    'ping',
    'content_block_start:thinking',
    'content_block_delta:thinking_delta',
    'content_block_delta:thinking_delta',
    'content_block_delta:signature_delta',
    'content_block_stop',
    'content_block_start:text',
    'content_block_delta:text_delta',
    'content_block_delta:text_delta',
    'content_block_stop',
    'message_delta',
    'message_stop'
  ]);
  assert.match(events[0].message.id, /^msg_/);
  assert.equal(events[0].message.model, 'active-model');
  assert.deepEqual(events[2], { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  assert.equal(decodeThinkingSignature(events[5].delta.signature), REASONING);
  assert.equal(events[7].index, 1);
  assert.equal(events[8].delta.text + events[9].delta.text, 'OK');
  assert.deepEqual(events[11].delta, { stop_reason: 'end_turn', stop_sequence: null });
  assert.deepEqual(events[11].usage, { input_tokens: 12, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 8 });

  const usage = db.prepare('SELECT input_tokens, output_tokens, was_streaming, status FROM usage_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(student.id);
  assert.deepEqual(usage, { input_tokens: 20, output_tokens: 6, was_streaming: 1, status: 'success' });
});

test('streaming tool calls emit a tool_use block with input_json_delta fragments', async () => {
  const student = createStudent();
  const res = await request(app)
    .post('/v1/messages')
    .set('x-api-key', student.key)
    .send({ model: 'active-model', max_tokens: 256, stream: true, tools: [weatherTool], messages: [{ role: 'user', content: 'Use the tool.' }] })
    .expect(200);

  const events = parseSse(res.text);
  const starts = events.filter((event) => event.type === 'content_block_start');
  assert.deepEqual(starts.map((event) => [event.index, event.content_block.type]), [[0, 'thinking'], [1, 'text'], [2, 'tool_use']]);
  assert.deepEqual(starts[2].content_block, { type: 'tool_use', id: 'call_01', name: 'get_weather', input: {} });
  const jsonDeltas = events.filter((event) => event.delta?.type === 'input_json_delta');
  assert.ok(jsonDeltas.every((event) => event.index === 2));
  assert.deepEqual(JSON.parse(jsonDeltas.map((event) => event.delta.partial_json).join('')), { city: 'Barcelona' });
  assert.equal(events.filter((event) => event.type === 'content_block_stop').length, 3);
  const messageDelta = events.find((event) => event.type === 'message_delta');
  assert.equal(messageDelta.delta.stop_reason, 'tool_use');
  assert.equal(events.at(-1).type, 'message_stop');
});

test('an active stream outlives the request timeout', async () => {
  const config = require('../src/config');
  const previousRequestTimeout = config.requestTimeoutMs;
  config.requestTimeoutMs = 50;
  try {
    const student = createStudent();
    const res = await request(app)
      .post('/v1/messages')
      .set('x-api-key', student.key)
      .send({ model: 'active-model', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Answer slowly.' }] })
      .expect(200);
    const events = parseSse(res.text);
    const text = events.filter((event) => event.delta?.type === 'text_delta').map((event) => event.delta.text).join('');
    assert.equal(text, 'STILL OK');
    assert.equal(events.at(-1).type, 'message_stop');
    assert.ok(!events.some((event) => event.type === 'error'));
  } finally {
    config.requestTimeoutMs = previousRequestTimeout;
  }
});

test('a returned thinking signature restores reasoning_content for the tool loop', async () => {
  const student = createStudent();
  const first = await request(app)
    .post('/v1/messages')
    .set('x-api-key', student.key)
    .send({ model: 'active-model', max_tokens: 256, tools: [weatherTool], messages: [{ role: 'user', content: 'Use the tool.' }] })
    .expect(200);

  // Clients may drop the visible thinking text; the signature alone carries it.
  const assistantContent = first.body.content.map((block) => block.type === 'thinking' ? { ...block, thinking: '' } : block);
  await request(app)
    .post('/v1/messages')
    .set('x-api-key', student.key)
    .send({
      model: 'active-model',
      max_tokens: 256,
      tools: [weatherTool],
      messages: [
        { role: 'user', content: 'Use the tool.' },
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_02', content: 'Rain' }] }
      ]
    })
    .expect(200);

  const assistant = lastChatPayload.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant.reasoning_content, 'Need the weather.');
  assert.deepEqual(assistant.tool_calls, [{ id: 'call_02', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Girona"}' } }]);
  assert.deepEqual(lastChatPayload.messages.at(-1), { role: 'tool', tool_call_id: 'call_02', content: 'Rain' });
});

test('anthropic auth failures use the anthropic error format', async () => {
  const missing = await request(app)
    .post('/v1/messages')
    .send({ model: 'active-model', max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] })
    .expect(401);
  assert.equal(missing.body.type, 'error');
  assert.equal(missing.body.error.type, 'authentication_error');

  const invalid = await request(app)
    .post('/v1/messages')
    .set('x-api-key', 'ieti_sk_not_a_real_key')
    .send({ model: 'active-model', max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] })
    .expect(401);
  assert.deepEqual(invalid.body, { type: 'error', error: { type: 'authentication_error', message: 'Invalid or revoked API key.' } });

  await request(app).post('/v1/messages/count_tokens').send({ model: 'active-model', messages: [] }).expect(401);
});

test('models the proxy does not serve return a not_found_error without contacting upstream', async () => {
  const student = createStudent();
  lastChatPayload = null;
  const res = await request(app)
    .post('/v1/messages')
    .set('x-api-key', student.key)
    .send({ model: 'claude-sonnet-4-5', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'Hi' }] })
    .expect(404);
  assert.equal(res.body.type, 'error');
  assert.equal(res.body.error.type, 'not_found_error');
  assert.match(res.body.error.message, /does not serve Anthropic models/);
  assert.match(res.body.error.message, /active-model/);
  assert.equal(lastChatPayload, null);
});

test('invalid anthropic requests return invalid_request_error', async () => {
  const student = createStudent();
  const res = await request(app)
    .post('/v1/messages')
    .set('x-api-key', student.key)
    .send({ model: 'active-model', max_tokens: 16 })
    .expect(400);
  assert.equal(res.body.error.type, 'invalid_request_error');
});

test('count_tokens returns an input token estimate', async () => {
  const student = createStudent();
  const res = await request(app)
    .post('/v1/messages/count_tokens')
    .set('x-api-key', student.key)
    .send({ model: 'active-model', system: 'Be brief.', tools: [weatherTool], messages: [{ role: 'user', content: 'Hello there, how are you?' }] })
    .expect(200);
  assert.deepEqual(Object.keys(res.body), ['input_tokens']);
  assert.ok(Number.isInteger(res.body.input_tokens) && res.body.input_tokens > 10);
});
