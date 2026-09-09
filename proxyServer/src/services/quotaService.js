const config = require('../config');
const { apiError } = require('../utils/errors');
const { getUsageTotals } = require('./usageService');
const { getUserGroup } = require('./accessService');
const { getPublicModelAliasesForProviderSlugs } = require('./providerService');

function checkQuota({ user, model }) {
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
  if (group.daily_call_limit !== null && totals.todayCalls + 1 > group.daily_call_limit) {
    throw apiError(429, 'daily_call_quota_exceeded', 'Daily call limit exceeded.');
  }
  if (group.hourly_call_limit !== null && totals.hourCalls + 1 > group.hourly_call_limit) {
    throw apiError(429, 'hourly_call_quota_exceeded', 'Hourly call limit exceeded.');
  }
  if (group.daily_token_limit !== null && totals.todayTokens >= group.daily_token_limit) {
    throw apiError(429, 'daily_quota_exceeded', 'Daily token limit exceeded.');
  }
  if (group.hourly_token_limit !== null && totals.hourTokens >= group.hourly_token_limit) {
    throw apiError(429, 'hourly_quota_exceeded', 'Hourly token limit exceeded.');
  }

  return { totals, group };
}

module.exports = { checkQuota };
