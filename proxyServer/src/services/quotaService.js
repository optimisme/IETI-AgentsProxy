const config = require('../config');
const { apiError } = require('../utils/errors');
const { getUsageTotals } = require('./usageService');
const { getUserGroup } = require('./accessService');
const { getPublicModelAliasesForProviderSlugs } = require('./providerService');
const { getSetting } = require('./settingsService');

// Requests in flight are not in usage_logs until they finish, so their calls and token
// budget are reserved here. Without this, parallel requests all pass the same check.
const reservationsByUser = new Map();

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function reserve(userId, tokens) {
  const current = reservationsByUser.get(userId) || { requests: 0, tokens: 0 };
  reservationsByUser.set(userId, { requests: current.requests + 1, tokens: current.tokens + tokens });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = reservationsByUser.get(userId);
    if (!entry) return;
    if (entry.requests <= 1) reservationsByUser.delete(userId);
    else reservationsByUser.set(userId, { requests: entry.requests - 1, tokens: Math.max(0, entry.tokens - tokens) });
  };
}

// Returns the group, the max_tokens value to send upstream (the requested value, or the
// per-request maximum, lowered to fit the remaining token quota) and a release callback
// that must be called once the request has finished and its usage has been recorded.
function checkQuota({ user, model, estimatedInputTokens = 0, requestedMaxTokens = 0 }) {
  const group = getUserGroup(user.id);
  if (!group) {
    throw apiError(403, 'group_required', 'This user is not assigned to a group.');
  }
  if (!group.provider_slug) {
    throw apiError(403, 'provider_required', 'This user group has no assigned provider.');
  }
  const allowedModels = getPublicModelAliasesForProviderSlugs(group.provider_slugs);
  if (!allowedModels.includes(model)) {
    const hint = allowedModels.length ? allowedModels.join(', ') : config.publicModelName;
    throw apiError(403, 'model_not_allowed', `Use ${hint} for this user.`);
  }

  const totals = getUsageTotals(user.id);
  const reserved = reservationsByUser.get(user.id) || { requests: 0, tokens: 0 };
  // Not seeded into the settings table, so existing databases are unchanged until an admin saves it.
  const maxConcurrent = positiveNumber(getSetting('max_concurrent_requests_per_user', null)) || positiveNumber(config.maxConcurrentRequestsPerUser);
  if (maxConcurrent && reserved.requests >= maxConcurrent) {
    throw apiError(429, 'concurrent_request_limit_exceeded', `Only ${maxConcurrent} requests per user can run at the same time.`);
  }
  if (group.daily_call_limit !== null && totals.todayCalls + reserved.requests + 1 > group.daily_call_limit) {
    throw apiError(429, 'daily_call_quota_exceeded', 'Daily call limit exceeded.');
  }
  if (group.hourly_call_limit !== null && totals.hourCalls + reserved.requests + 1 > group.hourly_call_limit) {
    throw apiError(429, 'hourly_call_quota_exceeded', 'Hourly call limit exceeded.');
  }

  const inputTokens = Math.max(0, Number(estimatedInputTokens) || 0);
  let maxTokens = positiveNumber(requestedMaxTokens) || positiveNumber(getSetting('max_tokens_per_request', config.maxTokensPerRequest));
  for (const [limit, used, code, message] of [
    [group.daily_token_limit, totals.todayTokens, 'daily_quota_exceeded', 'Daily token limit exceeded.'],
    [group.hourly_token_limit, totals.hourTokens, 'hourly_quota_exceeded', 'Hourly token limit exceeded.']
  ]) {
    if (limit === null || limit === undefined) continue;
    const remainingForOutput = Number(limit) - used - reserved.tokens - inputTokens;
    if (remainingForOutput <= 0) throw apiError(429, code, message);
    maxTokens = maxTokens ? Math.min(maxTokens, remainingForOutput) : remainingForOutput;
  }

  const release = reserve(user.id, inputTokens + (maxTokens || 0));
  return { totals, group, maxTokens, release };
}

module.exports = { checkQuota };
