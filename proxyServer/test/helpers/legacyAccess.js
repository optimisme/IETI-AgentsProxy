// Most suites describe model access the way installations before pools did: an alias on
// each provider's model mapping (provider_models.public_model) and the providers of a
// group in group_providers or groups.provider_id. The proxy now reads pools instead.
//
// publishLegacyAccess mirrors that description into pools with the same conversion an
// upgraded database gets on its first start. It replaces the pools it made on its previous
// run, so changes to the old tables are picked up, and leaves pools made through the admin
// pages alone. withLegacyAccess wraps an app so this happens before each request.
const mirrored = new WeakMap();

function publishLegacyAccess(db) {
  const { convertLegacyAccessToPools } = require('../../src/db');
  db.transaction(() => {
    const remove = db.prepare('DELETE FROM pools WHERE id = ?');
    for (const id of mirrored.get(db) || []) remove.run(id);
    const before = new Set(db.prepare('SELECT id FROM pools').all().map((row) => row.id));
    convertLegacyAccessToPools(db);
    mirrored.set(db, db.prepare('SELECT id FROM pools').all().map((row) => row.id).filter((id) => !before.has(id)));
  })();
}

function withLegacyAccess(app, getDb) {
  const wrapped = (req, res) => {
    publishLegacyAccess(getDb());
    return app(req, res);
  };
  return Object.assign(wrapped, { unwrapped: app });
}

module.exports = { publishLegacyAccess, withLegacyAccess };
