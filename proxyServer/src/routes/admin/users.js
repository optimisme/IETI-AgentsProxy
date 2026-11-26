// Admin pages for users: list, create, edit, invitations, API keys and identity reviews.
const express = require('express');
const path = require('node:path');
const config = require('../../config');
const { getDb } = require('../../db');
const { requireAdmin } = require('../../middleware/authAdmin');
const { generateStudentKey } = require('../../services/keyService');
const {
  listUserApiKeys,
  normalizeApiKeyName,
  createUserApiKey,
  revokeUserApiKey,
  getAvailableLegacyName,
  MAX_USER_API_KEYS
} = require('../../services/userApiKeyService');
const { createInviteForUser, getActiveInviteForUser } = require('../../services/studentAuthService');
const { setPendingSecret, takePendingSecret } = require('../../utils/pendingSecrets');
const {
  auditAuthEvent,
  listIdentityConflicts,
  preserveIdentityConflict,
  rejectIdentityConflict,
  resetIdentityConflict
} = require('../../services/oauthIdentityService');
const { dailyUsage, recentUsage, getUsageTotals, countUsage } = require('../../services/usageService');
const { getSetting } = require('../../services/settingsService');
const { getAllGroups, getUserGroup, getUserGroups, setUserGroups } = require('../../services/accessService');
const { dailyUsageCard } = require('../../utils/usageCards');
const { apiError } = require('../../utils/errors');
const {
  escapeHtml,
  flash,
  getRequestBaseUrl: requestBaseUrl,
  paginationControls,
  quotaLimitCards
} = require('../../utils/html');
const { email: validateEmail, requiredText } = require('../../utils/validation');
const { render, usageTable } = require('./shared');

const router = express.Router();

const USER_ROLES = ['student', 'teacher'];

function getRequestBaseUrl(req) {
  return requestBaseUrl(req, config.publicBaseUrl || getSetting('public_base_url', ''));
}

function groupOptions(selectedId = null) {
  const selected = Number(selectedId || 0);
  return getAllGroups().map((group) => `
    <option value="${group.id}" ${Number(group.id) === selected ? 'selected' : ''}>${escapeHtml(group.name)}</option>
  `).join('');
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

function parseUserRole(value, fallback = 'student') {
  const role = String(value || fallback).trim().toLowerCase();
  if (!USER_ROLES.includes(role)) {
    throw apiError(400, 'invalid_form', `Role must be one of: ${USER_ROLES.join(', ')}.`);
  }
  return role;
}

function parseUserForm(body, { defaultRole = 'student' } = {}) {
  return {
    name: requiredText(body.name, 'Name', { max: 160 }),
    email: validateEmail(body.email),
    groupId: requireGroupId(body.group_id),
    enabled: body.enabled ? 1 : 0,
    role: parseUserRole(body.role, defaultRole)
  };
}

const USER_DELETION_CONDITION = "enabled = 0 AND datetime(disabled_at) < datetime('now', '-30 days')";

const USER_DELETION_MESSAGE = 'Users can only be deleted after being continuously disabled for more than 30 days.';

const USER_STATUS_FILTERS = [
  { value: 'approved-enabled', label: 'approved/enabled', registrationStatus: 'approved', enabled: 1 },
  { value: 'approved-disabled', label: 'approved/disabled', registrationStatus: 'approved', enabled: 0 },
  { value: 'pending', label: 'pending', registrationStatus: 'pending' },
  { value: 'rejected', label: 'rejected', registrationStatus: 'rejected' },
  { value: 'all', label: 'All users' }
];

function adminUsersUrl({ search = '', groupId = 0, status = 'approved-enabled', page = 1 } = {}) {
  const params = new URLSearchParams();
  if (search) params.set('q', search);
  if (groupId) params.set('group_id', String(groupId));
  if (status) params.set('status', status);
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

// Emails are unique regardless of letter case (idx_users_email_nocase).
function findUserByEmail(db, email, { exceptId = null } = {}) {
  return db.prepare(`
    SELECT id, name, enabled FROM users
    WHERE lower(email) = lower(?) AND id IS NOT ?
  `).get(email, exceptId === null ? null : Number(exceptId)) || null;
}

function emailTakenNotice(owner) {
  return `
    <div class="error">
      That email already belongs to <a href="/admin/users/${owner.id}">${escapeHtml(owner.name)}</a>${owner.enabled ? '' : ' (disabled, so hidden by the default filter on the Users page)'}.
      Nothing was saved. Open that user to change the group or enable the account.
    </div>
  `;
}

function userForm(user = {}, action = '/admin/users') {
  const selectedGroupId = user.id ? getUserGroups(user.id)[0]?.id : (user.groupId ?? null);
  const formId = user.id ? `user-edit-${user.id}` : 'user-new';
  const deleteFormId = user.id ? `user-delete-${user.id}` : '';
  const deleteModalId = user.id ? `user-delete-modal-${user.id}` : '';
  const removable = user.id && Boolean(getDb().prepare(`SELECT id FROM users WHERE id = ? AND ${USER_DELETION_CONDITION}`).get(user.id));
  const enabled = user.enabled === undefined ? true : Boolean(user.enabled);
  const registrationStatus = user.registration_status || 'approved';
  const selectedRole = USER_ROLES.includes(user.role) ? user.role : 'student';
  return `
    <div class="panel">
      ${user.id ? `<p><strong>Registration status:</strong> ${escapeHtml(registrationStatus)}</p>` : ''}
      ${user.id && !enabled && user.disabled_at ? `<p><strong>Disabled since (UTC):</strong> ${escapeHtml(user.disabled_at)}</p>` : ''}
      <form id="${formId}" method="post" action="${action}">
        <label>Name</label><input name="name" value="${escapeHtml(user.name)}" required>
        <label>Email</label><input name="email" type="email" value="${escapeHtml(user.email)}" required>
        <label>Role</label><select name="role" required>
          ${USER_ROLES.map((role) => `<option value="${role}" ${role === selectedRole ? 'selected' : ''}>${escapeHtml(role)}</option>`).join('')}
        </select>
        <label>Group</label><select name="group_id" required><option value="">Choose one group</option>${groupOptions(selectedGroupId)}</select>
        <label><input name="enabled" type="checkbox" value="1" style="width:auto" ${enabled ? 'checked' : ''}> Enabled</label>
      </form>
      <div class="form-actions">
        <div class="actions">
          <button type="submit" form="${formId}">${registrationStatus === 'pending' ? 'Assign group and approve' : 'Save'}</button>
          <a class="button secondary" href="/admin/users">Cancel</a>
        </div>
        ${user.id ? `
          ${removable ? `
            <button type="button" class="danger" data-open-user-delete-modal="${deleteModalId}">Delete</button>
          ` : `<span class="muted">${USER_DELETION_MESSAGE}</span>`}
        ` : ''}
      </div>
    </div>
    ${user.id && removable ? `
      <form id="${deleteFormId}" method="post" action="/admin/users/${user.id}/delete"></form>
      <dialog id="${deleteModalId}" class="modal" aria-labelledby="${deleteModalId}-title">
        <h2 id="${deleteModalId}-title">Delete user?</h2>
        <p>This will permanently delete <strong>${escapeHtml(user.name)}</strong> (<code>${escapeHtml(user.email)}</code>) and the user's invitations, API keys, linked sign-in identities, conversations and messages.</p>
        <p>Usage history will be retained without a link to this account.</p>
        <div class="actions">
          <button type="button" class="secondary" data-close-user-delete-modal>Cancel</button>
          <button type="submit" form="${deleteFormId}" class="danger">Delete user</button>
        </div>
      </dialog>
      <script>
        (() => {
          const modal = document.getElementById(${JSON.stringify(deleteModalId)});
          const openButton = document.querySelector(${JSON.stringify(`[data-open-user-delete-modal="${deleteModalId}"]`)});
          const closeButton = modal?.querySelector('[data-close-user-delete-modal]');
          const closeModal = () => {
            if (typeof modal?.close === 'function') modal.close();
            else modal?.removeAttribute('open');
          };
          openButton?.addEventListener('click', () => {
            if (typeof modal?.showModal === 'function') modal.showModal();
            else modal?.setAttribute('open', '');
          });
          closeButton?.addEventListener('click', closeModal);
          modal?.addEventListener('cancel', (event) => {
            event.preventDefault();
            closeModal();
          });
        })();
      </script>
    ` : ''}
  `;
}

router.get('/admin/users', requireAdmin, (req, res) => {
  const search = String(req.query.q || '').trim();
  const groupId = Number(req.query.group_id || 0);
  const requestedStatus = String(req.query.status || '');
  const filter = USER_STATUS_FILTERS.find((entry) => entry.value === requestedStatus) || USER_STATUS_FILTERS[0];
  const status = filter.value;
  const pageSize = 25;
  const groups = getAllGroups();
  const where = [];
  const params = {};
  if (filter.enabled !== undefined) {
    where.push('users.enabled = @enabled');
    params.enabled = filter.enabled;
  }
  if (search) {
    where.push('(users.name LIKE @search OR users.email LIKE @search OR users.id = @exact_id OR users.last_used_at LIKE @search OR users.created_at LIKE @search)');
    params.search = `%${search}%`;
    params.exact_id = Number(search) || -1;
  }
  if (groupId) {
    where.push('EXISTS (SELECT 1 FROM user_groups WHERE user_groups.user_id = users.id AND user_groups.group_id = @group_id)');
    params.group_id = groupId;
  }
  if (filter.registrationStatus) {
    where.push('users.registration_status = @registration_status');
    params.registration_status = filter.registrationStatus;
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
    SELECT users.*, groups.name AS group_name
    FROM users
    LEFT JOIN user_groups ON user_groups.user_id = users.id
    LEFT JOIN groups ON groups.id = user_groups.group_id
    ${whereSql}
    ORDER BY users.created_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });
  const rows = users.map((user) => `
    <tr>
      <td><a href="/admin/users/${user.id}">${escapeHtml(user.name)}</a></td>
      <td>${escapeHtml(user.email)}</td>
      <td>${escapeHtml(user.role)}</td>
      <td>${escapeHtml(user.group_name || '') || '<span class="muted">none</span>'}</td>
      <td><span class="${user.enabled && user.registration_status === 'approved' ? 'status-enabled' : 'status-disabled'}">${escapeHtml(user.registration_status)}${user.enabled ? '' : ' · disabled'}</span></td>
      <td>${user.last_used_at ? escapeHtml(user.last_used_at) : '<span class="muted">never</span>'}</td>
      <td class="actions">
        <a class="button secondary" href="/admin/users/${user.id}">Edit</a>
      </td>
    </tr>
  `).join('');
  const pagination = totalPages > 1 ? `
    <nav class="pagination" aria-label="Users pages">
      ${page > 1 ? `<a class="button secondary" href="${adminUsersUrl({ search, groupId, status, page: page - 1 })}">Previous</a>` : '<span class="muted">Previous</span>'}
      <span class="muted">Page ${page} of ${totalPages}. ${totalUsers} users.</span>
      ${page < totalPages ? `<a class="button secondary" href="${adminUsersUrl({ search, groupId, status, page: page + 1 })}">Next</a>` : '<span class="muted">Next</span>'}
    </nav>
  ` : `<p class="muted">${totalUsers} user${totalUsers === 1 ? '' : 's'}.</p>`;
  const emailAddresses = getDb().prepare(`
    SELECT users.email
    FROM users
    ${whereSql}
    ORDER BY users.email COLLATE NOCASE
  `).all(params)
    .map(({ email }) => email.trim()).filter(Boolean);
  const content = `
    <p class="actions">
      <a class="button" href="/admin/users/new">Create user</a>
    </p>
    <form method="get" action="/admin/users" class="panel search-panel">
      <label>Search users</label><input name="q" value="${escapeHtml(search)}" placeholder="Name, email, id, or date">
      <label>Filter by group</label><select name="group_id">
        <option value="">All groups</option>
        ${groups.map((group) => `<option value="${group.id}" ${group.id === groupId ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}
      </select>
      <label>Filter by registration status</label><select name="status">
        ${USER_STATUS_FILTERS.map((entry) => `<option value="${entry.value}" ${entry.value === status ? 'selected' : ''}>${entry.label}</option>`).join('')}
      </select>
      <div class="actions user-filter-actions">
        <button>Search</button>
        <a class="button secondary" href="/admin/users">Clear</a>
        <button type="button" class="secondary user-filter-copy" data-copy-user-emails="${escapeHtml(emailAddresses.join(', '))}" data-email-count="${emailAddresses.length}" title="Copy email addresses matching the current filters across all pages"${emailAddresses.length ? '' : ' disabled'}>Copy filtered emails</button>
      </div>
      <span id="copy-user-emails-status" class="muted user-filter-copy-status" role="status" aria-live="polite"></span>
    </form>
    <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Group</th><th>Status</th><th>Last used</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">No users found.</td></tr>'}</tbody></table>
    ${pagination}
    <script>
      (() => {
        const button = document.querySelector('[data-copy-user-emails]');
        const status = document.getElementById('copy-user-emails-status');
        const copyText = async (text) => {
          if (navigator.clipboard?.writeText) {
            try { await navigator.clipboard.writeText(text); return; } catch { /* Try the browser fallback. */ }
          }
          const area = document.createElement('textarea');
          area.value = text;
          area.setAttribute('readonly', '');
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          try {
            area.select();
            if (!document.execCommand('copy')) throw new Error('Copy failed');
          } finally { area.remove(); }
        };
        button?.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await copyText(button.dataset.copyUserEmails);
            const count = Number(button.dataset.emailCount);
            status.textContent = 'Copied ' + count + (count === 1 ? ' email address.' : ' email addresses.');
          } catch {
            status.textContent = 'Copy failed. Please allow clipboard access and try again.';
          } finally {
            button.disabled = Number(button.dataset.emailCount) === 0;
            button.focus();
          }
        });
      })();
    </script>
  `;
  render(req, res, 'users', { title: 'Users', content, flash: flash(req.query.created ? 'User created.' : req.query.deleted ? 'User deleted.' : '') });
});

router.get('/admin/users/new', requireAdmin, (req, res) => {
  render(req, res, 'user-detail', { title: 'New User', content: userForm() });
});

router.get('/admin/oauth-conflicts', requireAdmin, (req, res) => {
  const conflicts = listIdentityConflicts();
  const rows = conflicts.map((conflict) => {
    const expired = conflict.status === 'pending' && new Date(conflict.expires_at).getTime() <= Date.now();
    const actionable = conflict.status === 'pending' && !expired && conflict.user_id;
    return `
      <tr>
        <td>${escapeHtml(conflict.user_name || 'Deleted user')}<br><span class="muted">${escapeHtml(conflict.user_email || conflict.verified_email)}</span></td>
        <td>${escapeHtml(conflict.hosted_domain || 'any verified domain')}</td>
        <td><code>${escapeHtml(conflict.current_subject || 'none')}</code></td>
        <td><code>${escapeHtml(conflict.proposed_subject)}</code></td>
        <td>${escapeHtml(expired ? 'expired' : conflict.status)}${conflict.resolution ? ` · ${escapeHtml(conflict.resolution)}` : ''}</td>
        <td class="actions">
          ${actionable ? `
            <form method="post" action="/admin/oauth-conflicts/${conflict.id}/preserve"><button type="submit">Replace identity and preserve account</button></form>
            <form method="post" action="/admin/oauth-conflicts/${conflict.id}/reset" onsubmit="return confirm('Reset this student as a completely new user? API keys, group, password, messages, conversations, and account configuration will be lost. Historical usage will be anonymized.');"><button type="submit" class="danger">Reset as a new user</button></form>
            <form method="post" action="/admin/oauth-conflicts/${conflict.id}/reject"><button type="submit" class="secondary">Reject</button></form>
          ` : '<span class="muted">No action available</span>'}
        </td>
      </tr>
    `;
  }).join('');
  render(req, res, 'users', {
    title: 'OAuth identity reviews',
    flash: flash(req.query.resolved ? 'OAuth identity review resolved.' : req.query.error ? 'The review could not be resolved or has expired.' : ''),
    content: `
      <p class="muted">These requests occur when a verified email is already linked to a different Google identity.</p>
      <table>
        <thead><tr><th>User</th><th>Hosted domain</th><th>Current identity</th><th>Proposed identity</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">No identity reviews.</td></tr>'}</tbody>
      </table>
    `
  });
});

router.post('/admin/oauth-conflicts/:id/preserve', requireAdmin, (req, res) => {
  const result = preserveIdentityConflict(req.params.id, config.adminUsername);
  res.redirect(result ? '/admin/oauth-conflicts?resolved=1' : '/admin/oauth-conflicts?error=1');
});

router.post('/admin/oauth-conflicts/:id/reset', requireAdmin, (req, res) => {
  const result = resetIdentityConflict(req.params.id, config.adminUsername);
  res.redirect(result ? '/admin/oauth-conflicts?resolved=1' : '/admin/oauth-conflicts?error=1');
});

router.post('/admin/oauth-conflicts/:id/reject', requireAdmin, (req, res) => {
  const result = rejectIdentityConflict(req.params.id, config.adminUsername);
  res.redirect(result ? '/admin/oauth-conflicts?resolved=1' : '/admin/oauth-conflicts?error=1');
});

router.post('/admin/users', requireAdmin, (req, res) => {
  const form = parseUserForm(req.body);
  const db = getDb();
  const createUser = db.transaction(() => {
    const owner = findUserByEmail(db, form.email);
    if (owner) return { owner };
    const result = db.prepare(`
      INSERT INTO users (name, email, api_key_hash, enabled, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      form.name,
      form.email,
      null,
      form.enabled,
      form.role
    );
    const userId = result.lastInsertRowid;
    setUserGroups(userId, [form.groupId]);
    return { userId, invite: createInviteForUser(userId) };
  });
  const { owner, userId, invite } = createUser();
  if (owner) {
    res.status(409);
    return render(req, res, 'user-detail', { title: 'New User', content: userForm(form), flash: emailTakenNotice(owner) });
  }
  setPendingSecret(req.sessionID, `invite:${userId}`, invite);
  res.redirect(`/admin/users/${userId}?created=1&invite_created=1`);
});

router.get('/admin/users/:id', requireAdmin, (req, res) => {
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).send('User not found');
  const usage = getUsageTotals(user.id);
  const usageByDay = dailyUsage(15, new Date(), user.id);
  const group = getUserGroup(user.id);
  const usagePageSize = 25;
  const totalUsage = countUsage(user.id);
  const usageTotalPages = Math.max(1, Math.ceil(totalUsage / usagePageSize));
  const requestedUsagePage = Math.max(1, Number.parseInt(req.query.usage_page || '1', 10) || 1);
  const usagePage = Math.min(requestedUsagePage, usageTotalPages);
  const deleteError = req.query.delete_error
    ? USER_DELETION_MESSAGE
    : '';
  const activeInvite = getActiveInviteForUser(user.id);
  // Invitation links are only stored as digests, so a link is shown once, right after it is created.
  const newInvite = activeInvite ? takePendingSecret(req.sessionID, `invite:${user.id}`) : null;
  const activeInviteUrl = newInvite ? `${getRequestBaseUrl(req)}/invite/${encodeURIComponent(newInvite.token)}` : '';
  const userApiKeys = listUserApiKeys(user.id);
  const canAddApiKey = user.registration_status === 'approved' && userApiKeys.length < MAX_USER_API_KEYS;
  const apiKeyLimitMessage = `Only ${MAX_USER_API_KEYS} API keys per user are allowed.`;
  const apiKeyRows = userApiKeys.map((apiKey) => `
    <tr>
      <td>${escapeHtml(apiKey.name)}</td>
      <td><code>${escapeHtml(`${apiKey.api_key_prefix || 'ieti_sk_'}...${apiKey.api_key_suffix || ''}`)}</code></td>
      <td class="actions"><form method="post" action="/admin/users/${user.id}/revoke-key/${apiKey.id}"><button class="danger">Revoke</button></form></td>
    </tr>
  `).join('');
  const content = `
    <div class="section-stack">
      ${userForm(user, `/admin/users/${user.id}`)}
      <section class="panel">
        <h2>Invitation key</h2>
        <p><strong>${escapeHtml(user.name)}</strong><br><span class="muted">${escapeHtml(user.email)}</span></p>
        ${activeInvite && !newInvite ? `
          <p class="muted">An invitation is active until ${escapeHtml(activeInvite.expiresAt)}. Its link is only shown when it is generated; generate a new one if it was lost.</p>
        ` : ''}
        ${newInvite ? `
          <div class="command-row">
            <p id="invitation-url-${user.id}" class="key" style="flex:1;margin:0">${escapeHtml(activeInviteUrl)}</p>
            <button type="button" class="copy-command secondary" data-copy-invitation-url data-copy-target="invitation-url-${user.id}" title="Copy invitation URL" aria-label="Copy invitation URL">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="8" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>
              <span class="copy-label">Copy</span>
            </button>
          </div>
          <p class="muted">Invite expires at ${escapeHtml(activeInvite.expiresAt)}. Generating a new invitation invalidates this one.</p>
          <script>
            (() => {
              const button = document.querySelector('[data-copy-invitation-url]');
              const copyText = (text) => {
                if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
                const area = document.createElement('textarea');
                area.value = text;
                area.setAttribute('readonly', '');
                area.style.position = 'fixed';
                area.style.opacity = '0';
                document.body.appendChild(area);
                area.select();
                const copied = document.execCommand('copy');
                area.remove();
                return copied ? Promise.resolve() : Promise.reject(new Error('Copy failed'));
              };
              button?.addEventListener('click', () => {
                const target = document.getElementById(button.dataset.copyTarget);
                const label = button.querySelector('.copy-label');
                if (!target || !label) return;
                copyText(target.textContent).then(() => {
                  label.textContent = 'Copied';
                  window.setTimeout(() => { label.textContent = 'Copy'; }, 1600);
                }).catch(() => {
                  label.textContent = 'Copy failed';
                  window.setTimeout(() => { label.textContent = 'Copy'; }, 1600);
                });
              });
            })();
          </script>
        ` : ''}
        ${activeInvite ? '' : '<p class="muted">No active invitation key.</p>'}
        ${user.registration_status === 'approved' ? `<div class="actions">
          <form method="post" action="/admin/users/${user.id}/invite"><button>${activeInvite ? 'Regenerate invitation key' : 'Generate invitation key'}</button></form>
        </div>` : '<p class="muted">Invitations are unavailable until this registration is approved.</p>'}
      </section>
      <section class="panel">
        <h2>API keys</h2>
        ${userApiKeys.length ? `<table><thead><tr><th>Name</th><th>Key</th><th>Actions</th></tr></thead><tbody>${apiKeyRows}</tbody></table>` : '<p class="muted">No API keys configured.</p>'}
        ${canAddApiKey ? `
          <form id="user-api-key-add-${user.id}" method="post" action="/admin/users/${user.id}/regenerate-key">
            <input name="key_name" maxlength="80" placeholder="Key name (optional)" aria-label="New API key name">
          </form>
        ` : ''}
        <div class="form-actions" data-api-key-actions>
          ${canAddApiKey ? `<button type="submit" form="user-api-key-add-${user.id}">Add API key</button>` : `<span class="muted">${apiKeyLimitMessage}</span>`}
          <form method="post" action="/admin/users/${user.id}/revoke-key"><button class="danger">Revoke all keys</button></form>
        </div>
      </section>
      <section class="panel">
        <h2>Stats</h2>
        <div class="grid">
          <div class="metric">Last used<strong>${user.last_used_at ? escapeHtml(user.last_used_at) : 'never'}</strong></div>
          <div class="metric">Group pools<strong>${group?.pool_aliases?.length ? escapeHtml(group.pool_aliases.join(', ')) : 'none'}</strong>${group?.provider_names ? `<span class="muted">${escapeHtml(group.provider_names)}</span>` : ''}</div>
        </div>
        <div style="margin-top:16px">${usageStatus(user, group, usage)}</div>
        <div class="dashboard-section">${dailyUsageCard(usageByDay)}</div>
        <script src="/admin/assets/dashboard-usage.js" defer></script>
        <h3>Recent usage/errors</h3>
        ${usageTable(recentUsage(usagePageSize, user.id, (usagePage - 1) * usagePageSize))}
        ${paginationControls({
          page: usagePage,
          totalPages: usageTotalPages,
          totalItems: totalUsage,
          urlFor: (page) => userDetailUrl(user.id, { usagePage: page })
        })}
      </section>
      ${user.registration_status === 'pending' ? `
        <section class="panel">
          <h2>Pending registration</h2>
          <p>Assign a group in the account form to approve this user, or reject the registration.</p>
          <form method="post" action="/admin/users/${user.id}/reject-registration"><button type="submit" class="danger">Reject registration</button></form>
        </section>
      ` : ''}
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
  const emailOwner = req.query.email_taken
    ? getDb().prepare('SELECT id, name, enabled FROM users WHERE id = ? AND id != ?').get(Number.parseInt(String(req.query.email_taken), 10) || 0, user.id)
    : null;
  render(req, res, 'user-detail', { title: 'Edit User', content, flash: emailOwner ? emailTakenNotice(emailOwner) : flash(message) });
});

router.post('/admin/users/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const updateUser = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!existing) throw apiError(404, 'user_not_found', 'User not found.');
    const form = parseUserForm(req.body, { defaultRole: existing.role });
    const owner = findUserByEmail(db, form.email, { exceptId: existing.id });
    if (owner) return owner;
    const nextStatus = existing.registration_status === 'pending' ? 'approved' : existing.registration_status;
    const invalidateSessions = existing.enabled && !form.enabled ? 1 : 0;
    const result = db.prepare(`
      UPDATE users
      SET name = ?, email = ?, role = ?, enabled = ?, registration_status = ?,
          auth_version = auth_version + ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      form.name,
      form.email,
      form.role,
      form.enabled,
      nextStatus,
      invalidateSessions,
      req.params.id
    );
    if (!result.changes) throw apiError(404, 'user_not_found', 'User not found.');
    setUserGroups(req.params.id, [form.groupId]);
    if (existing.registration_status === 'pending') {
      auditAuthEvent(db, {
        event: 'oauth_registration_approved',
        userId: existing.id,
        email: form.email,
        actor: config.adminUsername,
        details: { groupId: form.groupId, role: form.role }
      });
    }
  });
  const owner = updateUser();
  if (owner) return res.redirect(`/admin/users/${req.params.id}?email_taken=${owner.id}`);
  res.redirect(`/admin/users/${req.params.id}`);
});

router.post('/admin/users/:id/reject-registration', requireAdmin, (req, res) => {
  const db = getDb();
  const reject = db.transaction(() => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user || user.registration_status !== 'pending') return false;
    db.prepare(`
      UPDATE users
      SET registration_status = 'rejected', auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(user.id);
    auditAuthEvent(db, {
      event: 'oauth_registration_rejected',
      userId: user.id,
      email: user.email,
      actor: config.adminUsername
    });
    return true;
  });
  const rejected = reject();
  res.redirect(rejected ? `/admin/users/${req.params.id}` : '/admin/users?status=pending');
});

router.post('/admin/users/:id/invite', requireAdmin, (req, res) => {
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).send('User not found');
  if (user.registration_status !== 'approved') return res.status(409).send('Approve this user before creating an invitation.');
  setPendingSecret(req.sessionID, `invite:${user.id}`, createInviteForUser(user.id));
  res.redirect(`/admin/users/${user.id}?invite_created=1`);
});

router.post('/admin/users/:id/regenerate-key', requireAdmin, (req, res) => {
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).send('User not found');
  if (user.registration_status !== 'approved') return res.status(409).send('Approve this user before creating API keys.');
  if (listUserApiKeys(user.id).length >= MAX_USER_API_KEYS) {
    return res.status(409).send(`Only ${MAX_USER_API_KEYS} API keys per user are allowed. Delete an existing key before adding another.`);
  }
  const key = generateStudentKey();
  const requestedName = normalizeApiKeyName(req.body.key_name);
  const name = requestedName || getAvailableLegacyName(user.id);
  if (requestedName && getDb().prepare('SELECT 1 FROM user_api_keys WHERE user_id = ? AND name = ? COLLATE NOCASE').get(user.id, requestedName)) {
    return res.redirect(`/admin/users/${user.id}?key_error=duplicate`);
  }
  try {
    createUserApiKey(user.id, name, key);
  } catch (error) {
    if (error.code === 'max_api_keys') {
      return res.status(409).send(`${error.message} Delete an existing key before adding another.`);
    }
    throw error;
  }
  render(req, res, 'user-detail', {
    title: 'New API Key',
    flash: flash('Copy this API key now. It will not be shown again.'),
    content: `<p><strong>${escapeHtml(name)}</strong></p><p class="key">${escapeHtml(key)}</p><p><a class="button" href="/admin/users/${req.params.id}">Back to user</a></p>`
  });
});

router.post('/admin/users/:id/revoke-key', requireAdmin, (req, res) => {
  getDb().prepare('DELETE FROM user_api_keys WHERE user_id = ?').run(req.params.id);
  getDb().prepare('UPDATE users SET api_key_hash = NULL, api_key_lookup_hash = NULL, api_key_prefix = NULL, api_key_suffix = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.redirect(`/admin/users/${req.params.id}?revoked=1`);
});

router.post('/admin/users/:id/revoke-key/:keyId', requireAdmin, (req, res) => {
  revokeUserApiKey(req.params.id, Number.parseInt(req.params.keyId, 10));
  res.redirect(`/admin/users/${req.params.id}?revoked=1`);
});

router.post('/admin/users/:id/delete', requireAdmin, (req, res) => {
  const db = getDb();
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id)) {
    return res.status(404).send('User not found');
  }
  const result = db.prepare(`DELETE FROM users WHERE id = ? AND ${USER_DELETION_CONDITION}`).run(req.params.id);
  if (!result.changes) {
    return res.redirect(userDetailUrl(req.params.id, { deleteError: 'disabled-period' }));
  }
  res.redirect('/admin/users?deleted=1');
});

module.exports = router;
