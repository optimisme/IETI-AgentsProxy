const { getDb } = require('../db');
const { apiError } = require('../utils/errors');

// A pool is a set of load-balanced providers published to students under one model alias.
// Groups are given pools; a provider may belong to several pools.

function validatePoolAlias(value) {
  const alias = String(value || '').trim();
  if (!alias) throw apiError(400, 'invalid_form', 'OpenCode model alias is required.');
  if (alias.length > 255) throw apiError(400, 'invalid_form', 'OpenCode model alias is too long.');
  if (/\s/.test(alias)) throw apiError(400, 'invalid_form', 'OpenCode model alias cannot contain whitespace.');
  return alias;
}

function positiveIds(values) {
  const list = Array.isArray(values) ? values : values === undefined || values === null || values === '' ? [] : [values];
  return [...new Set(list.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

// Keeps only the ids that exist in the table, so a stale form cannot reference deleted rows.
function existingIds(db, table, ids) {
  if (!ids.length) return [];
  const found = new Set(db.prepare(`SELECT id FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((row) => row.id));
  return ids.filter((id) => found.has(id));
}

function providersByPool(db, poolIds) {
  const byPool = new Map(poolIds.map((id) => [id, []]));
  if (!poolIds.length) return byPool;
  const rows = db.prepare(`
    SELECT pool_providers.pool_id, providers.id, providers.slug, providers.name, providers.enabled
    FROM pool_providers
    JOIN providers ON providers.id = pool_providers.provider_id
    WHERE pool_providers.pool_id IN (${poolIds.map(() => '?').join(',')})
    ORDER BY providers.priority DESC, providers.name ASC, providers.id ASC
  `).all(...poolIds);
  for (const { pool_id: poolId, ...provider } of rows) byPool.get(poolId).push(provider);
  return byPool;
}

function withProviders(db, pools) {
  const members = providersByPool(db, pools.map((pool) => pool.id));
  return pools.map((pool) => ({ ...pool, providers: members.get(pool.id) }));
}

function listPools() {
  const db = getDb();
  const pools = db.prepare(`
    SELECT pools.*, (SELECT COUNT(*) FROM group_pools WHERE group_pools.pool_id = pools.id) AS group_count
    FROM pools
    ORDER BY pools.alias ASC
  `).all();
  return withProviders(db, pools);
}

function getPool(id) {
  const db = getDb();
  const pool = db.prepare('SELECT * FROM pools WHERE id = ?').get(Number(id) || 0);
  return pool ? withProviders(db, [pool])[0] : null;
}

function findPoolByAlias(alias, { exceptId = null } = {}) {
  return getDb().prepare('SELECT id, alias FROM pools WHERE alias = ? AND id IS NOT ?')
    .get(alias, exceptId === null ? null : Number(exceptId)) || null;
}

function poolsForGroup(groupId) {
  if (!groupId) return [];
  const db = getDb();
  const pools = db.prepare(`
    SELECT pools.id, pools.alias
    FROM group_pools
    JOIN pools ON pools.id = group_pools.pool_id
    WHERE group_pools.group_id = ?
    ORDER BY pools.alias ASC
  `).all(groupId);
  return withProviders(db, pools);
}

function poolsForProvider(providerId) {
  return getDb().prepare(`
    SELECT pools.id, pools.alias
    FROM pool_providers
    JOIN pools ON pools.id = pool_providers.pool_id
    WHERE pool_providers.provider_id = ?
    ORDER BY pools.alias ASC
  `).all(providerId);
}

function groupsForPool(poolId) {
  return getDb().prepare(`
    SELECT groups.id, groups.name
    FROM group_pools
    JOIN groups ON groups.id = group_pools.group_id
    WHERE group_pools.pool_id = ?
    ORDER BY groups.name ASC
  `).all(poolId);
}

function replacePoolProviders(db, poolId, providerIds) {
  db.prepare('DELETE FROM pool_providers WHERE pool_id = ?').run(poolId);
  const insert = db.prepare('INSERT INTO pool_providers (pool_id, provider_id) VALUES (?, ?)');
  for (const providerId of existingIds(db, 'providers', positiveIds(providerIds))) insert.run(poolId, providerId);
}

function createPool({ alias, providerIds = [] }) {
  const db = getDb();
  return db.transaction(() => {
    const poolId = db.prepare('INSERT INTO pools (alias) VALUES (?)').run(validatePoolAlias(alias)).lastInsertRowid;
    replacePoolProviders(db, poolId, providerIds);
    return Number(poolId);
  })();
}

function updatePool(id, { alias, providerIds = [] }) {
  const db = getDb();
  return db.transaction(() => {
    const result = db.prepare('UPDATE pools SET alias = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(validatePoolAlias(alias), id);
    if (!result.changes) return false;
    replacePoolProviders(db, id, providerIds);
    return true;
  })();
}

function deletePool(id) {
  return getDb().prepare('DELETE FROM pools WHERE id = ?').run(id).changes > 0;
}

function setGroupPools(groupId, poolIds) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM group_pools WHERE group_id = ?').run(groupId);
    const insert = db.prepare('INSERT INTO group_pools (group_id, pool_id) VALUES (?, ?)');
    for (const poolId of existingIds(db, 'pools', positiveIds(poolIds))) insert.run(groupId, poolId);
  })();
}

module.exports = {
  createPool,
  deletePool,
  findPoolByAlias,
  getPool,
  groupsForPool,
  listPools,
  poolsForGroup,
  poolsForProvider,
  positiveIds,
  setGroupPools,
  updatePool,
  validatePoolAlias
};
