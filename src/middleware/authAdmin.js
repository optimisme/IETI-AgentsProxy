const bcrypt = require('bcryptjs');
const config = require('../config');

function requireAdmin(req, res, next) {
  if (req.session?.adminAuthenticated) return next();
  if (req.path.endsWith('.json') || req.accepts(['json', 'html']) === 'json') {
    return res.status(401).json({
      error: {
        message: 'Admin login required.',
        type: 'admin_auth_required',
        code: 'admin_auth_required'
      }
    });
  }
  return res.redirect('/?admin=1');
}

function verifyAdminCredentials(username, password) {
  if (username !== config.adminUsername) return false;
  if (config.adminPasswordHash) return bcrypt.compareSync(password || '', config.adminPasswordHash);
  return password === config.adminPassword;
}

module.exports = { requireAdmin, verifyAdminCredentials };
