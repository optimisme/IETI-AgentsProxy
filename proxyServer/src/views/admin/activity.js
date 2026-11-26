// Markup of the admin Activity page.
const { paginationControls, html, joinHtml } = require('../../utils/html');
const { actionLabel } = require('../../services/adminAuditService');

function activityDetails(details) {
  if (!details) return '';
  let values;
  try {
    values = JSON.parse(details);
  } catch {
    return details;
  }
  return html`<details><summary>Submitted values</summary><dl class="activity-values">${joinHtml(Object.entries(values).map(([field, value]) =>
    html`<dt>${field}</dt><dd>${Array.isArray(value) ? joinHtml(value, ', ') : value}</dd>`))}</dl></details>`;
}

function activityPage({ entries, page, total, totalPages }) {
  const rows = joinHtml(entries.map((entry) => {
    const target = entry.target_type && entry.target_id
      ? html`<a href="/admin/${entry.target_type}/${entry.target_id}">${entry.target_label || html`${entry.target_type} ${entry.target_id}`}</a>`
      : (entry.target_label || '');
    return html`
      <tr>
        <td>${entry.created_at}</td>
        <td>${entry.actor}</td>
        <td>${actionLabel(entry.action)}</td>
        <td>${target}</td>
        <td>${entry.status < 400 ? html`<span class="status-enabled">Done</span>` : html`<span class="status-disabled">Refused (${entry.status})</span>`}</td>
        <td>${activityDetails(entry.details)}</td>
      </tr>
    `;
  }));
  return html`
      <p class="muted">Every form submitted from the admin pages, newest first. Times are UTC. Secrets such as API keys are never recorded, and changes made outside these pages do not appear here.</p>
      <div class="provider-pool-table">
        <table>
          <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Record</th><th>Result</th><th>Details</th></tr></thead>
          <tbody>${rows || html`<tr><td colspan="6" class="muted">Nothing recorded yet.</td></tr>`}</tbody>
        </table>
      </div>
      ${paginationControls({ page, totalPages, totalItems: total, label: 'changes', urlFor: (target) => html`/admin/activity?page=${target}` })}
    `;
}

module.exports = {
  activityDetails,
  activityPage
};
