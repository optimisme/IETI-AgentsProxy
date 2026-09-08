const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const request = require('supertest');
const { probeProviderModel } = require('../src/services/providerProbeService');
const { prepareAssistantHistory, normalizeChatReasoning, normalizeReasoningEvent } = require('../src/utils/reasoningHistory');

function completion(message, finish_reason = 'stop') {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message }, finish_reason }] }), { status: 200 });
}
const missing = 'Assistant message is missing a thinking field. Provide one of: think, reasoning, reasoning_content, think_fast, think_faster.';
function reject(message, status = 400) { return new Response(JSON.stringify({ error: { message } }), { status }); }
function fixture(body) {
  if (body.messages.some((message) => message.role === 'assistant' && !Object.hasOwn(message, 'reasoning_content'))) return reject(missing);
  if (body.messages.some((message) => Array.isArray(message.content))) return reject('This model does not support image input.');
  if (body.messages.some((message) => message.role === 'tool')) return completion({ content: 'violet amber', reasoning: 'Use the tool results.' });
  if (body.tools) return completion({ content: null, reasoning_content: 'Look up both codes.', tool_calls: ['A', 'B'].map((code) => ({
    id: `call_${code}`, type: 'function', function: { name: 'lookup_probe', arguments: JSON.stringify({ code }) }
  })) }, 'tool_calls');
  return completion({ content: 'OK', reasoning: 'The requested answer is OK.' });
}

test('probes verify history repair and tool round trips, distinguish explicit image rejection, and retain useful errors', async () => {
  const bodies = [];
  const result = await probeProviderModel({ baseUrl: 'http://provider/v1', apiKey: 'test-key', model: 'active-model', fetchImpl: async (url, options) => {
    assert.equal(url, 'http://provider/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body); bodies.push(body); return fixture(body);
  } });
  assert.deepEqual(result.settings, { supports_reasoning: 1, supports_text_input: 1, reasoning_history_field: 'reasoning_content', supports_tools: 1, supports_parallel_tools: 1, supports_image_input: 0 });
  assert.equal(bodies.length, 7);
  assert.match(result.results.find((item) => item.name === 'Assistant history without reasoning').message, /missing a thinking field/);
  assert.equal(result.results.find((item) => item.name === 'Assistant history without reasoning').httpStatus, 400);
  assert.equal(result.results.find((item) => item.name === 'Tool result round trip').status, 'supported');
  assert.equal(bodies[4].messages[1].reasoning_content, 'Look up both codes.');
  assert.equal(JSON.stringify(result).includes('Look up both codes.'), false, 'Do not expose model reasoning in diagnostics');
  assert.equal(result.settings.reasoning_efforts, undefined);
});

test('timeouts, authentication, rate limits and server errors leave settings unknown and redact secrets', async () => {
  for (const status of [401, 429, 500, 503]) {
    let calls = 0;
    const result = await probeProviderModel({ baseUrl: 'http://provider', model: 'm', apiKey: 'secret-key', fetchImpl: async () => {
      calls++; return reject('Temporarily unavailable; Bearer secret-key', status);
    } });
    assert.deepEqual(result.settings, {}); assert.equal(calls, 1);
    assert.equal(result.results[0].httpStatus, status);
    assert.equal(result.results[0].status, 'inconclusive');
    assert.doesNotMatch(JSON.stringify(result), /secret-key/);
  }
  const timeout = await probeProviderModel({ baseUrl: 'http://provider', model: 'm', fetchImpl: async () => { throw new DOMException('expired', 'TimeoutError'); } });
  assert.match(timeout.results[0].message, /timed out/);
  assert.deepEqual(timeout.settings, {});
  const bodyTimeout = await probeProviderModel({ baseUrl: 'http://provider', model: 'm', fetchImpl: async () => ({
    status: 200, ok: true, json: async () => { throw new DOMException('expired', 'TimeoutError'); }
  }) });
  assert.match(bodyTimeout.results[0].message, /timed out/);
});

test('HTTP 200 that ignores tools and image parameters does not establish those capabilities', async () => {
  const result = await probeProviderModel({ baseUrl: 'http://provider', model: 'm', fetchImpl: async () => completion({ content: 'OK' }) });
  assert.equal(result.settings.supports_tools, undefined);
  assert.equal(result.settings.supports_image_input, undefined);
  assert.equal(result.settings.supports_reasoning, undefined);
  assert.match(result.results.find((item) => item.name === 'Tool calling').message, /No valid tool call/);
  const budget = await probeProviderModel({ baseUrl: 'http://provider', model: 'm', budgetMs: 0, fetchImpl: async () => { throw new Error('Must not call'); } });
  assert.match(budget.results[0].message, /budget exhausted/);
});

test('truncated reasoning can retry with a smaller effort without claiming all reasoning controls are supported', async () => {
  const bodies = [];
  const result = await probeProviderModel({ baseUrl: 'http://provider', model: 'm', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    return body.reasoning_effort === 'low' ? completion({ content: 'OK', reasoning: 'Done.' })
      : completion({ content: '', reasoning: 'Incomplete reasoning' }, 'length');
  } });
  assert.equal(bodies[0].reasoning_effort, undefined);
  assert.equal(bodies[1].reasoning_effort, 'low');
  assert.equal(result.settings.supports_text_input, 1);
  assert.equal(result.settings.reasoning_efforts, undefined);
  assert.equal(result.results[0].status, 'inconclusive');
});

test('rejecting parallel_tool_calls does not disable otherwise working tools', async () => {
  const result = await probeProviderModel({ baseUrl: 'http://provider', model: 'm', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    return body.parallel_tool_calls === true ? reject('Unsupported parameter: parallel_tool_calls') : fixture(body);
  } });
  assert.equal(result.settings.supports_tools, 1);
  assert.equal(result.settings.supports_parallel_tools, 0);
  assert.equal(result.results.find((item) => item.name === 'Tool calling').status, 'unsupported');
  assert.equal(result.results.find((item) => item.name === 'Tool result round trip').status, 'supported');
});

test('streaming probes require complete SSE and surface errors inside HTTP 200 streams', async () => {
  for (const failed of [false, true]) {
    const result = await probeProviderModel({ baseUrl: 'http://provider', model: 'm', fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (!body.stream) return fixture(body);
      const chunk = failed ? { error: { message: 'Streaming parser failed.' } }
        : { choices: [{ delta: { content: 'OK', reasoning: 'Done.' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\r\n\r\ndata: [DONE]\r\n\r\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    const streaming = result.results.find((item) => item.name === 'Streaming assistant history');
    assert.equal(streaming.httpStatus, 200);
    assert.equal(streaming.status, failed ? 'inconclusive' : 'supported');
    if (failed) assert.match(streaming.message, /Streaming parser failed/);
  }
});

test('history normalization is provider scoped, preserves actual reasoning, and leaves the caller payload unchanged', () => {
  const messages = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'OK', reasoning: 'Actual reasoning', tool_calls: [{ id: 'a' }] }, { role: 'assistant', content: 'Old message' }];
  assert.equal(prepareAssistantHistory(messages, null), messages);
  const prepared = prepareAssistantHistory(messages, 'reasoning_content');
  assert.equal(prepared[1].reasoning_content, 'Actual reasoning');
  assert.equal(prepared[2].reasoning_content, '');
  assert.equal(messages[1].reasoning_content, undefined);
  const existing = [{ role: 'assistant', reasoning_content: 'Preserve', reasoning: 'Other' }];
  assert.equal(prepareAssistantHistory(existing, 'reasoning_content')[0].reasoning_content, 'Preserve');
});

test('JSON and SSE normalization preserve framing, content, tools and existing reasoning_content', () => {
  const body = { choices: [{ message: { reasoning: 'Actual', content: 'OK', tool_calls: [{ id: 'a' }] } }] };
  assert.equal(normalizeChatReasoning(body).choices[0].message.reasoning_content, 'Actual');
  const event = 'id: 42\r\nevent: message\r\n: comment\r\ndata: {"choices":[{"delta":{"reasoning":"Raó"}}]}';
  const normalized = normalizeReasoningEvent(event);
  assert.match(normalized, /^id: 42\r\nevent: message\r\n: comment\r\ndata: /);
  assert.match(normalized, /"reasoning_content":"Raó"/);
  for (const unchanged of ['data: [DONE]', ': ping', 'data: broken JSON', 'data: {"choices":[{"delta":{"reasoning":"other","reasoning_content":"original"}}]}']) {
    assert.equal(normalizeReasoningEvent(unchanged), unchanged);
  }
});

test('autoconfigure uses official data first, tests only the selected model and persists only reviewed settings', async () => {
  const seen = [];
  let catalog = { data: [{ id: 'active-model', owned_by: 'vllm', max_model_len: 32768, supports_image_input: true }] };
  const server = http.createServer(async (req, res) => {
    seen.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify(catalog));
    if (req.url === '/version') return res.end(JSON.stringify({ version: 'test' }));
    if (req.url === '/v1/chat/completions') {
      let text = ''; for await (const chunk of req) text += chunk;
      const response = fixture(JSON.parse(text));
      res.statusCode = response.status; return res.end(await response.text());
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `provider-probe-${process.pid}-${Date.now()}.sqlite`);
  process.env.ADMIN_USERNAME = 'admin'; process.env.ADMIN_PASSWORD = 'secret'; process.env.PUBLIC_BASE_URL = '';
  process.env.SESSION_SECRET = 'probe-test-session-secret-with-enough-length';
  const app = require('../src/app').createApp();
  const db = require('../src/db').getDb();
  try {
    const providerId = db.prepare("INSERT INTO providers (slug, name, base_url, api_key) VALUES ('probe-test', 'Probe test', ?, 'secret-key')")
      .run(`http://127.0.0.1:${server.address().port}`).lastInsertRowid;
    db.prepare("INSERT INTO provider_models (provider_id, public_model, upstream_model, name, context_limit, output_limit) VALUES (?, 'my-alias', 'old-model', 'Probe test', 4096, 2048)").run(providerId);
    const agent = request.agent(app);
    await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
    const edit = await agent.get(`/admin/providers/${providerId}`).expect(200);
    assert.doesNotMatch(edit.text, /Metadata URL/);
    for (const script of edit.text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new (require('node:vm').Script)(script[1]);
    const endpoint = `/admin/providers/${providerId}/autoconfigure.json`;
    const preview = await agent.post(endpoint).send({ apply: false }).expect(200);
    assert.deepEqual(seen.slice(0, 2), ['/v1/models', '/version']);
    assert.equal(seen.includes('/ieti/capabilities'), false);
    assert.equal(preview.body.models[0].settings.supports_image_input, 1, 'Official true takes priority over test rejection');
    assert.match(preview.body.detail, /conflicts with the published value/);
    assert.match(preview.body.detail, /HTTP 400/);
    assert.match(preview.body.detail, /missing a thinking field/);
    assert.equal(db.prepare('SELECT upstream_model FROM provider_models WHERE provider_id = ?').get(providerId).upstream_model, 'old-model');
    await agent.post(endpoint).send({ apply: true }).expect(200);
    const saved = db.prepare('SELECT * FROM provider_models WHERE provider_id = ?').get(providerId);
    assert.equal(saved.context_limit, 32768); assert.equal(saved.output_limit, 2048);
    assert.equal(saved.public_model, 'my-alias'); assert.equal(saved.reasoning_history_field, 'reasoning_content');
    assert.equal(saved.supports_tools, 1);
    catalog.data[0].supports_tools = false;
    await agent.post(endpoint).send({ apply: true }).expect(200);
    assert.equal(db.prepare('SELECT supports_tools FROM provider_models WHERE provider_id = ?').get(providerId).supports_tools, 0,
      'An explicit official false has priority over a successful tool probe');
    catalog = { data: [{ id: 'other-a' }, { id: 'other-b' }] }; seen.length = 0;
    const choose = await agent.post(endpoint).send({ apply: false }).expect(200);
    assert.equal(choose.body.selectedModel, null); assert.deepEqual(seen, ['/v1/models']);
    db.exec('ALTER TABLE provider_models DROP COLUMN reasoning_history_field');
    require('../src/db').closeDb();
    const migrated = require('../src/db').getDb();
    assert.ok(migrated.prepare('PRAGMA table_info(provider_models)').all().some((column) => column.name === 'reasoning_history_field'));
    assert.equal(migrated.prepare('SELECT context_limit FROM provider_models WHERE provider_id = ?').get(providerId).context_limit, 32768);
  } finally {
    require('../src/db').closeDb();
    await new Promise((resolve) => server.close(resolve));
  }
});
