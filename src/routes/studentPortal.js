const express = require('express');
const { getDb } = require('../db');
const { generateStudentKey, hashApiKey, lookupHashApiKey, keyPrefixSuffix } = require('../services/keyService');
const { verifyAdminCredentials } = require('../middleware/authAdmin');
const { getUsageTotals, recentUsage } = require('../services/usageService');
const { getSetting } = require('../services/settingsService');
const { getEnabledModelEntries, getEnabledModels } = require('../services/providerService');
const { getUserGroup } = require('../services/accessService');
const {
  findUserByInviteToken,
  setPasswordFromInvite,
  findUserForLogin,
  verifyPassword,
  hashPassword,
  isLocked,
  recordFailedLogin,
  clearFailedLogins
} = require('../services/studentAuthService');
const config = require('../config');
const { renderTemplate } = require('../utils/templates');
const {
  escapeHtml,
  flash,
  getRequestBaseUrl: requestBaseUrl,
  quotaLimitCards,
  trustedHtml
} = require('../utils/html');

const router = express.Router();
const OPENCODE_DEFAULT_OUTPUT_LIMIT = 8192;

function getRequestBaseUrl(req) {
  return requestBaseUrl(req, getSetting('public_base_url', ''));
}

function getModelEntries(models) {
  const configured = new Map(getEnabledModelEntries().map((model) => [model.id, model]));
  const context = Number(getSetting('default_model_context_limit', config.defaultModelContextLimit));
  const output = Number(getSetting('default_model_output_limit', OPENCODE_DEFAULT_OUTPUT_LIMIT));
  return Object.fromEntries(models.map((model) => {
    const entry = configured.get(model.providerSlug);
    const limit = model.limit || entry?.limit || { context, output };
    const modelOutput = Number(limit.output || output);
    return [
      config.publicModelName,
      {
        name: config.publicModelName,
        limit,
        max_tokens: modelOutput,
        tool_call: true,
        reasoning: true,
        modalities: {
          input: ['text', 'image'],
          output: ['text']
        }
      }
    ];
  }));
}

function getActiveModelForUser(user) {
  const group = getUserGroup(user.id);
  const providerSlugs = group?.provider_slugs || [];
  const enabled = new Set(getEnabledModels());
  const activeSlugs = providerSlugs.filter((slug) => enabled.has(slug));
  if (!activeSlugs.length) return null;
  const entries = getEnabledModelEntries().filter((entry) => activeSlugs.includes(entry.id));
  const limit = entries.reduce((current, entry) => ({
    context: Math.min(current.context, Number(entry.limit?.context || current.context)),
    output: Math.min(current.output, Number(entry.limit?.output || current.output))
  }), {
    context: Number(getSetting('default_model_context_limit', config.defaultModelContextLimit)),
    output: Number(getSetting('default_model_output_limit', OPENCODE_DEFAULT_OUTPUT_LIMIT))
  });
  return { id: config.publicModelName, providerSlug: activeSlugs[0], providerSlugs: activeSlugs, limit, group };
}

function buildOpenCodeProviderBlock({ req, models, apiKey }) {
  return {
    'ieti-agents': {
      npm: '@ai-sdk/openai-compatible',
      name: 'IETI Agents',
      options: {
        baseURL: `${getRequestBaseUrl(req)}/v1`,
        apiKey,
        timeout: 900000,
        chunkTimeout: 600000
      },
      models: getModelEntries(models)
    }
  };
}

function buildOpenCodeConfig({ req, models, apiKey }) {
  const selectedModel = models[0]?.id || '';
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: buildOpenCodeProviderBlock({ req, models, apiKey }),
    model: selectedModel ? `ieti-agents/${selectedModel}` : ''
  };
}

function render(req, res, { title = 'User Portal', content = '', message = '' }) {
  const logout = req.session?.adminAuthenticated
    ? '<form method="post" action="/admin/logout" style="margin-left:auto"><button>Log out</button></form>'
    : req.session?.studentUserId
      ? '<form method="post" action="/portal/logout" style="margin-left:auto"><button>Log out</button></form>'
      : '';
  const isAdmin = !!req.session?.adminAuthenticated;
  const isStudent = !!req.session?.studentUserId;
  const isLoggedIn = isAdmin || isStudent;
  const nav = `
    <header>
      <strong>IETI Agents</strong>
      ${isLoggedIn ? '<a href="/">Dashboard</a>' : ''}
      ${isStudent ? '<a href="/portal/settings">Settings</a>' : ''}
      ${isAdmin ? '<a href="/admin">Admin</a>' : ''}
      ${logout}
    </header>
  `;
  res.send(renderTemplate('layout', {
    title,
    nav: trustedHtml(nav),
    content: trustedHtml(`${flash(message)}${content}`)
  }));
}

function usageLimitCards(group, usage) {
  return quotaLimitCards(group, usage);
}

function requireStudentSession(req, res, next) {
  const userId = req.session?.studentUserId;
  if (!userId) return res.redirect('/');
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || !user.enabled) {
    req.session.studentUserId = null;
    return res.redirect('/?error=disabled');
  }
  req.portalUser = user;
  next();
}

router.get('/', (req, res) => {
  if (req.session?.adminAuthenticated && req.query.admin) return res.redirect('/admin');
  if (req.session?.studentUserId) return res.redirect('/portal');
  const message = req.query.error === 'invalid'
    ? 'Invalid email or password.'
    : req.query.error === 'disabled'
      ? 'Your user is disabled. Contact the course administrator.'
      : req.query.error === 'setup'
        ? 'Set your password from the invite link before logging in.'
        : req.query.error === 'locked'
        ? 'Too many failed attempts. Try again later or ask the admin for a new invite link.'
          : req.query.ready
            ? 'Password set. You can now log in.'
      : '';
  render(req, res, {
    title: 'Login',
    message,
    content: `
      <h1>Login</h1>
      <form method="post" action="/login" class="panel" style="max-width:520px">
        <label>Email or admin username</label>
        <input name="login" autocomplete="username" required>
        <label>Password</label>
        <div class="password-field">
          <input id="login-password" name="password" type="password" autocomplete="current-password" required>
          <button type="button" class="secondary" aria-controls="login-password" aria-pressed="false" onclick="const input=document.getElementById('login-password'); const visible=input.type==='text'; input.type=visible?'password':'text'; this.setAttribute('aria-pressed', String(!visible)); this.textContent=visible?'Show':'Hide';">Show</button>
        </div>
        <p><button type="submit">Log in</button></p>
      </form>
    `
  });
});

function handleLogin(req, res) {
  const login = String(req.body.login || req.body.email || req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (verifyAdminCredentials(login, password)) {
    return req.session.regenerate((error) => {
      if (error) return res.status(500).send('Could not create session.');
      req.session.adminAuthenticated = true;
      res.redirect('/admin');
    });
  }

  const email = login;
  const user = findUserForLogin(email);
  if (!user || !user.enabled) return res.redirect('/?error=invalid');
  if (!user.password_hash) return res.redirect('/?error=setup');
  if (isLocked(user)) return res.redirect('/?error=locked');
  if (!verifyPassword(password, user.password_hash)) {
    recordFailedLogin(user.id);
    return res.redirect('/?error=invalid');
  }
  clearFailedLogins(user.id);

  req.session.regenerate((error) => {
    if (error) return res.status(500).send('Could not create session.');
    req.session.studentUserId = user.id;
    res.redirect('/portal');
  });
}

router.post('/login', handleLogin);

router.post('/portal/login', handleLogin);

router.post('/portal/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/invite/:token', (req, res) => {
  const user = findUserByInviteToken(req.params.token);
  if (!user || !user.enabled) {
    return render(req, res, {
      title: 'Invite expired',
      message: 'This invite link is invalid or expired. Ask the admin for a new one.',
      content: '<p><a class="button" href="/">Back to login</a></p>'
    });
  }

  render(req, res, {
    title: 'Set Password',
    content: `
      <h1>Set Password</h1>
      <p class="muted">${escapeHtml(user.email)}</p>
      <form method="post" action="/invite/${encodeURIComponent(req.params.token)}" class="panel" style="max-width:520px">
        <label>New password</label>
        <input name="password" type="password" autocomplete="new-password" minlength="10" required>
        <label>Confirm password</label>
        <input name="confirm_password" type="password" autocomplete="new-password" minlength="10" required>
        <p><button type="submit">Set password</button></p>
      </form>
    `
  });
});

router.post('/invite/:token', (req, res) => {
  const user = findUserByInviteToken(req.params.token);
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirm_password || '');

  if (!user || !user.enabled) {
    return render(req, res, {
      title: 'Invite expired',
      message: 'This invite link is invalid or expired. Ask the admin for a new one.',
      content: '<p><a class="button" href="/">Back to login</a></p>'
    });
  }
  if (password.length < 10 || password !== confirmPassword) {
    return render(req, res, {
      title: 'Set Password',
      message: 'Password must be at least 10 characters and both fields must match.',
      content: `
        <h1>Set Password</h1>
        <p class="muted">${escapeHtml(user.email)}</p>
        <form method="post" action="/invite/${encodeURIComponent(req.params.token)}" class="panel" style="max-width:520px">
          <label>New password</label>
          <input name="password" type="password" autocomplete="new-password" minlength="10" required>
          <label>Confirm password</label>
          <input name="confirm_password" type="password" autocomplete="new-password" minlength="10" required>
          <p><button type="submit">Set password</button></p>
        </form>
      `
    });
  }

  setPasswordFromInvite(user.id, password);
  res.redirect('/?ready=1');
});

router.get('/portal', requireStudentSession, (req, res) => {
  const user = req.portalUser;
  const usage = getUsageTotals(user.id);
  const activeModel = getActiveModelForUser(user);
  const models = activeModel ? [activeModel] : [];
  const providerSnippet = JSON.stringify({
    provider: buildOpenCodeProviderBlock({
      req,
      models,
      apiKey: '{env:IETI_AGENT_KEY}'
    })
  }, null, 2);
  const usageRows = recentUsage(25, user.id).map((row) => `
    <tr>
      <td>${escapeHtml(row.created_at)}</td>
      <td>${escapeHtml(row.model)}</td>
      <td>${row.input_tokens}</td>
      <td>${row.output_tokens}</td>
      <td>${row.total_tokens}</td>
      <td>${escapeHtml(row.status)}</td>
    </tr>
  `).join('');

  render(req, res, {
    title: 'User Portal',
    message: '',
    content: `
      ${req.session.studentOneTimeApiKey && req.query.created ? `
      <dialog id="api-key-modal" style="border:none;border-radius:8px;padding:24px;max-width:600px;width:90%;box-shadow:0 4px 24px rgba(0,0,0,0.2)">
        <h2>New API Key</h2>
        <p>Please save this API key somewhere safe and accessible. For security reasons, you won't be able to view it again through your account.</p>
        <div style="display:flex;gap:8px;align-items:center;margin:16px 0">
          <code style="flex:1;padding:8px;background:#f5f5f5;border-radius:4px;word-break:break-all">${escapeHtml(req.session.studentOneTimeApiKey)}</code>
          <button id="copy-key-btn">Copy</button>
        </div>
        <form method="post" action="/portal/key/dismiss-modal" style="margin:0">
          <button type="submit" class="secondary">Close</button>
        </form>
      </dialog>
      <script>
        (function(){
          var m = document.getElementById('api-key-modal');
          if (m) m.showModal();
          var b = document.getElementById('copy-key-btn');
          if (b) b.addEventListener('click', function(){
            navigator.clipboard.writeText(${JSON.stringify(req.session.studentOneTimeApiKey)}).then(function(){
              b.textContent = 'Copied!';
            });
          });
        })();
      </script>
      ` : ''}
      <h1>${escapeHtml(user.name)}</h1>
      <p class="muted">${escapeHtml(user.email)}</p>
      ${usageLimitCards(activeModel?.group, usage)}
      <div class="panel" style="margin-top:16px">
        <h2>OpenCode</h2>
        <p>Provider base URL: <span class="key">${escapeHtml(`${getRequestBaseUrl(req)}/v1`)}</span></p>
        <p>Model: <span class="key">${escapeHtml(config.publicModelName)}</span></p>
        <label>Provider section</label>
        <pre class="key">${escapeHtml(providerSnippet)}</pre>
        <div class="actions">
          <a class="button" href="/portal/opencode.json">Download opencode.json</a>
        </div>
        ${user.api_key_hash ? '' : '<p class="muted">Create an API key before downloading a config that embeds it.</p>'}
      </div>
      <h2>Recent usage</h2>
      <table>
        <thead><tr><th>When</th><th>Model</th><th>Input</th><th>Output</th><th>Total</th><th>Status</th></tr></thead>
        <tbody>${usageRows || '<tr><td colspan="6" class="muted">No usage yet.</td></tr>'}</tbody>
      </table>
    `
  });
});

router.post('/portal/settings/name', requireStudentSession, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.redirect('/portal');
  getDb().prepare('UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, req.portalUser.id);
  res.redirect('/portal?name_saved=1');
});

router.post('/portal/settings/password', requireStudentSession, (req, res) => {
  const user = req.portalUser;
  const currentPassword = String(req.body.current_password || '');
  const newPassword = String(req.body.new_password || '');
  const confirmPassword = String(req.body.confirm_password || '');
  if (!user.password_hash || !verifyPassword(currentPassword, user.password_hash) || newPassword.length < 10 || newPassword !== confirmPassword) {
    return res.redirect('/portal?password_error=1');
  }
  setPasswordFromInvite(user.id, newPassword);
  res.redirect('/portal?password_saved=1');
});

router.get('/portal/settings', requireStudentSession, (req, res) => {
  const user = req.portalUser;
  render(req, res, {
    title: 'Settings',
    message: '',
    content: `
      <h1>Settings</h1>
      ${req.query.name_saved ? '<div class="notice">Name updated.</div>' : ''}
      ${req.query.password_error ? '<div class="notice" style="background:#fee;color:#c33">Current password is incorrect or passwords do not match.</div>' : ''}
      ${req.query.password_saved ? '<div class="notice">Password updated.</div>' : ''}
      <div class="panel" style="margin-top:16px">
        <h2>API Key</h2>
        ${user.api_key_prefix && user.api_key_suffix ? `<p>API key: <span class="key">${escapeHtml(user.api_key_prefix + '...' + user.api_key_suffix)}</span></p>` : '<p class="muted">No API key configured.</p>'}
        <div class="actions">
          <form method="post" action="/portal/key/regenerate"><button type="submit">Create new API key</button></form>
          <form method="post" action="/portal/key/revoke"><button type="submit" class="danger">Delete API key</button></form>
        </div>
      </div>
      <div class="panel" style="margin-top:16px">
        <h2>Account</h2>
        <form method="post" action="/portal/settings/name" style="margin-bottom:16px">
          <label>Name</label>
          <input name="name" value="${escapeHtml(user.name)}" required>
          <button type="submit" style="margin-top:16px">Save name</button>
        </form>
        <form method="post" action="/portal/settings/password" style="border-top:1px solid #ddd;padding-top:16px">
          <label>Current password</label>
          <input name="current_password" type="password" autocomplete="current-password" required>
          <label>New password</label>
          <input name="new_password" type="password" autocomplete="new-password" minlength="10" required>
          <label>Confirm new password</label>
          <input name="confirm_password" type="password" autocomplete="new-password" minlength="10" required>
          <button type="submit" style="margin-top:16px">Save password</button>
        </form>
      </div>
    `
  });
});

router.post('/portal/key/regenerate', requireStudentSession, (req, res) => {
  const key = generateStudentKey();
  const { prefix, suffix } = keyPrefixSuffix(key);
  getDb().prepare('UPDATE users SET api_key_hash = ?, api_key_lookup_hash = ?, api_key_prefix = ?, api_key_suffix = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hashApiKey(key), lookupHashApiKey(key), prefix, suffix, req.portalUser.id);
  req.session.studentOneTimeApiKey = key;
  res.redirect('/portal?created=1');
});

router.post('/portal/key/dismiss-modal', requireStudentSession, (req, res) => {
  res.redirect('/portal');
});

router.post('/portal/key/revoke', requireStudentSession, (req, res) => {
  getDb().prepare('UPDATE users SET api_key_hash = NULL, api_key_lookup_hash = NULL, api_key_prefix = NULL, api_key_suffix = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.portalUser.id);
  req.session.studentOneTimeApiKey = null;
  res.redirect('/portal');
});

router.get('/portal/opencode.json', requireStudentSession, (req, res) => {
  const user = req.portalUser;
  const activeModel = getActiveModelForUser(user);
  const models = activeModel ? [activeModel] : [];
  const apiKey = '{env:IETI_AGENT_KEY}';
  const opencodeConfig = buildOpenCodeConfig({ req, models, apiKey });

  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="opencode.json"',
    'Cache-Control': 'no-store'
  });
  res.send(`${JSON.stringify(opencodeConfig, null, 2)}\n`);
});

module.exports = router;
