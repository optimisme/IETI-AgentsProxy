const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const request = require('supertest');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-portal-usage-chart-'));
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'portal.sqlite');
process.env.GOOGLE_OAUTH_ENABLED = 'false';
process.env.PUBLIC_BASE_URL = '';
process.env.DEFAULT_PROVIDER_API_KEY = '';
process.env.DEFAULT_PROVIDER_BASE_URL = 'http://127.0.0.1:9';
process.env.ADMIN_USERNAME = 'portal-chart-admin';
process.env.ADMIN_PASSWORD = 'portal-chart-admin-password';
process.env.ADMIN_PASSWORD_HASH = '';
process.env.SESSION_SECRET = 'portal-usage-chart-test-session-secret';

const { getDb, closeDb } = require('../src/db');
const { hashPassword } = require('../src/services/studentAuthService');
const { createApp } = require('../src/app');
const password = 'portal-chart-student-password';
const passwordHash = hashPassword(password);
let db;
let app;
let providerId;
let sequence = 0;

test.before(() => {
  db = getDb();
  providerId = Number(db.prepare(`
    INSERT INTO providers (slug, name, base_url, api_key, enabled)
    VALUES ('portal-chart-provider', 'Portal chart provider', 'http://127.0.0.1:9', '', 1)
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO provider_models (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
    VALUES (?, 'portal-chart-model', 'fixture-upstream', 'Portal chart model', 1, 8192, 1024)
  `).run(providerId);
  app = createApp();
});
test.beforeEach(() => {
  db.exec('DELETE FROM usage_logs; DELETE FROM users; DELETE FROM groups;');
});
test.after(() => {
  app?.locals.sessionStore.close();
  closeDb();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function student({ status = 'approved', grouped = true } = {}) {
  const email = `portal-chart-${++sequence}@example.test`;
  const id = Number(db.prepare(`
    INSERT INTO users (name, email, password_hash, registration_status)
    VALUES ('Chart Student', ?, ?, ?)
  `).run(email, passwordHash, status).lastInsertRowid);
  if (grouped) {
    const groupId = db.prepare('INSERT INTO groups (name, provider_id) VALUES (?, ?)')
      .run(`Portal chart group ${sequence}`, providerId).lastInsertRowid;
    db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)').run(id, groupId);
  }
  return { id, email };
}

async function login(user) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ login: user.email, password }).expect(302).expect('Location', '/portal');
  return agent;
}

function day(offset = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function usage(userId, date, tokens, status = 'success') {
  db.prepare(`
    INSERT INTO usage_logs (user_id, model, total_tokens, status, created_at)
    VALUES (?, 'portal-test-model', ?, ?, ?)
  `).run(userId, tokens, status, `${date} 12:00:00`);
}

function chartRows(html) {
  const attribute = html.match(/data-usage="([^"]+)"/);
  assert.ok(attribute, 'portal contains chart data');
  return JSON.parse(attribute[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
}

test('portal chart shows only the signed-in student’s completed or stopped calls and ignores query user ids', async () => {
  const owner = student();
  const other = student();
  usage(owner.id, day(-1), 11);
  usage(owner.id, day(), 17, 'cancelled');
  usage(owner.id, day(), 0, 'cancelled');
  usage(owner.id, day(), 8000, 'error');
  usage(owner.id, day(-15), 6000);
  usage(other.id, day(), 9000);
  usage(null, day(), 7000);

  const agent = await login(owner);
  const response = await agent.get(`/portal?user_id=${other.id}&userId=${other.id}`).expect(200);
  const rows = chartRows(response.text);
  assert.equal(rows.length, 15);
  assert.deepEqual(rows[0], { date: day(-14), calls: 0, tokens: 0 });
  assert.deepEqual(rows[13], { date: day(-1), calls: 1, tokens: 11 });
  assert.deepEqual(rows[14], { date: day(), calls: 1, tokens: 17 });
  assert.equal(rows.reduce((total, row) => total + row.calls, 0), 2);
  assert.equal(rows.reduce((total, row) => total + row.tokens, 0), 28);
  assert.match(response.text, /<code>portal-chart-model<\/code>/);
  const modelsPosition = response.text.indexOf('<h2 id="active-models-heading">Active models</h2>');
  const quotaPositions = ['Calls today', 'Tokens today', 'Calls this hour', 'Tokens this hour']
    .map((label) => response.text.indexOf(`<strong>${label}</strong>`));
  const chartPosition = response.text.indexOf('id="daily-usage-heading"');
  const recentPosition = response.text.indexOf('<h2>Recent usage</h2>');
  const usageTablePosition = response.text.indexOf('<thead><tr><th>When</th><th>Model</th>');
  assert.ok(modelsPosition >= 0 && modelsPosition < recentPosition);
  assert.ok(quotaPositions.every((position) => recentPosition < position && position < chartPosition));
  assert.ok(chartPosition < usageTablePosition);
  assert.equal((response.text.match(/<h2>Recent usage<\/h2>/g) || []).length, 1);
  assert.equal((response.text.match(/class="quota-grid"/g) || []).length, 1);
  assert.match(response.text, /<script src="\/portal\/assets\/dashboard-usage\.js" defer><\/script>/);
  assert.match(response.text, /Last 15 days, including today · UTC/);

  const otherResponse = await (await login(other)).get('/portal').expect(200);
  assert.deepEqual(chartRows(otherResponse.text)[14], { date: day(), calls: 1, tokens: 9000 });
});

test('new students receive all fifteen zero-valued days and the authenticated chart script', async () => {
  const agent = await login(student());
  const response = await agent.get('/portal').expect(200);
  const rows = chartRows(response.text);
  assert.equal(rows.length, 15);
  assert.equal(rows[0].date, day(-14));
  assert.equal(rows[14].date, day());
  assert.ok(rows.every((row) => row.calls === 0 && row.tokens === 0));
  assert.match(response.text, /View daily usage table/);

  const asset = await agent.get('/portal/assets/dashboard-usage.js').expect(200).expect('Cache-Control', 'no-cache');
  assert.match(asset.headers['content-type'], /javascript/);
  assert.match(asset.text, /getContext\('2d'\)/);
});

test('anonymous, pending and unassigned sessions cannot load the chart or script', async () => {
  await request(app).get('/portal').expect(302).expect('Location', '/');
  await request(app).get('/portal/assets/dashboard-usage.js').expect(302).expect('Location', '/');

  for (const options of [{ status: 'pending' }, { grouped: false }]) {
    const user = student(options);
    usage(user.id, day(), 123456);
    const agent = await login(user);
    const response = await agent.get('/portal').expect(200);
    assert.match(response.text, /Account awaiting approval/);
    assert.doesNotMatch(response.text, /data-usage-chart|dashboard-usage\.js|123456/);
    await agent.get('/portal/assets/dashboard-usage.js').expect(302).expect('Location', '/portal');
  }
});

test('disabled and rejected students lose chart access immediately', async () => {
  for (const column of ['enabled', 'registration_status']) {
    const user = student();
    const agent = await login(user);
    const assetAgent = await login(user);
    await agent.get('/portal').expect(200);
    if (column === 'enabled') db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(user.id);
    else db.prepare("UPDATE users SET registration_status = 'rejected' WHERE id = ?").run(user.id);
    const response = await agent.get('/portal').expect(302).expect('Location', '/?error=disabled');
    assert.doesNotMatch(response.text, /data-usage-chart|dashboard-usage\.js/);
    await assetAgent.get('/portal/assets/dashboard-usage.js').expect(302).expect('Location', '/?error=disabled');
    await agent.get('/portal/assets/dashboard-usage.js').expect(302).expect('Location', '/');
  }
});
