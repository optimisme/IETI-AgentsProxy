// Admin pages for groups: quotas, the pools a group can use, and its members.
const express = require('express');
const { getDb } = require('../../db');
const { requireAdmin } = require('../../middleware/authAdmin');
const { getAllGroups, setGroupPools } = require('../../services/accessService');
const { listPools, positiveIds } = require('../../services/poolService');
const { flash } = require('../../utils/html');
const { nonNegativeIntegerOrNull, requiredText } = require('../../utils/validation');
const { render, formConflict, formRoute } = require('./shared');
const { groupsPage, groupForm, groupPage, groupNameTakenNotice } = require('../../views/admin/groups');

const router = express.Router();

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

router.get('/admin/groups', requireAdmin, (req, res) => {
  const countUsers = getDb().prepare('SELECT COUNT(*) AS count FROM user_groups WHERE group_id = ?');
  const groups = getAllGroups().map((group) => ({ ...group, userCount: countUsers.get(group.id).count }));
  render(req, res, 'users', {
    title: 'Groups',
    content: groupsPage({ groups }),
    flash: flash(req.query.saved ? 'Group saved.' : '')
  });
});

// The group form's fields as submitted, valid or not, laid over the stored group if any.
function groupFromBody(body, stored = {}) {
  return {
    ...stored,
    name: body.name ?? '',
    pool_ids: positiveIds(body.pool_ids),
    daily_call_limit: body.daily_call_limit ?? '',
    daily_token_limit: body.daily_token_limit ?? '',
    hourly_call_limit: body.hourly_call_limit ?? '',
    hourly_token_limit: body.hourly_token_limit ?? ''
  };
}

// Group names are unique; saying so beats the database refusing the write.
function refuseTakenName(name, exceptId = null) {
  const owner = getDb().prepare('SELECT id FROM groups WHERE name = ? AND id IS NOT ?').get(name, exceptId);
  if (owner) throw formConflict('group_name_taken', `The name ${name} is already used by another group.`, groupNameTakenNotice(name, owner));
}

function showNewGroup(req, res, { values = null, notice = '', status = 200 } = {}) {
  res.status(status);
  render(req, res, 'user-detail', {
    title: 'New Group',
    content: groupForm(values ? groupFromBody(values) : {}, '/admin/groups', listPools()),
    flash: notice
  });
}

router.get('/admin/groups/new', requireAdmin, (req, res) => {
  showNewGroup(req, res);
});

router.post('/admin/groups', requireAdmin, formRoute(showNewGroup, (req, res) => {
  const form = parseGroupForm(req.body);
  refuseTakenName(form.name);
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
}));

function showGroup(req, res, { values = null, notice = '', status = 200 } = {}) {
  const group = getAllGroups().find((candidate) => Number(candidate.id) === Number(req.params.id));
  if (!group) return res.status(404).send('Group not found');
  const pools = listPools();
  const users = getDb().prepare(`
    SELECT users.id, users.name, users.email, users.enabled
    FROM users
    JOIN user_groups ON user_groups.user_id = users.id
    WHERE user_groups.group_id = ?
    ORDER BY users.name ASC
  `).all(group.id);
  const message = req.query.saved ? flash('Group saved.')
    : req.query.removed ? flash('User removed from the group.')
      : req.query.not_member ? flash('That user is no longer in this group. Nothing was changed.', 'error')
        : '';
  res.status(status);
  render(req, res, 'user-detail', {
    title: 'Edit Group',
    flash: notice || message,
    content: groupPage({ formGroup: values ? groupFromBody(values, group) : group, group, pools, users })
  });
}

router.get('/admin/groups/:id', requireAdmin, (req, res) => {
  showGroup(req, res);
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

router.post('/admin/groups/:id', requireAdmin, formRoute(showGroup, (req, res) => {
  const group = getDb().prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).send('Group not found');
  const form = parseGroupForm(req.body);
  refuseTakenName(form.name, group.id);
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
}));

module.exports = router;
