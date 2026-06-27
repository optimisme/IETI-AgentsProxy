const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

let db;

const DEFAULT_GROUP_LIMITS = {
  dailyCallLimit: 1000000000,
  dailyTokenLimit: 1000000000,
  hourlyCallLimit: 100000000,
  hourlyTokenLimit: 100000000
};

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  migrateSchema(db);
  seedSettings(db);
  return db;
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
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

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      external_conversation_id TEXT,
      title TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      model TEXT NOT NULL,
      provider_slug TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      was_streaming INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'openai-compatible',
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      max_concurrent_requests INTEGER,
      timeout_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS provider_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      public_model TEXT NOT NULL,
      upstream_model TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      context_limit INTEGER,
      output_limit INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider_id, public_model)
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL,
      daily_call_limit INTEGER,
      daily_token_limit INTEGER,
      hourly_call_limit INTEGER,
      hourly_token_limit INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_groups (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS group_providers (
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (group_id, provider_id)
    );

    CREATE INDEX IF NOT EXISTS idx_usage_logs_user_created ON usage_logs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_status_created ON usage_logs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_user_groups_group ON user_groups(group_id);
    CREATE INDEX IF NOT EXISTS idx_group_providers_provider ON group_providers(provider_id);
  `);
}

function migrateSchema(database) {
  const columns = database.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
  const addColumn = (name, definition) => {
    if (!columns.includes(name)) database.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  };

  addColumn('password_hash', 'TEXT');
  addColumn('password_changed_at', 'TEXT');
  addColumn('invite_token_hash', 'TEXT');
  addColumn('invite_token_nonce', 'TEXT');
  addColumn('invite_expires_at', 'TEXT');
  addColumn('invite_used_at', 'TEXT');
  addColumn('failed_login_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('locked_until', 'TEXT');
  addColumn('api_key_prefix', 'TEXT');
  addColumn('api_key_suffix', 'TEXT');
  addColumn('api_key_lookup_hash', 'TEXT');
  for (const name of ['daily_token_limit', 'monthly_token_limit', 'monthly_cost_limit_eur', 'allowed_models']) {
    if (columns.includes(name)) database.exec(`ALTER TABLE users DROP COLUMN ${name}`);
  }

  const usageColumns = database.prepare('PRAGMA table_info(usage_logs)').all().map((column) => column.name);
  if (!usageColumns.includes('provider_slug')) {
    database.exec('ALTER TABLE usage_logs ADD COLUMN provider_slug TEXT');
  }
  if (usageColumns.includes('estimated_cost_eur')) {
    database.exec('ALTER TABLE usage_logs DROP COLUMN estimated_cost_eur');
  }

  const providerModelColumns = database.prepare('PRAGMA table_info(provider_models)').all().map((column) => column.name);
  for (const name of ['input_eur_per_1m', 'output_eur_per_1m']) {
    if (providerModelColumns.includes(name)) database.exec(`ALTER TABLE provider_models DROP COLUMN ${name}`);
  }

  const groupColumns = database.prepare('PRAGMA table_info(groups)').all().map((column) => column.name);
  const addGroupColumn = (name, definition) => {
    if (!groupColumns.includes(name)) database.exec(`ALTER TABLE groups ADD COLUMN ${name} ${definition}`);
  };
  addGroupColumn('provider_id', 'INTEGER REFERENCES providers(id) ON DELETE SET NULL');
  addGroupColumn('daily_call_limit', 'INTEGER');
  addGroupColumn('daily_token_limit', 'INTEGER');
  addGroupColumn('hourly_call_limit', 'INTEGER');
  addGroupColumn('hourly_token_limit', 'INTEGER');
  if (groupColumns.includes('description')) {
    database.exec('ALTER TABLE groups DROP COLUMN description');
  }

  database.exec(`
    DELETE FROM user_groups
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM user_groups
      GROUP BY user_id
    )
  `);
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_groups_one_group ON user_groups(user_id)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_users_api_key_lookup_hash ON users(api_key_lookup_hash)');

  const groupProviderColumns = database.prepare('PRAGMA table_info(group_providers)').all().map((column) => column.name);
  const legacyProviderPoolColumn = ['wei', 'ght'].join('');
  if (groupProviderColumns.includes(legacyProviderPoolColumn)) {
    database.exec(`ALTER TABLE group_providers DROP COLUMN ${legacyProviderPoolColumn}`);
  }

  database.exec(`
    INSERT OR IGNORE INTO group_providers (group_id, provider_id, enabled, priority, updated_at)
    SELECT id, provider_id, 1, 100, CURRENT_TIMESTAMP
    FROM groups
    WHERE provider_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM group_providers
        WHERE group_providers.group_id = groups.id
      )
  `);

  database.prepare(`
    UPDATE settings
    SET value = ?, updated_at = CURRENT_TIMESTAMP
    WHERE key = 'default_model_context_limit' AND value IN ('16384', '64000', '32768', '65536')
  `).run(String(config.defaultModelContextLimit));

  database.prepare(`
    UPDATE settings
    SET value = ?, updated_at = CURRENT_TIMESTAMP
    WHERE key = 'max_tokens_per_request' AND value IN ('32000', '65536', '131072')
  `).run(String(config.maxTokensPerRequest));

  database.prepare(`
    UPDATE settings
    SET value = ?, updated_at = CURRENT_TIMESTAMP
    WHERE key = 'default_model_output_limit' AND value = '8192'
  `).run(String(config.defaultModelOutputLimit));

  database.prepare(`
    UPDATE provider_models
    SET context_limit = 65536, updated_at = CURRENT_TIMESTAMP
    WHERE context_limit IN (16384, 64000, 32768)
  `).run();

  database.prepare(`
    DELETE FROM settings
    WHERE key IN (
      'deepseek_api_key',
      'deepseek_api_key_enabled',
      'deepseek_base_url',
      'default_monthly_token_limit',
      'default_monthly_cost_limit_eur'
    )
  `).run();

  const hasLegacyGroupAllowedProviders = database.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'group_allowed_providers'
  `).get();
  if (hasLegacyGroupAllowedProviders) {
    database.exec(`
      INSERT OR IGNORE INTO group_providers (group_id, provider_id, enabled, priority, updated_at)
      SELECT group_id, provider_id, 1, 100, CURRENT_TIMESTAMP
      FROM group_allowed_providers
      WHERE EXISTS (SELECT 1 FROM groups WHERE groups.id = group_allowed_providers.group_id)
        AND EXISTS (SELECT 1 FROM providers WHERE providers.id = group_allowed_providers.provider_id)
    `);
  }
  database.exec('DROP TABLE IF EXISTS group_allowed_providers');
  database.exec('DROP TABLE IF EXISTS user_allowed_providers');

  database.prepare(`
    UPDATE providers
    SET enabled = 0, updated_at = CURRENT_TIMESTAMP
    WHERE slug = 'local-vllm'
      AND base_url LIKE 'https://api.deepseek.com%'
      AND EXISTS (SELECT 1 FROM providers WHERE slug = 'deepseek' AND enabled = 1)
  `).run();

  database.exec(`
    DELETE FROM provider_models
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM provider_models
      GROUP BY provider_id
    )
  `);
  database.prepare(`
    UPDATE settings
    SET value = ?, updated_at = CURRENT_TIMESTAMP
    WHERE key = 'default_daily_token_limit' AND value IN ('100000', '100000000')
  `).run(String(config.defaultDailyTokenLimit));

  database.prepare(`
    UPDATE settings
    SET value = ?, updated_at = CURRENT_TIMESTAMP
    WHERE key = 'max_requests_per_minute' AND value IN ('20', '50')
  `).run(String(config.maxRequestsPerMinute));

  database.prepare(`
    UPDATE groups
    SET daily_call_limit = ?,
        daily_token_limit = ?,
        hourly_call_limit = ?,
        hourly_token_limit = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE name = 'Default Users'
      AND (daily_call_limit IS NULL OR daily_call_limit = 1000000000)
      AND (daily_token_limit IS NULL OR daily_token_limit = 100000 OR daily_token_limit = 1000000000)
      AND (hourly_call_limit IS NULL OR hourly_call_limit = 100000000)
      AND (hourly_token_limit IS NULL OR hourly_token_limit = 100000000)
  `).run(
    DEFAULT_GROUP_LIMITS.dailyCallLimit,
    DEFAULT_GROUP_LIMITS.dailyTokenLimit,
    DEFAULT_GROUP_LIMITS.hourlyCallLimit,
    DEFAULT_GROUP_LIMITS.hourlyTokenLimit
  );
}

function seedSettings(database) {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `);

  const defaults = {
    public_base_url: process.env.PUBLIC_BASE_URL || '',
    default_daily_token_limit: String(config.defaultDailyTokenLimit),
    default_model_context_limit: String(config.defaultModelContextLimit),
    default_model_output_limit: String(config.defaultModelOutputLimit),
    maintenance_mode: 'false',
    max_tokens_per_request: String(config.maxTokensPerRequest),
    max_requests_per_minute: String(config.maxRequestsPerMinute),
    max_images_per_request: String(config.maxImagesPerRequest),
    max_image_bytes: String(config.maxImageBytes),
    max_total_image_bytes: String(config.maxTotalImageBytes),
    allow_video_input: String(config.allowVideoInput)
  };

  for (const [key, value] of Object.entries(defaults)) {
    insert.run(key, value);
  }

  seedDefaultProvider(database);
  seedDefaultGroup(database);
}

function seedDefaultProvider(database) {
  const providerCount = database.prepare('SELECT COUNT(*) AS count FROM providers').get().count;
  if (providerCount > 0) return;
  const setting = (key, fallback) => database.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
  const contextLimit = Number(setting('default_model_context_limit', config.defaultModelContextLimit));

  const provider = database.prepare(`
    INSERT INTO providers (slug, name, kind, base_url, api_key, enabled, priority, max_concurrent_requests, timeout_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    config.defaultProviderSlug,
    config.defaultProviderName,
    'openai-compatible',
    config.deepseekBaseUrl,
    config.deepseekApiKey,
    config.deepseekApiKey ? 1 : 0,
    200,
    null,
    config.requestTimeoutMs
  );

  database.prepare(`
    INSERT INTO provider_models
      (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(
    provider.lastInsertRowid,
    config.publicModelName,
    config.defaultUpstreamModel,
    config.defaultProviderName,
    contextLimit,
    8192
  );
}

function seedDefaultGroup(database) {
  const groupCount = database.prepare('SELECT COUNT(*) AS count FROM groups').get().count;
  const providerId = database.prepare('SELECT id FROM providers ORDER BY priority DESC, name ASC LIMIT 1').get()?.id ?? null;
  let groupId = database.prepare('SELECT id FROM groups ORDER BY name ASC LIMIT 1').get()?.id;

  if (groupCount === 0) {
    const group = database.prepare(`
      INSERT INTO groups
        (name, provider_id, daily_call_limit, daily_token_limit, hourly_call_limit, hourly_token_limit)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'Default Users',
      providerId,
      DEFAULT_GROUP_LIMITS.dailyCallLimit,
      DEFAULT_GROUP_LIMITS.dailyTokenLimit,
      DEFAULT_GROUP_LIMITS.hourlyCallLimit,
      DEFAULT_GROUP_LIMITS.hourlyTokenLimit
    );
    groupId = group.lastInsertRowid;
  }

  if (groupId) {
    database.prepare(`
      INSERT OR IGNORE INTO user_groups (user_id, group_id)
      SELECT users.id, ?
      FROM users
      WHERE NOT EXISTS (
        SELECT 1 FROM user_groups WHERE user_groups.user_id = users.id
      )
    `).run(groupId);
  }
}

function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}

module.exports = { getDb, closeDb, initSchema, migrateSchema, seedSettings };
