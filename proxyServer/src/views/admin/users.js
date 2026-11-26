// Markup of the admin pages for users, invitations, API keys and identity reviews.
const { quotaLimitCards, paginationControls, joinHtml, html, jsLiteral } = require('../../utils/html');
const { dailyUsageCard } = require('../../utils/usageCards');
const { usageTable } = require('./shared');

const USER_ROLES = ['student', 'teacher'];

function groupOptions(groups, selectedId = null) {
  const selected = Number(selectedId || 0);
  return joinHtml(groups.map((group) => html`
    <option value="${group.id}" ${Number(group.id) === selected ? 'selected' : ''}>${group.name}</option>
  `));
}

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
  return html`
    <div class="modal-backdrop" role="presentation">
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">Delete failed</h2>
        <p>${message}</p>
        <div class="actions"><a class="button" href="${closeHref}">Close</a></div>
      </div>
    </div>
  `;
}

function emailTakenNotice(owner) {
  return html`
    <div class="error">
      That email already belongs to <a href="/admin/users/${owner.id}">${owner.name}</a>${owner.enabled ? '' : ' (disabled, so hidden by the default filter on the Users page)'}.
      Nothing was saved. Open that user to change the group or enable the account.
    </div>
  `;
}

function userForm(user = {}, action = '/admin/users', { groups = [], selectedGroupId = null, removable = false } = {}) {
  const formId = user.id ? html`user-edit-${user.id}` : 'user-new';
  const deleteFormId = user.id ? html`user-delete-${user.id}` : '';
  const deleteModalId = user.id ? html`user-delete-modal-${user.id}` : '';
  const enabled = user.enabled === undefined ? true : Boolean(user.enabled);
  const registrationStatus = user.registration_status || 'approved';
  const selectedRole = USER_ROLES.includes(user.role) ? user.role : 'student';
  return html`
    <div class="panel">
      ${user.id ? html`<p><strong>Registration status:</strong> ${registrationStatus}</p>` : ''}
      ${user.id && !enabled && user.disabled_at ? html`<p><strong>Disabled since (UTC):</strong> ${user.disabled_at}</p>` : ''}
      <form id="${formId}" method="post" action="${action}">
        <label>Name</label><input name="name" value="${user.name}" required>
        <label>Email</label><input name="email" type="email" value="${user.email}" required>
        <label>Role</label><select name="role" required>
          ${joinHtml(USER_ROLES.map((role) => html`<option value="${role}" ${role === selectedRole ? 'selected' : ''}>${role}</option>`))}
        </select>
        <label>Group</label><select name="group_id" required><option value="">Choose one group</option>${groupOptions(groups, selectedGroupId)}</select>
        <label><input name="enabled" type="checkbox" value="1" style="width:auto" ${enabled ? 'checked' : ''}> Enabled</label>
      </form>
      <div class="form-actions">
        <div class="actions">
          <button type="submit" form="${formId}">${registrationStatus === 'pending' ? 'Assign group and approve' : 'Save'}</button>
          <a class="button secondary" href="/admin/users">Cancel</a>
        </div>
        ${user.id ? html`
          ${removable ? html`
            <button type="button" class="danger" data-open-user-delete-modal="${deleteModalId}">Delete</button>
          ` : html`<span class="muted">${USER_DELETION_MESSAGE}</span>`}
        ` : ''}
      </div>
    </div>
    ${user.id && removable ? html`
      <form id="${deleteFormId}" method="post" action="/admin/users/${user.id}/delete"></form>
      <dialog id="${deleteModalId}" class="modal" aria-labelledby="${deleteModalId}-title">
        <h2 id="${deleteModalId}-title">Delete user?</h2>
        <p>This will permanently delete <strong>${user.name}</strong> (<code>${user.email}</code>) and the user's invitations, API keys, linked sign-in identities, conversations and messages.</p>
        <p>Usage history will be retained without a link to this account.</p>
        <div class="actions">
          <button type="button" class="secondary" data-close-user-delete-modal>Cancel</button>
          <button type="submit" form="${deleteFormId}" class="danger">Delete user</button>
        </div>
      </dialog>
      <script>
        (() => {
          const modal = document.getElementById(${jsLiteral(deleteModalId)});
          const openButton = document.querySelector(${jsLiteral(`[data-open-user-delete-modal="${deleteModalId}"]`)});
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

function usersPage({ emailAddresses, groupId, groups, page, search, status, totalPages, totalUsers, users }) {
  const rows = joinHtml(users.map((user) => html`
    <tr>
      <td><a href="/admin/users/${user.id}">${user.name}</a></td>
      <td>${user.email}</td>
      <td>${user.role}</td>
      <td>${(user.group_name || '') || html`<span class="muted">none</span>`}</td>
      <td><span class="${user.enabled && user.registration_status === 'approved' ? 'status-enabled' : 'status-disabled'}">${user.registration_status}${user.enabled ? '' : ' · disabled'}</span></td>
      <td>${user.last_used_at ? user.last_used_at : html`<span class="muted">never</span>`}</td>
      <td class="actions">
        <a class="button secondary" href="/admin/users/${user.id}">Edit</a>
      </td>
    </tr>
  `));
  const pagination = totalPages > 1 ? html`
    <nav class="pagination" aria-label="Users pages">
      ${page > 1 ? html`<a class="button secondary" href="${adminUsersUrl({ search, groupId, status, page: page - 1 })}">Previous</a>` : html`<span class="muted">Previous</span>`}
      <span class="muted">Page ${page} of ${totalPages}. ${totalUsers} users.</span>
      ${page < totalPages ? html`<a class="button secondary" href="${adminUsersUrl({ search, groupId, status, page: page + 1 })}">Next</a>` : html`<span class="muted">Next</span>`}
    </nav>
  ` : html`<p class="muted">${totalUsers} user${totalUsers === 1 ? '' : 's'}.</p>`;
  const content = html`
    <p class="actions">
      <a class="button" href="/admin/users/new">Create user</a>
    </p>
    <form method="get" action="/admin/users" class="panel search-panel">
      <label>Search users</label><input name="q" value="${search}" placeholder="Name, email, id, or date">
      <label>Filter by group</label><select name="group_id">
        <option value="">All groups</option>
        ${joinHtml(groups.map((group) => html`<option value="${group.id}" ${group.id === groupId ? 'selected' : ''}>${group.name}</option>`))}
      </select>
      <label>Filter by registration status</label><select name="status">
        ${joinHtml(USER_STATUS_FILTERS.map((entry) => html`<option value="${entry.value}" ${entry.value === status ? 'selected' : ''}>${entry.label}</option>`))}
      </select>
      <div class="actions user-filter-actions">
        <button>Search</button>
        <a class="button secondary" href="/admin/users">Clear</a>
        <button type="button" class="secondary user-filter-copy" data-copy-user-emails="${joinHtml(emailAddresses, ', ')}" data-email-count="${emailAddresses.length}" title="Copy email addresses matching the current filters across all pages"${emailAddresses.length ? '' : ' disabled'}>Copy filtered emails</button>
      </div>
      <span id="copy-user-emails-status" class="muted user-filter-copy-status" role="status" aria-live="polite"></span>
    </form>
    <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Group</th><th>Status</th><th>Last used</th><th>Actions</th></tr></thead><tbody>${rows || html`<tr><td colspan="7" class="muted">No users found.</td></tr>`}</tbody></table>
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
  return content;
}

function identityReviewsPage({ conflicts }) {
  const rows = joinHtml(conflicts.map((conflict) => {
    const expired = conflict.status === 'pending' && new Date(conflict.expires_at).getTime() <= Date.now();
    const actionable = conflict.status === 'pending' && !expired && conflict.user_id;
    return html`
      <tr>
        <td>${conflict.user_name || 'Deleted user'}<br><span class="muted">${conflict.user_email || conflict.verified_email}</span></td>
        <td>${conflict.hosted_domain || 'any verified domain'}</td>
        <td><code>${conflict.current_subject || 'none'}</code></td>
        <td><code>${conflict.proposed_subject}</code></td>
        <td>${expired ? 'expired' : conflict.status}${conflict.resolution ? html` · ${conflict.resolution}` : ''}</td>
        <td class="actions">
          ${actionable ? html`
            <form method="post" action="/admin/oauth-conflicts/${conflict.id}/preserve"><button type="submit">Replace identity and preserve account</button></form>
            <form method="post" action="/admin/oauth-conflicts/${conflict.id}/reset" onsubmit="return confirm('Reset this student as a completely new user? API keys, group, password, messages, conversations, and account configuration will be lost. Historical usage will be anonymized.');"><button type="submit" class="danger">Reset as a new user</button></form>
            <form method="post" action="/admin/oauth-conflicts/${conflict.id}/reject"><button type="submit" class="secondary">Reject</button></form>
          ` : html`<span class="muted">No action available</span>`}
        </td>
      </tr>
    `;
  }));
  return html`
      <p class="muted">These requests occur when a verified email is already linked to a different Google identity.</p>
      <table>
        <thead><tr><th>User</th><th>Hosted domain</th><th>Current identity</th><th>Proposed identity</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows || html`<tr><td colspan="6" class="muted">No identity reviews.</td></tr>`}</tbody>
      </table>
    `;
}

// user is the stored account; formUser is what the edit form shows, which differs from it
// only when a refused submission is being shown again.
function userPage({ activeInvite, activeInviteUrl, apiKeyLimitMessage, canAddApiKey, deleteError, formData, formUser, group, newInvite, recentCalls, totalUsage, usage, usageByDay, usagePage, usageTotalPages, user, userApiKeys }) {
  const apiKeyRows = joinHtml(userApiKeys.map((apiKey) => html`
    <tr>
      <td>${apiKey.name}</td>
      <td><code>${html`${apiKey.api_key_prefix || 'ieti_sk_'}...${apiKey.api_key_suffix || ''}`}</code></td>
      <td class="actions"><form method="post" action="/admin/users/${user.id}/revoke-key/${apiKey.id}"><button class="danger">Revoke</button></form></td>
    </tr>
  `));
  const content = html`
    <div class="section-stack">
      ${userForm(formUser, `/admin/users/${user.id}`, formData)}
      <section class="panel">
        <h2>Invitation key</h2>
        <p><strong>${user.name}</strong><br><span class="muted">${user.email}</span></p>
        ${activeInvite && !newInvite ? html`
          <p class="muted">An invitation is active until ${activeInvite.expiresAt}. Its link is only shown when it is generated; generate a new one if it was lost.</p>
        ` : ''}
        ${newInvite ? html`
          <div class="command-row">
            <p id="invitation-url-${user.id}" class="key" style="flex:1;margin:0">${activeInviteUrl}</p>
            <button type="button" class="copy-command secondary" data-copy-invitation-url data-copy-target="invitation-url-${user.id}" title="Copy invitation URL" aria-label="Copy invitation URL">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="8" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>
              <span class="copy-label">Copy</span>
            </button>
          </div>
          <p class="muted">Invite expires at ${activeInvite.expiresAt}. Generating a new invitation invalidates this one.</p>
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
        ${activeInvite ? '' : html`<p class="muted">No active invitation key.</p>`}
        ${user.registration_status === 'approved' ? html`<div class="actions">
          <form method="post" action="/admin/users/${user.id}/invite"><button>${activeInvite ? 'Regenerate invitation key' : 'Generate invitation key'}</button></form>
        </div>` : html`<p class="muted">Invitations are unavailable until this registration is approved.</p>`}
      </section>
      <section class="panel">
        <h2>API keys</h2>
        ${userApiKeys.length ? html`<table><thead><tr><th>Name</th><th>Key</th><th>Actions</th></tr></thead><tbody>${apiKeyRows}</tbody></table>` : html`<p class="muted">No API keys configured.</p>`}
        ${canAddApiKey ? html`
          <form id="user-api-key-add-${user.id}" method="post" action="/admin/users/${user.id}/regenerate-key">
            <input name="key_name" maxlength="80" placeholder="Key name (optional)" aria-label="New API key name">
          </form>
        ` : ''}
        <div class="form-actions" data-api-key-actions>
          ${canAddApiKey ? html`<button type="submit" form="user-api-key-add-${user.id}">Add API key</button>` : html`<span class="muted">${apiKeyLimitMessage}</span>`}
          <form method="post" action="/admin/users/${user.id}/revoke-key"><button class="danger">Revoke all keys</button></form>
        </div>
      </section>
      <section class="panel">
        <h2>Stats</h2>
        <div class="grid">
          <div class="metric">Last used<strong>${user.last_used_at ? user.last_used_at : 'never'}</strong></div>
          <div class="metric">Group pools<strong>${group?.pool_aliases?.length ? joinHtml(group.pool_aliases, ', ') : 'none'}</strong>${group?.provider_names ? html`<span class="muted">${group.provider_names}</span>` : ''}</div>
        </div>
        <div style="margin-top:16px">${quotaLimitCards(group, usage)}</div>
        <div class="dashboard-section">${dailyUsageCard(usageByDay)}</div>
        <script src="/admin/assets/dashboard-usage.js" defer></script>
        <h3>Recent usage/errors</h3>
        ${usageTable(recentCalls)}
        ${paginationControls({
          page: usagePage,
          totalPages: usageTotalPages,
          totalItems: totalUsage,
          urlFor: (page) => userDetailUrl(user.id, { usagePage: page })
        })}
      </section>
      ${user.registration_status === 'pending' ? html`
        <section class="panel">
          <h2>Pending registration</h2>
          <p>Assign a group in the account form to approve this user, or reject the registration.</p>
          <form method="post" action="/admin/users/${user.id}/reject-registration"><button type="submit" class="danger">Reject registration</button></form>
        </section>
      ` : ''}
    </div>
    ${errorModal(deleteError, userDetailUrl(user.id, { usagePage }))}
  `;
  return content;
}

function newApiKeyPage({ key, name, userId }) {
  return html`<p><strong>${name}</strong></p><p class="key">${key}</p><p><a class="button" href="/admin/users/${userId}">Back to user</a></p>`;
}

module.exports = {
  USER_DELETION_MESSAGE,
  USER_ROLES,
  USER_STATUS_FILTERS,
  adminUsersUrl,
  emailTakenNotice,
  errorModal,
  groupOptions,
  identityReviewsPage,
  newApiKeyPage,
  userDetailUrl,
  userForm,
  userPage,
  usersPage
};
