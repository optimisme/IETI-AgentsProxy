const express = require('express');
const config = require('../config');
const { authStudent } = require('../middleware/authStudent');
const { getUsageTotals } = require('../services/usageService');
const { getUserGroup } = require('../services/accessService');

const router = express.Router();

router.get('/me', authStudent, (req, res) => {
  const user = req.student;
  const usage = getUsageTotals(user.id);
  const group = getUserGroup(user.id);
  res.json({
    name: user.name,
    email: user.email,
    enabled: Boolean(user.enabled),
    group: group ? {
      name: group.name,
      provider: group.provider_slug || null,
      providers: group.provider_slugs || []
    } : null,
    limits: {
      dailyCallLimit: group?.daily_call_limit ?? null,
      dailyTokenLimit: group?.daily_token_limit ?? null,
      hourlyCallLimit: group?.hourly_call_limit ?? null,
      hourlyTokenLimit: group?.hourly_token_limit ?? null
    },
    usageToday: {
      calls: usage.todayCalls,
      tokens: usage.todayTokens
    },
    usageThisHour: {
      calls: usage.hourCalls,
      tokens: usage.hourTokens
    },
    allowedModels: group?.provider_slugs?.length ? [config.publicModelName] : []
  });
});

module.exports = router;
