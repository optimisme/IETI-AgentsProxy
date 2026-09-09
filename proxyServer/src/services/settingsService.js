const { getDb } = require('../db');

function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  getDb()
    .prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `)
    .run(key, String(value ?? ''));
}

function getAllSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings ORDER BY key').all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

module.exports = {
  getSetting,
  setSetting,
  getAllSettings,
  maskSecret
};
