const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const request = require('supertest');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-dashboard-'));
process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
process.env.ADMIN_USERNAME = 'dashboard-admin';
process.env.ADMIN_PASSWORD = 'dashboard-test-password';
process.env.ADMIN_PASSWORD_HASH = '';
process.env.SESSION_SECRET = 'isolated-dashboard-test-session-secret';
process.env.PUBLIC_BASE_URL = '';
process.env.GOOGLE_OAUTH_ENABLED = 'false';

const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db');
const { escapeHtml } = require('../src/utils/html');
const app = createApp();
const db = getDb();

test.beforeEach(() => {
  db.exec('DELETE FROM usage_logs; DELETE FROM users;');
});

test.after(() => {
  app.locals.sessionStore.close();
  closeDb();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function admin() {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({
    login: 'dashboard-admin', password: 'dashboard-test-password'
  }).expect(302);
  return agent;
}

function day(offset = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function chartRows(html) {
  const attribute = html.match(/data-usage="([^"]+)"/);
  assert.ok(attribute, 'page contains daily chart data');
  return JSON.parse(attribute[1].replaceAll('&quot;', '"'));
}

test('dashboard renders all three cards with global calls and safely escaped user data', async () => {
  const name = '<script>alert("name")</script>';
  const email = 'first&student@example.test';
  const first = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run(name, email).lastInsertRowid;
  const second = db.prepare("INSERT INTO users (name, email) VALUES ('Second Student', 'second@example.test')").run().lastInsertRowid;
  const insert = db.prepare(`INSERT INTO usage_logs
    (user_id, model, provider_slug, total_tokens, status, error_message, created_at)
    VALUES (?, ?, 'test-provider', ?, ?, ?, CURRENT_TIMESTAMP)`);
  insert.run(first, 'first-success', 100, 'success', null);
  insert.run(second, 'second-success', 50, 'success', null);
  insert.run(first, 'failed-model', 999, 'error', '<img src=x onerror=alert(1)>');
  insert.run(second, 'timeout-model', 999, 'timeout', 'Provider request timed out.');
  insert.run(null, 'anonymous-success', 25, 'success', null);
  const agent = await admin();
  const page = await agent.get('/admin').expect(200);

  assert.match(page.text, /<h2 id="daily-usage-heading">Daily usage<\/h2>/);
  assert.match(page.text, /<h2 id="active-users-heading">Most active users<\/h2>/);
  assert.match(page.text, /<h2 id="recent-calls-heading">Recent calls<\/h2>/);
  assert.match(page.text, /<h2 id="recent-errors-heading">Recent errors<\/h2>/);
  assert.match(page.text, /<canvas tabindex="0"/);
  assert.match(page.text, /View daily usage table/);
  assert.match(page.text, /<strong>175<\/strong> tokens/);
  assert.match(page.text, /<strong>3<\/strong> successful calls/);
  assert.match(page.text, /<script src="\/admin\/assets\/dashboard-usage.js" defer><\/script>/);
  assert.ok(page.text.includes(escapeHtml(name)));
  assert.ok(page.text.includes(escapeHtml(email)));
  assert.ok(page.text.includes(escapeHtml('<img src=x onerror=alert(1)>')));
  assert.ok(!page.text.includes(name));
  assert.match(page.text, new RegExp(`href="/admin/users/${first}"`));

  const recent = page.text.match(/<section[^>]+aria-labelledby="recent-calls-heading">([\s\S]*?)<\/section>/)[1];
  for (const model of ['first-success', 'second-success', 'failed-model', 'timeout-model', 'anonymous-success']) {
    assert.ok(recent.includes(model));
  }
  assert.ok(recent.includes(escapeHtml(email)));
  assert.match(recent, /second@example\.test/);
  assert.match(recent, /Deleted user/);
  assert.ok(recent.indexOf('anonymous-success') < recent.indexOf('first-success'));

  const encoded = page.text.match(/data-usage="([^"]+)"/)[1];
  const rows = JSON.parse(encoded.replaceAll('&quot;', '"'));
  assert.equal(rows.length, 15);
  assert.equal(rows.at(-1).tokens, 175);
  assert.equal(rows.at(-1).calls, 3);
});

test('empty dashboard remains usable and chart asset requires admin authentication', async () => {
  await request(app).get('/admin').set('Accept', 'application/json').expect(401);
  await request(app).get('/admin/assets/dashboard-usage.js').set('Accept', 'application/json').expect(401);
  const agent = await admin();
  const page = await agent.get('/admin').expect(200);
  assert.match(page.text, /No successful calls from current users in the last 15 days\./);
  assert.match(page.text, /<strong>0<\/strong> tokens/);
  assert.match(page.text, /No records\./);
  const script = await agent.get('/admin/assets/dashboard-usage.js').expect(200);
  assert.match(script.headers['content-type'], /javascript/);
  assert.doesNotThrow(() => new Function(script.text));
});

test('admin user detail charts only the selected user’s successful calls after quota cards', async () => {
  const selected = db.prepare("INSERT INTO users (name, email) VALUES ('Selected Student', 'selected@example.test')").run().lastInsertRowid;
  const other = db.prepare("INSERT INTO users (name, email) VALUES ('Other Student', 'other@example.test')").run().lastInsertRowid;
  const insert = db.prepare(`
    INSERT INTO usage_logs (user_id, model, total_tokens, status, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insert.run(selected, 'selected-first-day', 11, 'success', `${day(-14)} 00:00:00`);
  insert.run(selected, 'selected-yesterday', 17, 'success', `${day(-1)} 23:59:59`);
  insert.run(selected, 'selected-today', 23, 'success', `${day()} 12:00:00`);
  insert.run(selected, 'selected-failure', 7000, 'error', `${day()} 12:00:00`);
  insert.run(selected, 'selected-before-window', 6000, 'success', `${day(-15)} 23:59:59`);
  insert.run(selected, 'selected-after-window', 5000, 'success', `${day(1)} 00:00:00`);
  insert.run(other, 'other-success', 9000, 'success', `${day()} 12:00:00`);
  insert.run(null, 'anonymous-success', 8000, 'success', `${day()} 12:00:00`);

  const agent = await admin();
  const page = await agent.get(`/admin/users/${selected}?user_id=${other}&userId=${other}&days=1`).expect(200);
  const rows = chartRows(page.text);
  assert.equal(rows.length, 15);
  assert.deepEqual(rows[0], { date: day(-14), calls: 1, tokens: 11 });
  assert.deepEqual(rows[1], { date: day(-13), calls: 0, tokens: 0 });
  assert.deepEqual(rows[13], { date: day(-1), calls: 1, tokens: 17 });
  assert.deepEqual(rows[14], { date: day(), calls: 1, tokens: 23 });
  assert.equal(rows.reduce((total, row) => total + row.calls, 0), 3);
  assert.equal(rows.reduce((total, row) => total + row.tokens, 0), 51);

  const quotaPosition = page.text.indexOf('<strong>Tokens this hour</strong>');
  const chartPosition = page.text.indexOf('id="daily-usage-heading"');
  const recentPosition = page.text.indexOf('<h3>Recent usage/errors</h3>');
  assert.ok(quotaPosition >= 0 && quotaPosition < chartPosition && chartPosition < recentPosition);
  assert.match(page.text, /Last 15 days, including today · UTC/);
  assert.match(page.text, /<script src="\/admin\/assets\/dashboard-usage\.js" defer><\/script>/);

  const otherPage = await agent.get(`/admin/users/${other}?user_id=${selected}`).expect(200);
  assert.deepEqual(chartRows(otherPage.text)[14], { date: day(), calls: 1, tokens: 9000 });
});

test('admin user detail fills fifteen empty days without including another user’s history', async () => {
  const empty = db.prepare("INSERT INTO users (name, email) VALUES ('New Student', 'new@example.test')").run().lastInsertRowid;
  const active = db.prepare("INSERT INTO users (name, email) VALUES ('Active Student', 'active@example.test')").run().lastInsertRowid;
  db.prepare(`
    INSERT INTO usage_logs (user_id, model, total_tokens, status)
    VALUES (?, 'active-model', 123456, 'success')
  `).run(active);

  const page = await (await admin()).get(`/admin/users/${empty}`).expect(200);
  const rows = chartRows(page.text);
  assert.equal(rows.length, 15);
  assert.equal(rows[0].date, day(-14));
  assert.equal(rows[14].date, day());
  assert.ok(rows.every((row) => row.calls === 0 && row.tokens === 0));
  assert.match(page.text, /<strong>0<\/strong> tokens/);
  assert.match(page.text, /<strong>0<\/strong> successful calls/);
  assert.match(page.text, /View daily usage table/);
  assert.doesNotMatch(page.text, /123456/);
});
