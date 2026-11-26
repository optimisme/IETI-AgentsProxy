// Admin page for server settings and usage log clean-up.
const express = require('express');
const config = require('../../config');
const { requireAdmin } = require('../../middleware/authAdmin');
const {
  cleanupUsageLogs,
  getUsageCleanupRetentionDays,
  getUsageCleanupStatus
} = require('../../services/usageService');
const { getAllSettings, setSetting } = require('../../services/settingsService');
const { apiError } = require('../../utils/errors');
const { escapeHtml, flash } = require('../../utils/html');
const { optionalText } = require('../../utils/validation');
const { render, tokens } = require('./shared');

const router = express.Router();

router.get('/admin/server', requireAdmin, (req, res) => {
  const settings = getAllSettings();
  const retentionDays = getUsageCleanupRetentionDays();
  const cleanupStatus = getUsageCleanupStatus(retentionDays);
  const cleanupFlash = req.query.cleanup_deleted !== undefined
    ? `Usage cleanup completed. Deleted ${Number(req.query.cleanup_deleted) || 0} records and compacted the database.`
    : '';
  const content = `
    <div class="server-sections">
      <form method="post" action="/admin/server" class="panel">
        <h2>Server settings</h2>
        <label>Public base URL. Leave empty to use the current request host.</label><input name="public_base_url" value="${escapeHtml(settings.public_base_url || '')}" placeholder="https://subdomain.example.com">
        <label>Default daily token limit</label><input name="default_daily_token_limit" type="number" value="${escapeHtml(settings.default_daily_token_limit)}">
        <label>OpenCode model context limit</label><input name="default_model_context_limit" type="number" value="${escapeHtml(settings.default_model_context_limit)}">
        <label>OpenCode model output limit</label><input name="default_model_output_limit" type="number" value="${escapeHtml(settings.default_model_output_limit)}">
        <label>Max output tokens per request</label><input name="max_tokens_per_request" type="number" value="${escapeHtml(settings.max_tokens_per_request)}">
        <label>Max image bytes</label><input name="max_image_bytes" type="number" value="${escapeHtml(settings.max_image_bytes)}">
        <label>Max total image bytes</label><input name="max_total_image_bytes" type="number" value="${escapeHtml(settings.max_total_image_bytes)}">
        <label><input name="allow_video_input" type="checkbox" value="true" style="width:auto" ${settings.allow_video_input === 'true' ? 'checked' : ''}> Allow video input</label>
        <label>Max requests per minute</label><input name="max_requests_per_minute" type="number" value="${escapeHtml(settings.max_requests_per_minute)}">
        <label>Max concurrent requests per user</label><input name="max_concurrent_requests_per_user" type="number" min="1" value="${escapeHtml(settings.max_concurrent_requests_per_user || config.maxConcurrentRequestsPerUser)}">
        <label><input name="maintenance_mode" type="checkbox" value="true" style="width:auto" ${settings.maintenance_mode === 'true' ? 'checked' : ''}> Maintenance mode</label>
        <p><button>Save server settings</button></p>
      </form>
      <section class="panel">
        <h2>Usage log cleanup</h2>
        <p class="muted">Deletes usage/error records older than ${retentionDays} days, checkpoints the WAL, and runs VACUUM.</p>
        <p>Last cleanup: ${cleanupStatus.lastRunAt ? escapeHtml(cleanupStatus.lastRunAt) : '<span class="muted">never</span>'}</p>
        <form method="post" action="/admin/server/cleanup-usage" onsubmit="return window.confirm('Clean usage logs older than ' + this.retention_days.value + ' days and compact the SQLite database?');">
          <label>Days to keep</label><input id="cleanup-retention-days" name="retention_days" type="number" min="1" value="${escapeHtml(retentionDays)}">
          <p><button class="danger">Clean logs older than <span id="cleanup-retention-label">${escapeHtml(retentionDays)}</span> days</button></p>
        </form>
      </section>
    </div>
    <script>
      (function () {
        const input = document.getElementById('cleanup-retention-days');
        const label = document.getElementById('cleanup-retention-label');
        if (!input || !label) return;
        input.addEventListener('input', () => {
          label.textContent = input.value || '${escapeHtml(retentionDays)}';
        });
      })();
    </script>
  `;
  render(req, res, 'server', { title: 'Edit Server', content, flash: flash(cleanupFlash || (req.query.saved ? 'Server settings saved.' : '')) });
});

const NUMERIC_SERVER_SETTINGS = [
  ['default_daily_token_limit', 'Default daily token limit'],
  ['default_model_context_limit', 'OpenCode model context limit'],
  ['default_model_output_limit', 'OpenCode model output limit'],
  ['max_tokens_per_request', 'Max output tokens per request'],
  ['max_requests_per_minute', 'Max requests per minute'],
  ['max_concurrent_requests_per_user', 'Max concurrent requests per user'],
  ['max_image_bytes', 'Max image bytes'],
  ['max_total_image_bytes', 'Max total image bytes']
];

router.post('/admin/server', requireAdmin, (req, res) => {
  // Everything is validated before anything is saved. A blank field keeps its current
  // value: stored as an empty string it would be read as zero and block every request.
  const numericSettings = [];
  for (const [key, label] of NUMERIC_SERVER_SETTINGS) {
    const raw = String(req.body[key] ?? '').trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw apiError(400, 'invalid_form', `${label} must be a whole number of at least 1.`);
    numericSettings.push([key, String(value)]);
  }
  setSetting('public_base_url', optionalText(req.body.public_base_url, { max: 2048 }));
  for (const [key, value] of numericSettings) setSetting(key, value);
  setSetting('allow_video_input', req.body.allow_video_input ? 'true' : 'false');
  setSetting('maintenance_mode', req.body.maintenance_mode ? 'true' : 'false');
  res.redirect('/admin/server?saved=1');
});

router.post('/admin/server/cleanup-usage', requireAdmin, (req, res) => {
  const result = cleanupUsageLogs(req.body.retention_days);
  res.redirect(`/admin/server?cleanup_deleted=${result.deleted}`);
});

module.exports = router;
