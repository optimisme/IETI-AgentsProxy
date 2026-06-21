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
    let user = db.prepare('SELECT * FROM users WHERE api_key_lookup_hash = ? AND api_key_hash IS NOT NULL').get(lookupHash);

    if (user && !verifyApiKey(apiKey, user.api_key_hash)) {
      user = null;
    }

    if (!user) {
      const { prefix, suffix } = keyPrefixSuffix(apiKey);
      const legacyUsers = db.prepare(`
        SELECT *
        FROM users
        WHERE api_key_hash IS NOT NULL
          AND api_key_lookup_hash IS NULL
          AND api_key_prefix = ?
          AND api_key_suffix = ?
      `).all(prefix, suffix);
      user = legacyUsers.find((candidate) => verifyApiKey(apiKey, candidate.api_key_hash));
      if (user) {
        db.prepare('UPDATE users SET api_key_lookup_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(lookupHash, user.id);
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
