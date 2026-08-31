const { getDb } = require('../db');
const { keyPrefixSuffix, lookupHashApiKey, verifyApiKey } = require('../services/keyService');
const { apiError } = require('../utils/errors');

function extractBearer(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function authStudent(req, res, next) {
  try {
    const apiKey = extractBearer(req);
    if (!apiKey) throw apiError(401, 'missing_api_key', 'Missing Authorization bearer token.');

    const db = getDb();
    const lookupHash = lookupHashApiKey(apiKey);
    let user = db.prepare(`
      SELECT users.*, user_api_keys.id AS authenticated_api_key_id, user_api_keys.api_key_hash AS authenticated_api_key_hash
      FROM user_api_keys
      JOIN users ON users.id = user_api_keys.user_id
      WHERE user_api_keys.api_key_lookup_hash = ?
    `).get(lookupHash);

    if (user && !verifyApiKey(apiKey, user.authenticated_api_key_hash)) {
      user = null;
    }

    if (user) {
      db.prepare('UPDATE user_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.authenticated_api_key_id);
      db.prepare('UPDATE users SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    }

    if (!user) {
      const { prefix, suffix } = keyPrefixSuffix(apiKey);
      const legacyUsers = db.prepare(`
        SELECT *
        FROM users
        WHERE api_key_hash IS NOT NULL
          AND (
            api_key_lookup_hash = ?
            OR (
              api_key_lookup_hash IS NULL
              AND api_key_prefix = ?
              AND api_key_suffix = ?
            )
          )
      `).all(lookupHash, prefix, suffix);
      user = legacyUsers.find((candidate) => verifyApiKey(apiKey, candidate.api_key_hash));
      if (user) {
        db.prepare('UPDATE users SET api_key_lookup_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(lookupHash, user.id);
        db.prepare(`
          INSERT OR IGNORE INTO user_api_keys
            (user_id, name, api_key_hash, api_key_lookup_hash, api_key_prefix, api_key_suffix, created_at, last_used_at)
          VALUES (?, 'Default', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(user.id, user.api_key_hash, lookupHash, user.api_key_prefix, user.api_key_suffix, user.created_at);
        user = { ...user, api_key_lookup_hash: lookupHash };
      }
    }

    if (!user) throw apiError(401, 'invalid_api_key', 'Invalid or revoked API key.');
    if (!user.enabled) throw apiError(403, 'user_disabled', 'This user is disabled.');

    req.student = user;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { authStudent };
