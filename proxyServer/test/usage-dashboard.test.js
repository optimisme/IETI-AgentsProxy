const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-dashboard-'));
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'usage.sqlite');
process.env.GOOGLE_OAUTH_ENABLED = 'false';
process.env.PUBLIC_BASE_URL = '';
process.env.DEFAULT_PROVIDER_API_KEY = '';

const { getDb, closeDb, initSchema } = require('../src/db');
const { dailyUsage, topActiveUsers, dashboardSummary, recentUsage } = require('../src/services/usageService');
const now = new Date('2026-10-02T15:04:05Z');
let db;

test.before(() => { db = getDb(); });
test.beforeEach(() => {
  db.exec('DELETE FROM usage_logs; DELETE FROM users;');
});
test.after(() => {
  closeDb();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function user(name, enabled = 1) {
  return Number(db.prepare('INSERT INTO users (name, email, enabled) VALUES (?, ?, ?)')
    .run(name, `${name.toLowerCase()}@example.test`, enabled).lastInsertRowid);
}

function usage(userId, createdAt, tokens = 7, status = 'success') {
  return Number(db.prepare(`
    INSERT INTO usage_logs (user_id, model, provider_slug, total_tokens, status, created_at)
    VALUES (?, 'test-model', 'test-provider', ?, ?, ?)
  `).run(userId, tokens, status, createdAt).lastInsertRowid);
}

test('daily usage includes exactly 15 UTC calendar days, fills gaps and counts completed calls and charged cancellations', () => {
  const student = user('Alice');
  usage(student, '2026-09-17 23:59:59', 10000);
  usage(student, '2026-09-18 00:00:00', 11);
  usage(student, '2026-09-19 12:00:00', 5000, 'error');
  usage(student, '2026-10-01 23:59:59', 13, 'cancelled');
  usage(student, '2026-10-02 12:00:00', 0, 'cancelled');
  usage(student, '2026-10-02 00:00:00', 17);
  usage(student, '2026-10-02 23:59:59', 19);
  usage(student, '2026-10-03 00:00:00', 10000);

  const daily = dailyUsage(15, now);
  assert.equal(daily.length, 15);
  assert.deepEqual(daily[0], { date: '2026-09-18', calls: 1, tokens: 11 });
  assert.deepEqual(daily[1], { date: '2026-09-19', calls: 0, tokens: 0 });
  assert.deepEqual(daily[13], { date: '2026-10-01', calls: 1, tokens: 13 });
  assert.deepEqual(daily[14], { date: '2026-10-02', calls: 2, tokens: 36 });
  assert.equal(daily.reduce((total, day) => total + day.calls, 0), 4);
  assert.equal(daily.reduce((total, day) => total + day.tokens, 0), 60);
});

test('empty usage and UTC boundaries produce complete buckets across a leap day', () => {
  assert.deepEqual(dailyUsage(3, new Date('2024-03-01T00:30:00+02:00')), [
    { date: '2024-02-27', calls: 0, tokens: 0 },
    { date: '2024-02-28', calls: 0, tokens: 0 },
    { date: '2024-02-29', calls: 0, tokens: 0 }
  ]);
  assert.deepEqual(topActiveUsers(15, 10, now), []);
  const summary = dashboardSummary(now);
  assert.equal(summary.totalTokensToday, 0);
  assert.equal(summary.dailyUsage.length, 15);
  assert.deepEqual(summary.topUsers, []);
  assert.deepEqual(summary.recentCalls, []);
});

test('student daily usage isolates completed calls and charged cancellations within UTC boundaries from other and anonymous users', () => {
  const alice = user('Alice');
  const bob = user('Bob');
  const removed = user('Removed');
  usage(alice, '2026-09-17 23:59:59', 10000);
  usage(alice, '2026-09-18 00:00:00', 11);
  usage(alice, '2026-10-01 23:59:59', 13);
  usage(alice, '2026-10-02 00:00:00', 17, 'cancelled');
  usage(alice, '2026-10-02 12:00:00', 0, 'cancelled');
  usage(alice, '2026-10-02 23:59:59', 19);
  usage(alice, '2026-10-02 12:00:00', 10000, 'error');
  usage(alice, '2026-10-03 00:00:00', 10000);
  usage(bob, '2026-09-18 00:00:00', 100);
  usage(bob, '2026-10-02 12:00:00', 200);
  usage(removed, '2026-10-02 12:00:00', 300);
  usage(null, '2026-10-02 12:00:00', 400);
  db.prepare('DELETE FROM users WHERE id = ?').run(removed);

  const aliceDaily = dailyUsage(15, now, alice);
  assert.equal(aliceDaily.length, 15);
  assert.deepEqual(aliceDaily[0], { date: '2026-09-18', calls: 1, tokens: 11 });
  assert.deepEqual(aliceDaily[1], { date: '2026-09-19', calls: 0, tokens: 0 });
  assert.deepEqual(aliceDaily[13], { date: '2026-10-01', calls: 1, tokens: 13 });
  assert.deepEqual(aliceDaily[14], { date: '2026-10-02', calls: 2, tokens: 36 });
  assert.equal(aliceDaily.reduce((sum, day) => sum + day.calls, 0), 4);
  assert.equal(aliceDaily.reduce((sum, day) => sum + day.tokens, 0), 60);
  const bobDaily = dailyUsage(15, now, bob);
  assert.equal(bobDaily.reduce((sum, day) => sum + day.calls, 0), 2);
  assert.equal(bobDaily.reduce((sum, day) => sum + day.tokens, 0), 300);

  const globalDaily = dailyUsage(15, now);
  assert.deepEqual(globalDaily[0], { date: '2026-09-18', calls: 2, tokens: 111 });
  assert.deepEqual(globalDaily[14], { date: '2026-10-02', calls: 5, tokens: 936 });
  assert.equal(globalDaily.reduce((sum, day) => sum + day.tokens, 0), 1060);
  assert.deepEqual(dailyUsage(15, now, null), globalDaily);
});

test('new, nonexistent, zero and deleted student ids receive zero-filled daily buckets', () => {
  const active = user('Active');
  const removed = user('Removed');
  const newStudent = user('New');
  usage(active, '2026-10-02 12:00:00', 17);
  usage(removed, '2026-10-02 12:00:00', 23);
  usage(null, '2026-10-02 12:00:00', 29);
  db.prepare('DELETE FROM users WHERE id = ?').run(removed);

  const globalDaily = dailyUsage(15, now);
  assert.equal(globalDaily[14].tokens, 69);
  const empty = globalDaily.map(({ date }) => ({ date, calls: 0, tokens: 0 }));
  for (const studentId of [newStudent, 0, 999999, removed]) {
    assert.deepEqual(dailyUsage(15, now, studentId), empty);
  }
});

test('active users rank by completed calls and charged cancellations, tokens and user id with the same date window and limit', () => {
  const alice = user('Alice');
  const bob = user('Bob', 0);
  const carol = user('Carol');
  const dan = user('Dan');
  user('Inactive');
  usage(alice, '2026-09-18 00:00:00', 10);
  usage(alice, '2026-10-02 23:59:59', 10);
  usage(bob, '2026-10-02 12:00:00', 20);
  usage(bob, '2026-10-02 13:00:00', 20, 'cancelled');
  usage(bob, '2026-10-02 12:00:00', 0, 'cancelled');
  usage(carol, '2026-10-02 12:00:00', 20);
  usage(carol, '2026-10-02 13:00:00', 20);
  usage(dan, '2026-10-02 12:00:00', 1000);
  usage(dan, '2026-10-02 13:00:00', 1000, 'error');
  usage(dan, '2026-09-17 23:59:59', 1000);
  usage(dan, '2026-10-03 00:00:00', 1000);
  usage(null, '2026-10-02 12:00:00', 100000);

  const ranking = topActiveUsers(15, 10, now);
  assert.deepEqual(ranking.map(({ id, calls, tokens }) => ({ id, calls, tokens })), [
    { id: bob, calls: 2, tokens: 40 },
    { id: carol, calls: 2, tokens: 40 },
    { id: alice, calls: 2, tokens: 20 },
    { id: dan, calls: 1, tokens: 1000 }
  ]);
  assert.equal(ranking[0].name, 'Bob');
  assert.equal(ranking[0].email, 'bob@example.test');
  assert.deepEqual(topActiveUsers(15, 2, now), ranking.slice(0, 2));
  assert.deepEqual(topActiveUsers(15, 0, now), []);
  assert.deepEqual(dashboardSummary(now).topUsers, ranking);
});

test('deleted users retain anonymous daily totals and recent calls while leaving the ranking', () => {
  const removed = user('Removed');
  const remaining = user('Remaining');
  const removedCall = usage(removed, '2026-10-02 10:00:00', 17);
  usage(remaining, '2026-10-02 11:00:00', 23);
  db.prepare('DELETE FROM users WHERE id = ?').run(removed);

  const summary = dashboardSummary(now);
  assert.equal(summary.totalUsers, 1);
  assert.equal(summary.totalTokensToday, 40);
  assert.deepEqual(summary.dailyUsage[14], { date: '2026-10-02', calls: 2, tokens: 40 });
  assert.deepEqual(summary.topUsers.map((row) => row.id), [remaining]);
  const anonymous = summary.recentCalls.find((row) => row.id === removedCall);
  assert.equal(anonymous.user_id, null);
  assert.equal(anonymous.email, null);
  assert.equal(anonymous.total_tokens, 17);
});

test('recent calls span users and paginate consistently when timestamps tie', () => {
  const alice = user('Alice');
  const bob = user('Bob');
  const old = usage(bob, '2026-10-01 12:00:00');
  const first = usage(alice, '2026-10-02 12:00:00');
  const second = usage(bob, '2026-10-02 12:00:00', 100, 'error');
  const third = usage(alice, '2026-10-02 12:00:00');
  const fourth = usage(null, '2026-10-02 12:00:00');

  assert.deepEqual(recentUsage(2).map((row) => row.id), [fourth, third]);
  assert.deepEqual(recentUsage(2, null, 2).map((row) => row.id), [second, first]);
  assert.deepEqual(recentUsage(2, null, 4).map((row) => row.id), [old]);
  assert.deepEqual(recentUsage(1, alice).map((row) => row.id), [third]);
  assert.deepEqual(recentUsage(1, alice, 1).map((row) => row.id), [first]);
  assert.equal(recentUsage(1, bob)[0].email, 'bob@example.test');
});

test('dashboard limits recent calls to 25 and sorts the latest ten errors consistently', () => {
  const alice = user('Alice');
  const bob = user('Bob');
  const inserted = [];
  for (let index = 0; index < 30; index += 1) {
    inserted.push(usage(index % 2 ? alice : bob, '2026-10-02 12:00:00', 100, 'error'));
  }
  const summary = dashboardSummary(now);
  assert.deepEqual(summary.recentCalls.map((row) => row.id), inserted.slice(-25).reverse());
  assert.deepEqual(summary.recentErrors.map((row) => row.id), inserted.slice(-10).reverse());
  assert.equal(new Set(summary.recentCalls.map((row) => row.user_id)).size, 2);
  assert.equal(summary.totalTokensToday, 0);
});

test('adding the global recent-call index is idempotent and preserves existing usage', () => {
  const student = user('Alice');
  usage(student, '2026-10-02 12:00:00', 42);
  const before = db.prepare('SELECT * FROM usage_logs').all();
  db.exec('DROP INDEX idx_usage_logs_created_id');
  initSchema(db);
  initSchema(db);

  assert.deepEqual(db.prepare('SELECT * FROM usage_logs').all(), before);
  assert.deepEqual(db.prepare('PRAGMA index_info(idx_usage_logs_created_id)').all().map((column) => column.name), ['created_at', 'id']);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});
