const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const request = require('supertest');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `agents-proxy-oauth-test-${Date.now()}.sqlite`);
process.env.DEFAULT_PROVIDER_API_KEY = 'oauth-test-provider-key';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'secret';
process.env.SESSION_SECRET = 'oauth-test-session-secret-with-enough-length';
process.env.PUBLIC_BASE_URL = '';
process.env.GOOGLE_OAUTH_ENABLED = 'false';
process.env.GOOGLE_OAUTH_AUTO_REGISTER = 'true';

const { createApp } = require('../src/app');
const { closeDb, getDb, initSchema, migrateSchema, seedSettings } = require('../src/db');
const { generateStudentKey } = require('../src/services/keyService');
const { createUserApiKey } = require('../src/services/userApiKeyService');
const { createInviteForUser, hashPassword } = require('../src/services/studentAuthService');
const {
  preserveIdentityConflict,
  resetIdentityConflict,
  resolveGoogleSignIn
} = require('../src/services/oauthIdentityService');
const { normalizeProfile, parseAllowedDomains } = require('../src/services/googleOAuthService');

const db = getDb();

function googleProfile(overrides = {}) {
  const suffix = `${Date.now()}-${Math.random()}`;
  return {
    provider: 'google',
    subject: `google-${suffix}`,
    email: `oauth-${suffix}@xtec.cat`,
    emailVerified: true,
    hostedDomain: 'xtec.cat',
    displayName: 'OAuth Student',
    ...overrides
  };
}

function createFakeOAuthService() {
  let profile = googleProfile();
  return {
    setProfile(nextProfile) {
      profile = nextProfile;
    },
    isEnabled() {
      return true;
    },
    async createAuthorizationRequest({ state }) {
      return {
        url: `https://accounts.example.test/authorize?state=${encodeURIComponent(state)}`,
        codeVerifier: 'test-code-verifier'
      };
    },
    async exchangeAndVerify() {
      return profile;
    }
  };
}

function createApprovedStudent(email, { withInvite = false, role = 'student' } = {}) {
  const result = db.prepare(`
    INSERT INTO users (name, email, enabled, role, registration_status, password_hash)
    VALUES ('Existing Student', ?, 1, ?, 'approved', ?)
  `).run(email, role, hashPassword('existing-password-123'));
  const groupId = db.prepare('SELECT id FROM groups ORDER BY id LIMIT 1').get().id;
  db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)').run(result.lastInsertRowid, groupId);
  if (withInvite) createInviteForUser(result.lastInsertRowid);
  return { id: result.lastInsertRowid, groupId };
}

async function oauthLogin(agent, fakeOAuthService, profile) {
  fakeOAuthService.setProfile(profile);
  const start = await agent.get('/auth/google').expect(302);
  const state = new URL(start.headers.location).searchParams.get('state');
  return agent.get(`/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`);
}

test.after(() => closeDb());

test('Google OAuth domain configuration is strict and ID token profiles require verified allowed domains', () => {
  assert.deepEqual(parseAllowedDomains(' XTEC.cat, @iesesteveterradas.cat, xtec.cat '), ['xtec.cat', 'iesesteveterradas.cat']);
  assert.deepEqual(parseAllowedDomains('*'), ['*']);
  assert.throws(() => parseAllowedDomains('*,xtec.cat'), /cannot be combined/);
  assert.throws(() => parseAllowedDomains('not a domain'), /Invalid Google OAuth hosted domain/);
  const profile = normalizeProfile({
    nonce: 'nonce',
    sub: 'subject',
    email: 'Student@XTEC.cat',
    email_verified: true,
    hd: 'XTEC.cat',
    name: 'Student'
  }, 'nonce', ['xtec.cat']);
  assert.equal(profile.email, 'student@xtec.cat');
  assert.equal(profile.hostedDomain, 'xtec.cat');
  assert.throws(() => normalizeProfile({
    nonce: 'nonce', sub: 'subject', email: 'student@example.com', email_verified: true
  }, 'nonce', ['xtec.cat']), /allowed hosted domain/);
  assert.doesNotThrow(() => normalizeProfile({
    nonce: 'nonce', sub: 'subject', email: 'student@example.com', email_verified: true
  }, 'nonce', ['*']));
});

test('legacy databases migrate existing users to approved and reject case-insensitive duplicate emails', () => {
  const legacy = new Database(':memory:');
  legacy.pragma('foreign_keys = ON');
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      api_key_hash TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL DEFAULT 'student',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT
    );
    INSERT INTO users (name, email) VALUES ('Legacy', 'legacy@example.test');
  `);
  initSchema(legacy);
  migrateSchema(legacy);
  const migrated = legacy.prepare('SELECT registration_status, auth_version FROM users').get();
  assert.equal(migrated.registration_status, 'approved');
  assert.equal(migrated.auth_version, 0);
  legacy.close();

  const duplicate = new Database(':memory:');
  duplicate.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      api_key_hash TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL DEFAULT 'student',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT
    );
    INSERT INTO users (name, email) VALUES ('First', 'Duplicate@example.test');
    INSERT INTO users (name, email) VALUES ('Second', 'duplicate@example.test');
  `);
  initSchema(duplicate);
  assert.throws(() => migrateSchema(duplicate), /case-insensitive user email uniqueness/);
  duplicate.close();
});

test('OAuth links an existing verified email without duplication and invalidates its invitation', async () => {
  const fakeOAuthService = createFakeOAuthService();
  const app = createApp({ googleOAuthService: fakeOAuthService });
  const agent = request.agent(app);
  const profile = googleProfile();
  const student = createApprovedStudent(profile.email, { withInvite: true });
  const originalPassword = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(student.id).password_hash;

  await oauthLogin(agent, fakeOAuthService, profile).then((response) => {
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, '/portal');
  });

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE lower(email) = lower(?)').get(profile.email).count, 1);
  const identity = db.prepare("SELECT * FROM user_identities WHERE provider = 'google' AND subject = ?").get(profile.subject);
  assert.equal(identity.user_id, student.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(student.id);
  assert.equal(user.password_hash, originalPassword);
  assert.equal(user.invite_token_nonce, null);
  await agent.get('/portal').expect(200).expect(/OpenCode configuration/);
});

test('OAuth links and logs in an approved teacher account', async () => {
  const fakeOAuthService = createFakeOAuthService();
  const app = createApp({ googleOAuthService: fakeOAuthService });
  const agent = request.agent(app);
  const profile = googleProfile();
  const teacher = createApprovedStudent(profile.email, { role: 'teacher' });

  const response = await oauthLogin(agent, fakeOAuthService, profile);
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/portal');
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(teacher.id);
  assert.equal(user.role, 'teacher');
  assert.equal(db.prepare('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?').get('google', profile.subject).user_id, teacher.id);
  await agent.get('/portal').expect(200).expect(/OpenCode configuration/);
});

test('OAuth auto-registration creates a restricted pending user that becomes active after group assignment', async () => {
  const fakeOAuthService = createFakeOAuthService();
  const app = createApp({ googleOAuthService: fakeOAuthService });
  const agent = request.agent(app);
  const profile = googleProfile();

  await oauthLogin(agent, fakeOAuthService, profile).then((response) => assert.equal(response.status, 302));
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(profile.email);
  assert.equal(user.registration_status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_groups WHERE user_id = ?').get(user.id).count, 0);

  seedSettings(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_groups WHERE user_id = ?').get(user.id).count, 0);
  const pendingPage = await agent.get('/portal').expect(200).expect('Cache-Control', /no-store/);
  assert.match(pendingPage.text, /Account awaiting approval/);
  assert.match(pendingPage.text, /administrator must assign your account to a course group/);
  assert.match(pendingPage.text, new RegExp(profile.email.replace('.', '\\.')));
  assert.doesNotMatch(pendingPage.text, /OpenCode configuration/);
  assert.doesNotMatch(pendingPage.text, /href="\/portal\/settings"/);
  await agent.post('/portal/key/regenerate').expect(302).expect('Location', '/portal');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_api_keys WHERE user_id = ?').get(user.id).count, 0);
  const pendingKey = generateStudentKey();
  createUserApiKey(user.id, 'Legacy key', pendingKey);
  const deniedApi = await request(app).get('/v1/models').set('Authorization', `Bearer ${pendingKey}`).expect(403);
  assert.equal(deniedApi.body.error.code, 'account_pending');
  db.prepare('DELETE FROM user_api_keys WHERE user_id = ?').run(user.id);

  const admin = request.agent(app);
  await admin.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const groupId = db.prepare('SELECT id FROM groups ORDER BY id LIMIT 1').get().id;
  await admin.post(`/admin/users/${user.id}`).type('form').send({
    name: user.name,
    email: user.email,
    role: 'teacher',
    group_id: String(groupId),
    enabled: '1'
  }).expect(302);
  const approved = db.prepare('SELECT registration_status, role FROM users WHERE id = ?').get(user.id);
  assert.equal(approved.registration_status, 'approved');
  assert.equal(approved.role, 'teacher');
  await agent.get('/portal').expect(200).expect(/OpenCode configuration/);
});

test('a recreated Google subject creates a review and preserve keeps the account configuration', async () => {
  const profile = googleProfile();
  const student = createApprovedStudent(profile.email, { withInvite: true });
  db.prepare(`
    INSERT INTO user_identities (provider, subject, user_id, email_at_link, last_email, hosted_domain)
    VALUES ('google', 'old-google-subject', ?, ?, ?, 'xtec.cat')
  `).run(student.id, profile.email, profile.email);
  createUserApiKey(student.id, 'Laptop', generateStudentKey());
  const app = createApp({ googleOAuthService: createFakeOAuthService() });
  const existingSession = request.agent(app);
  await existingSession.post('/login').type('form').send({ login: profile.email, password: 'existing-password-123' }).expect(302);
  const result = resolveGoogleSignIn(profile);
  assert.equal(result.kind, 'conflict');

  const before = db.prepare('SELECT auth_version FROM users WHERE id = ?').get(student.id).auth_version;
  const resolved = preserveIdentityConflict(result.conflict.id, 'admin');
  assert.equal(resolved.userId, student.id);
  assert.equal(db.prepare("SELECT subject FROM user_identities WHERE user_id = ? AND provider = 'google'").get(student.id).subject, profile.subject);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_api_keys WHERE user_id = ?').get(student.id).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_groups WHERE user_id = ?').get(student.id).count, 1);
  const after = db.prepare('SELECT * FROM users WHERE id = ?').get(student.id);
  assert.equal(after.auth_version, before + 1);
  assert.equal(after.invite_token_nonce, null);
  await existingSession.get('/portal').expect(302).expect('Location', '/?error=session_expired');
});

test('OAuth state is single-use and a subject conflict shows the administrator-review message', async () => {
  const fakeOAuthService = createFakeOAuthService();
  const app = createApp({ googleOAuthService: fakeOAuthService });
  const agent = request.agent(app);
  const profile = googleProfile();
  const student = createApprovedStudent(profile.email);
  db.prepare(`
    INSERT INTO user_identities (provider, subject, user_id, email_at_link, last_email, hosted_domain)
    VALUES ('google', 'review-old-subject', ?, ?, ?, 'xtec.cat')
  `).run(student.id, profile.email, profile.email);
  fakeOAuthService.setProfile(profile);
  const start = await agent.get('/auth/google').expect(302);
  const state = new URL(start.headers.location).searchParams.get('state');
  await agent.get('/auth/google/callback?code=test-code&state=wrong-state')
    .expect(302).expect('Location', '/?error=oauth_invalid');
  await agent.get(`/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`)
    .expect(302).expect('Location', '/?error=oauth_expired');

  const review = await oauthLogin(agent, fakeOAuthService, profile);
  assert.equal(review.status, 200);
  assert.match(review.text, /Account requires administrator review/);
  assert.match(review.text, /No duplicate account was created/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?').get(profile.email).count, 1);

  const admin = request.agent(app);
  await admin.post('/login').type('form').send({ login: 'admin', password: 'secret' }).expect(302);
  const reviews = await admin.get('/admin/oauth-conflicts').expect(200);
  assert.match(reviews.text, /Replace identity and preserve account/);
  assert.match(reviews.text, /Reset as a new user/);
  assert.equal((reviews.text.match(/<h1>OAuth identity reviews<\/h1>/g) || []).length, 1);
});

test('reset identity conflict deletes account data, anonymizes usage, and creates a fresh pending user', () => {
  const profile = googleProfile();
  const student = createApprovedStudent(profile.email);
  db.prepare(`
    INSERT INTO user_identities (provider, subject, user_id, email_at_link, last_email, hosted_domain)
    VALUES ('google', 'reset-old-subject', ?, ?, ?, 'xtec.cat')
  `).run(student.id, profile.email, profile.email);
  createUserApiKey(student.id, 'Laptop', generateStudentKey());
  db.prepare("INSERT INTO usage_logs (user_id, model, status) VALUES (?, 'active-model', 'success')").run(student.id);
  const conversation = db.prepare("INSERT INTO conversations (user_id, title) VALUES (?, 'Old')").run(student.id);
  db.prepare("INSERT INTO messages (conversation_id, user_id, role, content) VALUES (?, ?, 'user', 'Old message')")
    .run(conversation.lastInsertRowid, student.id);

  const conflict = resolveGoogleSignIn(profile);
  assert.equal(conflict.kind, 'conflict');
  const reset = resetIdentityConflict(conflict.conflict.id, 'admin');
  assert.notEqual(reset.userId, student.id);
  assert.equal(db.prepare('SELECT * FROM users WHERE id = ?').get(student.id), undefined);
  const replacement = db.prepare('SELECT * FROM users WHERE id = ?').get(reset.userId);
  assert.equal(replacement.email, profile.email);
  assert.equal(replacement.registration_status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_groups WHERE user_id = ?').get(reset.userId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_api_keys WHERE user_id = ?').get(reset.userId).count, 0);
  assert.equal(db.prepare('SELECT user_id FROM usage_logs WHERE model = ? ORDER BY id DESC LIMIT 1').get('active-model').user_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE id = ?').get(conversation.lastInsertRowid).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE content = ?').get('Old message').count, 0);
  assert.equal(db.prepare("SELECT user_id FROM user_identities WHERE provider = 'google' AND subject = ?").get(profile.subject).user_id, reset.userId);
  assert.ok(db.prepare("SELECT * FROM auth_audit_logs WHERE event = 'oauth_identity_reset_new_user' AND user_id = ?").get(reset.userId));
});
