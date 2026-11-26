// Admin dashboard and its script assets.
const express = require('express');
const path = require('node:path');
const { getDb } = require('../../db');
const { requireAdmin } = require('../../middleware/authAdmin');
const { dashboardSummary, getUsageCleanupStatus } = require('../../services/usageService');
const { render } = require('./shared');
const { dashboardPage } = require('../../views/admin/dashboard');

const router = express.Router();

router.get('/admin/assets/provider-autoconfigure.js', requireAdmin, (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '../../../assets/provider-autoconfigure.js'));
});

router.get('/admin/assets/dashboard-usage.js', requireAdmin, (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '../../../assets/dashboard-usage.js'));
});

router.get('/admin', requireAdmin, (req, res) => {
  const summary = dashboardSummary();
  const cleanupStatus = getUsageCleanupStatus();
  const pendingUsers = getDb().prepare("SELECT COUNT(*) AS count FROM users WHERE registration_status = 'pending'").get().count;
  render(req, res, 'dashboard', { title: 'Dashboard', content: dashboardPage({ cleanupStatus, pendingUsers, summary }) });
});

module.exports = router;
