// Admin pages for groups: quotas, the pools a group can use, and its members.
const express = require('express');
const { getDb } = require('../../db');
const { requireAdmin } = require('../../middleware/authAdmin');
const { getAllGroups, setGroupPools } = require('../../services/accessService');
const { listPools, positiveIds } = require('../../services/poolService');
const { escapeHtml, flash } = require('../../utils/html');
const { nonNegativeIntegerOrNull, requiredText } = require('../../utils/validation');
const { render } = require('./shared');

const router = express.Router();

function limitValue(value) {
  return value === null || value === undefined ? '' : escapeHtml(value);
}

function parseGroupForm(body) {
  return {
    name: requiredText(body.name, 'Name', { max: 160 }),
    poolIds: positiveIds(body.pool_ids),
    dailyCallLimit: nonNegativeIntegerOrNull(body.daily_call_limit, 'Calls per day'),
    dailyTokenLimit: nonNegativeIntegerOrNull(body.daily_token_limit, 'Tokens per day'),
    hourlyCallLimit: nonNegativeIntegerOrNull(body.hourly_call_limit, 'Calls per hour'),
    hourlyTokenLimit: nonNegativeIntegerOrNull(body.hourly_token_limit, 'Tokens per hour')
  };
}

function groupForm(group = {}, action = '/admin/groups') {
  const pools = listPools();
  const selectedPoolIds = new Set(group.pool_ids || []);
  return `
    <form method="post" action="${action}" class="panel">
      <label>Name</label><input name="name" value="${escapeHtml(group.name)}" required>
      <label>Pools <span class="muted" style="display:block;font-weight:400">Students in this group can use the model alias of each ticked pool. Pools are managed on the <a href="/admin/pools">Pools</a> page.</span></label>
      <div class="checkbox-list">
        ${pools.length ? pools.map((pool) => `
          <label>
            <input name="pool_ids" type="checkbox" value="${pool.id}" style="width:auto" ${selectedPoolIds.has(pool.id) ? 'checked' : ''}>
            <code>${escapeHtml(pool.alias)}</code>
            <span class="muted">${pool.providers.length ? pool.providers.map((provider) => `${escapeHtml(provider.name)}${provider.enabled ? '' : ' (disabled)'}`).join(', ') : 'no providers'}</span>
          </label>
        `).join('') : '<p class="muted">No pools configured.</p>'}
      </div>
      <label>Calls per day</label><input name="daily_call_limit" type="number" min="0" value="${limitValue(group.daily_call_limit)}" placeholder="Unlimited">
      <label>Tokens per day</label><input name="daily_token_limit" type="number" min="0" value="${limitValue(group.daily_token_limit)}" placeholder="Unlimited">
      <label>Calls per hour</label><input name="hourly_call_limit" type="number" min="0" value="${limitValue(group.hourly_call_limit)}" placeholder="Unlimited">
      <label>Tokens per hour</label><input name="hourly_token_limit" type="number" min="0" value="${limitValue(group.hourly_token_limit)}" placeholder="Unlimited">
      <p><button type="submit">Save group</button> <a class="button secondary" href="/admin/groups">Cancel</a></p>
    </form>
  `;
}

// Lists a group's pools by alias, each with the providers that serve it.
function groupPoolsSummary(pools) {
  if (!pools.length) return '<span class="muted">none</span>';
  return pools.map((pool) => `
    <div class="group-provider-model">
      <a href="/admin/pools/${pool.id}"><code>${escapeHtml(pool.alias)}</code></a>
      ${pool.providers.length ? `<ul>
        ${pool.providers
          .toSorted((left, right) => String(left.name || left.slug).localeCompare(String(right.name || right.slug)))
          .map((provider) => `<li><a href="/admin/providers/${provider.id}">${escapeHtml(provider.name || provider.slug)}</a>${provider.enabled ? '' : ' <span class="muted">(disabled)</span>'}</li>`)
          .join('')}
      </ul>` : '<span class="muted">no providers</span>'}
    </div>
  `).join('');
}

router.get('/admin/groups', requireAdmin, (req, res) => {
  const groups = getAllGroups();
  const rows = groups.map((group) => {
    const userCount = getDb().prepare('SELECT COUNT(*) AS count FROM user_groups WHERE group_id = ?').get(group.id).count;
    return `
      <tr>
        <td><a href="/admin/groups/${group.id}">${escapeHtml(group.name)}</a></td>
        <td>${groupPoolsSummary(group.pools)}</td>
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
      <table><thead><tr><th>Name</th><th>Pools</th><th>Calls day/hour</th><th>Tokens day/hour</th><th>Users</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">No groups.</td></tr>'}</tbody></table>
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
      INSERT INTO groups (name, daily_call_limit, daily_token_limit, hourly_call_limit, hourly_token_limit)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      form.name,
      form.dailyCallLimit,
      form.dailyTokenLimit,
      form.hourlyCallLimit,
      form.hourlyTokenLimit
    );
  setGroupPools(result.lastInsertRowid, form.poolIds);
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
      <td class="actions">
        <form method="post" action="/admin/groups/${group.id}/members/${user.id}/remove" onsubmit="return confirm(${escapeHtml(JSON.stringify(`Remove ${user.name} from ${group.name}? They will lose API access until they are assigned to another group.`))});">
          <button type="submit" class="danger-outline small">Remove</button>
        </form>
      </td>
    </tr>
  `).join('');
  const message = req.query.saved ? flash('Group saved.')
    : req.query.removed ? flash('User removed from the group.')
      : req.query.not_member ? flash('That user is no longer in this group. Nothing was changed.', 'error')
        : '';
  render(req, res, 'user-detail', {
    title: 'Edit Group',
    flash: message,
    content: `
      ${groupForm(group, `/admin/groups/${group.id}`)}
      <h2>Users</h2>
      <table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Actions</th></tr></thead><tbody>${userRows || '<tr><td colspan="4" class="muted">No users in this group.</td></tr>'}</tbody></table>
    `
  });
});

// Removes one student from this group only. The delete is scoped to the group, so a stale
// page or a repeated click cannot remove a student who has since been moved elsewhere.
router.post('/admin/groups/:id/members/:userId/remove', requireAdmin, (req, res) => {
  const group = getDb().prepare('SELECT id FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).send('Group not found');
  const result = getDb().prepare('DELETE FROM user_groups WHERE group_id = ? AND user_id = ?')
    .run(group.id, req.params.userId);
  res.redirect(`/admin/groups/${group.id}?${result.changes ? 'removed' : 'not_member'}=1`);
});

router.post('/admin/groups/:id', requireAdmin, (req, res) => {
  const group = getDb().prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).send('Group not found');
  const form = parseGroupForm(req.body);
  getDb().prepare(`
    UPDATE groups
    SET name = ?, daily_call_limit = ?, daily_token_limit = ?,
        hourly_call_limit = ?, hourly_token_limit = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    form.name,
    form.dailyCallLimit,
    form.dailyTokenLimit,
    form.hourlyCallLimit,
    form.hourlyTokenLimit,
    group.id
  );
  setGroupPools(group.id, form.poolIds);
  res.redirect(`/admin/groups/${group.id}?saved=1`);
});

module.exports = router;
