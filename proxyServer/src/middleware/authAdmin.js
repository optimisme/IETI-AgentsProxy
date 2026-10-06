const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');

// Admin sessions record a digest of the configured credentials. Changing the admin
// username or password and restarting therefore signs every existing admin session out.
function adminSessionFingerprint() {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${config.adminUsername}\n${config.adminPasswordHash || config.adminPassword}`)
    .digest('base64url');
}

function isAdminSession(session) {
  return Boolean(session?.adminAuthenticated && session.adminFingerprint === adminSessionFingerprint());
}

function startAdminSession(session) {
  session.adminAuthenticated = true;
  session.adminFingerprint = adminSessionFingerprint();
}

function requireAdmin(req, res, next) {
  if (isAdminSession(req.session)) return next();
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

function digestEqual(left, right) {
  const digest = (value) => crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(digest(left), digest(right));
}

async function verifyAdminCredentials(username, password) {
  // Evaluate both parts so the response time does not reveal whether the username matched.
  const usernameMatches = digestEqual(username, config.adminUsername);
  const passwordMatches = config.adminPasswordHash
    ? await bcrypt.compare(password || '', config.adminPasswordHash)
    : digestEqual(password, config.adminPassword);
  return usernameMatches && passwordMatches;
}

module.exports = { isAdminSession, requireAdmin, startAdminSession, verifyAdminCredentials };
