// Admin pages for users: list, create, edit, invitations, API keys and identity reviews.
const express = require('express');
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
const { apiError } = require('../../utils/errors');
const { flash, getRequestBaseUrl: requestBaseUrl } = require('../../utils/html');
const { email: validateEmail, requiredText } = require('../../utils/validation');
const { render, formRoute, formConflict } = require('./shared');
const {
  USER_ROLES,
  USER_STATUS_FILTERS,
  usersPage,
  userForm,
  identityReviewsPage,
  emailTakenNotice,
  USER_DELETION_MESSAGE,
  userPage,
  newApiKeyPage,
  userDetailUrl
} = require('../../views/admin/users');

const router = express.Router();

function getRequestBaseUrl(req) {
  return requestBaseUrl(req, config.publicBaseUrl || getSetting('public_base_url', ''));
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

// Emails are unique regardless of letter case (idx_users_email_nocase).
function findUserByEmail(db, email, { exceptId = null } = {}) {
  return db.prepare(`
    SELECT id, name, enabled FROM users
    WHERE lower(email) = lower(?) AND id IS NOT ?
  `).get(email, exceptId === null ? null : Number(exceptId)) || null;
}

// What the user form needs from the database: the groups to choose from, the user's
// current group and whether the account may be deleted.
function userFormData(user = {}, { groupId } = {}) {
  return {
    groups: getAllGroups(),
    selectedGroupId: groupId !== undefined ? groupId : user.id ? getUserGroups(user.id)[0]?.id : (user.groupId ?? null),
    removable: user.id && Boolean(getDb().prepare(`SELECT id FROM users WHERE id = ? AND ${USER_DELETION_CONDITION}`).get(user.id))
  };
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
  const emailAddresses = getDb().prepare(`
    SELECT users.email
    FROM users
    ${whereSql}
    ORDER BY users.email COLLATE NOCASE
  `).all(params)
    .map(({ email }) => email.trim()).filter(Boolean);
  render(req, res, 'users', { title: 'Users', content: usersPage({ emailAddresses, groupId, groups, page, search, status, totalPages, totalUsers, users }), flash: flash(req.query.created ? 'User created.' : req.query.deleted ? 'User deleted.' : '') });
});

// The user form's fields as submitted, valid or not, laid over the stored account if any.
function userFromBody(body, stored = {}) {
  return {
    ...stored,
    name: body.name ?? '',
    email: body.email ?? '',
    role: body.role ?? stored.role,
    enabled: body.enabled ? 1 : 0,
    groupId: body.group_id
  };
}

function showNewUser(req, res, { values = null, notice = '', status = 200 } = {}) {
  const user = values ? userFromBody(values) : {};
  res.status(status);
  render(req, res, 'user-detail', { title: 'New User', content: userForm(user, '/admin/users', userFormData(user)), flash: notice });
}

router.get('/admin/users/new', requireAdmin, (req, res) => {
  showNewUser(req, res);
});

router.get('/admin/oauth-conflicts', requireAdmin, (req, res) => {
  const conflicts = listIdentityConflicts();
  render(req, res, 'users', {
    title: 'OAuth identity reviews',
    flash: flash(req.query.resolved ? 'OAuth identity review resolved.' : req.query.error ? 'The review could not be resolved or has expired.' : ''),
    content: identityReviewsPage({ conflicts })
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

router.post('/admin/users', requireAdmin, formRoute(showNewUser, (req, res) => {
  const form = parseUserForm(req.body);
  const db = getDb();
  const createUser = db.transaction(() => {
    const owner = findUserByEmail(db, form.email);
    if (owner) throw formConflict('email_taken', 'That email already belongs to another user.', emailTakenNotice(owner));
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
  const { userId, invite } = createUser();
  setPendingSecret(req.sessionID, `invite:${userId}`, invite);
  res.redirect(`/admin/users/${userId}?created=1&invite_created=1`);
}));

// The user's page. After a refused submission it shows the typed values and the reason.
function showUser(req, res, { values = null, notice = '', status = 200 } = {}) {
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).send('User not found');
  const formUser = values && values.email !== undefined ? userFromBody(values, user) : user;
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
  const formData = userFormData(user, formUser === user ? {} : { groupId: values.group_id });
  const recentCalls = recentUsage(usagePageSize, user.id, (usagePage - 1) * usagePageSize);
  const message = req.query.invite_created
    ? 'Invitation key generated.'
    : req.query.revoked
      ? 'API key revoked.'
      : req.query.deleted
        ? 'User deleted.'
        : req.query.created
          ? 'User created.'
          : '';
  res.status(status);
  render(req, res, 'user-detail', { title: 'Edit User', content: userPage({ activeInvite, activeInviteUrl, apiKeyLimitMessage, canAddApiKey, deleteError, formData, formUser, group, newInvite, recentCalls, totalUsage, usage, usageByDay, usagePage, usageTotalPages, user, userApiKeys }), flash: notice || flash(message) });
}

router.get('/admin/users/:id', requireAdmin, (req, res) => {
  showUser(req, res);
});

router.post('/admin/users/:id', requireAdmin, formRoute(showUser, (req, res) => {
  const db = getDb();
  const updateUser = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!existing) throw apiError(404, 'user_not_found', 'User not found.');
    const form = parseUserForm(req.body, { defaultRole: existing.role });
    const owner = findUserByEmail(db, form.email, { exceptId: existing.id });
    if (owner) throw formConflict('email_taken', 'That email already belongs to another user.', emailTakenNotice(owner));
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
  updateUser();
  res.redirect(`/admin/users/${req.params.id}`);
}));

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

router.post('/admin/users/:id/invite', requireAdmin, formRoute(showUser, (req, res) => {
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).send('User not found');
  if (user.registration_status !== 'approved') throw formConflict('user_not_approved', 'Approve this user before creating an invitation.');
  setPendingSecret(req.sessionID, `invite:${user.id}`, createInviteForUser(user.id));
  res.redirect(`/admin/users/${user.id}?invite_created=1`);
}));

router.post('/admin/users/:id/regenerate-key', requireAdmin, formRoute(showUser, (req, res) => {
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).send('User not found');
  if (user.registration_status !== 'approved') throw formConflict('user_not_approved', 'Approve this user before creating API keys.');
  if (listUserApiKeys(user.id).length >= MAX_USER_API_KEYS) {
    throw formConflict('max_api_keys', `Only ${MAX_USER_API_KEYS} API keys per user are allowed. Delete an existing key before adding another.`);
  }
  const key = generateStudentKey();
  const requestedName = normalizeApiKeyName(req.body.key_name);
  const name = requestedName || getAvailableLegacyName(user.id);
  if (requestedName && getDb().prepare('SELECT 1 FROM user_api_keys WHERE user_id = ? AND name = ? COLLATE NOCASE').get(user.id, requestedName)) {
    throw formConflict('api_key_name_taken', `This user already has an API key named ${requestedName}. Choose another name.`);
  }
  try {
    createUserApiKey(user.id, name, key);
  } catch (error) {
    if (error.code === 'max_api_keys') {
      throw formConflict('max_api_keys', `${error.message} Delete an existing key before adding another.`);
    }
    throw error;
  }
  const userId = req.params.id;
  render(req, res, 'user-detail', {
    title: 'New API Key',
    flash: flash('Copy this API key now. It will not be shown again.'),
    content: newApiKeyPage({ key, name, userId })
  });
}));

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
