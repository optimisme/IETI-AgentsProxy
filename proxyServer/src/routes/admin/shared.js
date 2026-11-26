// Helpers used by more than one area of the admin backoffice: page layout, form parsing
// and the views of a provider's model mapping.
const { getDb } = require('../../db');
const { isAdminSession } = require('../../middleware/authAdmin');
const { renderTemplate } = require('../../utils/templates');
const { escapeHtml, flash, siteHeader, trustedHtml } = require('../../utils/html');

function render(req, res, view, { title, content = '', flash = '' } = {}) {
  const pendingUsers = isAdminSession(req.session)
    ? getDb().prepare("SELECT COUNT(*) AS count FROM users WHERE registration_status = 'pending'").get().count
    : 0;
  const pendingConflicts = isAdminSession(req.session)
    ? getDb().prepare("SELECT COUNT(*) AS count FROM oauth_identity_conflicts WHERE status = 'pending' AND expires_at > ?").get(new Date().toISOString()).count
    : 0;
  const nav = isAdminSession(req.session) ? siteHeader(req, {
    links: [
      { href: '/admin', label: 'Dashboard', exactOnly: true },
      { href: '/admin/users', label: 'Users' },
      { href: '/admin/users?status=pending', label: `Pending${pendingUsers ? ` (${pendingUsers})` : ''}` },
      { href: '/admin/oauth-conflicts', label: `OAuth reviews${pendingConflicts ? ` (${pendingConflicts})` : ''}` },
      { href: '/admin/groups', label: 'Groups' },
      { href: '/admin/pools', label: 'Pools' },
      { href: '/admin/providers', label: 'Providers' },
      { href: '/admin/server', label: 'Server' },
      { href: '/admin/activity', label: 'Activity' }
    ],
    logoutAction: '/admin/logout'
  }) : '';

  const body = renderTemplate(view, { title: title || 'Admin', content: trustedHtml(content), flash: trustedHtml(flash) });
  res.send(renderTemplate('layout', {
    title: title || 'Admin',
    nav: trustedHtml(nav),
    content: trustedHtml(body)
  }));
}

function activeProviderModel(providerId) {
  return providerId ? getDb().prepare(`
    SELECT *
    FROM provider_models
    WHERE provider_id = ?
    ORDER BY enabled DESC, updated_at DESC, id DESC
    LIMIT 1
  `).get(providerId) || {} : {};
}

const tokens = (value) => `${Number(value).toLocaleString('en-US')} tokens`;

function usageTable(rows) {
  if (!rows.length) return '<p class="muted">No records.</p>';
  return `
    <table>
      <thead><tr><th>When</th><th>User</th><th>Model</th><th>Provider</th><th>Tokens</th><th>Status</th><th>Error</th></tr></thead>
      <tbody>${rows.map((row) => `
        <tr>
          <td>${escapeHtml(row.created_at)}</td>
          <td>${escapeHtml(row.email || row.user_id || 'Deleted user')}</td>
          <td>${escapeHtml(row.model)}</td>
          <td>${escapeHtml(row.provider_slug || '')}</td>
          <td>${row.total_tokens}</td>
          <td>${escapeHtml(row.status)}</td>
          <td>${escapeHtml(row.error_message || '')}</td>
        </tr>
      `).join('')}</tbody>
    </table>
  `;
}

module.exports = {
  activeProviderModel,
  render,
  tokens,
  usageTable
};
