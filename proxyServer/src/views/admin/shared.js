// Markup shared by several admin pages.
const { html, joinHtml } = require('../../utils/html');

function usageTable(rows) {
  if (!rows.length) return html`<p class="muted">No records.</p>`;
  return html`
    <table>
      <thead><tr><th>When</th><th>User</th><th>Model</th><th>Provider</th><th>Tokens</th><th>Status</th><th>Error</th></tr></thead>
      <tbody>${joinHtml(rows.map((row) => html`
        <tr>
          <td>${row.created_at}</td>
          <td>${row.email || row.user_id || 'Deleted user'}</td>
          <td>${row.model}</td>
          <td>${row.provider_slug || ''}</td>
          <td>${row.total_tokens}</td>
          <td>${row.status}</td>
          <td>${row.error_message || ''}</td>
        </tr>
      `))}</tbody>
    </table>
  `;
}

module.exports = {
  usageTable
};
