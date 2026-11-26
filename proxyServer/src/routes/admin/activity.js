// Admin page listing the changes made from the admin pages.
const express = require('express');
const { requireAdmin } = require('../../middleware/authAdmin');
const { actionLabel, countAdminChanges, listAdminChanges } = require('../../services/adminAuditService');
const { escapeHtml, paginationControls } = require('../../utils/html');
const { render } = require('./shared');

const router = express.Router();

function activityDetails(details) {
  if (!details) return '';
  let values;
  try {
    values = JSON.parse(details);
  } catch {
    return escapeHtml(details);
  }
  return `<details><summary>Submitted values</summary><dl class="activity-values">${Object.entries(values).map(([field, value]) =>
    `<dt>${escapeHtml(field)}</dt><dd>${escapeHtml(Array.isArray(value) ? value.join(', ') : value)}</dd>`).join('')}</dl></details>`;
}

router.get('/admin/activity', requireAdmin, (req, res) => {
  const pageSize = 50;
  const total = countAdminChanges();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1), totalPages);
  const rows = listAdminChanges({ limit: pageSize, offset: (page - 1) * pageSize }).map((entry) => {
    const target = entry.target_type && entry.target_id
      ? `<a href="/admin/${entry.target_type}/${entry.target_id}">${escapeHtml(entry.target_label || `${entry.target_type} ${entry.target_id}`)}</a>`
      : escapeHtml(entry.target_label || '');
    return `
      <tr>
        <td>${escapeHtml(entry.created_at)}</td>
        <td>${escapeHtml(entry.actor)}</td>
        <td>${escapeHtml(actionLabel(entry.action))}</td>
        <td>${target}</td>
        <td>${entry.status < 400 ? '<span class="status-enabled">Done</span>' : `<span class="status-disabled">Refused (${entry.status})</span>`}</td>
        <td>${activityDetails(entry.details)}</td>
      </tr>
    `;
  }).join('');
  render(req, res, 'settings', {
    title: 'Activity',
    content: `
      <p class="muted">Every form submitted from the admin pages, newest first. Times are UTC. Secrets such as API keys are never recorded, and changes made outside these pages do not appear here.</p>
      <div class="provider-pool-table">
        <table>
          <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Record</th><th>Result</th><th>Details</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="muted">Nothing recorded yet.</td></tr>'}</tbody>
        </table>
      </div>
      ${paginationControls({ page, totalPages, totalItems: total, label: 'changes', urlFor: (target) => `/admin/activity?page=${target}` })}
    `
  });
});

module.exports = router;
