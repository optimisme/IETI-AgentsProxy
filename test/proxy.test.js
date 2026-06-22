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

test.before(async () => {
  mockServer = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        if (payload.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
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
  process.env.MAX_TOKENS_PER_REQUEST = '131072';

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

test('database startup does not re-add the default provider to configured group pools', () => {
  const database = new Database(path.join(os.tmpdir(), `agents-proxy-startup-test-${Date.now()}.sqlite`));
  const { initSchema, migrateSchema, seedSettings } = require('../src/db');
  database.pragma('foreign_keys = ON');
  initSchema(database);
  migrateSchema(database);
  seedSettings(database);

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
    .expect(/<h2>API key<\/h2>/)
    .expect(/Regenerate API key/)
    .expect(/Revoke API key/)
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
  assert.match(list.text, /Active upstream model/);
  assert.match(list.text, /<th>Groups<\/th>/);
  assert.doesNotMatch(list.text, /<th>Models<\/th>/);
  assert.doesNotMatch(list.text, /In progress/);
  await agent.get(`/admin/providers/${provider.id}`).expect(200).expect(/API key: configured/).expect(/Delete API key/);
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

test('admin can edit provider slug and sees edit title', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const provider = db.prepare('SELECT * FROM providers WHERE slug = ?').get('deepseek');
  const replacementSlug = `deepseek-renamed-${Date.now()}`;

  const edit = await agent.get(`/admin/providers/${provider.id}`).expect(200);
  assert.match(edit.text, /<title>Edit DeepSeek<\/title>/);
  assert.match(edit.text, /<h1>Edit DeepSeek<\/h1>/);
  assert.match(edit.text, /name="slug"/);
  assert.doesNotMatch(edit.text, /name="slug"[^>]*readonly/);
  assert.match(edit.text, /Active Model Mapping/);
  assert.match(edit.text, /Public alias shown to OpenCode/);
  assert.match(edit.text, /value="active-model" readonly/);
  assert.doesNotMatch(edit.text, /<h2>Models<\/h2>/);
  assert.doesNotMatch(edit.text, /Add model/);

  await agent.post(`/admin/providers/${provider.id}`).type('form').send({
    slug: replacementSlug,
    name: provider.name,
    base_url: provider.base_url,
    api_key: '',
    enabled: '1',
    max_concurrent_requests: provider.max_concurrent_requests || '',
    timeout_ms: provider.timeout_ms || ''
  }).expect(302);

  const updated = db.prepare('SELECT slug FROM providers WHERE id = ?').get(provider.id);
  assert.equal(updated.slug, replacementSlug);
  db.prepare('UPDATE providers SET slug = ? WHERE id = ?').run(provider.slug, provider.id);
});

test('provider active mapping can be saved and tested inline', async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const provider = db.prepare('SELECT * FROM providers WHERE slug = ?').get('deepseek');

  await agent.post(`/admin/providers/${provider.id}/mapping`).type('form').send({
    upstream_model: 'deepseek-chat',
    context_limit: '65536',
    output_limit: '8192'
  }).expect(302);

  const models = db.prepare('SELECT * FROM provider_models WHERE provider_id = ?').all(provider.id);
  assert.equal(models.length, 1);
  assert.equal(models[0].public_model, 'active-model');
  assert.equal(models[0].upstream_model, 'deepseek-chat');

  const providerTest = await agent.post(`/admin/providers/${provider.id}/test.json`).expect(200);
  assert.equal(providerTest.body.ok, true);
  assert.match(providerTest.body.message, /Server test request passed/);

  const mappingTest = await agent.post(`/admin/providers/${provider.id}/mapping/test.json`).expect(200);
  assert.equal(mappingTest.body.ok, true);
  assert.match(mappingTest.body.message, /Mapping test request passed/);
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
      .send({ model: 'active-model', messages: [{ role: 'user', content: 'Say OK.' }] })
      .expect(503);
    assert.equal(blocked.body.error.code, 'provider_capacity_exceeded');
  } finally {
    release();
  }

  const ok = await request(app)
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${student.key}`)
    .send({ model: 'active-model', messages: [{ role: 'user', content: 'Say OK.' }] })
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
  `).run(provider.lastInsertRowid, 'pool-internal', 'pool-upstream', 'Pool Local');

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
  assert.deepEqual(modelsRes.body.data.map((model) => model.id), ['active-model']);

  await request(app)
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${student.key}`)
    .send({ model: 'deepseek', messages: [{ role: 'user', content: 'No access.' }] })
    .expect(403);

  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: student.email, password: student.password }).expect(302);
  const configRes = await agent.get('/portal/opencode.json').expect(200);
  assert.deepEqual(Object.keys(configRes.body.provider['ieti-agents'].models), ['active-model']);
  assert.equal(configRes.body.model, 'ieti-agents/active-model');
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

test('student portal shows usage and downloads default opencode config', async () => {
  const student = createStudent();
  const agent = request.agent(app);
  db.prepare(`
    UPDATE provider_models
    SET context_limit = 131072, output_limit = 8192
    WHERE public_model = 'active-model'
  `).run();

  await agent.get('/').expect(200).expect(/<h1>Login<\/h1>/);
  await agent.post('/login').type('form').send({ login: student.email, password: student.password }).expect(302);

  const portal = await agent.get('/portal').expect(200).expect(/Tokens today/).expect(/Provider section/).expect(/chunkTimeout/);
  assert.doesNotMatch(portal.text, /Cost EUR/);
  const configRes = await agent
    .get('/portal/opencode.json')
    .set('Host', 'course.example.test')
    .set('X-Forwarded-Proto', 'https')
    .expect(200);

  assert.equal(configRes.body.provider['ieti-agents'].options.baseURL, 'https://course.example.test/v1');
  assert.equal(configRes.body.provider['ieti-agents'].options.apiKey, '{env:IETI_AGENT_KEY}');
  assert.equal(configRes.body.provider['ieti-agents'].options.timeout, 900000);
  assert.equal(configRes.body.provider['ieti-agents'].options.chunkTimeout, 600000);
  assert.equal(configRes.body.model, 'ieti-agents/active-model');
  assert.equal(configRes.body.provider['ieti-agents'].models['active-model'].name, 'active-model');
  assert.equal(configRes.body.provider['ieti-agents'].models['active-model'].limit.context, 131072);
  assert.equal(configRes.body.provider['ieti-agents'].models['active-model'].limit.output, 8192);
  assert.equal(configRes.body.provider['ieti-agents'].models['active-model'].max_tokens, 8192);
  assert.equal(configRes.body.provider['ieti-agents'].models['active-model'].tool_call, true);
  assert.equal(configRes.body.provider['ieti-agents'].models['active-model'].reasoning, true);
  assert.deepEqual(configRes.body.provider['ieti-agents'].models['active-model'].modalities, {
    input: ['text', 'image'],
    output: ['text']
  });
});

test('student can create and delete their own api key', async () => {
  const student = createStudent();
  const agent = request.agent(app);

  await agent.post('/login').type('form').send({ login: student.email, password: student.password }).expect(302);
  await agent.post('/portal/key/regenerate').expect(302).expect('Location', '/portal?created=1');
  const regenerated = await agent.get('/portal?created=1').expect(200);
  const match = regenerated.text.match(/ieti_sk_[A-Za-z0-9_-]+/);
  assert.ok(match);
  assert.notEqual(match[0], student.key);

  await request(app).get('/v1/models').set('Authorization', `Bearer ${student.key}`).expect(401);
  await request(app).get('/v1/models').set('Authorization', `Bearer ${match[0]}`).expect(200);

  await agent.post('/portal/key/revoke').expect(302);
  await request(app).get('/v1/models').set('Authorization', `Bearer ${match[0]}`).expect(401);
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
