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
const { flash } = require('../../utils/html');
const { optionalText } = require('../../utils/validation');
const { render, formRoute } = require('./shared');
const { serverPage } = require('../../views/admin/server');

const router = express.Router();

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

// The server settings page. After a refused submission it shows the typed values and the reason.
function showServer(req, res, { values = null, notice = '', status = 200 } = {}) {
  const stored = getAllSettings();
  // Two forms post to this page; the clean-up form is the one that sends retention_days.
  const settings = values && values.retention_days === undefined
    ? {
      ...stored,
      ...Object.fromEntries(['public_base_url', ...NUMERIC_SERVER_SETTINGS.map(([key]) => key)].map((key) => [key, values[key] ?? ''])),
      allow_video_input: values.allow_video_input ? 'true' : 'false',
      maintenance_mode: values.maintenance_mode ? 'true' : 'false'
    }
    : stored;
  const retentionDays = getUsageCleanupRetentionDays();
  const cleanupStatus = getUsageCleanupStatus(retentionDays);
  const cleanupFlash = req.query.cleanup_deleted !== undefined
    ? `Usage cleanup completed. Deleted ${Number(req.query.cleanup_deleted) || 0} records and compacted the database.`
    : '';
  const defaultConcurrentRequests = config.maxConcurrentRequestsPerUser;
  res.status(status);
  render(req, res, 'server', {
    title: 'Edit Server',
    content: serverPage({ cleanupStatus, defaultConcurrentRequests, retentionDays, settings }),
    flash: notice || flash(cleanupFlash || (req.query.saved ? 'Server settings saved.' : ''))
  });
}

router.get('/admin/server', requireAdmin, (req, res) => {
  showServer(req, res);
});

router.post('/admin/server', requireAdmin, formRoute(showServer, (req, res) => {
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
  const publicBaseUrl = optionalText(req.body.public_base_url, { max: 2048 });
  setSetting('public_base_url', publicBaseUrl);
  for (const [key, value] of numericSettings) setSetting(key, value);
  setSetting('allow_video_input', req.body.allow_video_input ? 'true' : 'false');
  setSetting('maintenance_mode', req.body.maintenance_mode ? 'true' : 'false');
  res.redirect('/admin/server?saved=1');
}));

router.post('/admin/server/cleanup-usage', requireAdmin, formRoute(showServer, (req, res) => {
  // Blank keeps the current retention. A mistyped number must not be read as "keep one day"
  // and delete nearly everything.
  const raw = String(req.body.retention_days ?? '').trim();
  const days = raw ? Number(raw) : getUsageCleanupRetentionDays();
  if (!Number.isSafeInteger(days) || days < 1) throw apiError(400, 'invalid_form', 'Days to keep must be a whole number of at least 1.');
  const result = cleanupUsageLogs(days);
  res.redirect(`/admin/server?cleanup_deleted=${result.deleted}`);
}));

module.exports = router;
