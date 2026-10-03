const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-keep-warm-'));
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'test.sqlite');
process.env.DEFAULT_PROVIDER_API_KEY = '';
process.env.DEFAULT_PROVIDER_BASE_URL = 'http://unused.example.test';
process.env.GOOGLE_OAUTH_ENABLED = 'false';
process.env.PUBLIC_BASE_URL = '';
process.env.REQUEST_TIMEOUT_MS = '1000';

const { getDb, closeDb } = require('../src/db');
const { getInFlight, reserveProviderForTest } = require('../src/services/providerService');
const { createProviderKeepWarmService, KEEP_WARM_INTERVAL_MS } = require('../src/services/providerKeepWarmService');
const db = getDb();

test.beforeEach(() => {
  db.prepare('DELETE FROM providers').run();
  db.prepare('DELETE FROM usage_logs').run();
});
test.after(() => {
  closeDb();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function addModel(providerId, overrides = {}) {
  const model = {
    public_model: `alias-${providerId}`,
    upstream_model: `upstream-${providerId}`,
    enabled: 1,
    supports_text_input: 1,
    output_limit: 1024,
    updated_at: '2026-01-01 00:00:00',
    ...overrides
  };
  return db.prepare(`
    INSERT INTO provider_models
      (provider_id, public_model, upstream_model, name, enabled, supports_text_input, output_limit, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(providerId, model.public_model, model.upstream_model, 'Test Model', model.enabled,
    model.supports_text_input, model.output_limit, model.updated_at).lastInsertRowid;
}

function addProvider(slug, overrides = {}, modelOverrides = {}) {
  const provider = {
    base_url: `http://${slug}.example.test`, api_key: `test-key-${slug}`,
    enabled: 1, keep_warm_interval_minutes: 1, max_concurrent_requests: 1, timeout_ms: 1000,
    ...overrides
  };
  const id = db.prepare(`
    INSERT INTO providers
      (slug, name, base_url, api_key, enabled, keep_warm_interval_minutes, max_concurrent_requests, timeout_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, slug, provider.base_url, provider.api_key, provider.enabled, provider.keep_warm_interval_minutes,
    provider.max_concurrent_requests, provider.timeout_ms).lastInsertRowid;
  if (modelOverrides !== false) addModel(id, modelOverrides);
  return { id, slug, ...provider };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const flushWork = () => new Promise((resolve) => setImmediate(resolve));
const successResponse = () => ({ ok: true, status: 200, text: async () => 'OK' });

function makeService(t, fetchImpl) {
  const warnings = [];
  let currentTime = 0;
  const service = createProviderKeepWarmService({
    fetchImpl,
    now: () => currentTime,
    logger: { warn: (message) => warnings.push(message) }
  });
  t.after(() => service.stop());
  return { service, warnings, advance: (milliseconds) => { currentTime += milliseconds; } };
}

test('keep-warm calls only eligible providers with one current upstream model and does not write usage or quotas', async (t) => {
  const first = addProvider('eligible', {}, { upstream_model: 'old-model', updated_at: '2025-01-01 00:00:00' });
  addModel(first.id, { public_model: 'current-alias', upstream_model: 'current-model', updated_at: '2026-02-01 00:00:00' });
  addModel(first.id, { public_model: 'disabled-alias', upstream_model: 'disabled-model', enabled: 0, updated_at: '2026-03-01 00:00:00' });
  const second = addProvider('eligible-v1', { base_url: 'http://eligible-v1.example.test/v1/' }, { output_limit: 2 });
  addProvider('unselected', { keep_warm_interval_minutes: 0 });
  addProvider('disabled', { enabled: 0 });
  addProvider('no-model', {}, false);
  addProvider('disabled-model', {}, { enabled: 0 });
  addProvider('no-text', {}, { supports_text_input: 0 });
  addProvider('no-upstream-model', {}, { upstream_model: '  ' });
  addProvider('no-key', { api_key: '  ' });
  addProvider('no-url', { base_url: '  ' });
  const calls = [];
  const { service, warnings } = makeService(t, async (url, options) => {
    calls.push({ url, options, payload: JSON.parse(options.body) });
    return successResponse();
  });
  const changesBefore = db.prepare('SELECT total_changes() AS count').get().count;
  await service.runOnce();
  assert.equal(db.prepare('SELECT total_changes() AS count').get().count, changesBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_logs').get().count, 0);
  assert.deepEqual(calls.map((call) => [call.url, call.payload.model, call.payload.max_tokens]), [
    ['http://eligible.example.test/v1/chat/completions', 'current-model', 8],
    ['http://eligible-v1.example.test/v1/chat/completions', `upstream-${second.id}`, 2]
  ]);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.Authorization, `Bearer ${[first, second][index].api_key}`);
    assert.equal(call.options.headers['Content-Type'], 'application/json');
    assert.equal(call.payload.stream, false);
    assert.equal(call.payload.messages.length, 1);
    assert.equal(call.payload.messages[0].role, 'user');
    assert.ok(call.payload.messages[0].content.length <= 20);
    assert.ok(call.payload.max_tokens > 0 && call.payload.max_tokens <= 8);
    assert.equal(getInFlight([first, second][index].slug), 0);
  }
  assert.deepEqual(warnings, []);
});

test('keep-warm reads provider selections, credentials, URLs, and model changes on each run', async (t) => {
  const previous = addProvider('previous');
  const next = addProvider('next', { keep_warm_interval_minutes: 0 });
  const calls = [];
  const { service, advance } = makeService(t, async (url, options) => {
    calls.push({ url, key: options.headers.Authorization, model: JSON.parse(options.body).model });
    return successResponse();
  });
  await service.runOnce();
  db.prepare('UPDATE providers SET keep_warm_interval_minutes = 0 WHERE id = ?').run(previous.id);
  db.prepare('UPDATE providers SET keep_warm_interval_minutes = 1, base_url = ?, api_key = ? WHERE id = ?')
    .run('http://changed.example.test/v1', 'changed-test-key', next.id);
  db.prepare('UPDATE provider_models SET upstream_model = ? WHERE provider_id = ?').run('changed-upstream', next.id);
  advance(60000);
  await service.runOnce();
  assert.deepEqual(calls, [
    { url: 'http://previous.example.test/v1/chat/completions', key: `Bearer ${previous.api_key}`, model: `upstream-${previous.id}` },
    { url: 'http://changed.example.test/v1/chat/completions', key: 'Bearer changed-test-key', model: 'changed-upstream' }
  ]);
});

test('keep-warm skips student traffic and holds shared capacity through response bodies without overlapping calls', async (t) => {
  const slow = addProvider('slow');
  const independent = addProvider('independent');
  const body = deferred();
  const calls = [];
  const { service, advance } = makeService(t, async (url) => {
    calls.push(url);
    return url.includes('slow.') ? { ok: true, status: 200, text: () => body.promise } : successResponse();
  });
  t.after(() => body.resolve('OK'));
  const releaseStudent = reserveProviderForTest(slow.slug);
  t.after(releaseStudent);
  await service.runOnce();
  assert.deepEqual(calls, ['http://independent.example.test/v1/chat/completions']);
  assert.equal(getInFlight(slow.slug), 1);
  releaseStudent();

  const pending = service.runOnce();
  await flushWork();
  assert.equal(getInFlight(slow.slug), 1);
  assert.equal(getInFlight(independent.slug), 0);
  assert.throws(() => reserveProviderForTest(slow.slug), { code: 'provider_capacity_exceeded' });
  advance(60000);
  await service.runOnce();
  assert.equal(calls.filter((url) => url.includes('slow.')).length, 1);
  assert.equal(calls.filter((url) => url.includes('independent.')).length, 2);
  await service.runOnce();
  assert.equal(calls.filter((url) => url.includes('slow.')).length, 1);
  assert.equal(calls.filter((url) => url.includes('independent.')).length, 2);
  body.resolve('OK');
  await pending;
  assert.equal(getInFlight(slow.slug), 0);
});

test('keep-warm releases reservations after fetch, body, and HTTP failures without logging secrets', async (t) => {
  const providers = ['fetch-error', 'body-error', 'http-error'].map((slug) => addProvider(slug, {
    api_key: 'private-test-secret', keep_warm_interval_minutes: 5
  }));
  let fail = true;
  let calls = 0;
  const { service, warnings, advance } = makeService(t, async (url) => {
    calls += 1;
    if (!fail) return successResponse();
    if (url.includes('fetch-error.')) throw new Error(`private-test-secret ${url}`);
    if (url.includes('body-error.')) return { ok: true, status: 200, text: async () => { throw new Error('private-test-secret body'); } };
    return { ok: false, status: 503, text: async () => 'private-test-secret upstream response' };
  });
  await service.runOnce();
  assert.equal(warnings.length, 3);
  assert.match(warnings.join('\n'), /HTTP 503/);
  assert.doesNotMatch(warnings.join('\n'), /private-test-secret|example\.test|upstream response/);
  for (const provider of providers) assert.equal(getInFlight(provider.slug), 0);
  fail = false;
  await service.runOnce();
  advance(299999);
  await service.runOnce();
  assert.equal(calls, 3);
  advance(1);
  await service.runOnce();
  assert.equal(calls, 6);
  assert.equal(warnings.length, 3);
  for (const provider of providers) assert.equal(getInFlight(provider.slug), 0);
});

async function hangingServer(t, phase) {
  const server = http.createServer((req, res) => {
    req.resume();
    if (phase === 'body') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"partial":');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const phase of ['headers', 'body']) {
  test(`keep-warm times out while upstream ${phase} remain pending and releases capacity`, { timeout: 3000 }, async (t) => {
    const baseUrl = await hangingServer(t, phase);
    // Allow a slower deployment VM to receive headers before exercising a stalled body.
    const provider = addProvider(`timeout-${phase}`, { base_url: baseUrl, timeout_ms: 500 });
    let readingBody = false;
    const { service, warnings } = makeService(t, async (url, options) => {
      const response = await fetch(url, options);
      return {
        ok: response.ok,
        status: response.status,
        text: () => { readingBody = true; return response.text(); }
      };
    });
    await service.runOnce();
    assert.equal(readingBody, phase === 'body');
    assert.equal(getInFlight(provider.slug), 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /timed out/);
    assert.doesNotMatch(warnings[0], /127\.0\.0\.1|test-key/);
  });
}

test('stopping keep-warm aborts a pending body, releases capacity, and prevents future calls', { timeout: 1500 }, async (t) => {
  const baseUrl = await hangingServer(t, 'body');
  const provider = addProvider('stopped', { base_url: baseUrl });
  const bodyStarted = deferred();
  let signal;
  let calls = 0;
  const { service, warnings } = makeService(t, async (url, options) => {
    calls += 1;
    signal = options.signal;
    const response = await fetch(url, options);
    return {
      ok: response.ok,
      status: response.status,
      text: () => { bodyStarted.resolve(); return response.text(); }
    };
  });
  const pending = service.runOnce();
  await bodyStarted.promise;
  assert.equal(getInFlight(provider.slug), 1);
  service.stop();
  assert.equal(signal.aborted, true);
  await pending;
  assert.equal(getInFlight(provider.slug), 0);
  await service.runOnce();
  assert.equal(calls, 1);
  assert.deepEqual(warnings, []);
});

test('keep-warm starts immediately, runs every minute, avoids duplicate timers, and stops its timer', async (t) => {
  addProvider('cadence');
  let calls = 0;
  const { service, advance } = makeService(t, async () => { calls += 1; return successResponse(); });
  t.mock.timers.enable({ apis: ['setInterval'] });
  assert.equal(KEEP_WARM_INTERVAL_MS, 60000);
  service.start();
  service.start();
  assert.equal(calls, 1);
  await flushWork();
  advance(59999);
  t.mock.timers.tick(59999);
  assert.equal(calls, 1);
  advance(1);
  t.mock.timers.tick(1);
  assert.equal(calls, 2);
  await flushWork();
  advance(60000);
  t.mock.timers.tick(60000);
  assert.equal(calls, 3);
  await flushWork();
  service.stop();
  advance(120000);
  t.mock.timers.tick(120000);
  assert.equal(calls, 3);
});

test('keep-warm polls each minute while honoring mixed one-minute, five-minute, and Never schedules', async (t) => {
  addProvider('minute', { keep_warm_interval_minutes: 1 });
  addProvider('five', { keep_warm_interval_minutes: 5 });
  addProvider('never', { keep_warm_interval_minutes: 0 });
  const defaultProviderId = db.prepare(`
    INSERT INTO providers (slug, name, base_url, api_key)
    VALUES ('default-never', 'Default Never', 'http://default-never.example.test', 'default-test-key')
  `).run().lastInsertRowid;
  addModel(defaultProviderId);
  assert.equal(db.prepare('SELECT keep_warm_interval_minutes FROM providers WHERE id = ?')
    .get(defaultProviderId).keep_warm_interval_minutes, 0);

  const calls = [];
  const { service, advance, warnings } = makeService(t, async (url) => {
    calls.push(new URL(url).hostname.split('.')[0]);
    return successResponse();
  });
  const count = (slug) => calls.filter((call) => call === slug).length;
  t.mock.timers.enable({ apis: ['setInterval'] });
  service.start();
  await flushWork();
  assert.equal(count('minute'), 1);
  assert.equal(count('five'), 1);
  assert.equal(count('never'), 0);
  assert.equal(count('default-never'), 0);
  await service.runOnce();
  assert.equal(calls.length, 2);

  for (let minute = 1; minute <= 10; minute += 1) {
    advance(60000);
    t.mock.timers.tick(60000);
    await flushWork();
    assert.equal(count('minute'), minute + 1);
    assert.equal(count('five'), Math.floor(minute / 5) + 1);
    assert.equal(count('never'), 0);
    assert.equal(count('default-never'), 0);
  }
  assert.deepEqual(warnings, []);
});

test('keep-warm maintains scheduled cadence after callback jitter without catch-up duplicates', async (t) => {
  addProvider('jitter-minute', { keep_warm_interval_minutes: 1 });
  addProvider('jitter-five', { keep_warm_interval_minutes: 5 });
  const calls = [];
  const { service, advance } = makeService(t, async (url) => {
    calls.push(new URL(url).hostname.split('.')[0]);
    return successResponse();
  });
  const count = (slug) => calls.filter((call) => call === slug).length;
  let previousTime = 0;
  for (const [time, minuteCalls, fiveMinuteCalls] of [
    [0, 1, 1],
    [60001, 2, 1],
    [120000, 3, 1],
    [300001, 4, 2],
    [600000, 5, 3]
  ]) {
    advance(time - previousTime);
    previousTime = time;
    await service.runOnce();
    assert.equal(count('jitter-minute'), minuteCalls, `One-minute calls at ${time} ms`);
    assert.equal(count('jitter-five'), fiveMinuteCalls, `Five-minute calls at ${time} ms`);
    await service.runOnce();
    assert.equal(count('jitter-minute'), minuteCalls, 'Repeated checks do not replay missed calls');
    assert.equal(count('jitter-five'), fiveMinuteCalls, 'Repeated checks do not replay missed calls');
  }
});

test('keep-warm honors a shorter saved interval and resets eligibility after Never is selected', async (t) => {
  const provider = addProvider('changed-interval', { keep_warm_interval_minutes: 5 });
  let calls = 0;
  const { service, advance } = makeService(t, async () => { calls += 1; return successResponse(); });
  await service.runOnce();
  assert.equal(calls, 1);
  advance(60000);
  db.prepare('UPDATE providers SET keep_warm_interval_minutes = 1 WHERE id = ?').run(provider.id);
  await service.runOnce();
  assert.equal(calls, 2);

  db.prepare('UPDATE providers SET keep_warm_interval_minutes = 0 WHERE id = ?').run(provider.id);
  await service.runOnce();
  advance(60000);
  await service.runOnce();
  assert.equal(calls, 2);
  db.prepare('UPDATE providers SET keep_warm_interval_minutes = 5 WHERE id = ?').run(provider.id);
  await service.runOnce();
  assert.equal(calls, 3);
  await service.runOnce();
  assert.equal(calls, 3);
});
