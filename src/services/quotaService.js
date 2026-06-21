const config = require('../config');
const { apiError } = require('../utils/errors');
const { getUsageTotals } = require('./usageService');
const { getSetting } = require('./settingsService');
const { getUserGroup } = require('./accessService');

function checkQuota({ user, model, estimatedInputTokens, requestedMaxTokens = 0 }) {
  const maxTokensPerRequest = Number(getSetting('max_tokens_per_request', 32000));
  const requestBudget = estimatedInputTokens + Number(requestedMaxTokens || 0);

  if (requestBudget > maxTokensPerRequest) {
    throw apiError(413, 'request_too_large', `Request token estimate exceeds ${maxTokensPerRequest} tokens.`);
  }

  if (model !== config.publicModelName) {
    throw apiError(403, 'model_not_allowed', `Use ${config.publicModelName} for this user.`);
  }

  const group = getUserGroup(user.id);
  if (!group) {
    throw apiError(403, 'group_required', 'This user is not assigned to a group.');
  }
  if (!group.provider_slug) {
    throw apiError(403, 'provider_required', 'This user group has no assigned provider.');
  }

  const totals = getUsageTotals(user.id);
  if (group.daily_call_limit !== null && totals.todayCalls + 1 > group.daily_call_limit) {
    throw apiError(429, 'daily_call_quota_exceeded', 'Daily call limit exceeded.');
  }
  if (group.hourly_call_limit !== null && totals.hourCalls + 1 > group.hourly_call_limit) {
    throw apiError(429, 'hourly_call_quota_exceeded', 'Hourly call limit exceeded.');
  }
  if (group.daily_token_limit !== null && totals.todayTokens + requestBudget > group.daily_token_limit) {
    throw apiError(429, 'daily_quota_exceeded', 'Daily token limit exceeded.');
  }
  if (group.hourly_token_limit !== null && totals.hourTokens + requestBudget > group.hourly_token_limit) {
    throw apiError(429, 'hourly_quota_exceeded', 'Hourly token limit exceeded.');
  }

  return { totals, group };
}

module.exports = { checkQuota };
