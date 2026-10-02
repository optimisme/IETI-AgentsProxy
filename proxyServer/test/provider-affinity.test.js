const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const request = require('supertest');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-affinity-'));
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'test.sqlite');
process.env.DEFAULT_PROVIDER_API_KEY = '';
process.env.PUBLIC_BASE_URL = '';
process.env.GOOGLE_OAUTH_ENABLED = 'false';
process.env.SESSION_SECRET = 'affinity-test-only-secret';
process.env.REQUEST_TIMEOUT_MS = '1500';
process.env.STREAM_INACTIVITY_TIMEOUT_MS = '1000';
process.env.MAX_REQUESTS_PER_MINUTE = '1000';

const { getDb, closeDb } = require('../src/db');
const { createAffinityStore, affinityContextFromRequest } = require('../src/services/conversationAffinityService');
const { createProviderAvailability, providerAvailability } = require('../src/services/providerAvailabilityService');
const { callChatCompletions, chooseProviderModel, getInFlight, reserveProviderForTest } = require('../src/services/providerService');
const { getUsageTotals } = require('../src/services/usageService');
const keys = require('../src/services/keyService');
const { createApp } = require('../src/app');
const pool = ['affinity-a', 'affinity-b'];
const firstMessages = [{ role: 'system', content: 'Shared instructions' }, { role: 'user', content: 'Shared first template' }];
const answer = { role: 'assistant', content: 'Distinct actual answer' };
let db;
let app;
let appServer;
let upstream;
let calls = [];
let mode = 'success';
let student;
let sequence = 0;

test.before(async () => {
  upstream = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const payload = JSON.parse(text);
    calls.push(payload);
    if (mode === 'reject-all' || (mode === 'reject-a' && payload.model === 'upstream-a')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Restarting' }, usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 } }));
    }
    if (mode === 'headers-timeout') return;
    if (mode === 'auth-a' && payload.model === 'upstream-a') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Bad key' } }));
    }
    if (payload.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (mode === 'sse-error') return res.end('data: {"error":{"message":"Unavailable"},"usage":{"prompt_tokens":3,"completion_tokens":0,"total_tokens":3}}\n\n');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.content } }] })}\r\n\r\n`);
      if (mode === 'truncate') return res.end();
      if (mode === 'hold') return;
      return setTimeout(() => res.end('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\r\n\r\ndata: [DONE]'), 25);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: payload.model, choices: [{ message: answer, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  db = getDb();
  const addProvider = db.prepare("INSERT INTO providers (slug,name,base_url,api_key,priority,enabled,max_concurrent_requests) VALUES (?, ?, ?, 'fixture', ?, 1, 3)");
  const addModel = db.prepare('INSERT INTO provider_models (provider_id,public_model,upstream_model,name,enabled,supports_text_input,supports_image_input,supports_tools) VALUES (?, ?, ?, ?, 1, 1, 1, 1)');
  pool.forEach((slug, index) => {
    const id = addProvider.run(slug, slug, `http://127.0.0.1:${upstream.address().port}`, index ? 10 : 100).lastInsertRowid;
    addModel.run(id, 'affinity-model', `upstream-${index ? 'b' : 'a'}`, slug);
    addModel.run(id, 'other-model', `upstream-${index ? 'b' : 'a'}`, slug);
  });
  const group = db.prepare("INSERT INTO groups (name,provider_id,daily_call_limit,daily_token_limit,hourly_call_limit,hourly_token_limit) VALUES ('Affinity fixtures', ?, 1000, 10000000, 1000, 10000000)")
    .run(db.prepare('SELECT id FROM providers WHERE slug=?').get(pool[0]).id).lastInsertRowid;
  pool.forEach((slug) => db.prepare('INSERT INTO group_providers (group_id,provider_id,enabled,priority) VALUES (?, ?, 1, 100)').run(group, db.prepare('SELECT id FROM providers WHERE slug=?').get(slug).id));
  const key = keys.generateStudentKey();
  student = { key, id: db.prepare("INSERT INTO users (name,email,api_key_hash,api_key_lookup_hash) VALUES ('Synthetic','affinity@example.test', ?, ?)").run(keys.hashApiKey(key), keys.lookupHashApiKey(key)).lastInsertRowid };
  db.prepare('INSERT INTO user_groups (user_id,group_id) VALUES (?,?)').run(student.id, group);
  app = createApp();
  appServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => appServer.once('listening', resolve));
});

test.beforeEach(() => {
  calls = [];
  mode = 'success';
  pool.forEach((slug) => providerAvailability.succeeded(slug));
  db.prepare('UPDATE providers SET enabled=1,max_concurrent_requests=3 WHERE slug IN (?,?)').run(...pool);
  db.prepare('UPDATE providers SET base_url=? WHERE slug IN (?,?)').run(`http://127.0.0.1:${upstream.address().port}`, ...pool);
  db.prepare('UPDATE provider_models SET supports_image_input=1,enabled=1 WHERE provider_id IN (SELECT id FROM providers WHERE slug IN (?,?))').run(...pool);
  db.prepare('DELETE FROM usage_logs WHERE user_id=?').run(student.id);
  db.prepare("UPDATE settings SET value='1000' WHERE key='max_requests_per_minute'").run();
});

test.after(async () => {
  app.locals.sessionStore.close();
  appServer.closeAllConnections();
  await new Promise((resolve) => appServer.close(resolve));
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  closeDb();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function payload(conversationId = `conversation-${++sequence}`, messages = firstMessages) {
  return { model: 'affinity-model', conversation_id: conversationId, messages, max_tokens: 8 };
}
function chat(body) {
  return request(app).post('/v1/chat/completions').set('Authorization', `Bearer ${student.key}`).send(body);
}
function responses(body) {
  return request(app).post('/v1/responses').set('Authorization', `Bearer ${student.key}`).send(body);
}

test('new conversations choose least load; continuing ties prefer previous endpoint before priority', async () => {
  const body = payload();
  const release = reserveProviderForTest(pool[0]);
  try { assert.equal((await chat(body).expect(200)).body.model, 'upstream-b'); } finally { release(); }
  assert.equal((await chat({ ...body, messages: [...firstMessages, answer, { role: 'user', content: 'Continue' }] }).expect(200)).body.model, 'upstream-b');
  const busy = reserveProviderForTest(pool[1]);
  try { assert.equal((await chat(body).expect(200)).body.model, 'upstream-a'); } finally { busy(); }
  assert.equal(calls[0].conversation_id, undefined);
  assert.equal(getInFlight(pool[0]), 0);
  assert.equal(getInFlight(pool[1]), 0);
});

test('disabled, incompatible, unauthorized and full previous providers cannot be selected', async () => {
  const body = payload();
  const held = reserveProviderForTest(pool[0]);
  try { await chat(body).expect(200); } finally { held(); }
  db.prepare('UPDATE providers SET enabled=0 WHERE slug=?').run(pool[1]);
  assert.equal((await chat(body).expect(200)).body.model, 'upstream-a');
  db.prepare('UPDATE providers SET enabled=1 WHERE slug=?').run(pool[1]);
  db.prepare('UPDATE provider_models SET supports_image_input=0 WHERE provider_id=(SELECT id FROM providers WHERE slug=?)').run(pool[0]);
  const image = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] };
  assert.equal((await chat({ ...body, messages: [image] }).expect(200)).body.model, 'upstream-b');
  const affinity = createAffinityStore().request({ userId: 1, model: 'affinity-model', conversationId: 'assigned' });
  affinity.setPool(pool); affinity.complete(pool[1]);
  assert.equal(chooseProviderModel('affinity-model', [pool[0]], {}, { affinity }).slug, pool[0]);
  db.prepare('UPDATE providers SET max_concurrent_requests=1 WHERE slug=?').run(pool[1]);
  const full = reserveProviderForTest(pool[1]);
  try { assert.equal((await chat(body).expect(200)).body.model, 'upstream-a'); } finally { full(); }
});

test('prefix fallback recognizes completed answer, separates branches and ignores shared first templates', async () => {
  const body = { ...payload(), conversation_id: undefined };
  const held = reserveProviderForTest(pool[0]);
  try { await chat(body).expect(200); } finally { held(); }
  assert.equal((await chat({ ...body, messages: [...firstMessages, answer, { role: 'user', content: 'Continue' }] }).expect(200)).body.model, 'upstream-b');
  assert.equal((await chat(body).expect(200)).body.model, 'upstream-a', 'a repeated template without an assistant boundary starts fresh');
  assert.equal((await chat({ ...body, messages: [...firstMessages, { role: 'assistant', content: 'Different branch' }, { role: 'user', content: 'Continue' }] }).expect(200)).body.model, 'upstream-a');
});

test('affinity scopes user/model/pool/ID; expires and stays bounded; compaction retains only explicit affinity', () => {
  let now = 0;
  const store = createAffinityStore({ now: () => now, ttlMs: 100, maxEntries: 3 });
  const base = { userId: 1, model: 'a', conversationId: 'one', messages: firstMessages };
  const remember = store.request(base); remember.setPool(pool); remember.complete(pool[1], answer);
  assert.equal(store.request({ ...base, messages: [{ role: 'user', content: 'Compacted summary' }] }).setPool([...pool].reverse()), pool[1]);
  for (const change of [{ userId: 2 }, { model: 'b' }, { conversationId: 'two' }]) assert.equal(store.request({ ...base, ...change }).setPool(pool), null);
  assert.equal(store.request(base).setPool([pool[0]]), null);
  for (let index = 0; index < 5; index++) { const current = store.request({ ...base, conversationId: `id-${index}` }); current.setPool(pool); current.complete(pool[0]); }
  assert.equal(store.size(), 3);
  now = 101;
  assert.equal(store.size(), 0);
  const implicit = store.request({ ...base, conversationId: null }); implicit.setPool(pool); implicit.complete(pool[1], answer);
  assert.equal(store.request({ ...base, conversationId: null, messages: [{ role: 'user', content: 'Compacted summary' }] }).setPool(pool), null);
  assert.equal(store.request({ ...base, conversationId: null, messages: [...firstMessages, { ...answer, content: [{ type: 'text', text: answer.content }], reasoning_content: 'ignored' }, { role: 'user', content: 'Next' }] }).setPool(pool), pool[1]);
});

test('identifier validation supports header, metadata and Responses conversation object', () => {
  const req = { student: { id: 1 }, get: () => 'header-id' };
  assert.equal(affinityContextFromRequest(req, {}).conversationId, 'header-id');
  assert.equal(affinityContextFromRequest(req, { metadata: { conversation_id: 'metadata-id' } }).conversationId, 'metadata-id');
  assert.equal(affinityContextFromRequest(req, { conversation: { id: 'response-id' } }).conversationId, 'response-id');
  assert.throws(() => affinityContextFromRequest(req, { conversation_id: 'bad id' }), /opaque string/);
});

test('transient rejection falls back once, holds only final reservation and charges known retry tokens without extra calls', async () => {
  mode = 'reject-a';
  const body = payload();
  const result = await chat(body).expect(200);
  assert.equal(result.body.model, 'upstream-b');
  assert.equal(calls.length, 2);
  assert.equal(getInFlight(pool[0]), 0); assert.equal(getInFlight(pool[1]), 0);
  const usage = db.prepare('SELECT provider_slug,status,total_tokens FROM usage_logs WHERE user_id=? ORDER BY id').all(student.id);
  assert.deepEqual(usage.map((entry) => [entry.provider_slug, entry.status, entry.total_tokens]), [[pool[0], 'upstream_retry', 3], [pool[1], 'success', 7]]);
  assert.equal(getUsageTotals(student.id).todayCalls, 1);
  assert.equal(getUsageTotals(student.id).todayTokens, 10);
  assert.equal((await chat(payload()).expect(200)).body.model, 'upstream-b', 'cooldown bypasses unavailable endpoint without a probe');
  assert.equal(calls.length, 3);
});

test('nontransient auth failure is not retried; terminal rejection records usage once and release is idempotent', async () => {
  mode = 'auth-a';
  await chat(payload()).expect(502);
  assert.equal(calls.length, 1);
  assert.equal(getInFlight(pool[0]), 0);
  mode = 'reject-a';
  const blocked = reserveProviderForTest(pool[1]);
  db.prepare('UPDATE providers SET max_concurrent_requests=1 WHERE slug=?').run(pool[1]);
  try { await chat(payload()).expect(503); } finally { blocked(); blocked(); }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_logs WHERE user_id=? AND status='upstream_retry'").get(student.id).n, 0);
  assert.equal(getUsageTotals(student.id).todayTokens, 3);
  assert.equal(getInFlight(pool[1]), 0);
});

test('connection refusal falls back without charging unknown usage; aborted requests reserve nothing; retries are capped at two', async () => {
  const closedServer = http.createServer();
  await new Promise((resolve) => closedServer.listen(0, '127.0.0.1', resolve));
  const closedPort = closedServer.address().port;
  await new Promise((resolve) => closedServer.close(resolve));
  db.prepare('UPDATE providers SET base_url=? WHERE slug=?').run(`http://127.0.0.1:${closedPort}`, pool[0]);
  assert.equal((await chat(payload()).expect(200)).body.model, 'upstream-b');
  assert.equal(calls.length, 1);
  assert.equal(getUsageTotals(student.id).todayTokens, 7);
  await assert.rejects(callChatCompletions(payload(), { signal: AbortSignal.abort(), providerSlugs: pool }), { name: 'AbortError' });
  assert.equal(getInFlight(pool[0]), 0); assert.equal(getInFlight(pool[1]), 0);
  db.prepare('UPDATE providers SET base_url=? WHERE slug=?').run(`http://127.0.0.1:${upstream.address().port}`, pool[0]);
  pool.forEach((slug) => providerAvailability.succeeded(slug));
  mode = 'reject-all'; calls = [];
  await chat(payload()).expect(503);
  assert.equal(calls.length, 2);
  assert.equal(getInFlight(pool[0]), 0); assert.equal(getInFlight(pool[1]), 0);
  assert.equal(getUsageTotals(student.id).todayCalls, 2);
  assert.equal(getUsageTotals(student.id).todayTokens, 13);
});

test('Responses metadata identifier retains affinity through compaction and isolates model changes', async () => {
  const body = { model: 'affinity-model', metadata: { conversation_id: `responses-${++sequence}` }, input: 'Synthetic' };
  const held = reserveProviderForTest(pool[0]);
  try { await responses(body).expect(200); } finally { held(); }
  await responses({ ...body, input: 'Compacted conversation summary' }).expect(200);
  assert.equal(calls.at(-1).model, 'upstream-b');
  await responses({ ...body, model: 'other-model' }).expect(200);
  assert.equal(calls.at(-1).model, 'upstream-a');
  assert.equal(calls.at(-1).metadata, undefined);
});

test('stream completion accepts CRLF and trailing fragments for Chat and Responses and seeds implicit affinity', async () => {
  const held = reserveProviderForTest(pool[0]);
  const body = { ...payload(), conversation_id: undefined, stream: true };
  try { assert.match((await chat(body).expect(200)).text, /Distinct actual answer/); } finally { held(); }
  assert.equal((await chat({ ...body, stream: false, messages: [...firstMessages, answer, { role: 'user', content: 'After stream' }] }).expect(200)).body.model, 'upstream-b');
  const converted = await responses({ model: 'affinity-model', conversation_id: `responses-${++sequence}`, input: 'Synthetic', stream: true }).expect(200);
  assert.match(converted.text, /response.completed/);
  assert.equal(getInFlight(pool[0]), 0); assert.equal(getInFlight(pool[1]), 0);
});

test('SSE errors and incomplete streams fail without replay, retain reported usage and cool down endpoint', async () => {
  for (const currentMode of ['sse-error', 'truncate']) {
    mode = currentMode; pool.forEach((slug) => providerAvailability.succeeded(slug)); calls = [];
    const result = await chat({ ...payload(), stream: true }).expect(200);
    assert.match(result.text, /stream_error/);
    assert.equal(calls.length, 1);
    assert.equal(providerAvailability.available(pool[0]), false);
    assert.equal(getInFlight(pool[0]), 0);
    const last = db.prepare('SELECT status,total_tokens FROM usage_logs WHERE user_id=? ORDER BY id DESC LIMIT 1').get(student.id);
    assert.equal(last.status, 'upstream_error'); assert.ok(last.total_tokens > 0);
  }
  mode = 'sse-error'; pool.forEach((slug) => providerAvailability.succeeded(slug)); calls = [];
  assert.match((await responses({ model: 'affinity-model', input: 'Synthetic', stream: true }).expect(200)).text, /response.failed/);
  assert.equal(calls.length, 1); assert.equal(getInFlight(pool[0]), 0);
});

test('cancellation holds a streaming reservation until disconnect, releases it once and never retries', async () => {
  mode = 'hold';
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${appServer.address().port}/v1/chat/completions`, {
    method: 'POST', signal: controller.signal,
    headers: { Authorization: `Bearer ${student.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload(), stream: true })
  });
  const reader = response.body.getReader();
  await reader.read();
  assert.equal(getInFlight(pool[0]), 1);
  controller.abort();
  await reader.cancel().catch(() => {});
  for (let index = 0; index < 100 && getInFlight(pool[0]); index++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(getInFlight(pool[0]), 0); assert.equal(calls.length, 1);
  assert.equal(providerAvailability.available(pool[0]), true, 'client cancellation does not penalize upstream health');
});

test('Responses cancellation aborts active streams and handshake timeout cools down only the failed endpoint', async () => {
  mode = 'hold';
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${appServer.address().port}/v1/responses`, {
    method: 'POST', signal: controller.signal,
    headers: { Authorization: `Bearer ${student.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'affinity-model', input: 'Synthetic cancel', stream: true })
  });
  await response.body.getReader().read();
  assert.equal(getInFlight(pool[0]), 1);
  controller.abort();
  for (let index = 0; index < 100 && getInFlight(pool[0]); index++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(getInFlight(pool[0]), 0); assert.equal(calls.length, 1);
  assert.equal(providerAvailability.available(pool[0]), true);
  mode = 'headers-timeout'; calls = [];
  await responses({ model: 'affinity-model', input: 'Synthetic timeout' }).expect(504);
  assert.equal(calls.length, 1); assert.equal(getInFlight(pool[0]), 0);
  assert.equal(providerAvailability.available(pool[0]), false);
  assert.equal(providerAvailability.available(pool[1]), true);
});

test('failure metadata has capped cooldown, bounded entries and expiry', () => {
  let now = 0;
  const availability = createProviderAvailability({ now: () => now, maxEntries: 2 });
  availability.failed('a', 10000000);
  now = 29999; assert.equal(availability.available('a'), false);
  now = 30000; assert.equal(availability.available('a'), true);
  availability.failed('b'); availability.failed('c'); assert.equal(availability.size(), 2);
  now = 330001; assert.equal(availability.size(), 0);
});
