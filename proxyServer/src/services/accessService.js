const { getDb } = require('../db');
const { poolsForGroup, setGroupPools } = require('./poolService');

// Adds the group's pools and, derived from them, the providers that can serve its students.
function attachProviderPool(group) {
  if (!group) return null;
  const pools = poolsForGroup(group.id);
  const providers = [...new Map(pools.flatMap((pool) => pool.providers).map((provider) => [provider.id, provider])).values()];
  return {
    ...group,
    pools,
    pool_ids: pools.map((pool) => pool.id),
    pool_aliases: pools.map((pool) => pool.alias),
    providers,
    provider_slugs: providers.map((provider) => provider.slug).filter(Boolean),
    provider_names: providers.map((provider) => provider.name || provider.slug).filter(Boolean).join(', '),
    provider_slug: providers[0]?.slug || null,
    provider_name: providers[0]?.name || null
  };
}

function getAllGroups() {
  return getDb().prepare(`
    SELECT groups.*
    FROM groups
    ORDER BY groups.name ASC
  `).all().map(attachProviderPool);
}

function getUserGroups(userId) {
  return getDb().prepare(`
    SELECT groups.*
    FROM groups
    JOIN user_groups ON user_groups.group_id = groups.id
    WHERE user_groups.user_id = ?
    ORDER BY groups.name ASC
  `).all(userId).map(attachProviderPool);
}

function getUserGroup(userId) {
  const group = getDb().prepare(`
    SELECT groups.*
    FROM groups
    JOIN user_groups ON user_groups.group_id = groups.id
    WHERE user_groups.user_id = ?
    ORDER BY groups.name ASC
    LIMIT 1
  `).get(userId);
  return attachProviderPool(group);
}

function setUserGroups(userId, groupIds) {
  const db = getDb();
  const id = groupIds.map(Number).find(Number.isFinite);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(userId);
    if (id) db.prepare('INSERT OR REPLACE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(userId, id);
  });
  tx();
}

module.exports = {
  attachProviderPool,
  getAllGroups,
  getUserGroup,
  getUserGroups,
  setGroupPools,
  setUserGroups
};
