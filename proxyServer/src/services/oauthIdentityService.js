const config = require('../config');
const { getDb } = require('../db');

const CONFLICT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function auditAuthEvent(db, { event, userId = null, email = null, actor = 'system', details = null }) {
  db.prepare(`
    INSERT INTO auth_audit_logs (event, user_id, email, actor, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(event, userId, email, actor, details ? JSON.stringify(details) : null);
}

function invalidateInvite(db, userId) {
  db.prepare(`
    UPDATE users
    SET invite_used_at = CASE WHEN invite_token_nonce IS NOT NULL OR invite_token_hash IS NOT NULL THEN CURRENT_TIMESTAMP ELSE invite_used_at END,
        invite_token_hash = NULL, invite_token_nonce = NULL, invite_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(userId);
}

function createOrRefreshConflict(db, user, currentIdentity, profile) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CONFLICT_LIFETIME_MS).toISOString();
  const existing = db.prepare(`
    SELECT * FROM oauth_identity_conflicts
    WHERE provider = ? AND proposed_subject = ?
  `).get(profile.provider, profile.subject);
  if (existing && existing.status !== 'pending') return existing;
  if (existing) {
    db.prepare(`
      UPDATE oauth_identity_conflicts
      SET user_id = ?, verified_email = ?, display_name = ?, hosted_domain = ?,
          requested_at = ?, expires_at = ?
      WHERE id = ?
    `).run(user.id, profile.email, profile.displayName, profile.hostedDomain, now, expiresAt, existing.id);
    return db.prepare('SELECT * FROM oauth_identity_conflicts WHERE id = ?').get(existing.id);
  }
  const result = db.prepare(`
    INSERT INTO oauth_identity_conflicts
      (user_id, provider, proposed_subject, verified_email, display_name, hosted_domain, requested_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user.id, profile.provider, profile.subject, profile.email, profile.displayName, profile.hostedDomain, now, expiresAt);
  auditAuthEvent(db, {
    event: 'oauth_identity_conflict_created',
    userId: user.id,
    email: profile.email,
    actor: 'google_oauth',
    details: { provider: profile.provider, currentSubject: currentIdentity.subject, proposedSubject: profile.subject }
  });
  return db.prepare('SELECT * FROM oauth_identity_conflicts WHERE id = ?').get(result.lastInsertRowid);
}

function resolveGoogleSignIn(profile) {
  const db = getDb();
  return db.transaction(() => {
    const linked = db.prepare(`
      SELECT users.*, user_identities.last_email AS identity_last_email
      FROM user_identities
      JOIN users ON users.id = user_identities.user_id
      WHERE user_identities.provider = ? AND user_identities.subject = ?
    `).get(profile.provider, profile.subject);
    if (linked) {
      db.prepare(`
        UPDATE user_identities
        SET last_email = ?, hosted_domain = ?, last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE provider = ? AND subject = ?
      `).run(profile.email, profile.hostedDomain, profile.provider, profile.subject);
      if (!linked.enabled || linked.registration_status === 'rejected') {
        return { kind: 'denied' };
      }
      return { kind: 'login', user: linked };
    }

    const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(profile.email);
    if (user) {
      if (!user.enabled || user.registration_status === 'rejected') return { kind: 'denied' };
      const currentIdentity = db.prepare(`
        SELECT * FROM user_identities WHERE user_id = ? AND provider = ?
      `).get(user.id, profile.provider);
      if (currentIdentity) {
        const conflict = createOrRefreshConflict(db, user, currentIdentity, profile);
        return { kind: conflict.status === 'pending' ? 'conflict' : 'denied', conflict };
      }
      db.prepare(`
        INSERT INTO user_identities
          (provider, subject, user_id, email_at_link, last_email, hosted_domain, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(profile.provider, profile.subject, user.id, profile.email, profile.email, profile.hostedDomain);
      invalidateInvite(db, user.id);
      auditAuthEvent(db, {
        event: 'oauth_identity_linked',
        userId: user.id,
        email: profile.email,
        actor: 'google_oauth',
        details: { provider: profile.provider, subject: profile.subject }
      });
      return { kind: 'login', user: db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) };
    }

    if (!config.googleOAuthAutoRegister) return { kind: 'denied' };
    const created = db.prepare(`
      INSERT INTO users (name, email, enabled, role, registration_status)
      VALUES (?, ?, 1, 'student', 'pending')
    `).run(profile.displayName, profile.email);
    const userId = created.lastInsertRowid;
    db.prepare(`
      INSERT INTO user_identities
        (provider, subject, user_id, email_at_link, last_email, hosted_domain, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(profile.provider, profile.subject, userId, profile.email, profile.email, profile.hostedDomain);
    auditAuthEvent(db, {
      event: 'oauth_user_registered_pending',
      userId,
      email: profile.email,
      actor: 'google_oauth',
      details: { provider: profile.provider, subject: profile.subject, hostedDomain: profile.hostedDomain }
    });
    return { kind: 'login', user: db.prepare('SELECT * FROM users WHERE id = ?').get(userId) };
  })();
}

function listIdentityConflicts() {
  return getDb().prepare(`
    SELECT oauth_identity_conflicts.*, users.name AS user_name, users.email AS user_email,
           user_identities.subject AS current_subject
    FROM oauth_identity_conflicts
    LEFT JOIN users ON users.id = oauth_identity_conflicts.user_id
    LEFT JOIN user_identities
      ON user_identities.user_id = users.id AND user_identities.provider = oauth_identity_conflicts.provider
    ORDER BY CASE oauth_identity_conflicts.status WHEN 'pending' THEN 0 ELSE 1 END,
             oauth_identity_conflicts.requested_at DESC
  `).all();
}

function pendingConflict(db, conflictId) {
  const conflict = db.prepare('SELECT * FROM oauth_identity_conflicts WHERE id = ?').get(conflictId);
  if (!conflict || conflict.status !== 'pending') return null;
  if (new Date(conflict.expires_at).getTime() <= Date.now()) return null;
  return conflict;
}

function preserveIdentityConflict(conflictId, adminUsername) {
  const db = getDb();
  return db.transaction(() => {
    const conflict = pendingConflict(db, conflictId);
    if (!conflict?.user_id) return null;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(conflict.user_id);
    if (!user) return null;
    const identity = db.prepare('SELECT * FROM user_identities WHERE user_id = ? AND provider = ?').get(user.id, conflict.provider);
    if (!identity) return null;
    const proposedOwner = db.prepare('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?').get(conflict.provider, conflict.proposed_subject);
    if (proposedOwner && Number(proposedOwner.user_id) !== Number(user.id)) return null;
    db.prepare(`
      UPDATE user_identities
      SET subject = ?, last_email = ?, hosted_domain = ?, updated_at = CURRENT_TIMESTAMP, last_login_at = NULL
      WHERE provider = ? AND subject = ?
    `).run(conflict.proposed_subject, conflict.verified_email, conflict.hosted_domain, conflict.provider, identity.subject);
    invalidateInvite(db, user.id);
    db.prepare('UPDATE users SET auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    db.prepare(`
      UPDATE oauth_identity_conflicts
      SET status = 'resolved', resolution = 'preserve', resolved_at = CURRENT_TIMESTAMP, resolved_by = ?
      WHERE id = ?
    `).run(adminUsername, conflict.id);
    auditAuthEvent(db, {
      event: 'oauth_identity_replaced_preserve',
      userId: user.id,
      email: user.email,
      actor: adminUsername,
      details: { previousSubject: identity.subject, replacementSubject: conflict.proposed_subject }
    });
    return { userId: user.id };
  })();
}

function resetIdentityConflict(conflictId, adminUsername) {
  const db = getDb();
  return db.transaction(() => {
    const conflict = pendingConflict(db, conflictId);
    if (!conflict?.user_id) return null;
    const oldUser = db.prepare('SELECT * FROM users WHERE id = ?').get(conflict.user_id);
    if (!oldUser) return null;
    const oldUserId = oldUser.id;
    db.prepare('DELETE FROM users WHERE id = ?').run(oldUserId);
    const created = db.prepare(`
      INSERT INTO users (name, email, enabled, role, registration_status)
      VALUES (?, ?, 1, 'student', 'pending')
    `).run(conflict.display_name, conflict.verified_email);
    const replacementUserId = created.lastInsertRowid;
    db.prepare(`
      INSERT INTO user_identities
        (provider, subject, user_id, email_at_link, last_email, hosted_domain)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(conflict.provider, conflict.proposed_subject, replacementUserId, conflict.verified_email, conflict.verified_email, conflict.hosted_domain);
    db.prepare(`
      UPDATE oauth_identity_conflicts
      SET replacement_user_id = ?, status = 'resolved', resolution = 'reset',
          resolved_at = CURRENT_TIMESTAMP, resolved_by = ?
      WHERE id = ?
    `).run(replacementUserId, adminUsername, conflict.id);
    auditAuthEvent(db, {
      event: 'oauth_identity_reset_new_user',
      userId: replacementUserId,
      email: conflict.verified_email,
      actor: adminUsername,
      details: { deletedUserId: oldUserId, replacementSubject: conflict.proposed_subject }
    });
    return { userId: replacementUserId };
  })();
}

function rejectIdentityConflict(conflictId, adminUsername) {
  const db = getDb();
  return db.transaction(() => {
    const conflict = pendingConflict(db, conflictId);
    if (!conflict) return null;
    db.prepare(`
      UPDATE oauth_identity_conflicts
      SET status = 'rejected', resolution = 'reject', resolved_at = CURRENT_TIMESTAMP, resolved_by = ?
      WHERE id = ?
    `).run(adminUsername, conflict.id);
    auditAuthEvent(db, {
      event: 'oauth_identity_conflict_rejected',
      userId: conflict.user_id,
      email: conflict.verified_email,
      actor: adminUsername,
      details: { proposedSubject: conflict.proposed_subject }
    });
    return { userId: conflict.user_id };
  })();
}

module.exports = {
  auditAuthEvent,
  invalidateInvite,
  listIdentityConflicts,
  preserveIdentityConflict,
  rejectIdentityConflict,
  resetIdentityConflict,
  resolveGoogleSignIn
};
