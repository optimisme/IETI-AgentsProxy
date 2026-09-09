const { getDb } = require('../db');
const { getSetting, setSetting } = require('./settingsService');

const DEFAULT_CLEANUP_RETENTION_DAYS = 15;
const CLEANUP_SETTING_KEY = 'usage_cleanup_last_run_at';
const CLEANUP_RETENTION_SETTING_KEY = 'usage_cleanup_retention_days';

function startOfTodaySql() {
  return "datetime('now', 'start of day')";
}

function startOfHourSql() {
  return "datetime('now', 'start of hour')";
}

function getUsageTotals(userId) {
  const db = getDb();
  const today = db.prepare(`
    SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens
    FROM usage_logs
    WHERE user_id = ? AND status = 'success' AND created_at >= ${startOfTodaySql()}
  `).get(userId);

  const hour = db.prepare(`
    SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens
    FROM usage_logs
    WHERE user_id = ? AND status = 'success' AND created_at >= ${startOfHourSql()}
  `).get(userId);

  return {
    hourCalls: hour.calls,
    hourTokens: hour.tokens,
    todayCalls: today.calls,
    todayTokens: today.tokens
  };
}

function recordUsage({ userId, model, providerSlug = null, inputTokens = 0, outputTokens = 0, totalTokens, wasStreaming = false, status, errorMessage = null }) {
  const safeTotal = totalTokens ?? (inputTokens + outputTokens);
  getDb().prepare(`
    INSERT INTO usage_logs
      (user_id, model, provider_slug, input_tokens, output_tokens, total_tokens, was_streaming, status, error_message, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(userId, model || 'unknown', providerSlug, inputTokens, outputTokens, safeTotal, wasStreaming ? 1 : 0, status, errorMessage);

  if (userId && status === 'success') {
    getDb().prepare('UPDATE users SET last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
  }
}

function dashboardSummary() {
  const db = getDb();
  const users = db.prepare(`
    SELECT
      COUNT(*) AS total_users,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled_users,
      SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END) AS disabled_users
    FROM users
  `).get();
  const today = db.prepare(`SELECT COALESCE(SUM(total_tokens), 0) AS tokens FROM usage_logs WHERE status = 'success' AND created_at >= ${startOfTodaySql()}`).get();
  const recentErrors = db.prepare(`
    SELECT usage_logs.*, users.email
    FROM usage_logs
    LEFT JOIN users ON users.id = usage_logs.user_id
    WHERE usage_logs.status != 'success'
    ORDER BY usage_logs.created_at DESC
    LIMIT 10
  `).all();

  return {
    totalUsers: users.total_users || 0,
    enabledUsers: users.enabled_users || 0,
    disabledUsers: users.disabled_users || 0,
    totalTokensToday: today.tokens || 0,
    recentErrors
  };
}

function recentUsage(limit = 100, userId = null, offset = 0) {
  const db = getDb();
  if (userId) {
    return db.prepare(`
      SELECT usage_logs.*, users.email
      FROM usage_logs
      LEFT JOIN users ON users.id = usage_logs.user_id
      WHERE usage_logs.user_id = ?
      ORDER BY usage_logs.created_at DESC
      LIMIT ? OFFSET ?
    `).all(userId, limit, offset);
  }
  return db.prepare(`
    SELECT usage_logs.*, users.email
    FROM usage_logs
    LEFT JOIN users ON users.id = usage_logs.user_id
    ORDER BY usage_logs.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function countUsage(userId = null) {
  const db = getDb();
  if (userId) {
    return db.prepare('SELECT COUNT(*) AS count FROM usage_logs WHERE user_id = ?').get(userId).count;
  }
  return db.prepare('SELECT COUNT(*) AS count FROM usage_logs').get().count;
}

function normalizeCleanupRetentionDays(value) {
  return Math.max(1, Number.parseInt(value, 10) || DEFAULT_CLEANUP_RETENTION_DAYS);
}

function getUsageCleanupRetentionDays() {
  return normalizeCleanupRetentionDays(getSetting(CLEANUP_RETENTION_SETTING_KEY, DEFAULT_CLEANUP_RETENTION_DAYS));
}

function cleanupUsageLogs(retentionDays = getUsageCleanupRetentionDays()) {
  const days = normalizeCleanupRetentionDays(retentionDays);
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM usage_logs
    WHERE created_at < datetime('now', ?)
  `).run(`-${days} days`);

  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  setSetting(CLEANUP_RETENTION_SETTING_KEY, String(days));
  setSetting(CLEANUP_SETTING_KEY, new Date().toISOString());

  return {
    deleted: result.changes,
    retentionDays: days,
    lastRunAt: getSetting(CLEANUP_SETTING_KEY)
  };
}

function getUsageCleanupStatus(retentionDays = getUsageCleanupRetentionDays()) {
  const days = normalizeCleanupRetentionDays(retentionDays);
  const lastRunAt = getSetting(CLEANUP_SETTING_KEY, '');
  const row = getDb().prepare(`
    SELECT
      CASE
        WHEN @lastRunAt = '' THEN 1
        WHEN datetime(@lastRunAt) < datetime('now', @threshold) THEN 1
        ELSE 0
      END AS overdue
  `).get({ lastRunAt, threshold: `-${days} days` });
  return {
    lastRunAt,
    retentionDays: days,
    overdue: Boolean(row?.overdue)
  };
}

module.exports = {
  cleanupUsageLogs,
  countUsage,
  dashboardSummary,
  DEFAULT_CLEANUP_RETENTION_DAYS,
  getUsageCleanupRetentionDays,
  getUsageCleanupStatus,
  getUsageTotals,
  normalizeCleanupRetentionDays,
  recentUsage,
  recordUsage
};
