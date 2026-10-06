const { apiError } = require('../utils/errors');
const { getSetting } = require('../services/settingsService');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function allowedOrigins(req) {
  const origins = new Set([`${req.protocol}://${req.get('host')}`]);
  try {
    const configured = getSetting('public_base_url', '');
    if (configured) origins.add(new URL(configured).origin);
  } catch {
    // An invalid configured URL adds nothing; the request host still applies.
  }
  return origins;
}

// Cookie-authenticated forms are protected by checking Fetch Metadata and Origin, which
// browsers set on every cross-site request. Unlike SameSite=Lax, this also rejects requests
// from sibling subdomains of the same site. Bearer-authenticated /v1 routes need no check.
function rejectCrossSiteRequests(req, res, next) {
  if (SAFE_METHODS.has(req.method) || req.path.startsWith('/v1/')) return next();
  const fetchSite = req.get('Sec-Fetch-Site');
  const origin = req.get('Origin');
  if ((fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') || (origin && !allowedOrigins(req).has(origin))) {
    return next(apiError(403, 'csrf_invalid', 'Cross-site request blocked. Refresh the page and try again.'));
  }
  next();
}

module.exports = { rejectCrossSiteRequests };
