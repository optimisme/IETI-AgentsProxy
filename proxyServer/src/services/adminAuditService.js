const { getDb } = require('../db');

// A trace of what was changed from the admin pages: who, when, what and on which record.
// One row per submitted admin form, whether it succeeded or not. Responses are never stored,
// so generated API keys and invitation links do not end up here.

const ACTION_LABELS = {
  '/admin/users': 'Created user',
  '/admin/users/:id': 'Saved user',
  '/admin/users/:id/reject-registration': 'Rejected registration',
  '/admin/users/:id/invite': 'Generated invitation',
  '/admin/users/:id/regenerate-key': 'Generated API key',
  '/admin/users/:id/revoke-key': 'Revoked all API keys',
  '/admin/users/:id/revoke-key/:keyId': 'Revoked API key',
  '/admin/users/:id/delete': 'Deleted user',
  '/admin/oauth-conflicts/:id/preserve': 'Replaced sign-in identity',
  '/admin/oauth-conflicts/:id/reset': 'Reset user after identity review',
  '/admin/oauth-conflicts/:id/reject': 'Rejected identity review',
  '/admin/groups': 'Created group',
  '/admin/groups/:id': 'Saved group',
  '/admin/groups/:id/members/:userId/remove': 'Removed user from group',
  '/admin/pools': 'Created pool',
  '/admin/pools/:id': 'Saved pool',
  '/admin/pools/:id/delete': 'Deleted pool',
  '/admin/providers': 'Created provider',
  '/admin/providers/:id': 'Saved provider',
  '/admin/providers/:id/clear-key': 'Deleted provider API key',
  '/admin/providers/:id/delete': 'Deleted provider',
  '/admin/providers/:id/mapping': 'Saved provider model mapping',
  '/admin/providers/:id/autoconfigure.json': 'Applied provider autoconfiguration',
  '/admin/server': 'Saved server settings',
  '/admin/server/cleanup-usage': 'Cleaned up usage logs'
};

// The record a path such as /admin/providers/12/delete acts on, and the columns that name it.
const TARGETS = {
  users: { table: 'users', label: (row) => `${row.name} <${row.email}>` },
  groups: { table: 'groups', label: (row) => row.name },
  pools: { table: 'pools', label: (row) => row.alias },
  providers: { table: 'providers', label: (row) => `${row.name} (${row.slug})` }
};

const SECRET_FIELD = /key|password|secret|token/i;
const MAX_VALUE_LENGTH = 200;
const MAX_DETAILS_LENGTH = 4000;

// Posts that only run a check and change nothing.
function changesNothing(req) {
  if (req.path === '/admin/login' || req.path === '/admin/logout') return true;
  if (req.path.endsWith('/test') || req.path.endsWith('/test.json')) return true;
  if (req.path.endsWith('/autoconfigure.json')) return !req.body?.apply;
  return false;
}

function describeTarget(path) {
  const [, , kind, id] = path.split('/');
  const target = TARGETS[kind];
  if (!target || !/^\d+$/.test(id || '')) return { type: target ? kind : null, id: null, label: null };
  const row = getDb().prepare(`SELECT * FROM ${target.table} WHERE id = ?`).get(Number(id));
  return { type: kind, id: Number(id), label: row ? target.label(row) : null };
}

// Submitted values with secrets replaced by a marker and long values shortened.
function summarizeBody(body) {
  if (!body || typeof body !== 'object') return null;
  const summary = {};
  for (const [field, value] of Object.entries(body)) {
    if (SECRET_FIELD.test(field)) {
      if (String(value ?? '') !== '') summary[field] = '[provided]';
      continue;
    }
    const shorten = (item) => {
      const text = String(item ?? '');
      return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;
    };
    summary[field] = Array.isArray(value) ? value.map(shorten) : shorten(value);
  }
  if (!Object.keys(summary).length) return null;
  const text = JSON.stringify(summary);
  return text.length > MAX_DETAILS_LENGTH ? JSON.stringify({ truncated: `${text.slice(0, MAX_DETAILS_LENGTH)}…` }) : text;
}

function recordAdminChange({ actor, route, path, status, target, details }) {
  getDb().prepare(`
    INSERT INTO admin_audit_logs (actor, action, path, status, target_type, target_id, target_label, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(actor, route || path, path, status, target.type, target.id, target.label, details);
}

function listAdminChanges({ limit = 50, offset = 0 } = {}) {
  return getDb().prepare(`
    SELECT * FROM admin_audit_logs ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function countAdminChanges() {
  return getDb().prepare('SELECT COUNT(*) AS count FROM admin_audit_logs').get().count;
}

function actionLabel(action) {
  return ACTION_LABELS[action] || action;
}

// Express middleware for the admin router: records every form an authenticated admin submits.
function auditAdminChanges({ isAdmin, actor }) {
  return (req, res, next) => {
    if (req.method !== 'POST' || !req.path.startsWith('/admin') || !isAdmin(req)) return next();
    // Looked up before the handler runs, so a deleted record still gets its name in the trace.
    const before = describeTarget(req.path);
    res.on('finish', () => {
      try {
        // Decided here because some routes parse their body only once the route is reached.
        if (changesNothing(req)) return;
        const label = before.label || req.body?.name || req.body?.alias || null;
        recordAdminChange({
          actor: actor(req),
          route: req.route?.path,
          path: req.path,
          status: res.statusCode,
          target: { ...before, label: label ? String(label).slice(0, MAX_VALUE_LENGTH) : null },
          details: summarizeBody(req.body)
        });
      } catch (error) {
        console.error(`${new Date().toISOString()} Could not record admin change on ${req.path}:`, error);
      }
    });
    return next();
  };
}

module.exports = { actionLabel, auditAdminChanges, countAdminChanges, listAdminChanges, summarizeBody };
