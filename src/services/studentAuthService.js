const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');
const { getDb } = require('../db');

function hashPassword(password) {
  return bcrypt.hashSync(password, 12);
}

function verifyPassword(password, hash) {
  if (!password || !hash) return false;
  return bcrypt.compareSync(password, hash);
}

function generateInviteToken() {
  return `ieti_inv_${crypto.randomBytes(32).toString('base64url')}`;
}

function hashInviteToken(token) {
  return bcrypt.hashSync(token, 12);
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
  `).run(hashInviteToken(token), nonce, expiresAt, userId);
  return { token, expiresAt };
}

function findUserByInviteToken(token) {
  if (!token) return null;
  const signedInvite = parseSignedInviteToken(token);
  if (signedInvite) {
    const user = getDb().prepare(`
      SELECT *
      FROM users
      WHERE id = ?
        AND invite_token_nonce = ?
        AND invite_used_at IS NULL
    `).get(signedInvite.u, signedInvite.n);
    if (!user || user.invite_expires_at !== signedInvite.e || new Date(user.invite_expires_at).getTime() <= Date.now()) return null;
    return user;
  }

  const users = getDb().prepare(`
    SELECT *
    FROM users
    WHERE invite_token_hash IS NOT NULL
      AND invite_used_at IS NULL
      AND (invite_expires_at IS NULL OR invite_expires_at > datetime('now'))
  `).all();
  return users.find((user) => bcrypt.compareSync(token, user.invite_token_hash));
}

function getActiveInviteForUser(userId) {
  const user = getDb().prepare(`
    SELECT id, invite_token_nonce, invite_expires_at, invite_used_at
    FROM users
    WHERE id = ?
  `).get(userId);
  if (!user?.invite_token_nonce || user.invite_used_at) return null;
  if (!user.invite_expires_at || new Date(user.invite_expires_at).getTime() <= Date.now()) return null;
  return {
    token: buildInviteToken(user.id, user.invite_token_nonce, user.invite_expires_at),
    expiresAt: user.invite_expires_at
  };
}

function setPasswordFromInvite(userId, password) {
  getDb().prepare(`
    UPDATE users
    SET password_hash = ?, password_changed_at = CURRENT_TIMESTAMP, invite_used_at = CURRENT_TIMESTAMP,
        invite_token_hash = NULL, invite_token_nonce = NULL, invite_expires_at = NULL, failed_login_count = 0, locked_until = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(hashPassword(password), userId);
}

function findUserForLogin(email) {
  return getDb().prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email);
}

function isLocked(user) {
  return Boolean(user?.locked_until && new Date(user.locked_until).getTime() > Date.now());
}

function recordFailedLogin(userId) {
  const user = getDb().prepare('SELECT failed_login_count FROM users WHERE id = ?').get(userId);
  const count = Number(user?.failed_login_count || 0) + 1;
  const lockUntil = count >= 8 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
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
  createInviteForUser,
  findUserByInviteToken,
  getActiveInviteForUser,
  setPasswordFromInvite,
  findUserForLogin,
  isLocked,
  recordFailedLogin,
  clearFailedLogins
};
