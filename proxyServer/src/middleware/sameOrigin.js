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

// Cookie-authenticated forms are protected by checking Fetch Metadata, which browsers set
// on every request. Unlike SameSite=Lax, this also rejects requests from sibling subdomains
// of the same site. Browsers without Fetch Metadata fall back to the Origin header. Origin is
// not used when Sec-Fetch-Site is present: form posts can carry "Origin: null" depending on
// the referrer policy, even from this site. Bearer-authenticated /v1 routes need no check.
function isSameOriginRequest(req) {
  const fetchSite = req.get('Sec-Fetch-Site');
  if (fetchSite) return fetchSite === 'same-origin' || fetchSite === 'none';
  const origin = req.get('Origin');
  return !origin || allowedOrigins(req).has(origin);
}

function rejectCrossSiteRequests(req, res, next) {
  if (SAFE_METHODS.has(req.method) || req.path.startsWith('/v1/') || isSameOriginRequest(req)) return next();
  return next(apiError(403, 'csrf_invalid', 'Cross-site request blocked. Refresh the page and try again.'));
}

module.exports = { rejectCrossSiteRequests };
