// Admin dashboard and its script assets.
const express = require('express');
const path = require('node:path');
const { getDb } = require('../../db');
const { requireAdmin } = require('../../middleware/authAdmin');
const { dashboardSummary, getUsageCleanupStatus } = require('../../services/usageService');
const { dailyUsageCard, formatUsageNumber } = require('../../utils/usageCards');
const { escapeHtml } = require('../../utils/html');
const { render, usageTable } = require('./shared');

const router = express.Router();

function cleanupWarning(status = getUsageCleanupStatus()) {
  if (!status.overdue) return '';
  const lastRun = status.lastRunAt
    ? `Last cleanup: ${status.lastRunAt}.`
    : 'No cleanup has been recorded yet.';
  return `
    <div class="notice">
      Usage log cleanup is due. ${escapeHtml(lastRun)}
      <a href="/admin/server">Run cleanup from Server settings.</a>
    </div>
  `;
}

router.get('/admin/assets/provider-autoconfigure.js', requireAdmin, (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '../../../assets/provider-autoconfigure.js'));
});

router.get('/admin/assets/dashboard-usage.js', requireAdmin, (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '../../../assets/dashboard-usage.js'));
});

router.get('/admin', requireAdmin, (req, res) => {
  const summary = dashboardSummary();
  const cleanupStatus = getUsageCleanupStatus();
  const content = `
    ${cleanupWarning(cleanupStatus)}
    <div class="grid dashboard-metrics">
      <div class="metric">Total users<strong>${summary.totalUsers}</strong></div>
      <div class="metric">Enabled users<strong>${summary.enabledUsers}</strong></div>
      <div class="metric">Disabled users<strong>${summary.disabledUsers}</strong></div>
      <div class="metric">Pending approval<strong>${getDb().prepare("SELECT COUNT(*) AS count FROM users WHERE registration_status = 'pending'").get().count}</strong></div>
      <div class="metric">Tokens today<strong>${summary.totalTokensToday}</strong></div>
    </div>
    <div class="dashboard-cards">
      ${dailyUsageCard(summary.dailyUsage)}
      ${topUsersCard(summary.topUsers)}
    </div>
    <section class="panel dashboard-section" aria-labelledby="recent-calls-heading">
      <div class="dashboard-card-heading">
        <h2 id="recent-calls-heading">Recent calls</h2>
        <p class="muted">Latest 25 logged calls across all users · UTC</p>
      </div>
      <div class="table-scroll">${usageTable(summary.recentCalls)}</div>
    </section>
    <section class="panel dashboard-section" aria-labelledby="recent-errors-heading">
      <div class="dashboard-card-heading"><h2 id="recent-errors-heading">Recent errors</h2></div>
      <div class="table-scroll">${usageTable(summary.recentErrors)}</div>
    </section>
    <script src="/admin/assets/dashboard-usage.js" defer></script>
  `;
  render(req, res, 'dashboard', { title: 'Dashboard', content });
});

function topUsersCard(rows) {
  return `
    <section class="panel dashboard-card" aria-labelledby="active-users-heading">
      <div class="dashboard-card-heading">
        <h2 id="active-users-heading">Most active users</h2>
        <p class="muted">Top 10 by completed or stopped calls · Last 15 days · UTC</p>
      </div>
      ${rows.length ? `<div class="table-scroll"><table class="dashboard-users-table">
        <thead><tr><th scope="col">User</th><th scope="col" class="numeric">Calls</th><th scope="col" class="numeric">Tokens</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td><a href="/admin/users/${row.id}">${escapeHtml(row.name || row.email)}</a><span class="muted dashboard-user-email">${escapeHtml(row.email)}</span></td>
            <td class="numeric">${formatUsageNumber(row.calls)}</td>
            <td class="numeric">${formatUsageNumber(row.tokens)}</td>
          </tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No completed or stopped calls from current users in the last 15 days.</p>'}
    </section>
  `;
}

module.exports = router;
