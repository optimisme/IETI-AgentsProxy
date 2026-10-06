const TRUSTED_HTML = Symbol('trustedHtml');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function trustedHtml(value) {
  return { [TRUSTED_HTML]: true, value: String(value ?? '') };
}

function isTrustedHtml(value) {
  return Boolean(value && value[TRUSTED_HTML]);
}

function htmlValue(value) {
  return isTrustedHtml(value) ? value.value : escapeHtml(value);
}

function flash(message, type = 'notice') {
  if (!message) return '';
  const safeType = type === 'error' ? 'error' : 'notice';
  return `<div class="${safeType}">${escapeHtml(message)}</div>`;
}

// Marks the link for the current page. A link whose URL (including its query) matches the
// request exactly wins; otherwise a link matches its path, sub-paths or extra `paths`.
function currentLinkIndex(links, req) {
  const exact = links.findIndex((link) => link.href === req.originalUrl);
  if (exact !== -1) return exact;
  return links.findIndex((link) => [link.href, ...(link.paths || [])].some((path) =>
    !path.includes('?') && (req.path === path || (path !== '/' && !link.exactOnly && req.path.startsWith(`${path}/`)))));
}

// Shared site header. On narrow screens the links collapse behind a Menu toggle built from a
// checkbox and CSS, so it needs no script and works under the Content-Security-Policy.
function siteHeader(req, { links = [], logoutAction = '' } = {}) {
  const current = currentLinkIndex(links, req);
  const items = links.map((link, index) =>
    `<a href="${escapeHtml(link.href)}"${index === current ? ' aria-current="page"' : ''}>${escapeHtml(link.label)}</a>`).join('');
  const logout = logoutAction
    ? `<form method="post" action="${escapeHtml(logoutAction)}" class="site-nav-logout"><button>Log out</button></form>`
    : '';
  if (!items && !logout) return '<header class="site-header"><strong class="site-brand">IETI Agents</strong></header>';
  return `
    <header class="site-header">
      <strong class="site-brand">IETI Agents</strong>
      <input type="checkbox" id="site-nav-toggle" class="site-nav-toggle" aria-label="Show navigation menu">
      <label for="site-nav-toggle" class="site-nav-button" aria-hidden="true">Menu</label>
      <nav class="site-nav" aria-label="Main">${items}${logout}</nav>
    </header>
  `;
}

function getRequestBaseUrl(req, configuredBaseUrl = '') {
  const configured = String(configuredBaseUrl || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function paginationControls({ page, totalPages, totalItems, label = 'records', urlFor }) {
  if (totalPages <= 1) return '';
  return `
    <div class="pagination">
      ${page > 1 ? `<a class="button secondary" href="${escapeHtml(urlFor(page - 1))}">Previous</a>` : '<button class="secondary" disabled>Previous</button>'}
      <span class="muted">Page ${escapeHtml(page)} of ${escapeHtml(totalPages)}. ${escapeHtml(totalItems)} ${escapeHtml(label)}.</span>
      ${page < totalPages ? `<a class="button secondary" href="${escapeHtml(urlFor(page + 1))}">Next</a>` : '<button class="secondary" disabled>Next</button>'}
    </div>
  `;
}

function quotaLimitCards(group, usage) {
  const items = [
    ['Calls today', usage.todayCalls, group?.daily_call_limit],
    ['Tokens today', usage.todayTokens, group?.daily_token_limit],
    ['Calls this hour', usage.hourCalls, group?.hourly_call_limit],
    ['Tokens this hour', usage.hourTokens, group?.hourly_token_limit]
  ];
  return `
    <div class="quota-grid">
      ${items.map(([label, used, limit]) => {
        const hasLimit = limit !== null && limit !== undefined;
        const remaining = hasLimit ? Math.max(0, Number(limit) - Number(used || 0)) : null;
        const percent = hasLimit && Number(limit) > 0 ? Math.min(100, Math.round((Number(used || 0) / Number(limit)) * 100)) : 0;
        return `
          <div class="quota">
            <div class="quota-row"><strong>${escapeHtml(label)}</strong><span>${hasLimit ? `${escapeHtml(remaining)} left` : 'unlimited'}</span></div>
            <div class="progress"><span style="width:${escapeHtml(percent)}%"></span></div>
            <div class="muted">${escapeHtml(used || 0)} used${hasLimit ? ` of ${escapeHtml(limit)}` : ''}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

module.exports = {
  escapeHtml,
  flash,
  getRequestBaseUrl,
  htmlValue,
  isTrustedHtml,
  paginationControls,
  quotaLimitCards,
  siteHeader,
  trustedHtml
};
