// Markup of the admin dashboard.
const { formatUsageNumber, dailyUsageCard } = require('../../utils/usageCards');
const { usageTable } = require('./shared');
const { html, joinHtml } = require('../../utils/html');

function cleanupWarning(status) {
  if (!status.overdue) return '';
  const lastRun = status.lastRunAt
    ? html`Last cleanup: ${status.lastRunAt}.`
    : 'No cleanup has been recorded yet.';
  return html`
    <div class="notice">
      Usage log cleanup is due. ${lastRun}
      <a href="/admin/server">Run cleanup from Server settings.</a>
    </div>
  `;
}

function topUsersCard(rows) {
  return html`
    <section class="panel dashboard-card" aria-labelledby="active-users-heading">
      <div class="dashboard-card-heading">
        <h2 id="active-users-heading">Most active users</h2>
        <p class="muted">Top 10 by completed or stopped calls · Last 15 days · UTC</p>
      </div>
      ${rows.length ? html`<div class="table-scroll"><table class="dashboard-users-table">
        <thead><tr><th scope="col">User</th><th scope="col" class="numeric">Calls</th><th scope="col" class="numeric">Tokens</th></tr></thead>
        <tbody>${joinHtml(rows.map((row) => html`
          <tr>
            <td><a href="/admin/users/${row.id}">${row.name || row.email}</a><span class="muted dashboard-user-email">${row.email}</span></td>
            <td class="numeric">${formatUsageNumber(row.calls)}</td>
            <td class="numeric">${formatUsageNumber(row.tokens)}</td>
          </tr>`))}</tbody>
      </table></div>` : html`<p class="muted">No completed or stopped calls from current users in the last 15 days.</p>`}
    </section>
  `;
}

function dashboardPage({ cleanupStatus, pendingUsers, summary }) {
  const content = html`
    ${cleanupWarning(cleanupStatus)}
    <div class="grid dashboard-metrics">
      <div class="metric">Total users<strong>${summary.totalUsers}</strong></div>
      <div class="metric">Enabled users<strong>${summary.enabledUsers}</strong></div>
      <div class="metric">Disabled users<strong>${summary.disabledUsers}</strong></div>
      <div class="metric">Pending approval<strong>${pendingUsers}</strong></div>
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
  return content;
}

module.exports = {
  cleanupWarning,
  dashboardPage,
  topUsersCard
};
