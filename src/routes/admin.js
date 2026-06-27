const express = require('express');
const config = require('../config');
const { getDb } = require('../db');
const { requireAdmin } = require('../middleware/authAdmin');
const { generateStudentKey, hashApiKey, lookupHashApiKey, keyPrefixSuffix } = require('../services/keyService');
const { createInviteForUser, getActiveInviteForUser } = require('../services/studentAuthService');
const {
  cleanupUsageLogs,
  dashboardSummary,
  recentUsage,
  getUsageCleanupRetentionDays,
  getUsageCleanupStatus,
  getUsageTotals,
  countUsage
} = require('../services/usageService');
const { getAllSettings, getSetting, maskSecret, setSetting } = require('../services/settingsService');
const { listProviders, testProvider } = require('../services/providerService');
const {
  getAllGroups,
  getUserGroup,
  getUserGroups,
  setGroupProviders,
  setUserGroups
} = require('../services/accessService');
const { renderTemplate } = require('../utils/templates');
const { apiError } = require('../utils/errors');
const {
  escapeHtml,
  flash,
  getRequestBaseUrl: requestBaseUrl,
  paginationControls,
  quotaLimitCards,
  trustedHtml
} = require('../utils/html');
const {
  email: validateEmail,
  nonNegativeIntegerOrNull,
  optionalText,
  requiredText,
  slug: validateSlug,
  url: validateUrl
} = require('../utils/validation');

const router = express.Router();

function render(req, res, view, { title, content = '', flash = '' } = {}) {
  const nav = req.session?.adminAuthenticated ? `
    <header>
      <strong>IETI Agents</strong>
      <a href="/admin">Dashboard</a>
      <a href="/admin/users">Users</a>
      <a href="/admin/groups">Groups</a>
      <a href="/admin/settings">Providers</a>
      <a href="/admin/server">Server</a>
      <form method="post" action="/admin/logout" style="margin-left:auto"><button>Log out</button></form>
    </header>
  ` : '';

  const body = renderTemplate(view, { title: title || 'Admin', content: trustedHtml(content), flash: trustedHtml(flash) });
  res.send(renderTemplate('layout', {
    title: title || 'Admin',
    nav: trustedHtml(nav),
    content: trustedHtml(body)
  }));
}

function slugify(value) {
  return validateSlug(value, 'Provider slug');
}

function testResultPayload(label, result) {
  const detailParts = [];
  if (result.errorMessage) detailParts.push(`Upstream error: ${result.errorMessage}`);
  if (result.diagnostics?.warnings?.length) detailParts.push(`Configuration: ${result.diagnostics.warnings.join(' ')}`);
  if (result.diagnostics?.baseUrl) detailParts.push(`Base URL: ${result.diagnostics.baseUrl}`);
  if (result.diagnostics?.model) detailParts.push(`Model: ${result.diagnostics.model}`);
  return {
    ok: result.ok,
    status: result.status,
    message: `${label} ${result.ok ? 'passed' : 'failed'}${result.status ? ` with status ${result.status}` : ''}.`,
    detail: detailParts.join('\n'),
    body: result.body
  };
}

function getRequestBaseUrl(req) {
  return requestBaseUrl(req, getSetting('public_base_url', ''));
}

function groupOptions(selectedId = null) {
  const selected = Number(selectedId || 0);
  return getAllGroups().map((group) => `
    <option value="${group.id}" ${Number(group.id) === selected ? 'selected' : ''}>${escapeHtml(group.name)}</option>
  `).join('');
}

function limitValue(value) {
  return value === null || value === undefined ? '' : escapeHtml(value);
}

function validGroupId(value) {
  const id = Number(value);
  if (!Number.isFinite(id)) return null;
  const group = getDb().prepare('SELECT id FROM groups WHERE id = ?').get(id);
  return group ? id : null;
}

function requireGroupId(value) {
  const id = validGroupId(value);
  if (!id) throw apiError(400, 'invalid_form', 'A valid group is required.');
  return id;
}

function validProviderId(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw apiError(400, 'invalid_form', 'Provider must be valid.');
  const provider = getDb().prepare('SELECT id FROM providers WHERE id = ?').get(id);
  if (!provider) throw apiError(400, 'invalid_form', 'Provider must be valid.');
  return id;
}

function validProviderIds(value) {
  const values = Array.isArray(value)
    ? value
    : value === undefined || value === null || String(value).trim() === ''
      ? []
      : [value];
  const ids = [...new Set(values.map((item) => Number(item)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return [];
  const valid = getDb().prepare(`SELECT id FROM providers WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((row) => row.id);
  if (valid.length !== ids.length) throw apiError(400, 'invalid_form', 'Providers must be valid.');
  return ids;
}

function parseUserForm(body) {
  return {
    name: requiredText(body.name, 'Name', { max: 160 }),
    email: validateEmail(body.email),
    groupId: requireGroupId(body.group_id),
    enabled: body.enabled ? 1 : 0
  };
}

function parseGroupForm(body) {
  const providerIds = validProviderIds(body.provider_ids ?? body.provider_id);
  return {
    name: requiredText(body.name, 'Name', { max: 160 }),
    providerId: providerIds[0] || validProviderId(body.provider_id),
    providerIds,
    dailyCallLimit: nonNegativeIntegerOrNull(body.daily_call_limit, 'Calls per day'),
    dailyTokenLimit: nonNegativeIntegerOrNull(body.daily_token_limit, 'Tokens per day'),
    hourlyCallLimit: nonNegativeIntegerOrNull(body.hourly_call_limit, 'Calls per hour'),
    hourlyTokenLimit: nonNegativeIntegerOrNull(body.hourly_token_limit, 'Tokens per hour')
  };
}

function parseProviderForm(body, existingProvider = {}) {
  const name = requiredText(body.name, 'Name', { max: 160 });
  return {
    slug: slugify(body.slug || name),
    name,
    baseUrl: validateUrl(body.base_url, 'Base URL'),
    apiKey: optionalText(body.api_key, { max: 4096 }) || existingProvider.api_key || 'local',
    enabled: body.enabled ? 1 : 0,
    maxConcurrentRequests: nonNegativeIntegerOrNull(body.max_concurrent_requests, 'Maximum concurrent requests'),
    timeoutMs: nonNegativeIntegerOrNull(body.timeout_ms, 'Timeout milliseconds')
  };
}

function isProviderApiKeyOnlyForm(body) {
  return Object.prototype.hasOwnProperty.call(body, 'api_key') &&
    !Object.prototype.hasOwnProperty.call(body, 'name') &&
    !Object.prototype.hasOwnProperty.call(body, 'base_url') &&
    !Object.prototype.hasOwnProperty.call(body, 'slug');
}

function parseModelMappingForm(body) {
  return {
    publicModel: validatePublicModelAlias(body.public_model),
    upstreamModel: requiredText(body.upstream_model, 'Provider model name', { max: 255 }),
    contextLimit: nonNegativeIntegerOrNull(body.context_limit, 'Context limit'),
    outputLimit: nonNegativeIntegerOrNull(body.output_limit, 'Output limit')
  };
}

function validatePublicModelAlias(value) {
  const alias = requiredText(value, 'Public alias shown to OpenCode', { max: 120 });
  if (/[\s/]/.test(alias)) {
    throw apiError(400, 'invalid_form', 'Public alias shown to OpenCode cannot contain spaces or slashes.');
  }
  return alias;
}

function saveActiveModelMapping(db, providerId, providerName, form) {
  const existing = db.prepare(`
    SELECT id
    FROM provider_models
    WHERE provider_id = ?
    ORDER BY enabled DESC, updated_at DESC, id DESC
    LIMIT 1
  `).get(providerId);
  if (existing) {
    db.prepare('DELETE FROM provider_models WHERE provider_id = ? AND id != ?').run(providerId, existing.id);
  }
  if (existing) {
    db.prepare(`
      UPDATE provider_models
      SET public_model = ?, upstream_model = ?, name = ?, enabled = 1, context_limit = ?, output_limit = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(form.publicModel, form.upstreamModel, providerName, form.contextLimit, form.outputLimit, existing.id);
  } else {
    db.prepare(`
      INSERT INTO provider_models
        (provider_id, public_model, upstream_model, name, enabled, context_limit, output_limit)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(providerId, form.publicModel, form.upstreamModel, providerName, form.contextLimit, form.outputLimit);
  }
}

function adminUsersUrl({ search = '', groupId = 0, page = 1 } = {}) {
  const params = new URLSearchParams();
  if (search) params.set('q', search);
  if (groupId) params.set('group_id', String(groupId));
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return `/admin/users${query ? `?${query}` : ''}`;
}

function userDetailUrl(userId, { usagePage = 1, deleteError = '' } = {}) {
  const params = new URLSearchParams();
  if (usagePage > 1) params.set('usage_page', String(usagePage));
  if (deleteError) params.set('delete_error', deleteError);
  const query = params.toString();
  return `/admin/users/${userId}${query ? `?${query}` : ''}`;
}

function errorModal(message, closeHref = '') {
  if (!message) return '';
  return `
    <div class="modal-backdrop" role="presentation">
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">Delete failed</h2>
        <p>${escapeHtml(message)}</p>
        <div class="actions"><a class="button" href="${escapeHtml(closeHref)}">Close</a></div>
      </div>
    </div>
  `;
}

function usageStatus(user, group = getUserGroup(user.id), usage = getUsageTotals(user.id)) {
  return quotaLimitCards(group, usage);
}

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

function userForm(user = {}, action = '/admin/users') {
  const selectedGroupId = user.id ? getUserGroups(user.id)[0]?.id : null;
  const formId = user.id ? `user-edit-${user.id}` : 'user-new';
  const removable = user.id ? countUsage(user.id) === 0 : true;
  return `
    <div class="panel">
      <form id="${formId}" method="post" action="${action}">
        <label>Name</label><input name="name" value="${escapeHtml(user.name)}" required>
        <label>Email</label><input name="email" type="email" value="${escapeHtml(user.email)}" required>
        <label>Group</label><select name="group_id" required><option value="">Choose one group</option>${groupOptions(selectedGroupId)}</select>
        <label><input name="enabled" type="checkbox" value="1" style="width:auto" ${user.enabled === 0 ? '' : 'checked'}> Enabled</label>
      </form>
      <div class="form-actions">
        <div class="actions">
          <button type="submit" form="${formId}">Save</button>
          <a class="button secondary" href="/admin/users">Cancel</a>
        </div>
        ${user.id ? `
          ${removable ? `
            <form method="post" action="/admin/users/${user.id}/delete" onsubmit="return window.confirm('Are you sure to delete this user?');">
              <button class="danger">Delete</button>
            </form>
          ` : '<span class="muted">Non removable user</span>'}
        ` : ''}
      </div>
    </div>
  `;
}

function groupForm(group = {}, action = '/admin/groups') {
  const providers = listProviders().map((provider) => ({
    ...provider,
    model: activeProviderModel(provider.id)
  }));
  const providerPools = Map.groupBy(providers, (provider) => provider.model.public_model || 'Unconfigured');
  const selectedProviderIds = new Set((group.providers || [])
    .map((provider) => Number(provider.id))
    .filter((id) => Number.isInteger(id) && id > 0));
  if (!selectedProviderIds.size && group.provider_id) selectedProviderIds.add(Number(group.provider_id));
  return `
    <form method="post" action="${action}" class="panel">
      <label>Name</label><input name="name" value="${escapeHtml(group.name)}" required>
      <label>Model pools</label>
      <div class="checkbox-list">
        ${providers.length ? [...providerPools.entries()].map(([publicModel, poolProviders]) => `
          <fieldset style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:0 0 12px">
            <legend>${escapeHtml(publicModel)}</legend>
            ${poolProviders.map((provider) => `
              <label>
                <input name="provider_ids" type="checkbox" value="${provider.id}" style="width:auto" ${selectedProviderIds.has(Number(provider.id)) ? 'checked' : ''}>
                ${escapeHtml(provider.name)} (${escapeHtml(provider.slug)})
                ${provider.model.upstream_model ? `<span class="muted">${escapeHtml(provider.model.upstream_model)}</span>` : '<span class="muted">No active mapping</span>'}
                ${provider.enabled ? '' : '<span class="muted">disabled</span>'}
              </label>
            `).join('')}
          </fieldset>
        `).join('') : '<p class="muted">No providers configured.</p>'}
      </div>
      <label>Calls per day</label><input name="daily_call_limit" type="number" min="0" value="${limitValue(group.daily_call_limit)}" placeholder="Unlimited">
      <label>Tokens per day</label><input name="daily_token_limit" type="number" min="0" value="${limitValue(group.daily_token_limit)}" placeholder="Unlimited">
      <label>Calls per hour</label><input name="hourly_call_limit" type="number" min="0" value="${limitValue(group.hourly_call_limit)}" placeholder="Unlimited">
      <label>Tokens per hour</label><input name="hourly_token_limit" type="number" min="0" value="${limitValue(group.hourly_token_limit)}" placeholder="Unlimited">
      <p><button type="submit">Save group</button> <a class="button secondary" href="/admin/groups">Cancel</a></p>
    </form>
  `;
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

function modelMappingFields(provider = {}, model = activeProviderModel(provider.id)) {
  return `
    <h2>Active Model Mapping</h2>
    <label>Public alias shown to OpenCode</label><input name="public_model" value="${escapeHtml(model.public_model || config.publicModelName)}" required>
    <label>Provider model name</label><input name="upstream_model" value="${escapeHtml(model.upstream_model || '')}" required>
    <label>Context limit</label><input name="context_limit" type="number" min="0" value="${escapeHtml(model.context_limit ?? getSetting('default_model_context_limit'))}">
    <label>Output limit</label><input name="output_limit" type="number" min="0" value="${escapeHtml(model.output_limit ?? getSetting('default_model_output_limit'))}">
  `;
}

function providerForm(provider = {}, action = '/admin/providers') {
  return `
    <form method="post" action="${action}" class="panel">
      <h2>Provider Settings</h2>
      <label>Provider slug</label><input name="slug" value="${escapeHtml(provider.slug)}" required>
      <label>Name</label><input name="name" value="${escapeHtml(provider.name)}" required>
      <label>Base URL</label><input name="base_url" value="${escapeHtml(provider.base_url)}" placeholder="http://127.0.0.1:8001" required>
      <label>Maximum concurrent requests. Blank or 0 means infinite.</label><input name="max_concurrent_requests" type="number" min="0" value="${escapeHtml(provider.max_concurrent_requests ?? '')}">
      <label>Timeout milliseconds. Blank uses the server default.</label><input name="timeout_ms" type="number" min="0" value="${escapeHtml(provider.timeout_ms ?? '')}">
      <label><input name="enabled" type="checkbox" value="1" style="width:auto" ${provider.enabled === 0 ? '' : 'checked'}> Enabled</label>
      ${modelMappingFields(provider)}
      <div class="actions" style="margin-top:16px">
        <button type="submit">Save provider</button>
        ${provider.id ? `<button type="button" class="secondary" data-test-url="/admin/providers/${provider.id}/mapping/test.json" data-result-target="mapping-test-result">Run mapping test request</button>` : ''}
        <a class="button secondary" href="/admin/settings">Cancel</a>
      </div>
      ${provider.id ? '<p id="mapping-test-result" class="muted" aria-live="polite" style="white-space:pre-wrap"></p>' : ''}
    </form>
  `;
}

function providerApiKeyStatus(provider) {
  return provider.api_key ? `configured (${maskSecret(provider.api_key)})` : 'not configured';
}

router.get('/admin/login', (req, res) => {
  const query = req.query.error ? '?error=invalid' : '?admin=1';
  res.redirect(`/${query}`);
});

router.post('/admin/login', (req, res) => {
  req.body.login = req.body.login || req.body.username;
  res.redirect(307, '/login');
});

router.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/?admin=1'));
});

router.get('/admin', requireAdmin, (req, res) => {
  const summary = dashboardSummary();
  const cleanupStatus = getUsageCleanupStatus();
  const content = `
    ${cleanupWarning(cleanupStatus)}
    <div class="grid">
      <div class="metric">Total users<strong>${summary.totalUsers}</strong></div>
      <div class="metric">Enabled users<strong>${summary.enabledUsers}</strong></div>
      <div class="metric">Disabled users<strong>${summary.disabledUsers}</strong></div>
      <div class="metric">Tokens today<strong>${summary.totalTokensToday}</strong></div>
    </div>
    <h2>Recent errors</h2>
    ${usageTable(summary.recentErrors)}
  `;
  render(req, res, 'dashboard', { title: 'Dashboard', content });
});

router.get('/admin/users', requireAdmin, (req, res) => {
  const search = String(req.query.q || '').trim();
  const groupId = Number(req.query.group_id || 0);
  const pageSize = 25;
  const groups = getAllGroups();
  const where = [];
  const params = {};
  if (search) {
    where.push('(users.name LIKE @search OR users.email LIKE @search OR users.id = @exact_id OR users.last_used_at LIKE @search OR users.created_at LIKE @search)');
    params.search = `%${search}%`;
    params.exact_id = Number(search) || -1;
  }
  if (groupId) {
    where.push('EXISTS (SELECT 1 FROM user_groups WHERE user_groups.user_id = users.id AND user_groups.group_id = @group_id)');
    params.group_id = groupId;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalUsers = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM users
    ${whereSql}
  `).get(params).count;
  const totalPages = Math.max(1, Math.ceil(totalUsers / pageSize));
  const requestedPage = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
  const page = Math.min(requestedPage, totalPages);
  const users = getDb().prepare(`
    SELECT users.*, groups.name AS group_name, providers.name AS group_provider_name, providers.slug AS group_provider_slug
    FROM users
    LEFT JOIN user_groups ON user_groups.user_id = users.id
    LEFT JOIN groups ON groups.id = user_groups.group_id
    LEFT JOIN providers ON providers.id = groups.provider_id
    ${whereSql}
    ORDER BY users.created_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });
  const rows = users.map((user) => `
    <tr>
      <td><a href="/admin/users/${user.id}">${escapeHtml(user.name)}</a></td>
      <td>${escapeHtml(user.email)}</td>
      <td>${escapeHtml(user.group_name || '') || '<span class="muted">none</span>'}</td>
      <td>${user.group_provider_slug ? `${escapeHtml(user.group_provider_name || user.group_provider_slug)}<br><span class="muted">${escapeHtml(user.group_provider_slug)}</span>` : '<span class="muted">none</span>'}</td>
      <td><span class="${user.enabled ? 'status-enabled' : 'status-disabled'}">${user.enabled ? 'Enabled' : 'Disabled'}</span></td>
      <td>${user.last_used_at ? escapeHtml(user.last_used_at) : '<span class="muted">never</span>'}</td>
      <td class="actions">
        <a class="button secondary" href="/admin/users/${user.id}">Edit</a>
      </td>
    </tr>
  `).join('');
  const pagination = totalPages > 1 ? `
    <nav class="pagination" aria-label="Users pages">
      ${page > 1 ? `<a class="button secondary" href="${adminUsersUrl({ search, groupId, page: page - 1 })}">Previous</a>` : '<span class="muted">Previous</span>'}
      <span class="muted">Page ${page} of ${totalPages}. ${totalUsers} users.</span>
      ${page < totalPages ? `<a class="button secondary" href="${adminUsersUrl({ search, groupId, page: page + 1 })}">Next</a>` : '<span class="muted">Next</span>'}
    </nav>
  ` : `<p class="muted">${totalUsers} user${totalUsers === 1 ? '' : 's'}.</p>`;
  const content = `
    <p><a class="button" href="/admin/users/new">Create user</a></p>
    <form method="get" action="/admin/users" class="panel search-panel">
      <label>Search users</label><input name="q" value="${escapeHtml(search)}" placeholder="Name, email, id, or date">
      <label>Filter by group</label><select name="group_id">
        <option value="">All groups</option>
        ${groups.map((group) => `<option value="${group.id}" ${group.id === groupId ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}
      </select>
      <p><button>Search</button> <a class="button secondary" href="/admin/users">Clear</a></p>
    </form>
    <table><thead><tr><th>Name</th><th>Email</th><th>Group</th><th>Group Provider</th><th>Status</th><th>Last used</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">No users found.</td></tr>'}</tbody></table>
    ${pagination}
  `;
  render(req, res, 'users', { title: 'Users', content, flash: flash(req.query.created ? 'User created.' : '') });
});

router.get('/admin/users/new', requireAdmin, (req, res) => {
  render(req, res, 'user-detail', { title: 'New User', content: userForm() });
});

router.post('/admin/users', requireAdmin, (req, res) => {
  const form = parseUserForm(req.body);
  const result = getDb().prepare(`
    INSERT INTO users (name, email, api_key_hash, enabled, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    form.name,
    form.email,
    null,
    form.enabled,
    'student'
  );
  setUserGroups(result.lastInsertRowid, [form.groupId]);
  createInviteForUser(result.lastInsertRowid);
  res.redirect(`/admin/users/${result.lastInsertRowid}?created=1&invite_created=1`);
});

router.get('/admin/groups', requireAdmin, (req, res) => {
  const groups = getAllGroups();
  const rows = groups.map((group) => {
    const userCount = getDb().prepare('SELECT COUNT(*) AS count FROM user_groups WHERE group_id = ?').get(group.id).count;
    return `
      <tr>
        <td><a href="/admin/groups/${group.id}">${escapeHtml(group.name)}</a></td>
        <td>${escapeHtml(group.provider_names || group.provider_name || '') || '<span class="muted">none</span>'}</td>
        <td>${group.daily_call_limit ?? '<span class="muted">unlimited</span>'} / ${group.hourly_call_limit ?? '<span class="muted">unlimited</span>'}</td>
        <td>${group.daily_token_limit ?? '<span class="muted">unlimited</span>'} / ${group.hourly_token_limit ?? '<span class="muted">unlimited</span>'}</td>
        <td>${userCount}</td>
        <td><a class="button secondary" href="/admin/groups/${group.id}">Edit</a></td>
      </tr>
    `;
  }).join('');
  render(req, res, 'users', {
    title: 'Groups',
    content: `
      <p><a class="button" href="/admin/groups/new">Create group</a></p>
      <table><thead><tr><th>Name</th><th>Provider</th><th>Calls day/hour</th><th>Tokens day/hour</th><th>Users</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">No groups.</td></tr>'}</tbody></table>
    `,
    flash: flash(req.query.saved ? 'Group saved.' : '')
  });
});

router.get('/admin/groups/new', requireAdmin, (req, res) => {
  render(req, res, 'user-detail', { title: 'New Group', content: groupForm() });
});

router.post('/admin/groups', requireAdmin, (req, res) => {
  const form = parseGroupForm(req.body);
  const result = getDb().prepare(`
      INSERT INTO groups (name, provider_id, daily_call_limit, daily_token_limit, hourly_call_limit, hourly_token_limit)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      form.name,
      form.providerId,
      form.dailyCallLimit,
      form.dailyTokenLimit,
      form.hourlyCallLimit,
      form.hourlyTokenLimit
    );
  setGroupProviders(result.lastInsertRowid, form.providerIds);
  res.redirect('/admin/groups?saved=1');
});

router.get('/admin/groups/:id', requireAdmin, (req, res) => {
  const group = getAllGroups().find((candidate) => Number(candidate.id) === Number(req.params.id));
  if (!group) return res.status(404).send('Group not found');
  const users = getDb().prepare(`
    SELECT users.id, users.name, users.email, users.enabled
    FROM users
    JOIN user_groups ON user_groups.user_id = users.id
    WHERE user_groups.group_id = ?
    ORDER BY users.name ASC
  `).all(group.id);
  const userRows = users.map((user) => `
    <tr>
      <td><a href="/admin/users/${user.id}">${escapeHtml(user.name)}</a></td>
      <td>${escapeHtml(user.email)}</td>
      <td>${user.enabled ? 'enabled' : 'disabled'}</td>
    </tr>
  `).join('');
  render(req, res, 'user-detail', {
    title: 'Edit Group',
    content: `
      ${groupForm(group, `/admin/groups/${group.id}`)}
      <h2>Users</h2>
      <table><thead><tr><th>Name</th><th>Email</th><th>Status</th></tr></thead><tbody>${userRows || '<tr><td colspan="3" class="muted">No users in this group.</td></tr>'}</tbody></table>
    `
  });
});

router.post('/admin/groups/:id', requireAdmin, (req, res) => {
  const group = getDb().prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).send('Group not found');
  const form = parseGroupForm(req.body);
  getDb().prepare(`
    UPDATE groups
    SET name = ?, provider_id = ?, daily_call_limit = ?, daily_token_limit = ?,
        hourly_call_limit = ?, hourly_token_limit = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    form.name,
    form.providerId,
    form.dailyCallLimit,
    form.dailyTokenLimit,
    form.hourlyCallLimit,
    form.hourlyTokenLimit,
    group.id
  );
  setGroupProviders(group.id, form.providerIds);
  res.redirect(`/admin/groups/${group.id}?saved=1`);
});

router.get('/admin/users/:id', requireAdmin, (req, res) => {
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).send('User not found');
  const usage = getUsageTotals(user.id);
  const group = getUserGroup(user.id);
  const usagePageSize = 25;
  const totalUsage = countUsage(user.id);
  const usageTotalPages = Math.max(1, Math.ceil(totalUsage / usagePageSize));
  const requestedUsagePage = Math.max(1, Number.parseInt(req.query.usage_page || '1', 10) || 1);
  const usagePage = Math.min(requestedUsagePage, usageTotalPages);
  const deleteError = req.query.delete_error
    ? `This user has ${totalUsage} usage/error record${totalUsage === 1 ? '' : 's'}, so it cannot be deleted without losing audit history. Disable the user from the Enabled checkbox instead.`
    : '';
  const activeInvite = getActiveInviteForUser(user.id);
  const activeInviteUrl = activeInvite ? `${getRequestBaseUrl(req)}/invite/${encodeURIComponent(activeInvite.token)}` : '';
  const apiKeyStatus = user.api_key_prefix && user.api_key_suffix
    ? `${user.api_key_prefix}...${user.api_key_suffix}`
    : 'No API key configured';
  const content = `
    <div class="section-stack">
      ${userForm(user, `/admin/users/${user.id}`)}
      <section class="panel">
        <h2>Invitation key</h2>
        <p><strong>${escapeHtml(user.name)}</strong><br><span class="muted">${escapeHtml(user.email)}</span></p>
        ${activeInvite ? `
          <p class="key">${escapeHtml(activeInviteUrl)}</p>
          <p class="muted">Invite expires at ${escapeHtml(activeInvite.expiresAt)}. Generating a new invitation invalidates this one.</p>
        ` : '<p class="muted">No active invitation key.</p>'}
        <div class="actions">
          <form method="post" action="/admin/users/${user.id}/invite"><button>${activeInvite ? 'Regenerate invitation key' : 'Generate invitation key'}</button></form>
        </div>
      </section>
      <section class="panel">
        <h2>API key</h2>
        <p class="muted">${escapeHtml(apiKeyStatus)}</p>
        <div class="actions">
          <form method="post" action="/admin/users/${user.id}/regenerate-key"><button>Regenerate API key</button></form>
          <form method="post" action="/admin/users/${user.id}/revoke-key"><button class="danger">Revoke API key</button></form>
        </div>
      </section>
      <section class="panel">
        <h2>Stats</h2>
        <div class="grid">
          <div class="metric">Last used<strong>${user.last_used_at ? escapeHtml(user.last_used_at) : 'never'}</strong></div>
          <div class="metric">Group provider<strong>${group?.provider_names ? escapeHtml(group.provider_names) : 'none'}</strong>${group?.provider_slugs?.length ? `<span class="muted">${escapeHtml(group.provider_slugs.join(', '))}</span>` : ''}</div>
        </div>
        <div style="margin-top:16px">${usageStatus(user, group, usage)}</div>
        <h3>Recent usage/errors</h3>
        ${usageTable(recentUsage(usagePageSize, user.id, (usagePage - 1) * usagePageSize))}
        ${paginationControls({
          page: usagePage,
          totalPages: usageTotalPages,
          totalItems: totalUsage,
          urlFor: (page) => userDetailUrl(user.id, { usagePage: page })
        })}
      </section>
    </div>
    ${errorModal(deleteError, userDetailUrl(user.id, { usagePage }))}
  `;
  const message = req.query.invite_created
    ? 'Invitation key generated.'
    : req.query.revoked
      ? 'API key revoked.'
      : req.query.deleted
        ? 'User deleted.'
        : req.query.created
          ? 'User created.'
          : '';
  render(req, res, 'user-detail', { title: 'Edit User', content, flash: flash(message) });
});

router.post('/admin/users/:id', requireAdmin, (req, res) => {
  const form = parseUserForm(req.body);
  getDb().prepare(`
    UPDATE users
    SET name = ?, email = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    form.name,
    form.email,
    form.enabled,
    req.params.id
  );
  setUserGroups(req.params.id, [form.groupId]);
  res.redirect(`/admin/users/${req.params.id}`);
});

router.post('/admin/users/:id/invite', requireAdmin, (req, res) => {
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).send('User not found');
  createInviteForUser(user.id);
  res.redirect(`/admin/users/${user.id}?invite_created=1`);
});

router.post('/admin/users/:id/regenerate-key', requireAdmin, (req, res) => {
  const key = generateStudentKey();
  const { prefix, suffix } = keyPrefixSuffix(key);
  getDb().prepare('UPDATE users SET api_key_hash = ?, api_key_lookup_hash = ?, api_key_prefix = ?, api_key_suffix = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hashApiKey(key), lookupHashApiKey(key), prefix, suffix, req.params.id);
  render(req, res, 'user-detail', {
    title: 'New API Key',
    flash: flash('Copy this regenerated API key now. It will not be shown again.'),
    content: `<p class="key">${escapeHtml(key)}</p><p><a class="button" href="/admin/users/${req.params.id}">Back to user</a></p>`
  });
});

router.post('/admin/users/:id/revoke-key', requireAdmin, (req, res) => {
  getDb().prepare('UPDATE users SET api_key_hash = NULL, api_key_lookup_hash = NULL, api_key_prefix = NULL, api_key_suffix = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.redirect(`/admin/users/${req.params.id}?revoked=1`);
});

router.post('/admin/users/:id/delete', requireAdmin, (req, res) => {
  const count = countUsage(req.params.id);
  if (count > 0) {
    return res.redirect(userDetailUrl(req.params.id, { deleteError: 'usage-history' }));
  }
  getDb().prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.redirect('/admin/users?deleted=1');
});

router.get('/admin/settings', requireAdmin, (req, res) => {
  const providers = listProviders();
  const providerRows = providers.map((provider) => {
    const model = activeProviderModel(provider.id);
    const groupCount = getDb().prepare(`
      SELECT COUNT(DISTINCT groups.id) AS count
      FROM groups
      LEFT JOIN group_providers ON group_providers.group_id = groups.id
      WHERE groups.provider_id = ? OR group_providers.provider_id = ?
    `).get(provider.id, provider.id).count;
    return `
      <tr>
        <td><a href="/admin/providers/${provider.id}">${escapeHtml(provider.name)}</a><br><span class="muted">${escapeHtml(provider.slug)}</span></td>
        <td>${escapeHtml(provider.base_url)}</td>
        <td>${escapeHtml(provider.api_key ? 'configured' : 'not configured')}</td>
        <td><span class="${provider.enabled ? 'status-enabled' : 'status-disabled'}">${provider.enabled ? 'Enabled' : 'Disabled'}</span></td>
        <td>${model.upstream_model ? escapeHtml(model.upstream_model) : '<span class="muted">none</span>'}</td>
        <td>${groupCount}</td>
        <td class="actions">
          <a class="button secondary" href="/admin/providers/${provider.id}">Edit</a>
        </td>
      </tr>
    `;
  }).join('');
  const content = `
    <div class="panel">
      <p><a class="button" href="/admin/providers/new">Add provider</a></p>
      <table>
        <thead><tr><th>Name</th><th>Base URL</th><th>API key</th><th>Status</th><th>Active upstream model</th><th>Groups</th><th>Actions</th></tr></thead>
        <tbody>${providerRows || '<tr><td colspan="7" class="muted">No providers.</td></tr>'}</tbody>
      </table>
    </div>
  `;
  render(req, res, 'settings', { title: 'Providers', content, flash: flash(req.query.saved ? 'Provider saved.' : req.query.test || '') });
});

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
        <label>Max images per request</label><input name="max_images_per_request" type="number" value="${escapeHtml(settings.max_images_per_request)}">
        <label>Max image bytes</label><input name="max_image_bytes" type="number" value="${escapeHtml(settings.max_image_bytes)}">
        <label>Max total image bytes</label><input name="max_total_image_bytes" type="number" value="${escapeHtml(settings.max_total_image_bytes)}">
        <label><input name="allow_video_input" type="checkbox" value="true" style="width:auto" ${settings.allow_video_input === 'true' ? 'checked' : ''}> Allow video input</label>
        <label>Max requests per minute</label><input name="max_requests_per_minute" type="number" value="${escapeHtml(settings.max_requests_per_minute)}">
        <label><input name="maintenance_mode" type="checkbox" value="true" style="width:auto" ${settings.maintenance_mode === 'true' ? 'checked' : ''}> Maintenance mode</label>
        <p><button>Save server settings</button></p>
      </form>
      <section class="panel">
        <h2>Usage log cleanup</h2>
        <p class="muted">Deletes usage/error records older than ${retentionDays} days, checkpoints the WAL, and runs VACUUM.</p>
        <p>Last cleanup: ${cleanupStatus.lastRunAt ? escapeHtml(cleanupStatus.lastRunAt) : '<span class="muted">never</span>'}</p>
        <form method="post" action="/admin/server/cleanup-usage" onsubmit="return window.confirm('Clean usage logs older than ' + this.retention_days.value + ' days and compact the SQLite database?');">
          <label>Days to keep</label><input id="cleanup-retention-days" name="retention_days" type="number" min="1" value="${escapeHtml(retentionDays)}">
          <button class="danger">Clean logs older than <span id="cleanup-retention-label">${escapeHtml(retentionDays)}</span> days</button>
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

router.post('/admin/server', requireAdmin, (req, res) => {
  setSetting('public_base_url', req.body.public_base_url || '');
  for (const key of ['default_daily_token_limit', 'default_model_context_limit', 'default_model_output_limit', 'max_tokens_per_request', 'max_requests_per_minute', 'max_images_per_request', 'max_image_bytes', 'max_total_image_bytes']) {
    setSetting(key, req.body[key]);
  }
  setSetting('allow_video_input', req.body.allow_video_input ? 'true' : 'false');
  setSetting('maintenance_mode', req.body.maintenance_mode ? 'true' : 'false');
  res.redirect('/admin/server?saved=1');
});

router.post('/admin/server/cleanup-usage', requireAdmin, (req, res) => {
  const result = cleanupUsageLogs(req.body.retention_days);
  res.redirect(`/admin/server?cleanup_deleted=${result.deleted}`);
});

router.get('/admin/providers/new', requireAdmin, (req, res) => {
  render(req, res, 'settings', {
    title: 'New Provider',
    content: `
      ${providerForm({ enabled: 1, api_key: '' })}
    `
  });
});

router.post('/admin/providers', requireAdmin, (req, res) => {
  const form = parseProviderForm(req.body);
  const mapping = parseModelMappingForm(req.body);
  const db = getDb();
  const providerId = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO providers
        (slug, name, kind, base_url, api_key, enabled, max_concurrent_requests, timeout_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      form.slug,
      form.name,
      'openai-compatible',
      form.baseUrl,
      form.apiKey,
      form.enabled,
      form.maxConcurrentRequests,
      form.timeoutMs
    );
    saveActiveModelMapping(db, result.lastInsertRowid, form.name, mapping);
    return result.lastInsertRowid;
  })();
  res.redirect(`/admin/providers/${providerId}?saved=1`);
});

router.get('/admin/providers/:id', requireAdmin, (req, res) => {
  const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  render(req, res, 'settings', {
    title: 'Edit provider',
    flash: flash(req.query.saved ? 'Provider saved.' : req.query.test || ''),
    content: `
      <div class="provider-sections">
        ${providerForm(provider, `/admin/providers/${provider.id}`)}
        <div class="panel">
          <h2>Provider API key</h2>
          <form method="post" action="/admin/providers/${provider.id}">
            <label>API key or local placeholder</label><input name="api_key" type="password" autocomplete="off" placeholder="${provider.api_key ? 'Leave blank to keep current value' : 'local'}">
            <button type="submit" style="margin-top:16px">Save API key</button>
          </form>
          <p class="muted">API key: ${escapeHtml(providerApiKeyStatus(provider))}</p>
          <form method="post" action="/admin/providers/${provider.id}/clear-key">
            <button class="danger" ${provider.api_key ? '' : 'disabled'}>Delete API key</button>
          </form>
        </div>
        <div class="panel">
          <h2>Test provider</h2>
          <div class="actions">
            <button type="button" data-test-url="/admin/providers/${provider.id}/test.json" data-result-target="provider-test-result">Run server test request</button>
          </div>
          <p id="provider-test-result" class="muted" aria-live="polite" style="white-space:pre-wrap"></p>
        </div>
      </div>
      <script>
        document.querySelectorAll('[data-test-url]').forEach((button) => {
          button.addEventListener('click', async () => {
            const target = document.getElementById(button.dataset.resultTarget);
            const originalText = button.textContent;
            const clearResult = () => {
              if (!target) return;
              window.clearTimeout(target._clearTimer);
              target._clearTimer = window.setTimeout(() => {
                target.className = 'muted';
                target.textContent = '';
              }, 2000);
            };
            button.disabled = true;
            button.textContent = 'Running...';
            if (target) {
              window.clearTimeout(target._clearTimer);
              target.className = 'muted';
              target.textContent = 'Running test request...';
            }
            try {
              const response = await fetch(button.dataset.testUrl, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { Accept: 'application/json' }
              });
              const body = await response.json();
              if (target) {
                target.className = body.ok ? 'notice' : 'error';
                target.textContent = [body.message || (response.ok ? 'Test completed.' : 'Test failed.'), body.detail || ''].filter(Boolean).join('\\n');
                clearResult();
              }
            } catch (error) {
              if (target) {
                target.className = 'error';
                target.textContent = error.message || 'Test request failed.';
                clearResult();
              }
            } finally {
              button.disabled = false;
              button.textContent = originalText;
            }
          });
        });
      </script>
    `
  });
});

router.post('/admin/providers/:id', requireAdmin, (req, res) => {
  const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  if (isProviderApiKeyOnlyForm(req.body)) {
    const apiKey = optionalText(req.body.api_key, { max: 4096 });
    if (apiKey) {
      getDb().prepare('UPDATE providers SET api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(apiKey, provider.id);
    }
    return res.redirect(`/admin/providers/${provider.id}?saved=1`);
  }
  const form = parseProviderForm(req.body, provider);
  const mapping = parseModelMappingForm(req.body);
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      UPDATE providers
      SET slug = ?, name = ?, kind = ?, base_url = ?, api_key = ?, enabled = ?,
          max_concurrent_requests = ?, timeout_ms = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      form.slug,
      form.name,
      'openai-compatible',
      form.baseUrl,
      form.apiKey,
      form.enabled,
      form.maxConcurrentRequests,
      form.timeoutMs,
      provider.id
    );
    saveActiveModelMapping(db, provider.id, form.name, mapping);
  })();
  res.redirect(`/admin/providers/${provider.id}?saved=1`);
});

router.post('/admin/providers/:id/clear-key', requireAdmin, (req, res) => {
  const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  getDb().prepare('UPDATE providers SET api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('', provider.id);
  res.redirect(`/admin/providers/${provider.id}?saved=1`);
});

router.post('/admin/providers/:id/test', requireAdmin, async (req, res) => {
  const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  const result = await testProvider({ slug: provider.slug });
  res.redirect(`/admin/providers/${provider.id}?test=${encodeURIComponent(`${provider.name} test ${result.ok ? 'passed' : 'failed'} with status ${result.status}.`)}`);
});

router.post('/admin/providers/:id/test.json', requireAdmin, async (req, res, next) => {
  try {
    const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
    if (!provider) return res.status(404).json({ ok: false, message: 'Provider not found.' });
    const result = await testProvider({ slug: provider.slug });
    res.status(result.ok ? 200 : 502).json(testResultPayload('Server test request', result));
  } catch (error) {
    next(error);
  }
});

router.post('/admin/providers/:id/mapping', requireAdmin, (req, res) => {
  const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  const form = parseModelMappingForm(req.body);
  const db = getDb();
  const tx = db.transaction(() => {
    saveActiveModelMapping(db, provider.id, provider.name, form);
  });
  tx();
  res.redirect(`/admin/providers/${provider.id}?saved=1`);
});

router.post('/admin/providers/:id/mapping/test.json', requireAdmin, async (req, res, next) => {
  try {
    const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
    const model = activeProviderModel(req.params.id);
    if (!provider) return res.status(404).json({ ok: false, message: 'Provider not found.' });
    if (!model.upstream_model) return res.status(404).json({ ok: false, message: 'Active model mapping is not configured.' });
    const result = await testProvider({ slug: provider.slug, model: model.upstream_model });
    res.status(result.ok ? 200 : 502).json(testResultPayload('Mapping test request', result));
  } catch (error) {
    next(error);
  }
});

function usageTable(rows) {
  if (!rows.length) return '<p class="muted">No records.</p>';
  return `
    <table>
      <thead><tr><th>When</th><th>User</th><th>Model</th><th>Provider</th><th>Tokens</th><th>Status</th><th>Error</th></tr></thead>
      <tbody>${rows.map((row) => `
        <tr>
          <td>${escapeHtml(row.created_at)}</td>
          <td>${escapeHtml(row.email || row.user_id || 'unknown')}</td>
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

module.exports = router;
