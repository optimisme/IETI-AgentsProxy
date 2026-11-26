// Test fixtures for model access, written the way the admin pages store it: a pool holds an
// alias and its providers, and a group is given pools.

// Adds providers to the pool with this alias, creating the pool if needed. Returns its id.
function publish(db, alias, providerIds = []) {
  db.prepare('INSERT OR IGNORE INTO pools (alias) VALUES (?)').run(alias);
  const poolId = Number(db.prepare('SELECT id FROM pools WHERE alias = ?').get(alias).id);
  const add = db.prepare('INSERT OR IGNORE INTO pool_providers (pool_id, provider_id) VALUES (?, ?)');
  for (const providerId of [].concat(providerIds)) add.run(poolId, Number(providerId));
  return poolId;
}

// Gives a group the pools with these aliases.
function grant(db, groupId, aliases) {
  const add = db.prepare('INSERT OR IGNORE INTO group_pools (group_id, pool_id) SELECT ?, id FROM pools WHERE alias = ?');
  for (const alias of [].concat(aliases)) add.run(Number(groupId), alias);
}

// Gives a group every pool the provider is in: "this group uses that provider".
function grantProviderPools(db, groupId, providerId) {
  db.prepare('INSERT OR IGNORE INTO group_pools (group_id, pool_id) SELECT ?, pool_id FROM pool_providers WHERE provider_id = ?')
    .run(Number(groupId), Number(providerId));
}

module.exports = { grant, grantProviderPools, publish };
