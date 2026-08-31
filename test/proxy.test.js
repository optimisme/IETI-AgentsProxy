const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const request = require('supertest');

let app;
let mockServer;
let mockBaseUrl;
let db;
let keyService;
let studentAuthService;
let createApp;
let lastChatPayload;

test.before(async () => {
  mockServer = http.createServer((req, res) => {
    if (req.url === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{
          id: 'active-model',
          object: 'model',
          owned_by: 'vllm',
          root: 'test/model-root',
          max_model_len: 65536
        }]
      }));
      return;
    }
    if (req.url === '/version' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: 'test-vllm-version' }));
      return;
    }
    if (req.url === '/official/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'official-model-a', object: 'model', owned_by: 'official' },
          { id: 'official-model-b', object: 'model', owned_by: 'official' }
        ]
      }));
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        lastChatPayload = payload;
        if (payload.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          if (payload.messages?.[0]?.content === 'Stream beyond the request timeout.') {
            res.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}\n\n');
            setTimeout(() => {
              res.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"STILL"}}]}\n\n');
            }, 150);
            setTimeout(() => {
              res.end('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":" OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
            }, 300);
            return;
          }
          if (payload.stream_options?.include_usage) {
            res.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"reasoning":"Checked the request."}}]}\n\n');
          }
          res.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"OK"}}]}\n\n');
          res.end('data: [DONE]\n\n');
          return;
        }
        const sendResponse = () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            model: payload.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
          }));
        };
        if (payload.model === 'slow-local-upstream') {
          setTimeout(sendResponse, 200);
          return;
        }
        sendResponse();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockServer.listen(0, resolve));
  mockBaseUrl = `http://127.0.0.1:${mockServer.address().port}`;

  process.env.DATABASE_PATH = path.join(os.tmpdir(), `agents-proxy-test-${Date.now()}.sqlite`);
  process.env.DEEPSEEK_BASE_URL = mockBaseUrl;
  process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'secret';
  process.env.SESSION_SECRET = 'test-session-secret-with-enough-length';
  process.env.MAX_REQUESTS_PER_MINUTE = '1000';
  process.env.DEFAULT_DAILY_TOKEN_LIMIT = '10000000';
  process.env.DEFAULT_MONTHLY_TOKEN_LIMIT = '100000000';
  process.env.DEFAULT_MODEL_CONTEXT_LIMIT = '131072';
  process.env.DEFAULT_MODEL_OUTPUT_LIMIT = '16384';
  process.env.MAX_TOKENS_PER_REQUEST = '16384';

  ({ createApp } = require('../src/app'));
  const { getDb } = require('../src/db');
  keyService = require('../src/services/keyService');
  studentAuthService = require('../src/services/studentAuthService');
  app = createApp();
  db = getDb();
});

test.after(async () => {
  const { closeDb } = require('../src/db');
  closeDb();
  await new Promise((resolve) => mockServer.close(resolve));
});

function createStudent({ enabled = 1, dailyLimit = 1000000000, models = [], password = 'student-password-123' } = {}) {
  const key = keyService.generateStudentKey();
  const { prefix, suffix } = keyService.keyPrefixSuffix(key);
  const email = `student-${Date.now()}-${Math.random()}@example.test`;
  const providerSlug = models[0] || 'deepseek';
  const provider = db.prepare('SELECT id FROM providers WHERE slug = ?').get(providerSlug);
  const group = db.prepare(`
    INSERT INTO groups (name, provider_id, daily_call_limit, daily_token_limit, hourly_call_limit, hourly_token_limit)
    VALUES (?, ?, NULL, ?, NULL, NULL)
  `).run(`Group ${Date.now()} ${Math.random()}`, provider?.id || null, dailyLimit);
  const name = `Student ${Date.now()} ${Math.random()}`;
  const result = db.prepare(`
    INSERT INTO users (name, email, api_key_hash, api_key_lookup_hash, api_key_prefix, api_key_suffix, enabled, role, password_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'student', ?)
  `).run(
    name,
    email,
    keyService.hashApiKey(key),
    keyService.lookupHashApiKey(key),
    prefix,
    suffix,
    enabled,
    password ? studentAuthService.hashPassword(password) : null
  );
  db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)').run(result.lastInsertRowid, group.lastInsertRowid);
  return { id: result.lastInsertRowid, key, name, email, password };
}

test('health works', async () => {
  const res = await request(app).get('/health').expect(200);
  assert.equal(res.body.ok, true);
});

test('invalid student key is rejected', async () => {
  const res = await request(app).get('/v1/models').set('Authorization', 'Bearer bad-key').expect(401);
  assert.equal(res.body.error.code, 'invalid_api_key');
  await request(app).get('/v1/model-capabilities').set('Authorization', 'Bearer bad-key').expect(401);
});

test('disabled user is rejected', async () => {
  const student = createStudent({ enabled: 0 });
  const res = await request(app).get('/v1/models').set('Authorization', `Bearer ${student.key}`).expect(403);
  assert.equal(res.body.error.code, 'user_disabled');
});

test('valid user can call models', async () => {
  const student = createStudent();
  const res = await request(app).get('/v1/models').set('Authorization', `Bearer ${student.key}`).expect(200);
  assert.equal(res.body.object, 'list');
  assert.equal(res.body.data[0].id, 'active-model');
  assert.deepEqual(Object.keys(res.body.data[0]), ['id', 'object', 'created', 'owned_by']);
});

test('valid user can publish current model capabilities for client configuration', async () => {
  const student = createStudent();
  const res = await request(app)
    .get('/v1/model-capabilities')
    .set('Authorization', `Bearer ${student.key}`)
    .expect(200);
  assert.equal(res.body.object, 'ieti.model_capabilities.list');
  assert.equal(res.body.schema_version, 1);
  assert.equal(res.body.data[0].id, 'active-model');
  assert.equal(res.body.data[0].context_window, 131072);
  assert.equal(res.body.data[0].max_output_tokens, 8192);
  assert.deepEqual(res.body.data[0].capabilities, {
    text: true,
    image: true,
    tools: true,
    reasoning: true,
    parallel_tools: true
  });
  assert.deepEqual(res.body.data[0].reasoning_efforts, []);
  assert.equal(res.body.data[0].default_reasoning_effort, null);
  assert.equal(res.body.data[0].supports_chat_template_kwargs, false);
  assert.deepEqual(res.body.data[0].modalities, { input: ['text', 'image'], output: ['text'] });
});

test('codex model discovery returns virtual model metadata', async () => {
  const student = createStudent();
  const res = await request(app)
    .get('/v1/models?client_version=0.145.0')
    .set('Authorization', `Bearer ${student.key}`)
    .expect(200);

  assert.equal(res.body.models.length, 1);
  assert.equal(res.body.models[0].slug, 'active-model');
  assert.equal(res.body.models[0].display_name, 'active-model');
  assert.equal(res.body.models[0].supported_in_api, true);
  assert.equal(res.body.models[0].context_window, 131072);
  assert.equal(res.body.models[0].supports_parallel_tool_calls, true);
  assert.match(res.body.models[0].base_instructions, /coding agent/);
  assert.equal(res.body.data, undefined);
});

test('codex model discovery publishes configured capabilities', async () => {
  const student = createStudent();
  const provider = db.prepare('SELECT id FROM providers WHERE slug = ?').get('deepseek');
  db.prepare(`
    UPDATE provider_models
    SET supports_image_input = 0, supports_tools = 0, supports_reasoning = 0, supports_parallel_tools = 0
    WHERE provider_id = ?
  `).run(provider.id);

  try {
    const res = await request(app)
      .get('/v1/models?client_version=0.145.0')
      .set('Authorization', `Bearer ${student.key}`)
      .expect(200);
    const model = res.body.models[0];
    assert.deepEqual(model.input_modalities, ['text']);
    assert.equal(model.shell_type, 'disabled');
    assert.equal(model.supports_parallel_tool_calls, false);
    assert.equal(model.default_reasoning_level, null);
    assert.deepEqual(model.supported_reasoning_levels, []);
  } finally {
    db.prepare(`
      UPDATE provider_models
      SET supports_image_input = 1, supports_tools = 1, supports_reasoning = 1, supports_parallel_tools = 1
      WHERE provider_id = ?
    `).run(provider.id);
  }
});

test('responses api translates a non-streaming request and response', async () => {
  const student = createStudent();
  const res = await request(app)
    .post('/v1/responses')
    .set('Authorization', `Bearer ${student.key}`)
    .send({
      model: 'active-model',
      instructions: 'Be concise.',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Say OK.' }]
      }],
      stream: false,
      max_output_tokens: 64
    })
    .expect(200);

  assert.equal(res.body.object, 'response');
  assert.equal(res.body.status, 'completed');
  assert.equal(res.body.model, 'active-model');
  assert.equal(res.body.output[0].type, 'message');
  assert.equal(res.body.output[0].content[0].type, 'output_text');
  assert.equal(res.body.output[0].content[0].text, 'OK');
  assert.deepEqual(res.body.usage, {
    input_tokens: 5,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 2,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 7
  });

  const usage = db.prepare(`
    SELECT model, provider_slug, input_tokens, output_tokens, total_tokens, was_streaming, status
    FROM usage_logs
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(student.id);
  assert.deepEqual(usage, {
    model: 'active-model',
    provider_slug: 'deepseek',
    input_tokens: 5,
    output_tokens: 2,
    total_tokens: 7,
    was_streaming: 0,
    status: 'success'
  });
});

test('responses api translates chat streaming to responses events', async () => {
  const student = createStudent();
  const res = await request(app)
    .post('/v1/responses')
    .set('Authorization', `Bearer ${student.key}`)
    .send({ model: 'active-model', input: 'Say OK.', stream: true })
    .expect(200);

  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.match(res.text, /event: response\.created/);
  assert.match(res.text, /event: response\.reasoning_text\.delta/);
  assert.match(res.text, /"delta":"Checked the request\."/);
  assert.match(res.text, /event: response\.output_text\.delta/);
  assert.match(res.text, /"delta":"OK"/);
  assert.match(res.text, /event: response\.completed/);
  assert.match(res.text, /"status":"completed"/);

  const usage = db.prepare(`
    SELECT model, provider_slug, was_streaming, status
    FROM usage_logs
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(student.id);
  assert.deepEqual(usage, {
    model: 'active-model',
    provider_slug: 'deepseek',
    was_streaming: 1,
    status: 'success'
  });
});

test('responses api converts Codex function tools and prior tool output', () => {
  const { responsesToChatPayload } = require('../src/services/responsesService');
  const payload = responsesToChatPayload({
    model: 'active-model',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect.' }] },
      { type: 'function_call', call_id: 'call_123', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'call_123', output: '/workspace' }
    ],
    tools: [{
      type: 'function',
      name: 'exec_command',
      description: 'Run a command.',
      strict: false,
      parameters: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        required: ['cmd'],
        additionalProperties: false
      }
    }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: { effort: 'xhigh' },
    stream: true
  });

  assert.equal(payload.messages[0].role, 'user');
  assert.equal(payload.messages[1].tool_calls[0].function.name, 'exec_command');
  assert.equal(payload.messages[2].role, 'tool');
  assert.equal(payload.messages[2].tool_call_id, 'call_123');
  assert.equal(payload.tools[0].function.name, 'exec_command');
  assert.equal(payload.parallel_tool_calls, false);
  assert.equal(payload.reasoning_effort, 'xhigh');
  assert.deepEqual(payload.stream_options, { include_usage: true });
});

test('configured reasoning levels are advertised, validated, and forwarded unchanged', async () => {
  const provider = db.prepare('SELECT id FROM providers WHERE slug = ?').get('deepseek');
  const original = db.prepare(`
    SELECT reasoning_efforts, default_reasoning_effort, supports_chat_template_kwargs
    FROM provider_models
    WHERE provider_id = ?
  `).get(provider.id);
  db.prepare(`
    UPDATE provider_models
    SET reasoning_efforts = ?, default_reasoning_effort = ?, supports_chat_template_kwargs = 1
    WHERE provider_id = ?
  `).run(JSON.stringify(['low', 'medium', 'xhigh']), 'low', provider.id);

  try {
    const student = createStudent();
    const capabilities = await request(app)
      .get('/v1/model-capabilities')
      .set('Authorization', `Bearer ${student.key}`)
      .expect(200);
    assert.deepEqual(capabilities.body.data[0].reasoning_efforts, ['low', 'medium', 'xhigh']);
    assert.equal(capabilities.body.data[0].default_reasoning_effort, 'low');
    assert.equal(capabilities.body.data[0].supports_chat_template_kwargs, true);

    const portal = request.agent(app);
    await portal.post('/login').type('form').send({ login: student.email, password: student.password }).expect(302);
    const openCodeConfig = await portal.get('/portal/opencode.json').expect(200);
    const openCodeModel = openCodeConfig.body.provider['ieti-agents'].models['active-model'];
    assert.equal(openCodeModel.options.reasoningEffort, 'low');
    assert.deepEqual(openCodeModel.variants.low, { reasoningEffort: 'low' });
    assert.deepEqual(openCodeModel.variants.xhigh, { reasoningEffort: 'xhigh' });
    assert.deepEqual(openCodeModel.variants.high, { disabled: true });

    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${student.key}`)
      .send({
        model: 'active-model',
        messages: [{ role: 'user', content: 'Think carefully.' }],
        reasoning_effort: 'xhigh',
        chat_template_kwargs: { enable_thinking: true, preserve_thinking: true }
      })
      .expect(200);
    assert.equal(lastChatPayload.reasoning_effort, 'xhigh');
    assert.deepEqual(lastChatPayload.chat_template_kwargs, {
      enable_thinking: true,
      preserve_thinking: true
    });
    assert.equal(lastChatPayload.model, 'deepseek-chat');

    const unsupported = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${student.key}`)
      .send({
        model: 'active-model',
        messages: [{ role: 'user', content: 'Use maximum effort.' }],
        reasoning_effort: 'max'
      })
      .expect(400);
    assert.equal(unsupported.body.error.code, 'reasoning_effort_not_supported');

    const unsafeKwarg = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${student.key}`)
      .send({
        model: 'active-model',
        messages: [{ role: 'user', content: 'Override the template.' }],
        chat_template_kwargs: { arbitrary_template_option: true }
      })
      .expect(400);
    assert.equal(unsafeKwarg.body.error.code, 'invalid_chat_template_kwargs');
  } finally {
    db.prepare(`
      UPDATE provider_models
      SET reasoning_efforts = ?, default_reasoning_effort = ?, supports_chat_template_kwargs = ?
      WHERE provider_id = ?
    `).run(
      original.reasoning_efforts,
      original.default_reasoning_effort,
      original.supports_chat_template_kwargs,
      provider.id
    );
  }
});

test('a reasoning model with no selectable levels preserves provider defaults', async () => {
  const provider = db.prepare('SELECT id FROM providers WHERE slug = ?').get('deepseek');
  const original = db.prepare(`
    SELECT reasoning_efforts, default_reasoning_effort
    FROM provider_models
    WHERE provider_id = ?
  `).get(provider.id);
  db.prepare(`
    UPDATE provider_models
    SET reasoning_efforts = '[]', default_reasoning_effort = NULL
    WHERE provider_id = ?
  `).run(provider.id);

  try {
    const student = createStudent();
    await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${student.key}`)
      .send({ model: 'active-model', messages: [{ role: 'user', content: 'Use the provider default.' }] })
      .expect(200);
    assert.equal(lastChatPayload.reasoning_effort, undefined);

    const unsupported = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${student.key}`)
      .send({
        model: 'active-model',
        messages: [{ role: 'user', content: 'Try low.' }],
        reasoning_effort: 'low'
      })
      .expect(400);
    assert.equal(unsupported.body.error.code, 'reasoning_effort_not_supported');
  } finally {
    db.prepare(`
      UPDATE provider_models
      SET reasoning_efforts = ?, default_reasoning_effort = ?
      WHERE provider_id = ?
    `).run(original.reasoning_efforts, original.default_reasoning_effort, provider.id);
  }
});

test('responses api preserves raw upstream reasoning in non-streaming output', () => {
  const { chatCompletionToResponse } = require('../src/services/responsesService');
  const response = chatCompletionToResponse({
    id: 'chatcmpl-reasoning',
    choices: [{ message: { role: 'assistant', reasoning: 'Inspected the request.', content: 'Done.' } }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
  }, { model: 'active-model', input: 'Inspect.' }, 3);

  assert.deepEqual(response.output[0], {
    id: response.output[0].id,
    type: 'reasoning',
    summary: [],
    content: [{ type: 'reasoning_text', text: 'Inspected the request.' }]
  });
  assert.equal(response.output[1].type, 'message');
  assert.equal(response.output[1].content[0].text, 'Done.');
});

test('responses api moves Codex developer messages to the initial system message', () => {
  const { responsesToChatPayload } = require('../src/services/responsesService');
  const payload = responsesToChatPayload({
    model: 'active-model',
    instructions: 'Base instructions.',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First turn.' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Late developer instruction.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Second turn.' }] }
    ]
  });

  assert.deepEqual(payload.messages, [
    { role: 'system', content: 'Base instructions.\n\nLate developer instruction.' },
    { role: 'user', content: 'First turn.' },
    { role: 'user', content: 'Second turn.' }
  ]);
});

test('quota exceeded blocks requests', async () => {
  const student = createStudent({ dailyLimit: 1 });
  db.prepare(`
    INSERT INTO usage_logs (user_id, model, provider_slug, input_tokens, output_tokens, total_tokens, was_streaming, status, error_message)
    VALUES (?, 'active-model', 'deepseek', 1, 0, 1, 0, 'success', NULL)
  `).run(student.id);
  const res = await request(app)
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${student.key}`)
    .send({ model: 'active-model', messages: [{ role: 'user', content: 'This request is too large for the tiny quota.' }] })
    .expect(429);
  assert.equal(res.body.error.code, 'daily_quota_exceeded');
});

test('multimodal image base64 is forwarded and usage comes from provider', async () => {
  const student = createStudent();
  const largeBase64 = Buffer.alloc(420000, 1).toString('base64');
  const res = await request(app)
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${student.key}`)
    .send({
      model: 'active-model',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${largeBase64}` } }
        ]
      }],
      max_tokens: 64
    })
    .expect(200);

  assert.equal(res.body.model, 'deepseek-chat');
  const usage = db.prepare(`
    SELECT input_tokens, output_tokens, total_tokens, status
    FROM usage_logs
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(student.id);
  assert.deepEqual(usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7, status: 'success' });
});

test('multimodal validation rejects too many images and video', async () => {
  const student = createStudent();
  const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('image').toString('base64')}` } };

  const tooMany = await request(app)
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${student.key}`)
    .send({
      model: 'active-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Images' }, image, image, image, image, image] }]
    })
    .expect(413);
  assert.equal(tooMany.body.error.code, 'too_many_images');

  const video = await request(app)
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${student.key}`)
    .send({
      model: 'active-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Video' }, { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } }] }]
    })
    .expect(400);
  assert.equal(video.body.error.code, 'video_not_supported');
});

test('requested max_tokens is bounded before provider call', async () => {
  const student = createStudent();
  const res = await request(app)
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${student.key}`)
    .send({
      model: 'active-model',
      messages: [{ role: 'user', content: 'Say OK.' }],
      max_tokens: 200000
    })
    .expect(413);
  assert.equal(res.body.error.code, 'max_tokens_too_large');
});

test('admin can create user and regenerate key', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const email = `created-${Date.now()}@example.test`;
  const createdPost = await agent.post('/admin/users').type('form').send({
    name: 'Created User',
    email,
    enabled: '1',
    group_id: String(db.prepare('SELECT id FROM groups ORDER BY id ASC LIMIT 1').get().id)
  }).expect(302);
  const created = await agent.get(createdPost.headers.location).expect(200);
  assert.match(created.text, /\/invite\/ieti_inv_/);
  assert.match(created.text, /Created User/);
  assert.match(created.text, new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const user = db.prepare('SELECT * FROM users WHERE name = ?').get('Created User');
  assert.ok(user.invite_token_hash);
  const regenerated = await agent.post(`/admin/users/${user.id}/regenerate-key`).expect(200);
  assert.match(regenerated.text, /ieti_sk_/);
});

test('admin form validation rejects invalid writes', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const groupId = db.prepare('SELECT id FROM groups ORDER BY id ASC LIMIT 1').get().id;

  const badEmail = `bad-email-${Date.now()}`;
  const badUser = await agent.post('/admin/users').type('form').send({
    name: 'Invalid User',
    email: badEmail,
    enabled: '1',
    group_id: String(groupId)
  }).expect(400);
  assert.equal(badUser.body.error.code, 'invalid_form');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?').get(badEmail).count, 0);

  const badProvider = await agent.post('/admin/providers').type('form').send({
    slug: 'bad-provider',
    name: 'Bad Provider',
    base_url: 'ftp://invalid.example.test',
    api_key: 'local',
    enabled: '1'
  }).expect(400);
  assert.equal(badProvider.body.error.code, 'invalid_form');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM providers WHERE slug = ?').get('bad-provider').count, 0);

  const badGroup = await agent.post('/admin/groups').type('form').send({
    name: 'Bad Group',
    provider_id: '',
    daily_call_limit: '-1',
    daily_token_limit: '',
    hourly_call_limit: '',
    hourly_token_limit: ''
  }).expect(400);
  assert.equal(badGroup.body.error.code, 'invalid_form');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM groups WHERE name = ?').get('Bad Group').count, 0);
});

test('admin can assign multiple providers to a group', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const secondProvider = db.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(`admin-pool-${Date.now()}`, 'Admin Pool Provider', 'openai-compatible', mockBaseUrl, 'local');
  db.prepare(`
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
    VALUES (?, ?, ?, ?, 1, 32000, 4096)
  `).run(secondProvider.lastInsertRowid, 'admin-fast-model', 'admin-fast-upstream', 'Admin Fast');
  const deepseek = db.prepare('SELECT id FROM providers WHERE slug = ?').get('deepseek');
  const groupName = `Admin Pool Group ${Date.now()}`;

  await agent.post('/admin/groups').type('form').send({
    name: groupName,
    provider_ids: [String(deepseek.id), String(secondProvider.lastInsertRowid)],
    daily_call_limit: '',
    daily_token_limit: '',
    hourly_call_limit: '',
    hourly_token_limit: ''
  }).expect(302);

  const group = db.prepare('SELECT id, provider_id FROM groups WHERE name = ?').get(groupName);
  assert.equal(group.provider_id, deepseek.id);
  const providerIds = db.prepare(`
    SELECT provider_id
    FROM group_providers
    WHERE group_id = ?
    ORDER BY priority DESC, provider_id ASC
  `).all(group.id).map((row) => row.provider_id);
  assert.deepEqual(providerIds, [deepseek.id, secondProvider.lastInsertRowid]);

  const edit = await agent.get(`/admin/groups/${group.id}`).expect(200);
  assert.match(edit.text, /Balanced model pools/);
  assert.match(edit.text, /active-model/);
  assert.match(edit.text, /admin-fast-model/);
  assert.match(edit.text, /Admin Pool Provider/);
  assert.match(edit.text, /admin-fast-upstream/);
});

test('admin can clear all providers from a group', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const deepseek = db.prepare('SELECT id FROM providers WHERE slug = ?').get('deepseek');
  const groupName = `No Provider Group ${Date.now()}`;
  const group = db.prepare(`
    INSERT INTO groups (name, provider_id, daily_call_limit, daily_token_limit, hourly_call_limit, hourly_token_limit)
    VALUES (?, ?, NULL, NULL, NULL, NULL)
  `).run(groupName, deepseek.id);
  db.prepare(`
    INSERT INTO group_providers (group_id, provider_id, enabled, priority)
    VALUES (?, ?, 1, 100)
  `).run(group.lastInsertRowid, deepseek.id);

  await agent.post(`/admin/groups/${group.lastInsertRowid}`).type('form').send({
    name: groupName,
    daily_call_limit: '',
    daily_token_limit: '',
    hourly_call_limit: '',
    hourly_token_limit: ''
  }).expect(302);

  const updated = db.prepare('SELECT provider_id FROM groups WHERE id = ?').get(group.lastInsertRowid);
  const providerCount = db.prepare('SELECT COUNT(*) AS count FROM group_providers WHERE group_id = ?').get(group.lastInsertRowid).count;
  assert.equal(updated.provider_id, null);
  assert.equal(providerCount, 0);
});

test('database startup preserves configured provider pools, aliases, limits, and settings', () => {
  const database = new Database(path.join(os.tmpdir(), `agents-proxy-startup-test-${Date.now()}.sqlite`));
  const { initSchema, migrateSchema, seedSettings } = require('../src/db');
  database.pragma('foreign_keys = ON');
  initSchema(database);
  const legacyProviderPoolColumn = ['wei', 'ght'].join('');
  database.exec(`ALTER TABLE group_providers ADD COLUMN ${legacyProviderPoolColumn} INTEGER NOT NULL DEFAULT 100`);
  migrateSchema(database);
  seedSettings(database);
  const groupProviderColumns = database.prepare('PRAGMA table_info(group_providers)').all().map((column) => column.name);
  assert.equal(groupProviderColumns.includes(legacyProviderPoolColumn), false);

  const activeSlug = `active-model-${Date.now()}`;
  const activeProvider = database.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled, priority)
    VALUES (?, ?, ?, ?, ?, 1, 100)
  `).run(activeSlug, 'Spark 25 vLLM', 'openai-compatible', mockBaseUrl, 'local');
  const group = database.prepare(`
    INSERT INTO groups (name, provider_id, daily_call_limit, daily_token_limit, hourly_call_limit, hourly_token_limit)
    VALUES (?, ?, NULL, NULL, NULL, NULL)
  `).run(`Curs Agents ${Date.now()}`, activeProvider.lastInsertRowid);

  database.prepare(`
    INSERT INTO group_providers (group_id, provider_id, enabled, priority)
    VALUES (?, ?, 1, 100)
  `).run(group.lastInsertRowid, activeProvider.lastInsertRowid);
  database.prepare(`
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
    VALUES (?, ?, ?, ?, 1, 65536, 8192)
  `).run(activeProvider.lastInsertRowid, 'custom-public-alias', 'custom-upstream', 'Custom Model');
  database.prepare(`
    UPDATE provider_models
    SET context_limit = 32768
    WHERE provider_id = ?
  `).run(activeProvider.lastInsertRowid);
  database.prepare(`
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
    VALUES (?, ?, ?, ?, 1, 8192, 2048)
  `).run(activeProvider.lastInsertRowid, 'custom-secondary-alias', 'custom-secondary-upstream', 'Custom Secondary Model');
  const updateSetting = database.prepare('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?');
  updateSetting.run('16384', 'default_model_context_limit');
  updateSetting.run('8192', 'default_model_output_limit');
  updateSetting.run('32000', 'max_tokens_per_request');
  updateSetting.run('20', 'max_requests_per_minute');
  updateSetting.run('100000', 'default_daily_token_limit');
  database.prepare(`
    UPDATE groups
    SET daily_call_limit = 1000000000,
        daily_token_limit = 100000,
        hourly_call_limit = 100000000,
        hourly_token_limit = 100000000
    WHERE name = 'Default Users'
  `).run();

  migrateSchema(database);
  seedSettings(database);

  const providerSlugs = database.prepare(`
    SELECT providers.slug
    FROM group_providers
    JOIN providers ON providers.id = group_providers.provider_id
    WHERE group_providers.group_id = ?
    ORDER BY providers.slug ASC
  `).all(group.lastInsertRowid).map((row) => row.slug);

  assert.deepEqual(providerSlugs, [activeSlug]);
  const model = database.prepare('SELECT public_model, context_limit FROM provider_models WHERE provider_id = ?').get(activeProvider.lastInsertRowid);
  assert.equal(model.public_model, 'custom-public-alias');
  assert.equal(model.context_limit, 32768);
  assert.deepEqual(
    database.prepare('SELECT public_model FROM provider_models WHERE provider_id = ? ORDER BY id').all(activeProvider.lastInsertRowid).map((row) => row.public_model),
    ['custom-public-alias', 'custom-secondary-alias']
  );
  const settings = Object.fromEntries(database.prepare(`
    SELECT key, value
    FROM settings
    WHERE key IN (
      'default_model_context_limit',
      'default_model_output_limit',
      'max_tokens_per_request',
      'max_requests_per_minute',
      'default_daily_token_limit'
    )
  `).all().map((row) => [row.key, row.value]));
  assert.deepEqual(settings, {
    default_daily_token_limit: '100000',
    default_model_context_limit: '16384',
    default_model_output_limit: '8192',
    max_requests_per_minute: '20',
    max_tokens_per_request: '32000'
  });
  const defaultGroup = database.prepare(`
    SELECT daily_call_limit, daily_token_limit, hourly_call_limit, hourly_token_limit
    FROM groups
    WHERE name = 'Default Users'
  `).get();
  assert.deepEqual(defaultGroup, {
    daily_call_limit: 1000000000,
    daily_token_limit: 100000,
    hourly_call_limit: 100000000,
    hourly_token_limit: 100000000
  });
  database.close();
});

test('admin pages escape dynamic user and group content', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const groupId = db.prepare('SELECT id FROM groups ORDER BY id ASC LIMIT 1').get().id;
  const marker = `escaped-${Date.now()}`;

  const result = db.prepare(`
    INSERT INTO users (name, email, enabled, role)
    VALUES (?, ?, 1, 'student')
  `).run(`<script>${marker}</script>`, `${marker}@example.test`);
  db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)').run(result.lastInsertRowid, groupId);

  const res = await agent.get(`/admin/users?q=${encodeURIComponent(marker)}`).expect(200);
  assert.match(res.text, new RegExp(`&lt;script&gt;${marker}&lt;\\/script&gt;`));
  assert.doesNotMatch(res.text, new RegExp(`<script>${marker}</script>`));
});

test('admin users list links to edit page only', async () => {
  const student = createStudent();
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);

  await agent.get('/admin/users')
    .expect(200)
    .expect(new RegExp(`/admin/users/${student.id}`))
    .expect(/<th>Group Provider<\/th>/)
    .expect(/status-enabled/)
    .expect((res) => {
      assert.doesNotMatch(res.text, /<th>Usage<\/th>/);
      assert.doesNotMatch(res.text, /\/stats/);
      assert.doesNotMatch(res.text, />Disable<\/button>/);
    });
});

test('admin user edit page separates management and stats', async () => {
  const student = createStudent();
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);

  await agent.get(`/admin/users/${student.id}`)
    .expect(200)
    .expect(/<h2>Invitation key<\/h2>/)
    .expect(/Generate invitation key/)
    .expect(/<h2>API keys<\/h2>/)
    .expect(/Add API key/)
    .expect(/Revoke all keys/)
    .expect(/<h2>Stats<\/h2>/)
    .expect(/Calls today/)
    .expect(/Calls this hour/)
    .expect(/Tokens today/)
    .expect(/Tokens this hour/)
    .expect(/Recent usage\/errors/)
    .expect(/Last used/)
    .expect(/Group provider/)
    .expect(/Are you sure to delete this user\?/)
    .expect(/>Delete<\/button>/)
    .expect((res) => {
      assert.doesNotMatch(res.text, /Delete if safe/);
      assert.doesNotMatch(res.text, /By provider/);
      assert.doesNotMatch(res.text, /Total cost/);
    });
});

test('admin user recent usage is paginated', async () => {
  const student = createStudent();
  const marker = `usage-page-${Date.now()}`;
  const insertUsage = db.prepare(`
    INSERT INTO usage_logs (user_id, model, provider_slug, input_tokens, output_tokens, total_tokens, was_streaming, status, error_message)
    VALUES (?, ?, 'deepseek', 1, 1, 2, 0, 'success', NULL)
  `);
  for (let i = 0; i < 30; i += 1) {
    insertUsage.run(student.id, `${marker}-${String(i).padStart(2, '0')}`);
  }
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);

  const first = await agent.get(`/admin/users/${student.id}`).expect(200);
  assert.match(first.text, /Page 1 of 2\. 30 records\./);
  assert.match(first.text, /Next/);
  assert.equal((first.text.match(new RegExp(`${marker}-\\d+`, 'g')) || []).length, 25);

  const second = await agent.get(`/admin/users/${student.id}?usage_page=2`).expect(200);
  assert.match(second.text, /Page 2 of 2\. 30 records\./);
  assert.match(second.text, /Previous/);
  assert.equal((second.text.match(new RegExp(`${marker}-\\d+`, 'g')) || []).length, 5);
});

test('admin delete user shows modal reason when usage history exists', async () => {
  const student = createStudent();
  db.prepare(`
    INSERT INTO usage_logs (user_id, model, provider_slug, input_tokens, output_tokens, total_tokens, was_streaming, status, error_message)
    VALUES (?, 'delete-block-test', 'deepseek', 1, 1, 2, 0, 'success', NULL)
  `).run(student.id);
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);

  const detail = await agent.get(`/admin/users/${student.id}`).expect(200);
  assert.match(detail.text, /Non removable user/);
  assert.doesNotMatch(detail.text, new RegExp(`/admin/users/${student.id}/delete`));

  await agent.post(`/admin/users/${student.id}/delete`)
    .expect(302)
    .expect('Location', `/admin/users/${student.id}?delete_error=usage-history`);

  const res = await agent.get(`/admin/users/${student.id}?delete_error=usage-history`).expect(200);
  assert.match(res.text, /Delete failed/);
  assert.match(res.text, /cannot be deleted without losing audit history/);
  assert.ok(db.prepare('SELECT id FROM users WHERE id = ?').get(student.id));
});

test('admin users list paginates search results', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const groupId = db.prepare('SELECT id FROM groups ORDER BY id ASC LIMIT 1').get().id;
  const marker = `paged-users-${Date.now()}`;
  const insertUser = db.prepare(`
    INSERT INTO users (name, email, enabled, role)
    VALUES (?, ?, ?, 'student')
  `);
  const insertGroup = db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)');
  for (let i = 0; i < 30; i += 1) {
    const result = insertUser.run(`${marker} ${i}`, `${marker}-${i}@example.test`, i % 2);
    insertGroup.run(result.lastInsertRowid, groupId);
  }

  const first = await agent.get(`/admin/users?q=${encodeURIComponent(marker)}`).expect(200);
  assert.match(first.text, /Page 1 of 2\. 30 users\./);
  assert.match(first.text, /Next/);
  assert.match(first.text, /<th>Group Provider<\/th>/);
  assert.match(first.text, /status-enabled/);
  assert.match(first.text, /status-disabled/);
  assert.doesNotMatch(first.text, /<th>Usage<\/th>/);
  assert.equal((first.text.match(new RegExp(`${marker}-\\d+@example\\.test`, 'g')) || []).length, 25);

  const second = await agent.get(`/admin/users?q=${encodeURIComponent(marker)}&page=2`).expect(200);
  assert.match(second.text, /Page 2 of 2\. 30 users\./);
  assert.equal((second.text.match(new RegExp(`${marker}-\\d+@example\\.test`, 'g')) || []).length, 5);
});

test('admin groups do not expose description and usage section is removed', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);

  const groupColumns = db.prepare('PRAGMA table_info(groups)').all().map((column) => column.name);
  assert.doesNotMatch(groupColumns.join(','), /description/);
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
  assert.doesNotMatch(userColumns.join(','), /allowed_models|monthly_token_limit|monthly_cost_limit_eur/);
  const usageColumns = db.prepare('PRAGMA table_info(usage_logs)').all().map((column) => column.name);
  assert.doesNotMatch(usageColumns.join(','), /estimated_cost_eur/);
  const providerModelColumns = db.prepare('PRAGMA table_info(provider_models)').all().map((column) => column.name);
  assert.doesNotMatch(providerModelColumns.join(','), /input_eur_per_1m|output_eur_per_1m/);
  assert.equal(providerModelColumns.includes('reasoning_efforts'), true);
  assert.equal(providerModelColumns.includes('default_reasoning_effort'), true);
  assert.equal(providerModelColumns.includes('supports_chat_template_kwargs'), true);
  const groupProviderColumns = db.prepare('PRAGMA table_info(group_providers)').all().map((column) => column.name);
  assert.equal(groupProviderColumns.includes(['wei', 'ght'].join('')), false);
  const legacyAccessTables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('user_allowed_providers', 'group_allowed_providers')
  `).all();
  assert.equal(legacyAccessTables.length, 0);
  const legacySettings = db.prepare(`
    SELECT key FROM settings
    WHERE key IN ('default_monthly_token_limit', 'default_monthly_cost_limit_eur', 'deepseek_api_key', 'deepseek_base_url')
  `).all();
  assert.equal(legacySettings.length, 0);

  const dashboard = await agent.get('/admin').expect(200);
  assert.doesNotMatch(dashboard.text, /href="\/admin\/usage"/);
  assert.doesNotMatch(dashboard.text, /Cost this month/);

  const groups = await agent.get('/admin/groups').expect(200);
  assert.doesNotMatch(groups.text, /<th>Description<\/th>/);
  assert.doesNotMatch(groups.text, /name="description"/);

  await agent.get('/admin/groups/new')
    .expect(200)
    .expect((res) => {
      assert.doesNotMatch(res.text, /<label>Description<\/label>/);
      assert.doesNotMatch(res.text, /name="description"/);
    });

  await agent.get('/admin/usage').expect(404);
});

test('admin can clean old usage logs and dashboard warns when cleanup is overdue', async () => {
  const student = createStudent();
  db.prepare("DELETE FROM settings WHERE key = 'usage_cleanup_last_run_at'").run();
  db.prepare(`
    INSERT INTO usage_logs
      (user_id, model, provider_slug, input_tokens, output_tokens, total_tokens, was_streaming, status, error_message, created_at)
    VALUES
      (?, 'cleanup-old', 'deepseek', 1, 1, 2, 0, 'success', NULL, datetime('now', '-16 days')),
      (?, 'cleanup-recent', 'deepseek', 1, 1, 2, 0, 'success', NULL, datetime('now', '-14 days'))
  `).run(student.id, student.id);

  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);

  await agent.get('/admin')
    .expect(200)
    .expect(/Usage log cleanup is due/)
    .expect(/No cleanup has been recorded yet/);

  await agent.get('/admin/server')
    .expect(200)
    .expect(/Usage log cleanup/)
    .expect(/Clean logs older than <span id="cleanup-retention-label">15<\/span> days/);

  await agent.post('/admin/server/cleanup-usage')
    .expect(302)
    .expect('Location', '/admin/server?cleanup_deleted=1');

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM usage_logs WHERE model = 'cleanup-old'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM usage_logs WHERE model = 'cleanup-recent'").get().count, 1);
  assert.ok(db.prepare("SELECT value FROM settings WHERE key = 'usage_cleanup_last_run_at'").get()?.value);

  await agent.get('/admin/server?cleanup_deleted=1')
    .expect(200)
    .expect(/Usage cleanup completed\. Deleted 1 records and compacted the database\./);
  const dashboard = await agent.get('/admin').expect(200);
  assert.doesNotMatch(dashboard.text, /Usage log cleanup is due/);

  db.prepare(`
    INSERT INTO usage_logs
      (user_id, model, provider_slug, input_tokens, output_tokens, total_tokens, was_streaming, status, error_message, created_at)
    VALUES
      (?, 'cleanup-19-days', 'deepseek', 1, 1, 2, 0, 'success', NULL, datetime('now', '-19 days')),
      (?, 'cleanup-21-days', 'deepseek', 1, 1, 2, 0, 'success', NULL, datetime('now', '-21 days'))
  `).run(student.id, student.id);
  await agent.post('/admin/server/cleanup-usage')
    .type('form')
    .send({ retention_days: '20' })
    .expect(302)
    .expect('Location', '/admin/server?cleanup_deleted=1');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM usage_logs WHERE model = 'cleanup-19-days'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM usage_logs WHERE model = 'cleanup-21-days'").get().count, 0);

  await agent.get('/admin/server')
    .expect(200)
    .expect(/Days to keep/)
    .expect(/Clean logs older than <span id="cleanup-retention-label">20<\/span> days/);
});

test('admin json endpoints return json auth errors', async () => {
  const provider = db.prepare('SELECT * FROM providers WHERE slug = ?').get('deepseek');
  const res = await request(app)
    .post(`/admin/providers/${provider.id}/test.json`)
    .set('Accept', 'application/json')
    .expect(401);
  assert.equal(res.body.error.code, 'admin_auth_required');
  const autoconfigure = await request(app)
    .post(`/admin/providers/${provider.id}/autoconfigure.json`)
    .set('Accept', 'application/json')
    .expect(401);
  assert.equal(autoconfigure.body.error.code, 'admin_auth_required');
});

test('provider key can be tested', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const provider = db.prepare('SELECT * FROM providers WHERE slug = ?').get('deepseek');
  const res = await agent.post(`/admin/providers/${provider.id}/test`).expect(302);
  assert.match(res.headers.location, /DeepSeek\+test\+passed|DeepSeek%20test%20passed/);
});

test('admin can see and delete provider api key', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const provider = db.prepare('SELECT * FROM providers WHERE slug = ?').get('deepseek');

  const list = await agent.get('/admin/settings').expect(200).expect(/<th>API key<\/th>/).expect(/configured/);
  assert.match(list.text, /OpenCode alias/);
  assert.match(list.text, /active-model/);
  assert.match(list.text, /Active upstream model/);
  assert.match(list.text, /<th>Groups<\/th>/);
  assert.doesNotMatch(list.text, /<th>Models<\/th>/);
  assert.doesNotMatch(list.text, /In progress/);
  const edit = await agent.get(`/admin/providers/${provider.id}`).expect(200).expect(/API key: configured/).expect(/Delete API key/);
  const apiKeyActions = edit.text.match(/<div class="actions">([\s\S]*?Save API key[\s\S]*?Delete API key[\s\S]*?)<\/div>/);
  assert.ok(apiKeyActions, 'Save API key and Delete API key should share one actions row');
  assert.match(apiKeyActions[1], new RegExp(`form="provider-api-key-save-${provider.id}"`));
  assert.match(apiKeyActions[1], new RegExp(`form="provider-api-key-delete-${provider.id}"`));
  await agent.post(`/admin/providers/${provider.id}/clear-key`).expect(302);

  const updated = db.prepare('SELECT api_key FROM providers WHERE id = ?').get(provider.id);
  assert.equal(updated.api_key, '');
  await agent.get(`/admin/providers/${provider.id}`).expect(200).expect(/API key: not configured/);
  db.prepare('UPDATE providers SET api_key = ? WHERE id = ?').run(provider.api_key, provider.id);
});

test('admin can update only provider api key', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const provider = db.prepare('SELECT * FROM providers WHERE slug = ?').get('deepseek');
  const replacement = `provider-key-${Date.now()}`;

  await agent.post(`/admin/providers/${provider.id}`).type('form').send({
    api_key: replacement
  }).expect(302).expect('Location', `/admin/providers/${provider.id}?saved=1`);

  const updated = db.prepare('SELECT api_key, name, base_url, slug FROM providers WHERE id = ?').get(provider.id);
  assert.equal(updated.api_key, replacement);
  assert.equal(updated.name, provider.name);
  assert.equal(updated.base_url, provider.base_url);
  assert.equal(updated.slug, provider.slug);
  db.prepare('UPDATE providers SET api_key = ? WHERE id = ?').run(provider.api_key, provider.id);
});

test('admin deletes a provider through an explicit modal without deleting usage history', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const provider = db.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run('delete-provider-test', 'Delete Provider Test', 'openai-compatible', mockBaseUrl, 'local');
  db.prepare(`
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
    VALUES (?, ?, ?, ?, 1, 32000, 4096)
  `).run(provider.lastInsertRowid, 'delete-provider-alias', 'delete-provider-upstream', 'Delete Provider Test');
  const group = db.prepare(`
    INSERT INTO groups (name, provider_id, daily_call_limit, daily_token_limit, hourly_call_limit, hourly_token_limit)
    VALUES (?, ?, NULL, NULL, NULL, NULL)
  `).run(`Delete Provider Group ${Date.now()}`, provider.lastInsertRowid);
  db.prepare(`
    INSERT INTO group_providers (group_id, provider_id, enabled, priority)
    VALUES (?, ?, 1, 100)
  `).run(group.lastInsertRowid, provider.lastInsertRowid);
  db.prepare(`
    INSERT INTO usage_logs (user_id, model, provider_slug, input_tokens, output_tokens, total_tokens, was_streaming, status)
    VALUES (NULL, ?, ?, 1, 1, 2, 0, 'success')
  `).run('delete-provider-alias', 'delete-provider-test');

  const edit = await agent.get(`/admin/providers/${provider.lastInsertRowid}`).expect(200);
  assert.match(edit.text, /data-open-modal="provider-delete-modal-/);
  assert.match(edit.text, /<dialog[^>]+class="modal"/);
  assert.match(edit.text, />Delete provider</);
  assert.doesNotMatch(edit.text, /window\.confirm|\balert\s*\(/);

  await agent.post(`/admin/providers/${provider.lastInsertRowid}/delete`)
    .expect(302)
    .expect('Location', '/admin/settings?deleted=1');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM providers WHERE id = ?').get(provider.lastInsertRowid).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_models WHERE provider_id = ?').get(provider.lastInsertRowid).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM group_providers WHERE provider_id = ?').get(provider.lastInsertRowid).count, 0);
  assert.equal(db.prepare('SELECT provider_id FROM groups WHERE id = ?').get(group.lastInsertRowid).provider_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_logs WHERE provider_slug = ?').get('delete-provider-test').count, 1);
  await agent.get('/admin/settings?deleted=1').expect(200).expect(/Provider deleted/);
});

test('admin can edit provider slug and sees edit title', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const provider = db.prepare('SELECT * FROM providers WHERE slug = ?').get('deepseek');
  const originalModel = db.prepare('SELECT * FROM provider_models WHERE provider_id = ? AND public_model = ?').get(provider.id, 'active-model');
  const replacementSlug = `deepseek-renamed-${Date.now()}`;

  const edit = await agent.get(`/admin/providers/${provider.id}`).expect(200);
  assert.match(edit.text, /<title>Edit provider<\/title>/);
  assert.match(edit.text, /<h1>Edit provider<\/h1>/);
  assert.doesNotMatch(edit.text, /<h1>Providers<\/h1>/);
  assert.doesNotMatch(edit.text, /<h1>Edit DeepSeek<\/h1>/);
  assert.match(edit.text, /name="slug"/);
  assert.doesNotMatch(edit.text, /name="slug"[^>]*readonly/);
  assert.match(edit.text, /Active Model Mapping/);
  assert.match(edit.text, /OpenCode model alias/);
  assert.match(edit.text, /Providers with the same alias are load-balanced together and shown as one model in OpenCode/);
  assert.match(edit.text, /name="public_model"/);
  assert.doesNotMatch(edit.text, /name="public_model"[^>]*readonly/);
  assert.match(edit.text, /Upstream model name/);
  assert.doesNotMatch(edit.text, /Save mapping/);
  assert.doesNotMatch(edit.text, /<h2>Models<\/h2>/);
  assert.doesNotMatch(edit.text, /Add model/);

  const replacementModel = `renamed-model-${Date.now()}`;
  await agent.post(`/admin/providers/${provider.id}`).type('form').send({
    slug: replacementSlug,
    name: provider.name,
    base_url: provider.base_url,
    api_key: '',
    enabled: '1',
    max_concurrent_requests: provider.max_concurrent_requests || '',
    timeout_ms: provider.timeout_ms || '',
    public_model: replacementModel,
    upstream_model: 'deepseek-chat-renamed',
    context_limit: '65536',
    output_limit: '8192'
  }).expect(302).expect('Location', `/admin/providers/${provider.id}?saved=1`);

  const updated = db.prepare('SELECT slug FROM providers WHERE id = ?').get(provider.id);
  assert.equal(updated.slug, replacementSlug);
  const model = db.prepare('SELECT public_model, upstream_model FROM provider_models WHERE provider_id = ?').get(provider.id);
  assert.equal(model.public_model, replacementModel);
  assert.equal(model.upstream_model, 'deepseek-chat-renamed');
  db.prepare('UPDATE providers SET slug = ? WHERE id = ?').run(provider.slug, provider.id);
  db.prepare(`
    UPDATE provider_models
    SET public_model = ?, upstream_model = ?, context_limit = ?, output_limit = ?
    WHERE provider_id = ?
  `).run(originalModel.public_model, originalModel.upstream_model, originalModel.context_limit, originalModel.output_limit, provider.id);
});

test('provider active mapping can be saved and both provider tests return modal-ready results', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const provider = db.prepare('SELECT * FROM providers WHERE slug = ?').get('deepseek');
  const originalModel = db.prepare('SELECT * FROM provider_models WHERE provider_id = ?').get(provider.id);

  await agent.post(`/admin/providers/${provider.id}/mapping`).type('form').send({
    public_model: 'saved-alias',
    upstream_model: 'deepseek-chat',
    context_limit: '65536',
    output_limit: '8192',
    supports_reasoning: '1',
    reasoning_efforts_present: '1',
    reasoning_efforts: ['low', 'medium', 'xhigh'],
    default_reasoning_effort: 'low',
    supports_chat_template_kwargs: '1'
  }).expect(302);

  const models = db.prepare('SELECT * FROM provider_models WHERE provider_id = ?').all(provider.id);
  assert.equal(models.length, 1);
  assert.equal(models[0].public_model, 'saved-alias');
  assert.equal(models[0].upstream_model, 'deepseek-chat');
  assert.deepEqual(JSON.parse(models[0].reasoning_efforts), ['low', 'medium', 'xhigh']);
  assert.equal(models[0].default_reasoning_effort, 'low');
  assert.equal(models[0].supports_chat_template_kwargs, 1);

  const providerTest = await agent.post(`/admin/providers/${provider.id}/test.json`).expect(200);
  assert.equal(providerTest.body.ok, true);
  assert.match(providerTest.body.message, /Server test request passed/);
  assert.match(providerTest.body.detail, /Available models: active-model/);

  const mappingTest = await agent.post(`/admin/providers/${provider.id}/mapping/test.json`).expect(200);
  assert.equal(mappingTest.body.ok, true);
  assert.match(mappingTest.body.message, /Mapping test request passed/);
  assert.match(mappingTest.body.detail, /Model: deepseek-chat/);
  const edit = await agent.get(`/admin/providers/${provider.id}`).expect(200);
  assert.match(edit.text, /<h2>Test provider<\/h2>/);
  assert.match(edit.text, /Run server test request/);
  assert.match(edit.text, /Run mapping request/);
  assert.match(edit.text, /data-test-title="Server test request result"/);
  assert.match(edit.text, /data-test-title="Mapping request result"/);
  assert.match(edit.text, /name="reasoning_efforts"/);
  assert.match(edit.text, /name="default_reasoning_effort"/);
  assert.match(edit.text, /name="supports_chat_template_kwargs"/);
  assert.doesNotMatch(edit.text, /data-result-target="provider-test-result"/);
  const renderedScripts = [...edit.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(renderedScripts.length);
  for (const script of renderedScripts) assert.doesNotThrow(() => new Function(script));
  db.prepare(`
    UPDATE provider_models
    SET public_model = ?, upstream_model = ?, context_limit = ?, output_limit = ?,
        supports_text_input = ?, supports_image_input = ?, supports_tools = ?, supports_reasoning = ?,
        reasoning_efforts = ?, default_reasoning_effort = ?, supports_chat_template_kwargs = ?, supports_parallel_tools = ?
    WHERE provider_id = ?
  `).run(
    originalModel.public_model,
    originalModel.upstream_model,
    originalModel.context_limit,
    originalModel.output_limit,
    originalModel.supports_text_input,
    originalModel.supports_image_input,
    originalModel.supports_tools,
    originalModel.supports_reasoning,
    originalModel.reasoning_efforts,
    originalModel.default_reasoning_effort,
    originalModel.supports_chat_template_kwargs,
    originalModel.supports_parallel_tools,
    provider.id
  );
});

test('provider autoconfigure imports standard model IDs and optional vLLM context metadata', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const provider = db.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run('autoconfigure-vllm', 'Autoconfigure vLLM', 'openai-compatible', `${mockBaseUrl}/v1`, 'local');
  db.prepare(`
    INSERT INTO provider_models
      (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit,
       supports_text_input, supports_image_input, supports_tools, supports_reasoning, supports_parallel_tools)
    VALUES (?, ?, ?, ?, 1, ?, ?, 1, 0, 1, 1, 0)
  `).run(provider.lastInsertRowid, 'autoconfigure-alias', 'stale-model', 'Autoconfigure vLLM', 32000, 4096);

  const edit = await agent.get(`/admin/providers/${provider.lastInsertRowid}`)
    .expect(200)
    .expect(/Autoconfigure provider/)
    .expect(/data-apply-autoconfigure/);
  assert.match(edit.text, /<form method="post" action="\/admin\/providers\/\d+" class="panel" data-provider-settings-form>\s*<h2>Provider Settings<\/h2>/);
  const providerActions = edit.text.match(/<div class="actions" style="margin-top:16px">([\s\S]*?)<\/div>/);
  assert.ok(providerActions);
  assert.deepEqual(
    [...providerActions[1].matchAll(/>(Save provider|Delete provider|Autoconfigure|Run mapping request)</g)].map((match) => match[1]),
    ['Save provider', 'Delete provider', 'Autoconfigure']
  );
  assert.doesNotMatch(providerActions[1], />Cancel</);
  assert.doesNotMatch(edit.text, /Autoconfigure discovers model IDs/);
  assert.match(edit.text, /Configuration applied to the form\. Save the provider to persist it\./);
  assert.match(edit.text, /button\.textContent = 'Save provider'/);
  assert.match(edit.text, /providerForm\.requestSubmit\(\)/);

  const preview = await agent
    .post(`/admin/providers/${provider.lastInsertRowid}/autoconfigure.json`)
    .send({ preferred_model: '', apply: false })
    .expect(200);
  assert.equal(preview.body.ok, true);
  assert.equal(preview.body.providerType, 'vllm');
  assert.equal(preview.body.version, 'test-vllm-version');
  assert.equal(preview.body.selectedModel, 'active-model');
  assert.equal(preview.body.applied, null);
  assert.match(preview.body.message, /Review it before applying/);
  assert.match(preview.body.detail, /Model root: test\/model-root/);
  assert.equal(db.prepare('SELECT upstream_model FROM provider_models WHERE provider_id = ?').get(provider.lastInsertRowid).upstream_model, 'stale-model');

  const response = await agent
    .post(`/admin/providers/${provider.lastInsertRowid}/autoconfigure.json`)
    .send({ preferred_model: 'active-model', apply: true })
    .expect(200);
  assert.equal(response.body.applied.upstreamModel, 'active-model');
  assert.equal(response.body.applied.contextLimit, 65536);

  const updated = db.prepare('SELECT * FROM provider_models WHERE provider_id = ?').get(provider.lastInsertRowid);
  assert.equal(updated.public_model, 'autoconfigure-alias');
  assert.equal(updated.upstream_model, 'active-model');
  assert.equal(updated.context_limit, 65536);
  assert.equal(updated.output_limit, 4096);
  assert.equal(updated.supports_image_input, 0);
  assert.equal(updated.supports_tools, 1);
  assert.equal(updated.supports_reasoning, 1);
  assert.equal(updated.supports_parallel_tools, 0);
});

test('provider autoconfigure remains generic for official OpenAI-compatible APIs', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const provider = db.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run('autoconfigure-official', 'Autoconfigure Official', 'openai-compatible', `${mockBaseUrl}/official/v1`, 'official-key');
  db.prepare(`
    INSERT INTO provider_models
      (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit,
       supports_text_input, supports_image_input, supports_tools, supports_reasoning, supports_parallel_tools)
    VALUES (?, ?, ?, ?, 1, ?, ?, 1, 0, 1, 0, 0)
  `).run(provider.lastInsertRowid, 'official-alias', 'official-model-b', 'Autoconfigure Official', 32768, 2048);

  const response = await agent
    .post(`/admin/providers/${provider.lastInsertRowid}/autoconfigure.json`)
    .send({ preferred_model: 'official-model-b', apply: true })
    .expect(200);
  assert.equal(response.body.providerType, 'openai-compatible');
  assert.equal(response.body.version, null);
  assert.equal(response.body.applied.upstreamModel, 'official-model-b');
  assert.equal(response.body.applied.contextLimit, 32768);
  assert.match(response.body.detail, /Context limit: not published; existing value will be kept/);
});

test('provider test explains common configuration failures', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const provider = db.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run('broken-provider', 'Broken Provider', 'openai-compatible', mockBaseUrl, '');

  const res = await agent.post(`/admin/providers/${provider.lastInsertRowid}/test.json`).expect(502);
  assert.equal(res.body.ok, false);
  assert.match(res.body.message, /Server test request failed/);
  assert.match(res.body.detail, /API key is not configured/);
});

test('provider concurrency cap blocks the requested provider', async () => {
  const provider = db.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled, max_concurrent_requests)
    VALUES (?, ?, ?, ?, ?, 1, 1)
  `).run('local-vllm-test', 'Local vLLM Test', 'openai-compatible', mockBaseUrl, 'local');
  db.prepare(`
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
    VALUES (?, ?, ?, ?, 1, 32000, 4096)
  `).run(provider.lastInsertRowid, 'local-vllm-test', 'slow-local-upstream', 'Slow Local');

  const student = createStudent({ models: ['local-vllm-test'] });
  const release = require('../src/services/providerService').reserveProviderForTest('local-vllm-test');

  try {
    const blocked = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${student.key}`)
      .send({ model: 'local-vllm-test', messages: [{ role: 'user', content: 'Say OK.' }] })
      .expect(503);
    assert.equal(blocked.body.error.code, 'provider_capacity_exceeded');
  } finally {
    release();
  }

  const ok = await request(app)
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${student.key}`)
    .send({ model: 'local-vllm-test', messages: [{ role: 'user', content: 'Say OK.' }] })
    .expect(200);
  assert.equal(ok.body.model, 'slow-local-upstream');
});

test('group provider pool routes to the least busy provider', async () => {
  const provider = db.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled, max_concurrent_requests)
    VALUES (?, ?, ?, ?, ?, 1, NULL)
  `).run('pool-vllm-test', 'Pool vLLM Test', 'openai-compatible', mockBaseUrl, 'local');
  db.prepare(`
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
    VALUES (?, ?, ?, ?, 1, 32000, 4096)
  `).run(provider.lastInsertRowid, 'active-model', 'pool-upstream', 'Pool Local');

  const student = createStudent();
  const groupId = db.prepare('SELECT group_id FROM user_groups WHERE user_id = ?').get(student.id).group_id;
  const deepseek = db.prepare('SELECT id FROM providers WHERE slug = ?').get('deepseek');
  db.prepare(`
    INSERT OR REPLACE INTO group_providers (group_id, provider_id, enabled, priority)
    VALUES (?, ?, 1, ?)
  `).run(groupId, deepseek.id, 100);
  db.prepare(`
    INSERT OR REPLACE INTO group_providers (group_id, provider_id, enabled, priority)
    VALUES (?, ?, 1, ?)
  `).run(groupId, provider.lastInsertRowid, 100);

  const release = require('../src/services/providerService').reserveProviderForTest('deepseek');
  try {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${student.key}`)
      .send({ model: 'active-model', messages: [{ role: 'user', content: 'Say OK.' }] })
      .expect(200);
    assert.equal(res.body.model, 'pool-upstream');
  } finally {
    release();
  }
});

test('provider pool filters endpoints by required tool capability', async () => {
  const toolProvider = db.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled, priority)
    VALUES (?, ?, ?, ?, ?, 1, 100)
  `).run('tool-capable-pool-test', 'Tool Capable Pool Test', 'openai-compatible', mockBaseUrl, 'local');
  db.prepare(`
    INSERT INTO provider_models
      (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit,
       supports_text_input, supports_image_input, supports_tools, supports_reasoning, supports_parallel_tools)
    VALUES (?, 'active-model', 'tool-capable-upstream', 'Tool Capable', 1, 32000, 4096, 1, 1, 1, 1, 1)
  `).run(toolProvider.lastInsertRowid);

  const student = createStudent();
  const groupId = db.prepare('SELECT group_id FROM user_groups WHERE user_id = ?').get(student.id).group_id;
  const deepseek = db.prepare('SELECT id FROM providers WHERE slug = ?').get('deepseek');
  db.prepare('UPDATE provider_models SET supports_tools = 0 WHERE provider_id = ?').run(deepseek.id);
  db.prepare(`
    INSERT INTO group_providers (group_id, provider_id, enabled, priority)
    VALUES (?, ?, 1, 100)
  `).run(groupId, toolProvider.lastInsertRowid);

  try {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${student.key}`)
      .send({
        model: 'active-model',
        messages: [{ role: 'user', content: 'Use the tool.' }],
        tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
        tool_choice: 'auto'
      })
      .expect(200);
    assert.equal(res.body.model, 'tool-capable-upstream');

    db.prepare('UPDATE provider_models SET supports_tools = 0 WHERE provider_id = ?').run(toolProvider.lastInsertRowid);
    const unavailable = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${student.key}`)
      .send({
        model: 'active-model',
        messages: [{ role: 'user', content: 'Use the tool.' }],
        tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }]
      })
      .expect(400);
    assert.equal(unavailable.body.error.code, 'model_capability_unavailable');
  } finally {
    db.prepare('UPDATE provider_models SET supports_tools = 1 WHERE provider_id = ?').run(deepseek.id);
  }
});

test('group provider pool randomizes equally loaded providers', () => {
  const firstProvider = db.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled, priority)
    VALUES (?, ?, ?, ?, ?, 1, 100)
  `).run('random-pool-a', 'Random Pool A', 'openai-compatible', mockBaseUrl, 'local');
  const secondProvider = db.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled, priority)
    VALUES (?, ?, ?, ?, ?, 1, 100)
  `).run('random-pool-b', 'Random Pool B', 'openai-compatible', mockBaseUrl, 'local');
  const insertModel = db.prepare(`
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
    VALUES (?, ?, ?, ?, 1, 32000, 4096)
  `);
  insertModel.run(firstProvider.lastInsertRowid, 'active-model', 'random-upstream-a', 'Random A');
  insertModel.run(secondProvider.lastInsertRowid, 'active-model', 'random-upstream-b', 'Random B');

  const { chooseProviderModel } = require('../src/services/providerService');
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    const firstChoice = chooseProviderModel('active-model', ['random-pool-a', 'random-pool-b']);
    Math.random = () => 0.999999;
    const secondChoice = chooseProviderModel('active-model', ['random-pool-a', 'random-pool-b']);

    assert.equal(firstChoice.slug, 'random-pool-a');
    assert.equal(secondChoice.slug, 'random-pool-b');
  } finally {
    Math.random = originalRandom;
  }
});

test('user provider access controls api models and opencode download', async () => {
  const provider = db.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled, max_concurrent_requests)
    VALUES (?, ?, ?, ?, ?, 1, NULL)
  `).run('group-vllm-test', 'Group vLLM Test', 'openai-compatible', mockBaseUrl, 'local');
  db.prepare(`
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
    VALUES (?, ?, ?, ?, 1, 32000, 4096)
  `).run(provider.lastInsertRowid, 'group-internal', 'group-upstream', 'Group Internal');

  const student = createStudent({ models: ['group-vllm-test'] });

  const modelsRes = await request(app).get('/v1/models').set('Authorization', `Bearer ${student.key}`).expect(200);
  assert.deepEqual(modelsRes.body.data.map((model) => model.id), ['group-internal']);

  await request(app)
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${student.key}`)
    .send({ model: 'deepseek', messages: [{ role: 'user', content: 'No access.' }] })
    .expect(403);

  const chatRes = await request(app)
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${student.key}`)
    .send({ model: 'group-internal', messages: [{ role: 'user', content: 'Allowed.' }] })
    .expect(200);
  assert.equal(chatRes.body.model, 'group-upstream');

  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: student.email, password: student.password }).expect(302);
  const configRes = await agent.get('/portal/opencode.json').expect(200);
  assert.deepEqual(Object.keys(configRes.body.provider['ieti-agents'].models), ['group-internal']);
  assert.equal(configRes.body.model, 'ieti-agents/group-internal');

  const dashboard = await agent
    .get('/portal')
    .set('Host', 'portal.example.test')
    .set('X-Forwarded-Proto', 'https')
    .expect(200);
  assert.match(dashboard.text, /<h2 id="active-models-heading">Active models<\/h2>/);
  assert.match(dashboard.text, /<summary>\s*<code>group-internal<\/code>/);
  assert.match(dashboard.text, /<dt>Base URL<\/dt><dd><code>https:\/\/portal\.example\.test\/v1<\/code><\/dd>/);
  assert.match(dashboard.text, /&quot;context&quot;: 32000/);
  assert.doesNotMatch(dashboard.text, /<summary>\s*<code>active-model<\/code>/);
});

test('opencode config lists every public model pool assigned to the user group', async () => {
  const fastProvider = db.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled, max_concurrent_requests)
    VALUES (?, ?, ?, ?, ?, 1, NULL)
  `).run('multi-fast-test', 'Multi Fast Test', 'openai-compatible', mockBaseUrl, 'local');
  db.prepare(`
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
    VALUES (?, ?, ?, ?, 1, 32000, 4096)
  `).run(fastProvider.lastInsertRowid, 'fast-model', 'fast-upstream', 'Fast Model');
  db.prepare(`
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
    VALUES (?, ?, ?, ?, 1, 16000, 2048)
  `).run(fastProvider.lastInsertRowid, 'fast-secondary-model', 'fast-secondary-upstream', 'Fast Secondary Model');

  const secondFastProvider = db.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled, max_concurrent_requests)
    VALUES (?, ?, ?, ?, ?, 1, NULL)
  `).run('multi-fast-backup-test', 'Multi Fast Backup Test', 'openai-compatible', mockBaseUrl, 'local');
  db.prepare(`
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
    VALUES (?, ?, ?, ?, 1, 64000, 8192)
  `).run(secondFastProvider.lastInsertRowid, 'fast-model', 'fast-backup-upstream', 'Fast Backup Model');

  const visionProvider = db.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled, max_concurrent_requests)
    VALUES (?, ?, ?, ?, ?, 1, NULL)
  `).run('multi-vision-test', 'Multi Vision Test', 'openai-compatible', mockBaseUrl, 'local');
  db.prepare(`
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
    VALUES (?, ?, ?, ?, 1, 64000, 2048)
  `).run(visionProvider.lastInsertRowid, 'vision-model', 'vision-upstream', 'Vision Model');

  const student = createStudent({ models: ['multi-fast-test'] });
  const groupId = db.prepare('SELECT group_id FROM user_groups WHERE user_id = ?').get(student.id).group_id;
  db.prepare('DELETE FROM group_providers WHERE group_id = ?').run(groupId);
  db.prepare(`
    INSERT INTO group_providers (group_id, provider_id, enabled, priority)
    VALUES (?, ?, 1, ?)
  `).run(groupId, fastProvider.lastInsertRowid, 100);
  db.prepare(`
    INSERT INTO group_providers (group_id, provider_id, enabled, priority)
    VALUES (?, ?, 1, ?)
  `).run(groupId, secondFastProvider.lastInsertRowid, 99);
  db.prepare(`
    INSERT INTO group_providers (group_id, provider_id, enabled, priority)
    VALUES (?, ?, 1, ?)
  `).run(groupId, visionProvider.lastInsertRowid, 98);

  const modelsRes = await request(app).get('/v1/models').set('Authorization', `Bearer ${student.key}`).expect(200);
  assert.deepEqual(modelsRes.body.data.map((model) => model.id).sort(), ['fast-model', 'fast-secondary-model', 'vision-model']);
  const capabilitiesRes = await request(app)
    .get('/v1/model-capabilities')
    .set('Authorization', `Bearer ${student.key}`)
    .expect(200);
  assert.equal(capabilitiesRes.body.data[0].context_window, 32000);
  assert.equal(capabilitiesRes.body.data[0].max_output_tokens, 4096);

  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: student.email, password: student.password }).expect(302);
  const configRes = await agent.get('/portal/opencode.json').expect(200);
  assert.deepEqual(Object.keys(configRes.body.provider['ieti-agents'].models).sort(), ['fast-model', 'fast-secondary-model', 'vision-model']);
  assert.equal(configRes.body.model, 'ieti-agents/fast-model');
  assert.equal(configRes.body.provider['ieti-agents'].models['fast-model'].limit.context, 32000);
  assert.equal(configRes.body.provider['ieti-agents'].models['fast-model'].limit.output, 4096);
  assert.equal(configRes.body.provider['ieti-agents'].models['vision-model'].limit.context, 64000);
  assert.equal(configRes.body.provider['ieti-agents'].models['vision-model'].limit.output, 2048);
});

test('streaming works with a small request', async () => {
  const student = createStudent();
  const res = await request(app)
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${student.key}`)
    .send({ model: 'active-model', stream: true, messages: [{ role: 'user', content: 'Say OK.' }] })
    .expect(200);
  assert.match(res.text, /data:/);
  assert.match(res.text, /\[DONE]/);
});

test('active streams can outlive the request handshake timeout', async () => {
  const config = require('../src/config');
  const previousRequestTimeout = config.requestTimeoutMs;
  const previousStreamTimeout = config.streamInactivityTimeoutMs;
  config.requestTimeoutMs = 50;
  config.streamInactivityTimeoutMs = 250;

  try {
    const student = createStudent();
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${student.key}`)
      .send({
        model: 'active-model',
        stream: true,
        messages: [{ role: 'user', content: 'Stream beyond the request timeout.' }]
      })
      .expect(200);
    assert.match(res.text, /STILL/);
    assert.match(res.text, / OK/);
    assert.match(res.text, /\[DONE]/);
    assert.doesNotMatch(res.text, /stream_error/);
  } finally {
    config.requestTimeoutMs = previousRequestTimeout;
    config.streamInactivityTimeoutMs = previousStreamTimeout;
  }
});

test('student portal shows setup commands and serves configuration scripts', async () => {
  const student = createStudent();
  const agent = request.agent(app);
  db.prepare(`
    UPDATE provider_models
    SET context_limit = 131072, output_limit = 16384
    WHERE public_model = 'active-model'
  `).run();

  await agent.get('/').expect(200).expect(/<h1>Login<\/h1>/);
  await agent.post('/login').type('form').send({ login: student.email, password: student.password }).expect(302);

  const portal = await agent.get('/portal')
    .set('Host', 'course.example.test:8443')
    .set('X-Forwarded-Proto', 'https')
    .expect(200)
    .expect(/Tokens today/)
    .expect(/OpenCode configuration/)
    .expect(/BuildLite Configuration/)
    .expect(/set_harness_buildlite\.sh/)
    .expect(/set_harness_buildlite\.ps1/)
    .expect(/set_agents_opencode\.sh/)
    .expect(/set_agents_opencode\.ps1/);
  assert.match(portal.text, /bash -c/);
  assert.match(portal.text, /powershell\.exe/);
  assert.match(portal.text, /https%3A%2F%2Fcourse\.example\.test%3A8443%2Fv1/);
  assert.match(portal.text, /https:\/\/course\.example\.test:8443\/downloads\/set_agents_opencode\.sh/);
  assert.match(portal.text, /class="command-scroll"/);
  assert.equal((portal.text.match(/data-copy-target=/g) || []).length, 4);
  assert.equal((portal.text.match(/data-copy-value=/g) || []).length, 4);
  assert.match(portal.text, /data-copy-target="ieti-shell-command" data-copy-value="bash -c/);
  assert.match(portal.text, /data-copy-target="ieti-powershell-command" data-copy-value="\$p=Join-Path/);
  assert.match(portal.text, /ieti-shell-command/);
  assert.match(portal.text, /ieti-powershell-command/);
  assert.match(portal.text, /buildlite-shell-command/);
  assert.match(portal.text, /buildlite-powershell-command/);
  assert.match(portal.text, /downloads\/set_harness_buildlite\.sh/);
  assert.match(portal.text, /downloads\/set_harness_buildlite\.ps1/);
  assert.match(portal.text, /mklink \/J \.opencode \.agents/);
  assert.match(portal.text, /navigator\.clipboard/);
  assert.match(portal.text, /<h2 id="active-models-heading">Active models<\/h2>/);
  assert.match(portal.text, /<details class="active-model">/);
  assert.match(portal.text, /<summary>\s*<code>active-model<\/code>/);
  assert.match(portal.text, /<dt>Protocol<\/dt><dd>OpenAI-compatible<\/dd>/);
  assert.match(portal.text, /<dt>Base URL<\/dt><dd><code>https:\/\/course\.example\.test:8443\/v1<\/code><\/dd>/);
  assert.match(portal.text, /<dt>Context window<\/dt><dd>131072 tokens<\/dd>/);
  assert.match(portal.text, /<dt>Maximum output<\/dt><dd>16384 tokens<\/dd>/);
  assert.match(portal.text, /@ai-sdk\/openai-compatible/);
  assert.match(portal.text, /\{file:\.secrets\/agents_server_key\}/);
  assert.match(portal.text, /&quot;tool_call&quot;: true/);
  assert.ok(portal.text.indexOf('Active models') < portal.text.indexOf('Recent usage'));
  assert.doesNotMatch(portal.text, /run_opencode|PROXY_AGENTS_KEY|Qwen|DeepSeek Harness|install_deepseek_harness|dsh-ieti-agents|Harness plugin/i);
  assert.doesNotMatch(portal.text, /Cost EUR/);
  assert.doesNotMatch(portal.text, /Codex/);
  assert.doesNotMatch(portal.text, /config\.toml/);
  assert.doesNotMatch(portal.text, /env_key/);
  assert.doesNotMatch(portal.text, /chunkTimeout/);

  const shellScript = await request(app).get('/downloads/set_agents_opencode.sh?default_base_url=https%3A%2F%2Fdownload.example.test%2Fv1').expect(200);
  assert.match(shellScript.headers['content-disposition'], /attachment; filename="set_agents_opencode\.sh"/);
  assert.match(shellScript.headers['content-type'], /text\/plain/);
  assert.match(shellScript.text, /^#!\/usr\/bin\/env bash/);
  assert.match(shellScript.text, /\.secrets/);
  assert.match(shellScript.text, /agents_server_key/);
  assert.match(shellScript.text, /DEFAULT_BASE_URL="https:\/\/download\.example\.test\/v1"/);
  assert.match(shellScript.text, /apiKey: '\{file:\.secrets\/agents_server_key\}'/);
  assert.doesNotMatch(shellScript.text, /export PROXY_AGENTS_KEY|apiKey: '\{env:PROXY_AGENTS_KEY\}'|opencode:\/\/|OPENCODE_MODELS_PATH|ieti-models\.json|command -v opencode/);

  const powerShellScript = await request(app).get('/downloads/set_agents_opencode.ps1?default_base_url=https%3A%2F%2Fdownload.example.test%2Fv1').expect(200);
  assert.match(powerShellScript.headers['content-disposition'], /attachment; filename="set_agents_opencode\.ps1"/);
  assert.match(powerShellScript.headers['content-type'], /text\/plain/);
  assert.match(powerShellScript.text, /\$ErrorActionPreference = 'Stop'/);
  assert.match(powerShellScript.text, /\.secrets/);
  assert.match(powerShellScript.text, /agents_server_key/);
  assert.match(powerShellScript.text, /\$DefaultBaseUrl = 'https:\/\/download\.example\.test\/v1'/);
  assert.match(powerShellScript.text, /apiKey: '\{file:\.secrets\/agents_server_key\}'/);
  assert.doesNotMatch(powerShellScript.text, /EnvironmentVariable\([^)]*PROXY_AGENTS_KEY|apiKey: '\{env:PROXY_AGENTS_KEY\}'|opencode:\/\/|OPENCODE_MODELS_PATH|ieti-models\.json|Get-Command opencode/);

  const buildLiteShellScript = await request(app).get('/downloads/set_harness_buildlite.sh').expect(200);
  assert.match(buildLiteShellScript.headers['content-disposition'], /attachment; filename="set_harness_buildlite\.sh"/);
  assert.match(buildLiteShellScript.headers['content-type'], /text\/plain/);
  assert.match(buildLiteShellScript.text, /^#!\/usr\/bin\/env bash/);
  assert.match(buildLiteShellScript.text, /buildlite_harness\.zip/);
  assert.match(buildLiteShellScript.text, /cp -a "\$SOURCE_DIRECTORY\/\." "\$WORKING_DIRECTORY\//);
  assert.match(buildLiteShellScript.text, /ln -s \.agents/);
  assert.doesNotMatch(buildLiteShellScript.text, /__IETI_BUILD_LITE_ZIP_URL__/);

  const buildLitePowerShellScript = await request(app).get('/downloads/set_harness_buildlite.ps1').expect(200);
  assert.match(buildLitePowerShellScript.headers['content-disposition'], /attachment; filename="set_harness_buildlite\.ps1"/);
  assert.match(buildLitePowerShellScript.headers['content-type'], /text\/plain/);
  assert.match(buildLitePowerShellScript.text, /Expand-Archive/);
  assert.match(buildLitePowerShellScript.text, /Copy-Item -LiteralPath \$Item\.FullName/);
  assert.match(buildLitePowerShellScript.text, /mklink \/J/);
  assert.doesNotMatch(buildLitePowerShellScript.text, /__IETI_BUILD_LITE_ZIP_URL__/);

  const buildLiteArchive = await request(app).get('/downloads/buildlite_harness.zip').expect(200);
  assert.match(buildLiteArchive.headers['content-disposition'], /attachment; filename="buildlite_harness\.zip"/);
  assert.match(buildLiteArchive.headers['content-type'], /application\/zip/);
  assert.ok(Number(buildLiteArchive.headers['content-length']) > 1000);

  await request(app).get('/portal/set_agents_opencode.sh').expect(404);
  await request(app).get('/portal/set_agents_opencode.ps1').expect(404);
  await request(app).get('/portal/set_harness_buildlite.sh').expect(404);
  await request(app).get('/portal/set_harness_buildlite.ps1').expect(404);
  await agent.get('/portal/run_opencode.sh').expect(404);
  await agent.get('/portal/run_opencode.ps1').expect(404);
  await agent.get('/portal/install_deepseek_harness.sh').expect(404);
  await agent.get('/portal/install_deepseek_harness.ps1').expect(404);
  await request(app).get('/downloads/dsh-ieti-agents-0.1.0.tgz').expect(404);

  const publicBaseUrlSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('public_base_url');
  db.prepare('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?')
    .run('https://configured.example.test/v1', 'public_base_url');
  let configRes;
  try {
    configRes = await agent
      .get('/portal/opencode.json')
      .set('Host', 'course.example.test')
      .set('X-Forwarded-Proto', 'https')
      .expect(200);
  } finally {
    db.prepare('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?')
      .run(publicBaseUrlSetting?.value || '', 'public_base_url');
  }

  assert.equal(configRes.body.provider['ieti-agents'].options.baseURL, 'https://configured.example.test/v1');
  assert.equal(configRes.body.provider['ieti-agents'].options.apiKey, '{file:.secrets/agents_server_key}');
  assert.equal(configRes.body.provider['ieti-agents'].options.timeout, 900000);
  assert.equal(configRes.body.provider['ieti-agents'].options.chunkTimeout, 600000);
  assert.equal(configRes.body.model, 'ieti-agents/active-model');
  assert.equal(configRes.body.provider['ieti-agents'].models['active-model'].limit.context, 131072);
  assert.equal(configRes.body.provider['ieti-agents'].models['active-model'].limit.output, 16384);
  assert.equal(configRes.body.provider['ieti-agents'].models['active-model'].max_tokens, undefined);
  assert.equal(configRes.body.provider['ieti-agents'].models['active-model'].parallel_tool_call, undefined);
  assert.equal(configRes.body.provider['ieti-agents'].models['active-model'].tool_call, true);
  assert.equal(configRes.body.provider['ieti-agents'].models['active-model'].reasoning, true);
  assert.deepEqual(configRes.body.provider['ieti-agents'].models['active-model'].modalities, {
    input: ['text', 'image'],
    output: ['text']
  });

  await agent.get('/portal/codex.toml').expect(404);
});

test('student can create multiple named api keys and delete one from settings', async () => {
  const student = createStudent();
  const agent = request.agent(app);

  await agent.post('/login').type('form').send({ login: student.email, password: student.password }).expect(302);
  const settingsBefore = await agent.get('/portal/settings').expect(200);
  assert.match(settingsBefore.text, /API keys/);
  assert.match(settingsBefore.text, />Default</);
  assert.match(settingsBefore.text, /delete-api-key-modal/);
  assert.match(settingsBefore.text, /delete-api-key-confirm-form/);
  assert.match(settingsBefore.text, /Applications using it will stop working/);

  const firstRegenerate = await agent.post('/portal/key/regenerate');
  assert.equal(firstRegenerate.status, 302, firstRegenerate.text);
  assert.equal(firstRegenerate.headers.location, '/portal/settings?new_key=1');
  const pending = await agent.get('/portal/settings?new_key=1').expect(200);
  const firstMatch = pending.text.match(/ieti_sk_[A-Za-z0-9_-]+/);
  assert.ok(firstMatch);
  assert.notEqual(firstMatch[0], student.key);
  assert.match(pending.text, /name="key_name"/);
  assert.match(pending.text, /id="add-key-btn" disabled/);
  assert.match(pending.text, /id="api-key-modal"/);
  assert.match(pending.text, /modal-enter/);
  assert.match(pending.text, /is-closing/);

  await agent.post('/portal/key/add').type('form').send({ key_name: 'Laptop' }).expect(302).expect('Location', '/portal/settings?created=1');
  const settingsAfterFirst = await agent.get('/portal/settings?created=1').expect(200);
  assert.match(settingsAfterFirst.text, />Laptop</);
  assert.doesNotMatch(settingsAfterFirst.text, /id="api-key-modal"/);

  await request(app).get('/v1/models').set('Authorization', `Bearer ${student.key}`).expect(200);
  await request(app).get('/v1/models').set('Authorization', `Bearer ${firstMatch[0]}`).expect(200);

  const nextRegenerate = await agent.post('/portal/key/regenerate');
  assert.equal(nextRegenerate.status, 302, nextRegenerate.text);
  assert.equal(nextRegenerate.headers.location, '/portal/settings?new_key=1');
  const secondPending = await agent.get('/portal/settings?new_key=1').expect(200);
  const secondMatch = secondPending.text.match(/ieti_sk_[A-Za-z0-9_-]+/);
  assert.ok(secondMatch);
  await agent.post('/portal/key/add').type('form').send({ key_name: 'CI' }).expect(302).expect('Location', '/portal/settings?created=1');
  await request(app).get('/v1/models').set('Authorization', `Bearer ${firstMatch[0]}`).expect(200);
  await request(app).get('/v1/models').set('Authorization', `Bearer ${secondMatch[0]}`).expect(200);

  await agent.post('/portal/key/regenerate').expect(302).expect('Location', '/portal/settings?new_key=1');
  await agent.post('/portal/key/add').type('form').send({ key_name: 'laptop' }).expect(302).expect('Location', '/portal/settings?new_key=1&key_error=duplicate');
  await agent.get('/portal/settings?new_key=1&key_error=duplicate').expect(200).expect(/already in use/);

  const laptopKey = db.prepare('SELECT id FROM user_api_keys WHERE user_id = ? AND name = ?').get(student.id, 'Laptop');
  assert.ok(laptopKey);
  await agent.post(`/portal/key/${laptopKey.id}/revoke`).expect(302).expect('Location', '/portal/settings?revoked=1');
  await agent.get('/portal/settings?revoked=1').expect(200).expect(/API key deleted/);
  await request(app).get('/v1/models').set('Authorization', `Bearer ${firstMatch[0]}`).expect(401);
  await request(app).get('/v1/models').set('Authorization', `Bearer ${secondMatch[0]}`).expect(200);

  const defaultKey = db.prepare('SELECT id FROM user_api_keys WHERE user_id = ? AND name = ?').get(student.id, 'Default');
  await agent.post(`/portal/key/${defaultKey.id}/revoke`).expect(302).expect('Location', '/portal/settings?revoked=1');
  await request(app).get('/v1/models').set('Authorization', `Bearer ${student.key}`).expect(401);
  await request(app).get('/v1/models').set('Authorization', `Bearer ${secondMatch[0]}`).expect(200);

  const dashboard = await agent.get('/portal').expect(200);
  assert.doesNotMatch(dashboard.text, /api-key-modal/);
});

test('student sets password through invite and then logs in with email and password', async () => {
  const student = createStudent({ password: null });
  const invite = studentAuthService.createInviteForUser(student.id);
  const agent = request.agent(app);

  await agent.get(`/invite/${invite.token}`).expect(200).expect(/Set Password/);
  await agent.post(`/invite/${invite.token}`).type('form').send({
    password: 'new-student-password',
    confirm_password: 'new-student-password'
  }).expect(302);

  await agent.post('/login').type('form').send({
    login: student.email,
    password: 'new-student-password'
  }).expect(302);
  await agent.get('/portal').expect(200).expect(/Tokens today/);

  const reused = await request(app).get(`/invite/${invite.token}`).expect(200);
  assert.match(reused.text, /invalid or expired/);
});

test('admin can regenerate password invite links for lost passwords', async () => {
  const student = createStudent();
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);

  const firstPost = await agent.post(`/admin/users/${student.id}/invite`).expect(302);
  const first = await agent.get(firstPost.headers.location).expect(200);
  assert.match(first.text, new RegExp(student.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(first.text, new RegExp(student.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const firstToken = first.text.match(/ieti_inv_[A-Za-z0-9_-]+/)[0];
  const secondPost = await agent.post(`/admin/users/${student.id}/invite`).expect(302);
  const second = await agent.get(secondPost.headers.location).expect(200);
  const secondToken = second.text.match(/ieti_inv_[A-Za-z0-9_-]+/)[0];

  assert.notEqual(firstToken, secondToken);
  await request(app).get(`/invite/${firstToken}`).expect(200).expect(/invalid or expired/);
  await request(app).get(`/invite/${secondToken}`).expect(200).expect(/Set Password/);
});
