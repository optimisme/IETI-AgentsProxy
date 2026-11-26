const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const request = require('supertest');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-pools-'));
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'pools.sqlite');
process.env.GOOGLE_OAUTH_ENABLED = 'false';
process.env.PUBLIC_BASE_URL = '';
process.env.DEFAULT_PROVIDER_API_KEY = '';
process.env.DEFAULT_PROVIDER_BASE_URL = 'http://127.0.0.1:9';
process.env.ADMIN_USERNAME = 'pools-admin';
process.env.ADMIN_PASSWORD = 'pools-admin-password';
process.env.ADMIN_PASSWORD_HASH = '';
process.env.SESSION_SECRET = 'pools-test-session-secret-with-enough-length';
process.env.MAX_REQUESTS_PER_MINUTE = '1000';

const { getDb, closeDb, initSchema, migrateSchema, seedSettings } = require('../src/db');
const keys = require('../src/services/keyService');
const { reserveProviderForTest, getInFlight } = require('../src/services/providerService');
const { createApp } = require('../src/app');
const { closeServer, loopbackServer } = require('./helpers/server');
const { installOldAccessSchema } = require('./helpers/oldAccess');

let db;
let app;
let sessionStore;
let upstream;
let upstreamUrl;
let sequence = 0;

test.before(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'pool-fixture',
        object: 'chat.completion',
        model: payload.model,
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  db = getDb();
  const application = createApp();
  sessionStore = application.locals.sessionStore;
  app = await loopbackServer(application);
});

test.after(async () => {
  await closeServer(app);
  sessionStore?.close();
  closeDb();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function admin() {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: 'pools-admin', password: 'pools-admin-password' }).expect(302);
  return agent;
}

// A provider with one active mapping, as the provider form saves it.
function provider(name, { enabled = 1, contextLimit = 32000, tools = 1, maxConcurrent = null, mapped = true, mapping = {} } = {}) {
  const slug = `${name.toLowerCase()}-${++sequence}`;
  const id = Number(db.prepare(`
    INSERT INTO providers (slug, name, base_url, api_key, enabled, max_concurrent_requests)
    VALUES (?, ?, ?, 'local', ?, ?)
  `).run(slug, name, upstreamUrl, enabled, maxConcurrent).lastInsertRowid);
  if (mapped) {
    db.prepare(`
      INSERT INTO provider_models (provider_id, upstream_model, name, context_limit, output_limit, supports_tools)
      VALUES (?, ?, ?, ?, 4096, ?)
    `).run(id, `${slug}-upstream`, name, contextLimit, tools);
    for (const [column, value] of Object.entries(mapping)) {
      db.prepare(`UPDATE provider_models SET ${column} = ? WHERE provider_id = ?`).run(value, id);
    }
  }
  return { id, slug, name, upstreamModel: `${slug}-upstream` };
}

function pool(alias, providers = []) {
  const id = Number(db.prepare('INSERT INTO pools (alias) VALUES (?)').run(alias).lastInsertRowid);
  for (const member of providers) db.prepare('INSERT INTO pool_providers (pool_id, provider_id) VALUES (?, ?)').run(id, member.id);
  return id;
}

function student(poolIds = []) {
  const groupId = Number(db.prepare('INSERT INTO groups (name) VALUES (?)').run(`Pool group ${++sequence}`).lastInsertRowid);
  for (const poolId of poolIds) db.prepare('INSERT INTO group_pools (group_id, pool_id) VALUES (?, ?)').run(groupId, poolId);
  const key = keys.generateStudentKey();
  const id = Number(db.prepare('INSERT INTO users (name, email, api_key_hash, api_key_lookup_hash) VALUES (?, ?, ?, ?)')
    .run('Pool Student', `pool-student-${sequence}@example.test`, keys.hashApiKey(key), keys.lookupHashApiKey(key)).lastInsertRowid);
  db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)').run(id, groupId);
  return { id, key, groupId };
}

const models = async (user) => (await request(app).get('/v1/models').set('Authorization', `Bearer ${user.key}`).expect(200))
  .body.data.map((model) => model.id).sort();
const chat = (user, model) => request(app).post('/v1/chat/completions').set('Authorization', `Bearer ${user.key}`)
  .send({ model, messages: [{ role: 'user', content: 'Say OK.' }] });
const poolProviderIds = (poolId) => db.prepare('SELECT provider_id FROM pool_providers WHERE pool_id = ? ORDER BY provider_id').all(poolId)
  .map((row) => row.provider_id);
const groupPoolIds = (groupId) => db.prepare('SELECT pool_id FROM group_pools WHERE group_id = ? ORDER BY pool_id').all(groupId)
  .map((row) => row.pool_id);


const columnsOf = (database, table) => database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
const hasTable = (database, table) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
// Every row of a table without the columns that are being retired.
function rowsWithout(database, table, removed = []) {
  const columns = columnsOf(database, table).filter((column) => !removed.includes(column));
  return database.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY 1, 2`).all();
}

function oldAccessDatabase() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  initSchema(database);
  installOldAccessSchema(database);
  return database;
}

test('the first start converts the old access data to pools once, then removes it and keeps everything else', () => {
  const database = oldAccessDatabase();
  database.exec(`
    INSERT INTO providers (id, slug, name, base_url, enabled) VALUES
      (1, 'spark25', 'Spark25', 'http://a', 1), (2, 'spark26', 'Spark26', 'http://b', 1),
      (3, 'deepseek', 'DeepSeek', 'http://c', 1), (4, 'old', 'Old', 'http://d', 0),
      (5, 'unmapped', 'Unmapped', 'http://e', 1), (6, 'spark26-copy', 'Spark26 copy', 'http://b', 1);
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name, enabled, updated_at, max_images, reasoning_efforts) VALUES
      (1, 'Qwen38', 'qwen', 'Spark25', 1, '2026-01-01 00:00:00', 4, '["low"]'),
      (2, 'Qwen38', 'qwen', 'Spark26', 1, '2026-01-01 00:00:00', NULL, NULL),
      (3, 'deepseek-flash', 'deepseek', 'DeepSeek', 1, '2026-01-01 00:00:00', NULL, NULL),
      (4, 'Qwen36', 'qwen36', 'Old', 1, '2026-01-01 00:00:00', NULL, NULL),
      (6, 'active-model', 'qwen', 'Spark26 copy', 1, '2026-01-01 00:00:00', NULL, NULL),
      (6, 'stale-alias', 'older', 'Spark26 copy', 0, '2026-02-01 00:00:00', NULL, NULL);
    INSERT INTO groups (id, name, provider_id, daily_token_limit) VALUES
      (1, 'DAM2', 1, 5000), (2, 'Mixed', NULL, NULL), (3, 'Fallback', 3, NULL), (4, 'Empty', NULL, NULL),
      (5, 'Half pool', NULL, NULL), (6, 'Switched off', 3, NULL), (9, 'Deleted later', NULL, NULL);
    DELETE FROM groups WHERE id = 9;
    INSERT INTO group_providers (group_id, provider_id, enabled) VALUES
      (1, 1, 1), (1, 2, 1), (2, 3, 1), (2, 6, 1), (2, 5, 1), (5, 2, 1), (6, 1, 0);
    INSERT INTO users (id, name, email) VALUES (1, 'Member', 'member@example.test');
    INSERT INTO user_groups (user_id, group_id) VALUES (1, 4);
  `);
  const keptColumns = {
    groups: columnsOf(database, 'groups').filter((column) => column !== 'provider_id'),
    provider_models: columnsOf(database, 'provider_models').filter((column) => column !== 'public_model')
  };
  const before = {
    providers: rowsWithout(database, 'providers'),
    provider_models: rowsWithout(database, 'provider_models', ['public_model']),
    groups: rowsWithout(database, 'groups', ['provider_id']),
    user_groups: rowsWithout(database, 'user_groups')
  };
  const unchanged = (when) => {
    for (const [table, rows] of Object.entries(before)) assert.deepEqual(rowsWithout(database, table), rows, `${table} is unchanged ${when}`);
  };

  migrateSchema(database);

  const pools = database.prepare('SELECT id, alias FROM pools ORDER BY alias').all();
  assert.deepEqual(pools.map((row) => row.alias), ['Qwen36', 'Qwen38', 'active-model', 'deepseek-flash']);
  const membership = (alias) => database.prepare(`
    SELECT providers.slug FROM pool_providers
    JOIN pools ON pools.id = pool_providers.pool_id JOIN providers ON providers.id = pool_providers.provider_id
    WHERE pools.alias = ? ORDER BY providers.slug
  `).all(alias).map((row) => row.slug);
  assert.deepEqual(membership('Qwen38'), ['spark25', 'spark26']);
  assert.deepEqual(membership('Qwen36'), ['old'], 'A disabled provider keeps its pool');
  assert.deepEqual(membership('active-model'), ['spark26-copy'], 'An enabled mapping wins over a newer disabled one');
  assert.deepEqual(membership('deepseek-flash'), ['deepseek']);
  const access = (group) => database.prepare(`
    SELECT pools.alias FROM group_pools
    JOIN pools ON pools.id = group_pools.pool_id JOIN groups ON groups.id = group_pools.group_id
    WHERE groups.name = ? ORDER BY pools.alias
  `).all(group).map((row) => row.alias);
  assert.deepEqual(access('DAM2'), ['Qwen38']);
  assert.deepEqual(access('Mixed'), ['active-model', 'deepseek-flash'], 'An unmapped provider adds no pool');
  assert.deepEqual(access('Fallback'), ['deepseek-flash'], 'groups.provider_id counts when the group lists no providers');
  assert.deepEqual(access('Empty'), []);
  assert.deepEqual(access('Half pool'), ['Qwen38'], 'A group with one provider of an alias gets the whole pool');
  assert.deepEqual(access('Switched off'), [], 'A switched-off assignment grants nothing, and hides the fallback');

  // The old structures are gone; every other column, row and id is exactly as it was.
  assert.equal(hasTable(database, 'group_providers'), false);
  assert.deepEqual(columnsOf(database, 'groups'), keptColumns.groups, 'groups keeps its columns in their order');
  assert.deepEqual(columnsOf(database, 'provider_models'), keptColumns.provider_models, 'provider_models keeps its columns in their order');
  unchanged('by the conversion');
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(database.pragma('foreign_key_check'), []);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');

  // Rebuilt tables behave as before: ids are never reused, names stay unique, references still cascade.
  assert.equal(database.prepare("INSERT INTO groups (name) VALUES ('Next')").run().lastInsertRowid, 10);
  database.prepare("DELETE FROM groups WHERE name = 'Next'").run();
  assert.throws(() => database.prepare("INSERT INTO groups (name) VALUES ('DAM2')").run(), /UNIQUE/);
  assert.equal(database.prepare("INSERT INTO provider_models (provider_id, upstream_model, name) VALUES (5, 'now-mapped', 'Unmapped')").run().lastInsertRowid, 7);
  database.prepare('DELETE FROM provider_models WHERE id = 7').run();
  assert.throws(() => database.prepare("INSERT INTO provider_models (provider_id, upstream_model, name) VALUES (999, 'x', 'x')").run(), /FOREIGN KEY/);
  database.exec('SAVEPOINT cascade');
  database.prepare("DELETE FROM groups WHERE name = 'Empty'").run();
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM user_groups').get().count, 0, 'Deleting a group still removes its memberships');
  database.prepare('DELETE FROM providers WHERE id = 1').run();
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM provider_models WHERE provider_id = 1').get().count, 0, 'Deleting a provider still removes its mapping');
  database.exec('ROLLBACK TO cascade; RELEASE cascade');

  // Later starts change nothing, so pools an admin removed or renamed stay that way.
  database.prepare("DELETE FROM pools WHERE alias = 'Qwen36'").run();
  database.prepare("UPDATE pools SET alias = 'renamed' WHERE alias = 'active-model'").run();
  migrateSchema(database);
  seedSettings(database);
  assert.deepEqual(database.prepare('SELECT alias FROM pools ORDER BY alias').all().map((row) => row.alias), ['Qwen38', 'deepseek-flash', 'renamed']);
  unchanged('after a restart');
  database.close();
});

test('a database that already has pools keeps them and only loses the old access data', () => {
  const database = oldAccessDatabase();
  database.exec(`
    INSERT INTO providers (id, slug, name, base_url) VALUES (1, 'spark25', 'Spark25', 'http://a'), (2, 'spark26', 'Spark26', 'http://b');
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name) VALUES (1, 'old-alias', 'qwen', 'Spark25'), (2, '', 'qwen', 'Spark26');
    INSERT INTO groups (id, name, provider_id) VALUES (1, 'DAM2', 1);
    INSERT INTO group_providers (group_id, provider_id) VALUES (1, 1);
    CREATE TABLE pools (id INTEGER PRIMARY KEY AUTOINCREMENT, alias TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE pool_providers (pool_id INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE, provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (pool_id, provider_id));
    CREATE TABLE group_pools (group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, pool_id INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (group_id, pool_id));
    INSERT INTO pools (id, alias) VALUES (7, 'active-model');
    INSERT INTO pool_providers (pool_id, provider_id) VALUES (7, 1), (7, 2);
    INSERT INTO group_pools (group_id, pool_id) VALUES (1, 7);
  `);
  const pools = () => ['pools', 'pool_providers', 'group_pools'].map((table) => rowsWithout(database, table));
  const before = pools();
  migrateSchema(database);
  assert.deepEqual(pools(), before, 'The old alias is not converted again');
  assert.equal(hasTable(database, 'group_providers'), false);
  assert.equal(columnsOf(database, 'groups').includes('provider_id'), false);
  assert.equal(columnsOf(database, 'provider_models').includes('public_model'), false);
  assert.deepEqual(database.pragma('foreign_key_check'), []);
  database.close();
});

test('the clean-up stops and changes nothing when a table has a column it does not know', () => {
  const database = oldAccessDatabase();
  database.exec(`
    INSERT INTO providers (id, slug, name, base_url) VALUES (1, 'spark25', 'Spark25', 'http://a');
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name) VALUES (1, 'Qwen38', 'qwen', 'Spark25');
    INSERT INTO groups (id, name, provider_id) VALUES (1, 'DAM2', 1);
    INSERT INTO group_providers (group_id, provider_id) VALUES (1, 1);
    ALTER TABLE provider_models ADD COLUMN added_by_hand TEXT;
    UPDATE provider_models SET added_by_hand = 'keep me';
  `);
  assert.throws(() => migrateSchema(database), /Cannot rebuild provider_models: unexpected column\(s\) added_by_hand/);
  assert.equal(database.prepare('SELECT added_by_hand FROM provider_models').get().added_by_hand, 'keep me');
  assert.equal(database.prepare('SELECT public_model FROM provider_models').get().public_model, 'Qwen38');
  assert.equal(database.prepare('SELECT provider_id FROM groups').get().provider_id, 1, 'groups was not rebuilt either');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM group_providers').get().count, 1);
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1, 'Foreign keys are enforced again after the failure');
  database.close();
});

test('a new database starts with one pool for the default provider and gives it to the default group', () => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  initSchema(database);
  migrateSchema(database);
  seedSettings(database);
  assert.deepEqual(
    database.prepare(`
      SELECT pools.alias, providers.slug, groups.name AS group_name
      FROM pools
      JOIN pool_providers ON pool_providers.pool_id = pools.id
      JOIN providers ON providers.id = pool_providers.provider_id
      JOIN group_pools ON group_pools.pool_id = pools.id
      JOIN groups ON groups.id = group_pools.group_id
    `).all(),
    [{ alias: require('../src/config').publicModelName, slug: require('../src/config').defaultProviderSlug, group_name: 'Default Users' }]
  );
  database.close();
});

test('the same providers are published under two aliases, each visible only to the groups given that pool', async () => {
  const first = provider('Spark25', { maxConcurrent: 1 });
  const second = provider('Spark26', { maxConcurrent: 1 });
  const other = provider('DeepSeek');
  const qwen = pool(`Qwen38-${++sequence}`, [first, second]);
  const active = pool(`active-model-${sequence}`, [first, second]);
  const qwenAlias = db.prepare('SELECT alias FROM pools WHERE id = ?').get(qwen).alias;
  const activeAlias = db.prepare('SELECT alias FROM pools WHERE id = ?').get(active).alias;
  const onlyQwen = student([qwen]);
  const onlyActive = student([active]);
  const both = student([qwen, active]);
  const none = student([]);

  assert.deepEqual(await models(onlyQwen), [qwenAlias]);
  assert.deepEqual(await models(onlyActive), [activeAlias]);
  assert.deepEqual(await models(both), [qwenAlias, activeAlias].sort());
  assert.deepEqual(await models(none), []);

  const served = (await chat(onlyActive, activeAlias).expect(200)).body.model;
  assert.ok([first.upstreamModel, second.upstreamModel].includes(served), 'The alias reaches the pool\'s providers with their own upstream model');
  assert.equal((await chat(onlyQwen, activeAlias).expect(403)).body.error.code, 'model_not_allowed');
  assert.equal((await chat(none, activeAlias).expect(403)).body.error.code, 'provider_required');

  // Each provider's concurrency limit is shared by every pool it belongs to.
  const releases = [reserveProviderForTest(first.slug), reserveProviderForTest(second.slug)];
  try {
    assert.equal((await chat(both, qwenAlias).expect(503)).body.error.code, 'provider_capacity_exceeded');
    assert.equal((await chat(both, activeAlias).expect(503)).body.error.code, 'provider_capacity_exceeded');
  } finally {
    releases.forEach((release) => release());
  }
  assert.equal(getInFlight(first.slug) + getInFlight(second.slug), 0);

  // Pointing an alias somewhere else is a change to that pool's providers only.
  const agent = await admin();
  await agent.post(`/admin/pools/${active}`).type('form').send({ alias: activeAlias, provider_ids: String(other.id) })
    .expect(302).expect('Location', `/admin/pools/${active}?saved=1`);
  assert.equal((await chat(onlyActive, activeAlias).expect(200)).body.model, other.upstreamModel);
  assert.deepEqual(poolProviderIds(qwen), [first.id, second.id]);

  // A disabled provider no longer serves, and a pool with none left is not listed.
  db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(other.id);
  assert.deepEqual(await models(onlyActive), []);
  assert.equal((await chat(onlyActive, activeAlias).expect(403)).body.error.code, 'model_not_allowed');

  // Deleting a provider takes it out of its pools.
  db.prepare('DELETE FROM providers WHERE id = ?').run(first.id);
  assert.deepEqual(poolProviderIds(qwen), [second.id]);
});

test('admin creates, renames and deletes pools, and a taken or invalid alias saves nothing', async () => {
  const agent = await admin();
  const first = provider('Alpha');
  const second = provider('Bravo', { enabled: 0 });
  const alias = `team/model:${++sequence}`;

  await request(app).post('/admin/pools').type('form').send({ alias: 'anonymous' }).expect(401);
  const form = await agent.get('/admin/pools/new').expect(200);
  assert.match(form.text, /<h1>New pool<\/h1>/);
  assert.match(form.text, /name="alias" value="" required/);
  assert.match(form.text, new RegExp(`name="provider_ids" type="checkbox" value="${second.id}" style="width:auto" >\\s*Bravo \\(${second.slug}\\)[\\s\\S]*?disabled`));

  for (const invalid of ['', '  ', 'two words', 'x'.repeat(256)]) {
    await agent.post('/admin/pools').type('form').send({ alias: invalid, provider_ids: String(first.id) }).expect(400);
  }
  await agent.post('/admin/pools').type('form').send({ alias, provider_ids: '999999' }).expect(400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pools WHERE alias = ?').get(alias).count, 0);

  const created = await agent.post('/admin/pools').type('form').send({ alias, provider_ids: [String(first.id), String(second.id)] }).expect(302);
  const poolId = db.prepare('SELECT id FROM pools WHERE alias = ?').get(alias).id;
  assert.equal(created.headers.location, `/admin/pools/${poolId}?saved=1`);
  assert.deepEqual(poolProviderIds(poolId), [first.id, second.id]);
  const page = await agent.get(created.headers.location).expect(200);
  assert.match(page.text, /Pool saved\./);
  assert.match(page.text, new RegExp(`name="provider_ids" type="checkbox" value="${first.id}" style="width:auto" checked>`));
  assert.match(page.text, /No group can use this pool yet/);

  const otherAlias = `other-${sequence}`;
  const otherId = pool(otherAlias, [first]);
  assert.match(page.text, /A provider can be in several pools/);
  assert.match((await agent.get(`/admin/pools/${poolId}`).expect(200)).text, new RegExp(`· also in ${otherAlias}`));

  const clash = await agent.post('/admin/pools').type('form').send({ alias: otherAlias, provider_ids: String(second.id) }).expect(409);
  assert.match(clash.text, new RegExp(`The alias <code>${otherAlias}</code> is already used by <a href="/admin/pools/${otherId}">another pool</a>`));
  assert.match(clash.text, new RegExp(`name="alias" value="${otherAlias}"`));
  assert.match(clash.text, new RegExp(`value="${second.id}" style="width:auto" checked>`));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pools WHERE alias = ?').get(otherAlias).count, 1);
  await agent.post(`/admin/pools/${poolId}`).type('form').send({ alias: otherAlias, provider_ids: String(first.id) }).expect(409);
  assert.equal(db.prepare('SELECT alias FROM pools WHERE id = ?').get(poolId).alias, alias);
  assert.deepEqual(poolProviderIds(poolId), [first.id, second.id]);

  // Renaming keeps the groups; saving with nothing ticked empties the pool.
  const user = student([poolId]);
  const renamed = `renamed-${sequence}`;
  await agent.post(`/admin/pools/${poolId}`).type('form').send({ alias: renamed, provider_ids: String(first.id) }).expect(302);
  assert.deepEqual(await models(user), [renamed]);
  await agent.post(`/admin/pools/${poolId}`).type('form').send({ alias: renamed }).expect(302);
  assert.deepEqual(poolProviderIds(poolId), []);
  assert.deepEqual(await models(user), []);

  const list = await agent.get('/admin/pools').expect(200);
  assert.match(list.text, new RegExp(`<a href="/admin/pools/${poolId}"><code>${renamed}</code></a>`));
  assert.match(list.text, /⚠<\/span> No providers/);

  const editPage = await agent.get(`/admin/pools/${poolId}`).expect(200);
  assert.match(editPage.text, new RegExp(`Students in ${`Pool group`}[^.]* will lose this model\\.`));
  await agent.post(`/admin/pools/${poolId}/delete`).expect(302).expect('Location', '/admin/pools?deleted=1');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pools WHERE id = ?').get(poolId).count, 0);
  assert.deepEqual(groupPoolIds(user.groupId), []);
  assert.ok(db.prepare('SELECT id FROM providers WHERE id = ?').get(first.id), 'Deleting a pool keeps its providers');
  await agent.post(`/admin/pools/${poolId}/delete`).expect(404);
  await agent.get(`/admin/pools/${poolId}`).expect(404);
  await agent.post(`/admin/pools/${poolId}`).type('form').send({ alias: 'gone' }).expect(404);
});

test('a pool shows what students see and names the providers that lower it', async () => {
  const agent = await admin();
  const levels = JSON.stringify(['low', 'high']);
  const main = provider('Main', { contextLimit: 64000, mapping: { reasoning_efforts: levels } });
  const aligned = provider('Aligned', { contextLimit: 64000, mapping: { reasoning_efforts: levels } });
  const weaker = provider('Weaker', {
    contextLimit: 32000, tools: 0, mapping: { reasoning_efforts: JSON.stringify(['low']), max_images: 2, supports_parallel_tools: 0 }
  });
  const unmapped = provider('Unmapped', { mapped: false });
  const alias = `offer-${++sequence}`;
  const poolId = pool(alias, [main, aligned]);
  const user = student([poolId]);
  const listRow = async () => (await agent.get('/admin/pools').expect(200)).text
    .match(new RegExp(`<tr>\\s*<td><a href="/admin/pools/${poolId}">[\\s\\S]*?</tr>`))[0];
  const page = async () => (await agent.get(`/admin/pools/${poolId}`).expect(200)).text;
  const offered = (html, label) => html.match(new RegExp(`<th scope="row">${label}</th><td>([^<]*)</td>`))?.[1];
  const providerRow = (html, member) => html.match(new RegExp(`<tr>\\s*<td>\\s*<a href="/admin/providers/${member.id}">[\\s\\S]*?</tr>`))[0];
  const published = async () => (await request(app).get('/v1/model-capabilities').set('Authorization', `Bearer ${user.key}`).expect(200))
    .body.data.find((model) => model.id === alias);

  assert.match(await listRow(), /✓<\/span> All aligned/);
  let html = await page();
  assert.match(html, /<h2>What students see<\/h2>/);
  assert.equal(offered(html, 'Context window'), '64,000 tokens');
  assert.equal(offered(html, 'Tool calling'), 'Yes, with parallel calls');
  assert.equal(offered(html, 'Image input'), 'Yes');
  assert.equal(offered(html, 'Reasoning'), 'Yes: low, high');
  assert.match(providerRow(html, main), /Serving<\/span>[\s\S]*✓<\/span> Aligned/);
  assert.doesNotMatch(html, /Main\/reference|Align with main provider|\/align\//);

  // A provider that offers less lowers what students see, and the page says which one and how.
  db.prepare('INSERT INTO pool_providers (pool_id, provider_id) VALUES (?, ?)').run(poolId, weaker.id);
  assert.match(await listRow(), /⚠<\/span> 1 not aligned/);
  html = await page();
  assert.match(html, /<h2>Alignment <span class="pool-status pool-warning"><span aria-hidden="true">⚠<\/span> 1 not aligned<\/span><\/h2>/);
  assert.equal(offered(html, 'Context window'), '32,000 tokens');
  assert.equal(offered(html, 'Tool calling'), 'No');
  assert.equal(offered(html, 'Image input'), 'Yes, up to 2 per request');
  assert.equal(offered(html, 'Reasoning'), 'Yes: low');
  assert.deepEqual(
    [...providerRow(html, weaker).matchAll(/<li>([^<]*)<\/li>/g)].map((match) => match[1]),
    [
      'Limits the context to 32,000 tokens (others allow 64,000 tokens)',
      'Has no tool calling',
      'Has no parallel tool calls',
      'Limits images to 2 per request',
      'Does not accept reasoning level high'
    ]
  );
  assert.match(providerRow(html, main), /✓<\/span> Aligned/);
  assert.match(providerRow(html, aligned), /✓<\/span> Aligned/);
  // The page shows what the API publishes for this alias.
  const model = await published();
  assert.equal(model.context_window, 32000);
  assert.equal(model.capabilities.tools, false);
  assert.deepEqual(model.reasoning_efforts, ['low']);

  // Capabilities live on the provider only: nothing copies them from one provider to another.
  const weakerMapping = db.prepare('SELECT * FROM provider_models WHERE provider_id = ?').get(weaker.id);
  await agent.post(`/admin/pools/${poolId}/align/${weaker.id}`).expect(404);
  assert.deepEqual(db.prepare('SELECT * FROM provider_models WHERE provider_id = ?').get(weaker.id), weakerMapping);
  // The delete form must not sit inside the pool form: HTML forms cannot nest.
  const poolFormEnd = html.indexOf('</form>', html.indexOf(`action="/admin/pools/${poolId}" class="panel"`));
  assert.ok(html.indexOf(`action="/admin/pools/${poolId}/delete"`) > poolFormEnd);

  // A provider that is not serving does not count, and the page says why it is idle.
  db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(weaker.id);
  db.prepare('INSERT INTO pool_providers (pool_id, provider_id) VALUES (?, ?)').run(poolId, unmapped.id);
  assert.match(await listRow(), /✓<\/span> All aligned/);
  assert.match(await listRow(), new RegExp(`Weaker</a> <span class="muted">\\(provider disabled\\)</span>`));
  html = await page();
  assert.equal(offered(html, 'Context window'), '64,000 tokens');
  assert.match(providerRow(html, weaker), /Not serving<\/span><br><span class="muted">Provider disabled<\/span>/);
  assert.match(providerRow(html, unmapped), /Not serving<\/span><br><span class="muted">No model mapping<\/span>/);
  assert.equal((await published()).context_window, 64000);

  db.prepare('UPDATE providers SET enabled = 0 WHERE id IN (?, ?)').run(main.id, aligned.id);
  assert.match(await listRow(), /⚠<\/span> No provider is serving/);
  assert.match(await page(), /Students see no model under this alias/);
  assert.equal(await published(), undefined);
  db.prepare('DELETE FROM pool_providers WHERE pool_id = ?').run(poolId);
  assert.match(await listRow(), /⚠<\/span> No providers/);
});

test('a group chooses pools on its page, and the lists show pools from both sides', async () => {
  const agent = await admin();
  const first = provider('Zulu');
  const second = provider('Yankee', { enabled: 0 });
  const lonely = provider('Lonely');
  const beta = pool(`beta-<${++sequence}>`, [first, second]);
  const alpha = pool(`alpha-${sequence}`, [first]);
  const empty = pool(`empty-${sequence}`, []);
  const name = `Pool Group Form ${sequence}`;

  const blank = await agent.get('/admin/groups/new').expect(200);
  assert.match(blank.text, /<label>Pools /);
  assert.doesNotMatch(blank.text, /name="provider_ids"|Balanced model pools/);
  assert.match(blank.text, new RegExp(`name="pool_ids" type="checkbox" value="${beta}" style="width:auto" >\\s*<code>beta-&lt;${sequence}&gt;</code>\\s*<span class="muted">Yankee \\(disabled\\), Zulu</span>|name="pool_ids" type="checkbox" value="${beta}" style="width:auto" >\\s*<code>beta-&lt;${sequence}&gt;</code>\\s*<span class="muted">Zulu, Yankee \\(disabled\\)</span>`));
  assert.match(blank.text, new RegExp(`value="${empty}" style="width:auto" >\\s*<code>empty-${sequence}</code>\\s*<span class="muted">no providers</span>`));

  const limits = { daily_call_limit: '', daily_token_limit: '', hourly_call_limit: '', hourly_token_limit: '' };
  await agent.post('/admin/groups').type('form').send({ name, pool_ids: [String(beta), String(alpha), '999999'], ...limits }).expect(302);
  const group = db.prepare('SELECT * FROM groups WHERE name = ?').get(name);
  assert.deepEqual(groupPoolIds(group.id), [beta, alpha].sort((left, right) => left - right), 'Unknown pools are ignored');

  const edit = await agent.get(`/admin/groups/${group.id}`).expect(200);
  assert.match(edit.text, new RegExp(`name="pool_ids" type="checkbox" value="${alpha}" style="width:auto" checked>`));
  assert.match(edit.text, new RegExp(`name="pool_ids" type="checkbox" value="${empty}" style="width:auto" >`));

  const list = await agent.get('/admin/groups').expect(200);
  assert.match(list.text, /<th>Pools<\/th>/);
  const row = list.text.match(new RegExp(`<tr>\\s*<td><a href="/admin/groups/${group.id}">[\\s\\S]*?</tr>`))[0];
  assert.deepEqual(
    [...row.matchAll(/<a href="\/admin\/pools\/(\d+)"><code>([^<]*)<\/code>|<li><a href="\/admin\/providers\/(\d+)">([^<]*)<\/a>( <span class="muted">\(disabled\)<\/span>)?/g)]
      .map((match) => (match[1] ? `pool:${match[1]}:${match[2]}` : `${match[3]}:${match[4]}${match[5] ? ':disabled' : ''}`)),
    [
      `pool:${alpha}:alpha-${sequence}`, `${first.id}:Zulu`,
      `pool:${beta}:beta-&lt;${sequence}&gt;`, `${second.id}:Yankee:disabled`, `${first.id}:Zulu`
    ]
  );

  // Saving the group with one pool ticked, then none.
  await agent.post(`/admin/groups/${group.id}`).type('form').send({ name, pool_ids: String(empty), ...limits }).expect(302);
  assert.deepEqual(groupPoolIds(group.id), [empty]);
  await agent.post(`/admin/groups/${group.id}`).type('form').send({ name, ...limits }).expect(302);
  assert.deepEqual(groupPoolIds(group.id), []);
  assert.match((await agent.get('/admin/groups').expect(200)).text
    .match(new RegExp(`<tr>\\s*<td><a href="/admin/groups/${group.id}">[\\s\\S]*?</tr>`))[0], /<span class="muted">none<\/span>/);

  // Providers: a flat list with the pools each one is in, and no alias of their own.
  const providers = await agent.get('/admin/providers').expect(200);
  const providerRow = (id) => providers.text.match(new RegExp(`<tr>\\s*<td>\\s*<a href="/admin/providers/${id}">[\\s\\S]*?</tr>`))[0];
  assert.match(providerRow(first.id), new RegExp(`<a href="/admin/pools/${alpha}"><code>alpha-${sequence}</code></a><br><a href="/admin/pools/${beta}">`));
  assert.match(providerRow(lonely.id), /⚠<\/span> Not in a pool/);
  const lonelyPage = await agent.get(`/admin/providers/${lonely.id}`).expect(200);
  assert.match(lonelyPage.text, /Students cannot reach this provider until it is added to a <a href="\/admin\/pools">pool<\/a>/);
  assert.doesNotMatch(lonelyPage.text, /name="public_model"|OpenCode model alias/);
  const firstPage = await agent.get(`/admin/providers/${first.id}`).expect(200);
  assert.match(firstPage.text, new RegExp(`Published to students as <a href="/admin/pools/${alpha}"><code>alpha-${sequence}</code></a>, <a href="/admin/pools/${beta}">`));

  // A provider created through its form is in no pool until a pool ticks it.
  const slug = `form-made-${sequence}`;
  await agent.post('/admin/providers').type('form').send({
    slug, name: 'Form made', base_url: upstreamUrl, enabled: '1', upstream_model: 'form-upstream', public_model: 'ignored-alias'
  }).expect(302);
  const made = db.prepare('SELECT id FROM providers WHERE slug = ?').get(slug);
  assert.equal(db.prepare('SELECT upstream_model FROM provider_models WHERE provider_id = ?').get(made.id).upstream_model, 'form-upstream');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pool_providers WHERE provider_id = ?').get(made.id).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pools WHERE alias IN ('ignored-alias', ?)").get(slug).count, 0);
});

test('admin changes are traced with who, what and which record, without secrets', async () => {
  const agent = await admin();
  const audit = () => db.prepare('SELECT * FROM admin_audit_logs ORDER BY id').all();
  const start = audit().length;
  const since = () => audit().slice(start);

  // Nothing is recorded for visitors, for pages that are only read, or for checks that change nothing.
  await request(app).post('/admin/pools').type('form').send({ alias: 'anonymous-attempt' }).expect(401);
  await agent.get('/admin/pools').expect(200);
  const checked = provider('Checked');
  await agent.post(`/admin/providers/${checked.id}/mapping/test.json`).expect((response) => assert.ok([200, 502].includes(response.status)));
  assert.deepEqual(since(), []);

  const slug = `traced-${++sequence}`;
  await agent.post('/admin/providers').type('form').send({
    slug, name: 'Traced <Provider>', base_url: upstreamUrl, api_key: 'super-secret-upstream-key', enabled: '1', upstream_model: 'traced-upstream'
  }).expect(302);
  const providerId = db.prepare('SELECT id FROM providers WHERE slug = ?').get(slug).id;
  const alias = `traced-pool-${sequence}`;
  await agent.post('/admin/pools').type('form').send({ alias, provider_ids: String(providerId) }).expect(302);
  const poolId = db.prepare('SELECT id FROM pools WHERE alias = ?').get(alias).id;
  await agent.post('/admin/pools').type('form').send({ alias, provider_ids: String(providerId) }).expect(409);
  await agent.post(`/admin/providers/${providerId}`).type('form').send({ api_key: 'another-secret-key' }).expect(302);
  await agent.post(`/admin/providers/${providerId}/delete`).expect(302);
  await agent.post(`/admin/pools/${poolId}/delete`).expect(302);

  const entries = since();
  assert.deepEqual(
    entries.map((entry) => [entry.action, entry.status, entry.target_type, entry.target_id, entry.target_label]),
    [
      ['/admin/providers', 302, 'providers', null, 'Traced <Provider>'],
      ['/admin/pools', 302, 'pools', null, alias],
      ['/admin/pools', 409, 'pools', null, alias],
      ['/admin/providers/:id', 302, 'providers', providerId, `Traced <Provider> (${slug})`],
      ['/admin/providers/:id/delete', 302, 'providers', providerId, `Traced <Provider> (${slug})`],
      ['/admin/pools/:id/delete', 302, 'pools', poolId, alias]
    ]
  );
  assert.ok(entries.every((entry) => entry.actor === 'pools-admin' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(entry.created_at)));
  assert.equal(JSON.parse(entries[0].details).api_key, '[provided]');
  assert.equal(JSON.parse(entries[0].details).base_url, upstreamUrl);
  assert.deepEqual(JSON.parse(entries[3].details), { api_key: '[provided]' });
  assert.doesNotMatch(JSON.stringify(entries), /super-secret-upstream-key|another-secret-key/);

  const page = await agent.get('/admin/activity').expect(200);
  assert.match(page.text, /<h1>Activity<\/h1>/);
  assert.match(page.text, /<a href="\/admin\/activity"[^>]*>Activity<\/a>/);
  assert.match(page.text, new RegExp(`<td>pools-admin</td>\\s*<td>Deleted provider</td>\\s*<td><a href="/admin/providers/${providerId}">Traced &lt;Provider&gt; \\(${slug}\\)</a></td>\\s*<td><span class="status-enabled">Done</span></td>`));
  assert.match(page.text, new RegExp(`<td>Created pool</td>\\s*<td>${alias}</td>\\s*<td><span class="status-disabled">Refused \\(409\\)</span></td>`));
  assert.match(page.text, /<dt>api_key<\/dt><dd>\[provided\]<\/dd>/);
  assert.doesNotMatch(page.text, /super-secret-upstream-key|another-secret-key/);
  // Newest first.
  assert.ok(page.text.indexOf('Deleted pool') < page.text.indexOf('Created provider'));
  await request(app).get('/admin/activity').set('Accept', 'text/html').expect(302).expect('Location', '/?admin=1');

  // Long values are shortened and applying an autoconfiguration is a change, a preview is not.
  const { summarizeBody } = require('../src/services/adminAuditService');
  assert.equal(JSON.parse(summarizeBody({ name: 'x'.repeat(500), password: '', token: 't' })).name.length, 201);
  assert.deepEqual(JSON.parse(summarizeBody({ password: '', token: 't' })), { token: '[provided]' });
  assert.equal(summarizeBody({}), null);
});
