const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');
const { getDb } = require('../db');

// Request handlers use the async bcrypt functions so a password check never blocks
// other requests. The synchronous hash remains for seeding and tests.
function hashPassword(password) {
  return bcrypt.hashSync(password, 12);
}

async function verifyPassword(password, hash) {
  if (!password || !hash) return false;
  return bcrypt.compare(password, hash);
}

let dummyPasswordHash;

// Spends the same time as a real check so response timing does not reveal which
// accounts exist or have a password.
async function verifyDummyPassword(password) {
  dummyPasswordHash ||= bcrypt.hash(crypto.randomBytes(16).toString('hex'), 12);
  await bcrypt.compare(String(password || 'x'), await dummyPasswordHash);
  return false;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('base64url');
}

function inviteSignature(userId, nonce, expiresAt) {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${userId}.${nonce}.${expiresAt}`)
    .digest('base64url');
}

function buildInviteToken(userId, nonce, expiresAt) {
  const payload = {
    u: Number(userId),
    n: nonce,
    e: expiresAt,
    s: inviteSignature(userId, nonce, expiresAt)
  };
  return `ieti_inv_${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function parseSignedInviteToken(token) {
  if (!token?.startsWith('ieti_inv_')) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.slice('ieti_inv_'.length), 'base64url').toString('utf8'));
    if (!payload?.u || !payload?.n || !payload?.e || !payload?.s) return null;
    const expected = inviteSignature(payload.u, payload.n, payload.e);
    if (payload.s.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(payload.s), Buffer.from(expected))) return null;
    return payload;
  } catch {
    return null;
  }
}

function createInviteForUser(userId, { expiresInDays = 14 } = {}) {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const token = buildInviteToken(userId, nonce, expiresAt);
  getDb().prepare(`
    UPDATE users
    SET invite_token_hash = ?, invite_token_nonce = ?, invite_expires_at = ?, invite_used_at = NULL, locked_until = NULL,
        failed_login_count = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(sha256(token), sha256(nonce), expiresAt, userId);
  return { token, expiresAt };
}

function findUserByInviteToken(token) {
  // Only signed invites are accepted: they resolve to a single row by id and nonce.
  // Unsigned tokens would need a bcrypt comparison against every pending invite,
  // which lets any unauthenticated request block the event loop.
  // Only a digest of the nonce is stored, so database access does not reveal invite links;
  // plain nonces written by earlier versions are still accepted until they are used.
  const signedInvite = parseSignedInviteToken(token);
  if (!signedInvite) return null;
  const user = getDb().prepare(`
    SELECT *
    FROM users
    WHERE id = ?
      AND invite_token_nonce IN (?, ?)
      AND invite_used_at IS NULL
  `).get(signedInvite.u, sha256(signedInvite.n), String(signedInvite.n));
  if (!user || user.invite_expires_at !== signedInvite.e || new Date(user.invite_expires_at).getTime() <= Date.now()) return null;
  return user;
}

// Reports whether an unused invite exists. Its link cannot be rebuilt: it is shown once
// when created, and a lost link is replaced by generating a new invite.
function getActiveInviteForUser(userId) {
  const user = getDb().prepare(`
    SELECT id, invite_token_nonce, invite_expires_at, invite_used_at
    FROM users
    WHERE id = ?
  `).get(userId);
  if (!user?.invite_token_nonce || user.invite_used_at) return null;
  if (!user.invite_expires_at || new Date(user.invite_expires_at).getTime() <= Date.now()) return null;
  return { expiresAt: user.invite_expires_at };
}

async function setPasswordFromInvite(userId, password) {
  const passwordHash = await bcrypt.hash(password, 12);
  const passwordChangedAt = new Date().toISOString();
  getDb().prepare(`
    UPDATE users
    SET password_hash = ?, password_changed_at = ?, invite_used_at = CURRENT_TIMESTAMP,
        invite_token_hash = NULL, invite_token_nonce = NULL, invite_expires_at = NULL, failed_login_count = 0, locked_until = NULL,
        auth_version = auth_version + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(passwordHash, passwordChangedAt, userId);
  return passwordChangedAt;
}

const ACCOUNT_LOCK_THRESHOLD = 50;

function findUserForLogin(email) {
  return getDb().prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email);
}

function isLocked(user) {
  return Boolean(user?.locked_until && new Date(user.locked_until).getTime() > Date.now());
}

function recordFailedLogin(userId) {
  const user = getDb().prepare('SELECT failed_login_count FROM users WHERE id = ?').get(userId);
  const count = Number(user?.failed_login_count || 0) + 1;
  // Per-address limits stop ordinary guessing; this account-wide lock only catches attempts
  // spread across many addresses, so its threshold is high enough that a stranger cannot
  // casually lock a student out.
  const lockUntil = count >= ACCOUNT_LOCK_THRESHOLD ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
  getDb().prepare(`
    UPDATE users
    SET failed_login_count = ?, locked_until = COALESCE(?, locked_until), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(count, lockUntil, userId);
}

function clearFailedLogins(userId) {
  getDb().prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyDummyPassword,
  createInviteForUser,
  findUserByInviteToken,
  getActiveInviteForUser,
  setPasswordFromInvite,
  findUserForLogin,
  isLocked,
  recordFailedLogin,
  clearFailedLogins
};
