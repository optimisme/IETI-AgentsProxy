// Gives an empty database the access structures that existed before pools replaced them,
// with the exact table definitions of a long-lived installation (columns in the order its
// migrations added them). Used to test the one-time conversion and clean-up at startup.
function installOldAccessSchema(database) {
  database.exec(`
    DROP TABLE IF EXISTS group_pools;
    DROP TABLE IF EXISTS pool_providers;
    DROP TABLE IF EXISTS pools;
    DROP TABLE provider_models;
    DROP TABLE groups;
    CREATE TABLE groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    , provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL, daily_call_limit INTEGER, daily_token_limit INTEGER, hourly_call_limit INTEGER, hourly_token_limit INTEGER);
    CREATE TABLE provider_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      public_model TEXT NOT NULL,
      upstream_model TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      context_limit INTEGER,
      output_limit INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, supports_text_input INTEGER NOT NULL DEFAULT 1, supports_image_input INTEGER NOT NULL DEFAULT 1, supports_tools INTEGER NOT NULL DEFAULT 1, supports_reasoning INTEGER NOT NULL DEFAULT 1, supports_parallel_tools INTEGER NOT NULL DEFAULT 1, reasoning_efforts TEXT, default_reasoning_effort TEXT, supports_chat_template_kwargs INTEGER NOT NULL DEFAULT 0, reasoning_history_field TEXT, max_images INTEGER,
      UNIQUE(provider_id, public_model)
    );
    CREATE TABLE group_providers (
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (group_id, provider_id)
    );
    CREATE INDEX idx_group_providers_provider ON group_providers(provider_id);
  `);
}

module.exports = { installOldAccessSchema };
