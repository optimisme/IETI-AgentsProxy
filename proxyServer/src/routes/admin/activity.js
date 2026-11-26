// Admin page listing the changes made from the admin pages.
const express = require('express');
const { requireAdmin } = require('../../middleware/authAdmin');
const { countAdminChanges, listAdminChanges } = require('../../services/adminAuditService');
const { render } = require('./shared');
const { activityPage } = require('../../views/admin/activity');

const router = express.Router();

router.get('/admin/activity', requireAdmin, (req, res) => {
  const pageSize = 50;
  const total = countAdminChanges();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1), totalPages);
  const entries = listAdminChanges({ limit: pageSize, offset: (page - 1) * pageSize });
  render(req, res, 'settings', {
    title: 'Activity',
    content: activityPage({ entries, page, total, totalPages })
  });
});

module.exports = router;
