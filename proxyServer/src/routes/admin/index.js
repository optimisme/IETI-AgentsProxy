// Admin backoffice: sign-in, the trace of admin changes, and the routers of each area.
const express = require('express');
const config = require('../../config');
const { isAdminSession } = require('../../middleware/authAdmin');
const { auditAdminChanges } = require('../../services/adminAuditService');
const dashboardRoutes = require('./dashboard');
const usersRoutes = require('./users');
const groupsRoutes = require('./groups');
const poolsRoutes = require('./pools');
const providersRoutes = require('./providers');
const serverRoutes = require('./server');
const activityRoutes = require('./activity');

const router = express.Router();

router.use(auditAdminChanges({ isAdmin: (req) => isAdminSession(req.session), actor: () => config.adminUsername }));

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

// Each area owns its paths, so the order here does not matter.
router.use(dashboardRoutes);
router.use(usersRoutes);
router.use(groupsRoutes);
router.use(poolsRoutes);
router.use(providersRoutes);
router.use(serverRoutes);
router.use(activityRoutes);

module.exports = router;
