const { getDb } = require('../db');

function providerPoolForGroup(groupId) {
  if (!groupId) return [];
  return getDb().prepare(`
    SELECT providers.id, providers.slug, providers.name, group_providers.priority, group_providers.weight
    FROM group_providers
    JOIN providers ON providers.id = group_providers.provider_id
    WHERE group_providers.group_id = ?
      AND group_providers.enabled = 1
    ORDER BY group_providers.priority DESC, providers.priority DESC, providers.name ASC
  `).all(groupId);
}

function attachProviderPool(group) {
  if (!group) return null;
  const providers = providerPoolForGroup(group.id);
  const fallbackProvider = group.provider_slug
    ? [{ id: group.provider_id, slug: group.provider_slug, name: group.provider_name }]
    : [];
  const pool = providers.length ? providers : fallbackProvider;
  return {
    ...group,
    providers: pool,
    provider_slugs: pool.map((provider) => provider.slug).filter(Boolean),
    provider_names: pool.map((provider) => provider.name || provider.slug).filter(Boolean).join(', '),
    provider_slug: pool[0]?.slug || group.provider_slug || null,
    provider_name: pool[0]?.name || group.provider_name || null
  };
}

function getAllGroups() {
  return getDb().prepare(`
    SELECT groups.*, providers.slug AS provider_slug, providers.name AS provider_name
    FROM groups
    LEFT JOIN providers ON providers.id = groups.provider_id
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
    SELECT groups.*, providers.slug AS provider_slug, providers.name AS provider_name
    FROM groups
    JOIN user_groups ON user_groups.group_id = groups.id
    LEFT JOIN providers ON providers.id = groups.provider_id
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

function getAllowedProviderSlugsForUser(userId) {
  const group = getUserGroup(userId);
  return group?.provider_slugs || [];
}

function setGroupProviders(groupId, providerIds) {
  const ids = [...new Set(providerIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const db = getDb();
  const validIds = ids.length
    ? db.prepare(`SELECT id FROM providers WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((row) => row.id)
    : [];
  const primaryProviderId = validIds[0] || null;

  const tx = db.transaction(() => {
    db.prepare('UPDATE groups SET provider_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(primaryProviderId, groupId);
    db.prepare('DELETE FROM group_providers WHERE group_id = ?').run(groupId);
    const insert = db.prepare(`
      INSERT INTO group_providers (group_id, provider_id, enabled, priority, updated_at)
      VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP)
    `);
    validIds.forEach((providerId, index) => insert.run(groupId, providerId, 100 - index));
  });
  tx();
}

module.exports = {
  attachProviderPool,
  getAllGroups,
  getAllowedProviderSlugsForUser,
  getUserGroup,
  getUserGroups,
  providerPoolForGroup,
  setGroupProviders,
  setUserGroups
};
