const { apiError } = require('../utils/errors');
const { getSetting } = require('../services/settingsService');

const buckets = new Map();
const oauthBuckets = new Map();
const loginFailures = new Map();

const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_LOGIN_FAILURES_PER_ACCOUNT_AND_ADDRESS = 10;
const MAX_LOGIN_FAILURES_PER_ADDRESS = 100;

// Buckets are keyed by user id or client address. Expired ones are swept so a stream of
// distinct addresses cannot grow these maps without bound.
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const map of [buckets, oauthBuckets, loginFailures]) {
    for (const [key, bucket] of map) {
      if (now > bucket.resetAt) map.delete(key);
    }
  }
}, 60_000);
sweepTimer.unref?.();

function hit(map, key, windowMs) {
  const now = Date.now();
  let bucket = map.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    map.set(key, bucket);
  }
  bucket.count += 1;
  return bucket;
}

function countIn(map, key) {
  const bucket = map.get(key);
  return bucket && Date.now() <= bucket.resetAt ? bucket.count : 0;
}

function studentRateLimit(req, res, next) {
  try {
    const user = req.student;
    if (!user) return next();
    const max = Number(getSetting('max_requests_per_minute', 1000));
    const bucket = hit(buckets, String(user.id), 60_000);

    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.set('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      throw apiError(429, 'rate_limit_exceeded', 'Rate limit exceeded.');
    }

    next();
  } catch (error) {
    next(error);
  }
}

function oauthRateLimit(req, res, next) {
  try {
    const bucket = hit(oauthBuckets, `oauth:${req.ip}`, 10 * 60_000);
    if (bucket.count > 20) throw apiError(429, 'oauth_rate_limit_exceeded', 'Too many sign-in attempts. Try again later.');
    next();
  } catch (error) {
    next(error);
  }
}

function loginKeys(ip, login) {
  return { address: `ip:${ip}`, account: `account:${ip}:${String(login || '').trim().toLowerCase()}` };
}

// Covers admin and student password logins alike.
function isLoginAllowed(ip, login) {
  const { address, account } = loginKeys(ip, login);
  return countIn(loginFailures, address) < MAX_LOGIN_FAILURES_PER_ADDRESS &&
    countIn(loginFailures, account) < MAX_LOGIN_FAILURES_PER_ACCOUNT_AND_ADDRESS;
}

function recordLoginFailure(ip, login) {
  const { address, account } = loginKeys(ip, login);
  hit(loginFailures, address, LOGIN_WINDOW_MS);
  hit(loginFailures, account, LOGIN_WINDOW_MS);
}

function clearLoginFailures(ip, login) {
  loginFailures.delete(loginKeys(ip, login).account);
}

module.exports = { clearLoginFailures, isLoginAllowed, oauthRateLimit, recordLoginFailure, studentRateLimit };
