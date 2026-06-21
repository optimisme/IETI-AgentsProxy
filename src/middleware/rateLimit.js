const { apiError } = require('../utils/errors');
const { getSetting } = require('../services/settingsService');

const buckets = new Map();

function studentRateLimit(req, res, next) {
  try {
    const user = req.student;
    if (!user) return next();
    const max = Number(getSetting('max_requests_per_minute', 1000));
    const now = Date.now();
    const key = String(user.id);
    const bucket = buckets.get(key) || { count: 0, resetAt: now + 60_000 };

    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + 60_000;
    }

    bucket.count += 1;
    buckets.set(key, bucket);

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

module.exports = { studentRateLimit };
