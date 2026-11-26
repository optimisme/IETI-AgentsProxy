const TRUSTED_HTML = Symbol('trustedHtml');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// HTML that is inserted as it is. It turns back into its text wherever a string is expected,
// including JSON.stringify.
function trustedHtml(value) {
  const text = String(value ?? '');
  return { [TRUSTED_HTML]: true, value: text, toString: () => text, toJSON: () => text };
}

function isTrustedHtml(value) {
  return Boolean(value && value[TRUSTED_HTML]);
}

function htmlValue(value) {
  return isTrustedHtml(value) ? value.value : escapeHtml(value);
}

function htmlFragment(value) {
  if (Array.isArray(value)) return value.map(htmlFragment).join('');
  if (value === null || value === undefined || value === false) return '';
  return htmlValue(value);
}

// Template tag for HTML. Every interpolated value is escaped unless it is HTML already: the
// result of another html template, of joinHtml or of trustedHtml. Arrays are concatenated,
// and null, undefined and false add nothing. Views should write all their markup with it,
// so that forgetting to escape a value is not possible.
function html(strings, ...values) {
  let text = strings[0];
  values.forEach((value, index) => {
    text += htmlFragment(value) + strings[index + 1];
  });
  return trustedHtml(text);
}

// Array.join for HTML: items and separator are escaped unless they are HTML already. Like
// join, an empty list gives an empty string, so `list || fallback` keeps working.
function joinHtml(items, separator = '') {
  if (!items.length) return '';
  return trustedHtml(items.map(htmlFragment).join(htmlValue(separator)));
}

function flash(message, type = 'notice') {
  if (!message) return '';
  const safeType = type === 'error' ? 'error' : 'notice';
  return html`<div class="${safeType}">${message}</div>`;
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
  const items = joinHtml(links.map((link, index) =>
    html`<a href="${link.href}"${index === current ? html` aria-current="page"` : ''}>${link.label}</a>`));
  const logout = logoutAction
    ? html`<form method="post" action="${logoutAction}" class="site-nav-logout"><button>Log out</button></form>`
    : '';
  if (!items && !logout) return html`<header class="site-header"><strong class="site-brand">IETI Agents</strong></header>`;
  return html`
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
  return html`
    <div class="pagination">
      ${page > 1 ? html`<a class="button secondary" href="${urlFor(page - 1)}">Previous</a>` : html`<button class="secondary" disabled>Previous</button>`}
      <span class="muted">Page ${page} of ${totalPages}. ${totalItems} ${label}.</span>
      ${page < totalPages ? html`<a class="button secondary" href="${urlFor(page + 1)}">Next</a>` : html`<button class="secondary" disabled>Next</button>`}
    </div>
  `;
}

// A number grouped for en-US, tagged so assets/dashboard-usage.js can rewrite it with the
// grouping of the browser's language and region. Without the script the en-US text stays.
function localizedNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return html`${value}`;
  return html`<span data-number="${number}">${number.toLocaleString('en-US')}</span>`;
}

function quotaLimitCards(group, usage) {
  const items = [
    ['Calls today', usage.todayCalls, group?.daily_call_limit],
    ['Tokens today', usage.todayTokens, group?.daily_token_limit],
    ['Calls this hour', usage.hourCalls, group?.hourly_call_limit],
    ['Tokens this hour', usage.hourTokens, group?.hourly_token_limit]
  ];
  return html`
    <div class="quota-grid">
      ${items.map(([label, used, limit]) => {
        const hasLimit = limit !== null && limit !== undefined;
        const remaining = hasLimit ? Math.max(0, Number(limit) - Number(used || 0)) : null;
        const percent = hasLimit && Number(limit) > 0 ? Math.min(100, Math.round((Number(used || 0) / Number(limit)) * 100)) : 0;
        return html`
          <div class="quota">
            <div class="quota-row"><strong>${label}</strong><span>${hasLimit ? html`${localizedNumber(remaining)} left` : 'unlimited'}</span></div>
            <div class="progress"><span style="width:${percent}%"></span></div>
            <div class="muted">${localizedNumber(used)} used${hasLimit ? html` of ${localizedNumber(limit)}` : ''}</div>
          </div>
        `;
      })}
    </div>
  `;
}

// A value written into a <script> element as a JavaScript literal. HTML escaping would
// corrupt it there; "<" is written as an escape so the value cannot close the element.
function jsLiteral(value) {
  return trustedHtml(JSON.stringify(value).replace(/</g, '\\u003c'));
}

module.exports = {
  escapeHtml,
  flash,
  getRequestBaseUrl,
  html,
  htmlValue,
  isTrustedHtml,
  joinHtml,
  jsLiteral,
  localizedNumber,
  paginationControls,
  quotaLimitCards,
  siteHeader,
  trustedHtml
};
