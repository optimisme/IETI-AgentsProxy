// Helpers used by more than one area of the admin backoffice: the page layout and the one
// path every admin form goes through when a submission is refused.
const { getDb } = require('../../db');
const { isAdminSession } = require('../../middleware/authAdmin');
const { renderTemplate } = require('../../utils/templates');
const { flash, siteHeader, trustedHtml } = require('../../utils/html');
const { ApiError, apiError } = require('../../utils/errors');
const { usageTable } = require('../../views/admin/shared');

function render(req, res, view, { title, content = '', flash = '' } = {}) {
  const pendingUsers = isAdminSession(req.session)
    ? getDb().prepare("SELECT COUNT(*) AS count FROM users WHERE registration_status = 'pending'").get().count
    : 0;
  const pendingConflicts = isAdminSession(req.session)
    ? getDb().prepare("SELECT COUNT(*) AS count FROM oauth_identity_conflicts WHERE status = 'pending' AND expires_at > ?").get(new Date().toISOString()).count
    : 0;
  const nav = isAdminSession(req.session) ? siteHeader(req, {
    links: [
      { href: '/admin', label: 'Dashboard', exactOnly: true },
      { href: '/admin/users', label: 'Users' },
      { href: '/admin/users?status=pending', label: `Pending${pendingUsers ? ` (${pendingUsers})` : ''}` },
      { href: '/admin/oauth-conflicts', label: `OAuth reviews${pendingConflicts ? ` (${pendingConflicts})` : ''}` },
      { href: '/admin/groups', label: 'Groups' },
      { href: '/admin/pools', label: 'Pools' },
      { href: '/admin/providers', label: 'Providers' },
      { href: '/admin/server', label: 'Server' },
      { href: '/admin/activity', label: 'Activity' }
    ],
    logoutAction: '/admin/logout'
  }) : '';

  // Views hand over html`` results; a plain string here is text and gets escaped like any other.
  const body = renderTemplate(view, { title: title || 'Admin', content, flash });
  res.send(renderTemplate('layout', {
    title: title || 'Admin',
    nav: trustedHtml(nav),
    content: trustedHtml(body)
  }));
}

function activeProviderModel(providerId) {
  return providerId ? getDb().prepare(`
    SELECT *
    FROM provider_models
    WHERE provider_id = ?
    ORDER BY enabled DESC, updated_at DESC, id DESC
    LIMIT 1
  `).get(providerId) || {} : {};
}

const tokens = (value) => `${Number(value).toLocaleString('en-US')} tokens`;

// ---- Forms -------------------------------------------------------------------------------
// A form handler refuses a submission by throwing:
//   - apiError(400, 'invalid_form', message), which is what the validation helpers throw
//   - formConflict(code, message, notice) when a value clashes with another record
// formRoute catches both and shows the same form again with what was typed and the reason;
// nothing is saved. A client that asks for JSON gets the error as JSON instead.

function formConflict(code, message, notice) {
  const error = apiError(409, code, message);
  // Not part of error.details, which is sent to JSON clients.
  error.notice = notice;
  return error;
}

function prefersJson(req) {
  return Boolean(req.get('accept')) && req.accepts(['html', 'json']) === 'json';
}

// showForm(req, res, { values, notice, status }) renders the form's page from the submitted
// values. handler is the usual route handler; it must do all its writes in one transaction
// or after its last check, so that a refusal leaves nothing half saved.
function formRoute(showForm, handler) {
  return (req, res, next) => {
    try {
      return handler(req, res, next);
    } catch (error) {
      const refused = error instanceof ApiError && (error.statusCode === 400 || error.statusCode === 409);
      if (!refused || prefersJson(req)) return next(error);
      return showForm(req, res, {
        values: req.body || {},
        notice: error.notice || flash(error.message, 'error'),
        status: error.statusCode
      });
    }
  };
}

module.exports = {
  formConflict,
  formRoute,
  activeProviderModel,
  render,
  tokens,
  usageTable
};
