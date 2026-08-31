const { getDb } = require('../db');
const { generateStudentKey, hashApiKey, lookupHashApiKey, keyPrefixSuffix } = require('./keyService');

const KEY_NAME_MAX_LENGTH = 80;

function normalizeApiKeyName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > KEY_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

function listUserApiKeys(userId) {
  const db = getDb();
  migrateLegacyUserKey(db, userId);
  return db.prepare(`
    SELECT id, name, api_key_prefix, api_key_suffix, created_at, last_used_at
    FROM user_api_keys
    WHERE user_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(userId);
}

function hasUserApiKeyName(userId, name) {
  return Boolean(getDb().prepare('SELECT 1 FROM user_api_keys WHERE user_id = ? AND name = ? COLLATE NOCASE').get(userId, name));
}

function createUserApiKey(userId, name, apiKey = generateStudentKey()) {
  const normalizedName = normalizeApiKeyName(name);
  if (!normalizedName) throw new Error('Invalid API key name.');
  const { prefix, suffix } = keyPrefixSuffix(apiKey);
  const result = getDb().prepare(`
    INSERT INTO user_api_keys
      (user_id, name, api_key_hash, api_key_lookup_hash, api_key_prefix, api_key_suffix)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    normalizedName,
    hashApiKey(apiKey),
    lookupHashApiKey(apiKey),
    prefix,
    suffix
  );
  return { id: result.lastInsertRowid, name: normalizedName, key: apiKey, prefix, suffix };
}

function revokeUserApiKey(userId, keyId) {
  const db = getDb();
  const key = db.prepare('SELECT api_key_lookup_hash FROM user_api_keys WHERE id = ? AND user_id = ?').get(keyId, userId);
  if (!key) return false;
  const deleted = db.prepare('DELETE FROM user_api_keys WHERE id = ? AND user_id = ?').run(keyId, userId).changes > 0;
  if (deleted) {
    db.prepare(`
      UPDATE users
      SET api_key_hash = NULL, api_key_lookup_hash = NULL, api_key_prefix = NULL, api_key_suffix = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND api_key_lookup_hash = ?
    `).run(userId, key.api_key_lookup_hash);
  }
  return deleted;
}

function migrateLegacyUserKey(database, userId) {
  const legacy = database.prepare(`
    SELECT id, api_key_hash, api_key_lookup_hash, api_key_prefix, api_key_suffix, created_at, last_used_at
    FROM users
    WHERE id = ? AND api_key_hash IS NOT NULL AND api_key_lookup_hash IS NOT NULL
  `).get(userId);
  if (!legacy || database.prepare('SELECT 1 FROM user_api_keys WHERE user_id = ?').get(userId)) return;
  database.prepare(`
    INSERT OR IGNORE INTO user_api_keys
      (user_id, name, api_key_hash, api_key_lookup_hash, api_key_prefix, api_key_suffix, created_at, last_used_at)
    VALUES (?, 'Default', ?, ?, ?, ?, ?, ?)
  `).run(
    legacy.id,
    legacy.api_key_hash,
    legacy.api_key_lookup_hash,
    legacy.api_key_prefix,
    legacy.api_key_suffix,
    legacy.created_at,
    legacy.last_used_at
  );
}

function getAvailableLegacyName(userId, prefix = 'Admin key') {
  let candidate = prefix;
  let suffix = 2;
  while (hasUserApiKeyName(userId, candidate)) candidate = `${prefix} ${suffix++}`;
  return candidate;
}

module.exports = {
  KEY_NAME_MAX_LENGTH,
  normalizeApiKeyName,
  listUserApiKeys,
  hasUserApiKeyName,
  createUserApiKey,
  revokeUserApiKey,
  getAvailableLegacyName
};
