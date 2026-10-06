const express = require('express');
const { commonCapabilities } = require('../utils/modelCapabilities');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDb } = require('../db');
const { generateStudentKey } = require('../services/keyService');
const {
  KEY_NAME_MAX_LENGTH,
  normalizeApiKeyName,
  listUserApiKeys,
  hasUserApiKeyName,
  createUserApiKey,
  revokeUserApiKey,
  MAX_USER_API_KEYS
} = require('../services/userApiKeyService');
const { isAdminSession, startAdminSession, verifyAdminCredentials } = require('../middleware/authAdmin');
const { getUsageTotals, recentUsage, dailyUsage } = require('../services/usageService');
const { getSetting } = require('../services/settingsService');
const { getEnabledModelEntries } = require('../services/providerService');
const { getUserGroup } = require('../services/accessService');
const {
  findUserByInviteToken,
  setPasswordFromInvite,
  findUserForLogin,
  verifyPassword,
  verifyDummyPassword,
  isLocked,
  recordFailedLogin,
  clearFailedLogins
} = require('../services/studentAuthService');
const config = require('../config');
const { renderTemplate } = require('../utils/templates');
const { REASONING_EFFORTS } = require('../utils/reasoning');
const { apiError } = require('../utils/errors');
const { clearLoginFailures, isLoginAllowed, recordLoginFailure, studentRateLimit } = require('../middleware/rateLimit');
const { clearPendingSecret, getPendingSecret, setPendingSecret } = require('../utils/pendingSecrets');
const { largeJsonBody } = require('../middleware/bodyParsers');
const { handleChatCompletion } = require('../services/chatCompletionService');
const { chatLimits, preparePortalChatPayload } = require('../utils/portalChat');
const { dailyUsageCard } = require('../utils/usageCards');
const {
  escapeHtml,
  flash,
  getRequestBaseUrl: requestBaseUrl,
  quotaLimitCards,
  trustedHtml
} = require('../utils/html');

const router = express.Router();
const OPENCODE_DEFAULT_OUTPUT_LIMIT = 8192;
const NAME_MAX_LENGTH = 255;
const PENDING_API_KEY = 'student-api-key';
const CLIENT_SCRIPT_DIRECTORY = path.resolve(__dirname, '..', '..', 'assets');
const chatAssets = new Map([
  ['portal-chat.js', 'portal-chat.js'],
  ['portal-chat.css', 'portal-chat.css'],
  ['marked.umd.js', 'vendor/marked.umd.js'],
  ['purify.min.js', 'vendor/purify.min.js']
]);
const chatAssetUrls = new Map([...chatAssets].map(([name, file]) => {
  const version = crypto.createHash('sha256').update(fs.readFileSync(path.join(CLIENT_SCRIPT_DIRECTORY, file))).digest('hex').slice(0, 16);
  return [name, `/portal/chat/assets/${name}?v=${version}`];
}));

function getRequestBaseUrl(req) {
  return requestBaseUrl(req, getSetting('public_base_url', ''));
}

function normalizeAgentBaseUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return null;
    }
    const pathname = url.pathname.replace(/\/+$/, '');
    url.pathname = pathname && pathname.endsWith('/v1') ? pathname : `${pathname}/v1`;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function normalizeWebsiteBaseUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return null;
    }
    let pathname = url.pathname.replace(/\/+$/, '');
    if (pathname.endsWith('/v1')) pathname = pathname.slice(0, -3).replace(/\/+$/, '');
    url.pathname = pathname || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function getNormalizedRequestBaseUrl(req) {
  return normalizeAgentBaseUrl(getRequestBaseUrl(req)) ||
    normalizeAgentBaseUrl(`${req.protocol}://${req.get('host')}`);
}

function getWebsiteBaseUrl(req) {
  return normalizeWebsiteBaseUrl(getRequestBaseUrl(req)) ||
    normalizeWebsiteBaseUrl(`${req.protocol}://${req.get('host')}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function getClientScriptUrl(req, filename) {
  return `${getWebsiteBaseUrl(req)}/downloads/${filename}`;
}

function getClientScriptCommand(req, filename) {
  const scriptUrl = getClientScriptUrl(req, filename);
  if (filename.endsWith('.sh')) {
    return `ieti_setup=$(curl -fsSL --connect-timeout 10 --max-time 30 --max-redirs 3 --max-filesize 65536 ${shellQuote(scriptUrl)}) && bash -c "$ieti_setup"`;
  }
  return `$p=Join-Path $env:TEMP ('ieti-set-agents-server-'+[Guid]::NewGuid().ToString('N')+'.ps1'); try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop -Uri ${powershellQuote(scriptUrl)} -OutFile $p; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p } finally { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }`;
}

function getModelEntries(models) {
  const configured = new Map(getEnabledModelEntries().map((model) => [model.publicModel, model]));
  const context = Number(getSetting('default_model_context_limit', config.defaultModelContextLimit));
  const output = Number(getSetting('default_model_output_limit', OPENCODE_DEFAULT_OUTPUT_LIMIT));
  return Object.fromEntries(models.map((model) => {
    const entry = configured.get(model.id);
    const limit = model.limit || entry?.limit || { context, output };
    const capabilities = model.capabilities || entry?.capabilities || {};
    const reasoningEfforts = capabilities.reasoning
      ? REASONING_EFFORTS.filter((effort) => capabilities.reasoningEfforts?.includes(effort))
      : [];
    const defaultReasoningEffort = reasoningEfforts.includes(capabilities.defaultReasoningEffort)
      ? capabilities.defaultReasoningEffort
      : null;
    const variants = capabilities.reasoning
      ? Object.fromEntries(REASONING_EFFORTS.map((effort) => [
          effort,
          reasoningEfforts.includes(effort) ? { reasoningEffort: effort } : { disabled: true }
        ]))
      : {};
    return [
      model.id,
      {
        limit,
        tool_call: capabilities.tools ?? true,
        reasoning: capabilities.reasoning ?? true,
        ...(capabilities.reasoning ? { interleaved: { field: 'reasoning_content' } } : {}),
        modalities: {
          input: [
            ...(capabilities.text === false ? [] : ['text']),
            ...(capabilities.image === false ? [] : ['image'])
          ],
          output: ['text']
        },
        variants,
        ...(defaultReasoningEffort ? { options: { reasoningEffort: defaultReasoningEffort } } : {})
      }
    ];
  }));
}

function getActiveModelsForUser(user) {
  const group = getUserGroup(user.id);
  const providerSlugs = group?.provider_slugs || [];
  const enabled = getEnabledModelEntries().filter((entry) => providerSlugs.includes(entry.id));
  const defaults = {
    context: Number(getSetting('default_model_context_limit', config.defaultModelContextLimit)),
    output: Number(getSetting('default_model_output_limit', OPENCODE_DEFAULT_OUTPUT_LIMIT))
  };
  const byAlias = new Map();
  for (const entry of enabled) {
    if (!entry.publicModel) continue;
    const current = byAlias.get(entry.publicModel) || {
      id: entry.publicModel,
      providerSlug: entry.id,
      providerSlugs: [],
      limit: null,
      capabilities: null,
      group
    };
    current.providerSlugs.push(entry.id);
    const entryLimit = {
      context: Number(entry.limit?.context || defaults.context),
      output: Number(entry.limit?.output || defaults.output)
    };
    current.limit = {
      context: current.limit ? Math.min(current.limit.context, entryLimit.context) : entryLimit.context,
      output: current.limit ? Math.min(current.limit.output, entryLimit.output) : entryLimit.output
    };
    current.capabilities = commonCapabilities(current.capabilities, entry.capabilities);
    byAlias.set(entry.publicModel, current);
  }
  return [...byAlias.values()];
}

function buildOpenCodeProviderBlock({ req, models, apiKey }) {
  return {
    'ieti-agents': {
      npm: '@ai-sdk/openai-compatible',
      name: 'IETI Agents',
      options: {
        baseURL: getNormalizedRequestBaseUrl(req),
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

function yesNo(value) {
  return value ? 'Yes' : 'No';
}

function renderActiveModels(req, models) {
  const baseUrl = getNormalizedRequestBaseUrl(req);
  const modelEntries = getModelEntries(models);
  const modelList = models.map((model) => {
    const entry = modelEntries[model.id];
    const capabilities = model.capabilities || {};
    const reasoningEfforts = capabilities.reasoningEfforts?.length
      ? capabilities.reasoningEfforts.join(', ')
      : (capabilities.reasoning ? 'Provider-managed' : 'Not supported');
    const inputs = entry.modalities.input.join(', ') || 'None';
    return `
      <details class="active-model">
        <summary>
          <code>${escapeHtml(model.id)}</code>
          <span>${escapeHtml(entry.limit.context)} context · ${escapeHtml(entry.limit.output)} max output</span>
        </summary>
        <div class="active-model-details">
          <dl class="model-config-grid">
            <div><dt>Protocol</dt><dd>OpenAI-compatible</dd></div>
            <div><dt>Base URL</dt><dd><code>${escapeHtml(baseUrl)}</code></dd></div>
            <div><dt>Model ID</dt><dd><code>${escapeHtml(model.id)}</code></dd></div>
            <div><dt>OpenCode model</dt><dd><code>ieti-agents/${escapeHtml(model.id)}</code></dd></div>
            <div><dt>OpenCode package</dt><dd><code>@ai-sdk/openai-compatible</code></dd></div>
            <div><dt>Context window</dt><dd>${escapeHtml(entry.limit.context)} tokens</dd></div>
            <div><dt>Maximum output</dt><dd>${escapeHtml(entry.limit.output)} tokens</dd></div>
            <div><dt>Input modalities</dt><dd>${escapeHtml(inputs)}</dd></div>
            <div><dt>Tool calling</dt><dd>${yesNo(entry.tool_call)}</dd></div>
            <div><dt>Reasoning</dt><dd>${yesNo(entry.reasoning)}</dd></div>
            <div><dt>Reasoning efforts</dt><dd>${escapeHtml(reasoningEfforts)}</dd></div>
          </dl>
        </div>
      </details>
    `;
  }).join('');

  return `
    <section class="active-models" aria-labelledby="active-models-heading">
      <h2 id="active-models-heading">Active models</h2>
      <p class="muted">Models available to your account. Select a model to see the same connection and capability parameters used by the setup scripts.</p>
      <div class="active-model-list">
        ${modelList || '<div class="panel muted">No active models are assigned to your account.</div>'}
      </div>
    </section>
  `;
}

function render(req, res, { title = 'User Portal', content = '', message = '' }) {
  const logout = isAdminSession(req.session)
    ? '<form method="post" action="/admin/logout" style="margin-left:auto"><button>Log out</button></form>'
    : req.session?.studentUserId
      ? '<form method="post" action="/portal/logout" style="margin-left:auto"><button>Log out</button></form>'
      : '';
  const isAdmin = isAdminSession(req.session);
  const isStudent = !!req.session?.studentUserId;
  const isApprovedStudent = isStudent && req.portalUser?.registration_status === 'approved';
  const isLoggedIn = isAdmin || isStudent;
  const nav = `
    <header>
      <strong>IETI Agents</strong>
      ${isLoggedIn ? '<a href="/">Dashboard</a>' : ''}
      ${isApprovedStudent ? '<a href="/portal/chat">Chat</a>' : ''}
      ${isApprovedStudent ? '<a href="/portal/settings">Settings</a>' : ''}
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

function setStudentSession(req, userId, passwordChangedAt) {
  const user = getDb().prepare('SELECT auth_version FROM users WHERE id = ?').get(userId);
  req.session.studentUserId = userId;
  req.session.studentPasswordChangedAt = passwordChangedAt || null;
  req.session.studentAuthVersion = Number(user?.auth_version || 0);
}

function rejectStudentSession(req, res, redirect, code, message, status = 401) {
  if (req.method === 'POST' && req.path === '/portal/chat/completions') {
    return res.status(status).json({ error: { code, type: code, message } });
  }
  return res.redirect(redirect);
}

function requireStudentSession(req, res, next) {
  const userId = req.session?.studentUserId;
  if (!userId) return rejectStudentSession(req, res, '/', 'session_required', 'Sign in to use Chat.');
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || !user.enabled) {
    req.session.studentUserId = null;
    return rejectStudentSession(req, res, '/?error=disabled', 'user_disabled', 'This account is disabled.', 403);
  }
  if (user.registration_status === 'rejected') {
    return req.session.destroy(() => rejectStudentSession(req, res, '/?error=disabled', 'account_rejected', 'This account is not approved.', 403));
  }
  if ((req.session.studentPasswordChangedAt ?? null) !== (user.password_changed_at ?? null)) {
    return req.session.destroy(() => rejectStudentSession(req, res, '/?error=session_expired', 'session_expired', 'Your session expired. Sign in again.'));
  }
  const authVersion = Number(user.auth_version || 0);
  if (req.session.studentAuthVersion === undefined) {
    req.session.studentAuthVersion = authVersion;
  } else if (Number(req.session.studentAuthVersion) !== authVersion) {
    return req.session.destroy(() => rejectStudentSession(req, res, '/?error=session_expired', 'session_expired', 'Your session expired. Sign in again.'));
  }
  req.portalUser = user;
  next();
}

function requireApprovedStudentSession(req, res, next) {
  requireStudentSession(req, res, () => {
    if (req.portalUser.registration_status !== 'approved' || !getUserGroup(req.portalUser.id)) {
      return rejectStudentSession(req, res, '/portal', 'account_unavailable', 'An approved account and assigned group are required.', 403);
    }
    next();
  });
}

router.get('/', (req, res) => {
  if (isAdminSession(req.session) && req.query.admin) return res.redirect('/admin');
  if (req.session?.studentUserId) return res.redirect('/portal');
  const message = req.query.error === 'invalid'
    ? 'Invalid email or password. If you have not set a password yet, use your invite link.'
    : req.query.error === 'disabled'
      ? 'Your user is disabled. Contact the course administrator.'
      : req.query.error === 'setup'
        ? 'Set your password from the invite link before logging in.'
        : req.query.error === 'locked'
        ? 'Too many failed attempts. Try again later or ask the admin for a new invite link.'
          : req.query.error === 'session_expired'
            ? 'Your account security settings changed, so this session was signed out. Log in again.'
          : req.query.error === 'oauth_denied'
            ? 'Google sign-in was cancelled or this account is not allowed.'
          : req.query.error === 'oauth_expired'
            ? 'The Google sign-in request expired. Please try again.'
          : req.query.error === 'oauth_invalid'
            ? 'Google sign-in could not be verified. Please try again.'
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
      ${config.googleOAuthEnabled ? `
        <div class="panel" style="max-width:520px;margin-top:16px;text-align:center">
          <p class="muted">Or use your institutional Google account</p>
          <a class="button" href="/auth/google">Continue with Google</a>
        </div>
      ` : ''}
    `
  });
});

async function handleLogin(req, res, next) {
  try {
    const login = String(req.body.login || req.body.email || req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!isLoginAllowed(req.ip, login)) return res.redirect('/?error=locked');

    if (await verifyAdminCredentials(login, password)) {
      clearLoginFailures(req.ip, login);
      return req.session.regenerate((error) => {
        if (error) return res.status(500).send('Could not create session.');
        startAdminSession(req.session);
        res.redirect('/admin');
      });
    }

    // Unknown, disabled and password-less accounts all get the same answer, after the
    // same bcrypt work, so the login form does not reveal which emails are registered.
    const user = findUserForLogin(login);
    const usable = Boolean(user?.enabled && user.registration_status !== 'rejected' && user.password_hash);
    if (usable && isLocked(user)) return res.redirect('/?error=locked');
    const valid = usable ? await verifyPassword(password, user.password_hash) : await verifyDummyPassword(password);
    if (!valid) {
      recordLoginFailure(req.ip, login);
      if (usable) recordFailedLogin(user.id);
      return res.redirect('/?error=invalid');
    }
    clearLoginFailures(req.ip, login);
    clearFailedLogins(user.id);

    req.session.regenerate((error) => {
      if (error) return res.status(500).send('Could not create session.');
      setStudentSession(req, user.id, user.password_changed_at);
      res.redirect('/portal');
    });
  } catch (error) {
    next(error);
  }
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

router.post('/invite/:token', async (req, res, next) => {
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

  let passwordChangedAt;
  try {
    passwordChangedAt = await setPasswordFromInvite(user.id, password);
  } catch (error) {
    return next(error);
  }
  req.session.regenerate((error) => {
    if (error) return res.status(500).send('Password saved, but the session could not be created. Log in with your new password.');
    setStudentSession(req, user.id, passwordChangedAt);
    res.redirect('/portal');
  });
});

router.get('/portal/chat', requireApprovedStudentSession, (req, res) => {
  req.session.portalChatCsrfToken ||= crypto.randomBytes(32).toString('hex');
  const models = getActiveModelsForUser(req.portalUser);
  const chatConfig = {
    models: models.map(({ id, limit, capabilities }) => ({ id, limit, capabilities })),
    csrfToken: req.session.portalChatCsrfToken,
    streaming: config.enableStreaming,
    ...chatLimits()
  };
  const json = JSON.stringify(chatConfig).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  res.set('Cache-Control', 'no-store');
  render(req, res, {
    title: 'Chat',
    content: `
      <link rel="stylesheet" href="${chatAssetUrls.get('portal-chat.css')}">
      <h1>Chat</h1>
      <section class="panel chat-panel">
        <div id="chat-messages" class="chat-messages" aria-label="Conversation"></div>
        <form id="chat-form" class="chat-form">
          <label for="chat-input" class="visually-hidden">Message</label>
          <textarea id="chat-input" rows="4" placeholder="Write a message…"></textarea>
          <div id="chat-attachments" class="chat-attachments"></div>
          <div class="chat-composer-actions">
            <div class="chat-composer-controls">
              <div id="chat-image-upload" class="chat-image-upload">
                <input id="chat-images" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>
                <button id="chat-upload" type="button" class="chat-icon-button" aria-label="Upload images" title="Upload images">
                  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>
                </button>
              </div>
              <div class="chat-toolbar-actions">
                <button type="button" id="chat-reset" class="secondary">Reset</button>
                <button type="button" id="chat-compact" class="secondary">Compact</button>
              </div>
            </div>
            <div class="chat-send-actions">
              <div class="chat-composer-model">
                <label for="chat-model" class="visually-hidden">Model</label>
                <select id="chat-model"${models.length === 1 ? ' hidden' : ''}>${models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.id)}</option>`).join('') || '<option value="">No active models</option>'}</select>
                ${models.length === 1 ? `<span class="chat-model-name" title="${escapeHtml(models[0].id)}">${escapeHtml(models[0].id)}</span>` : ''}
              </div>
              <span id="chat-state" class="chat-status-indicator" role="img" aria-label="Ready." title="Ready."></span>
              <button type="button" id="chat-stop" class="chat-send-button" aria-label="Stop response" title="Stop response" hidden>
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>
              </button>
              <button type="submit" id="chat-send" class="chat-send-button" aria-label="Send message" title="Send message">
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m-7 7 7-7 7 7"></path></svg>
              </button>
            </div>
          </div>
        </form>
        <p id="chat-status" class="chat-status muted visually-hidden" role="status" aria-live="polite"></p>
        <p id="chat-budget" class="chat-budget muted"></p>
      </section>
      <script id="portal-chat-config" type="application/json">${json}</script>
      <script src="${chatAssetUrls.get('marked.umd.js')}" defer></script>
      <script src="${chatAssetUrls.get('purify.min.js')}" defer></script>
      <script src="${chatAssetUrls.get('portal-chat.js')}" defer></script>
    `
  });
});

router.get('/portal/chat/assets/:filename', requireApprovedStudentSession, (req, res) => {
  const asset = chatAssets.get(req.params.filename);
  if (!asset) return res.status(404).send('Not found');
  res.set('Cache-Control', 'private, no-cache');
  res.sendFile(path.join(CLIENT_SCRIPT_DIRECTORY, asset));
});

router.post('/portal/chat/completions', requireApprovedStudentSession, largeJsonBody, (req, res, next) => {
  try {
    const expected = req.session.portalChatCsrfToken;
    const supplied = req.get('X-CSRF-Token') || '';
    const expectedBytes = Buffer.from(expected || '');
    const suppliedBytes = Buffer.from(supplied);
    const origin = req.get('Origin');
    const websiteOrigin = new URL(getWebsiteBaseUrl(req)).origin;
    if (!expected || suppliedBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(expectedBytes, suppliedBytes) ||
        req.get('Sec-Fetch-Site') === 'cross-site' || (origin && origin !== websiteOrigin)) {
      throw apiError(403, 'csrf_invalid', 'Refresh the Chat page and try again.');
    }
    if (getSetting('maintenance_mode', 'false') === 'true') throw apiError(503, 'maintenance_mode', 'Server is in maintenance mode.');
    req.student = req.portalUser;
    req.body = preparePortalChatPayload(req.body, getActiveModelsForUser(req.portalUser));
    studentRateLimit(req, res, (error) => error ? next(error) : handleChatCompletion(req, res, next));
  } catch (error) {
    next(error);
  }
});

router.get('/portal/assets/dashboard-usage.js', requireApprovedStudentSession, (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(CLIENT_SCRIPT_DIRECTORY, 'dashboard-usage.js'));
});

router.get('/portal', requireStudentSession, (req, res) => {
  const user = req.portalUser;
  if (user.registration_status !== 'approved' || !getUserGroup(user.id)) {
    res.set('Cache-Control', 'no-store');
    return render(req, res, {
      title: 'Account awaiting approval',
      content: `
        <div class="panel" style="max-width:680px;margin:0 auto">
          <h1>Account awaiting approval</h1>
          <p class="muted">${escapeHtml(user.email)}</p>
          <p>Your Google account was verified successfully. An administrator must assign your account to a course group before you can use IETI Agents. You do not need to register or sign in again. Return later and refresh this page, or contact your course administrator if your account remains pending.</p>
          <div class="actions">
            <a class="button" href="/portal">Check approval status</a>
            <form method="post" action="/portal/logout"><button class="secondary" type="submit">Log out</button></form>
          </div>
        </div>
      `
    });
  }
  const usage = getUsageTotals(user.id);
  const usageByDay = dailyUsage(15, new Date(), user.id);
  const models = getActiveModelsForUser(user);
  const shellCommand = getClientScriptCommand(req, 'set_agents_opencode.sh');
  const powershellCommand = getClientScriptCommand(req, 'set_agents_opencode.ps1');
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
      <h1>${escapeHtml(user.name)}</h1>
      <p class="muted">${escapeHtml(user.email)}</p>
      <div class="panel" style="margin-top:16px">
        <h2>OpenCode configuration</h2>
        <ol class="opencode-instructions">
          <li>Install OpenCode Terminal or Desktop from <a href="https://opencode.ai/download" target="_blank" rel="noopener noreferrer">https://opencode.ai/download</a>.</li>
          <li>Get an API key from the <a href="/portal/settings">Settings</a> section.</li>
          <li>Run the next command for your operating system to install or update your global OpenCode configuration.</li>
          <li>Run or restart OpenCode (desktop or terminal).</li>
          <li>Optionally configure other harnesses manually using your Active Models parameters.</li>
        </ol>
        <label>macOS/Linux</label>
        <div class="command-row">
          <div class="command-scroll"><pre><code id="ieti-shell-command">${escapeHtml(shellCommand)}</code></pre></div>
          <button type="button" class="copy-command secondary" data-copy-command data-copy-target="ieti-shell-command" data-copy-value="${escapeHtml(shellCommand)}" title="Copy macOS/Linux command" aria-label="Copy macOS/Linux command">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="8" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>
            <span class="copy-label">Copy</span>
          </button>
        </div>
        <label>Windows PowerShell</label>
        <div class="command-row">
          <div class="command-scroll"><pre><code id="ieti-powershell-command">${escapeHtml(powershellCommand)}</code></pre></div>
          <button type="button" class="copy-command secondary" data-copy-command data-copy-target="ieti-powershell-command" data-copy-value="${escapeHtml(powershellCommand)}" title="Copy Windows PowerShell command" aria-label="Copy Windows PowerShell command">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="8" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>
            <span class="copy-label">Copy</span>
          </button>
        </div>
        <script>
          (function(){
            function copyText(text) {
              if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
              var area = document.createElement('textarea');
              area.value = text;
              area.setAttribute('readonly', '');
              area.style.position = 'fixed';
              area.style.opacity = '0';
              document.body.appendChild(area);
              area.select();
              var copied = document.execCommand('copy');
              area.remove();
              return copied ? Promise.resolve() : Promise.reject(new Error('Copy failed'));
            }
            document.querySelectorAll('[data-copy-command]').forEach(function(button){
              button.addEventListener('click', function(){
                var target = document.getElementById(button.dataset.copyTarget);
                var label = button.querySelector('.copy-label');
                var text = button.dataset.copyValue || (target && target.textContent);
                if (!text || !label) return;
                copyText(text).then(function(){
                  label.textContent = 'Copied';
                  window.setTimeout(function(){ label.textContent = 'Copy'; }, 1600);
                }).catch(function(){
                  label.textContent = 'Copy failed';
                  window.setTimeout(function(){ label.textContent = 'Copy'; }, 1600);
                });
              });
            });
          })();
        </script>
      </div>
      ${renderActiveModels(req, models)}
      <h2>Recent usage</h2>
      <div class="dashboard-section">${usageLimitCards(models[0]?.group, usage)}</div>
      <div class="dashboard-section">${dailyUsageCard(usageByDay)}</div>
      <script src="/portal/assets/dashboard-usage.js" defer></script>
      <div class="dashboard-section">
        <table>
          <thead><tr><th>When</th><th>Model</th><th>Input</th><th>Output</th><th>Total</th><th>Status</th></tr></thead>
          <tbody>${usageRows || '<tr><td colspan="6" class="muted">No usage yet.</td></tr>'}</tbody>
        </table>
      </div>
    `
  });
});

router.post('/portal/settings/name', requireApprovedStudentSession, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.redirect('/portal/settings');
  if (name.length > NAME_MAX_LENGTH) return res.redirect('/portal/settings?name_error=1');
  getDb().prepare('UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, req.portalUser.id);
  res.redirect('/portal/settings?name_saved=1');
});

router.post('/portal/settings/password', requireApprovedStudentSession, async (req, res, next) => {
  const user = req.portalUser;
  const currentPassword = String(req.body.current_password || '');
  const newPassword = String(req.body.new_password || '');
  const confirmPassword = String(req.body.confirm_password || '');
  let passwordChangedAt;
  try {
    if (newPassword.length < 10 || newPassword !== confirmPassword || !await verifyPassword(currentPassword, user.password_hash)) {
      return res.redirect('/portal/settings?password_error=1');
    }
    passwordChangedAt = await setPasswordFromInvite(user.id, newPassword);
  } catch (error) {
    return next(error);
  }
  req.session.regenerate((error) => {
    if (error) return res.status(500).send('Password saved, but the session could not be renewed. Log in with your new password.');
    setStudentSession(req, user.id, passwordChangedAt);
    res.redirect('/portal/settings?password_saved=1');
  });
});

router.get('/portal/settings', requireApprovedStudentSession, (req, res) => {
  const user = req.portalUser;
  const apiKeys = listUserApiKeys(user.id);
  const canAddApiKey = apiKeys.length < MAX_USER_API_KEYS;
  const pendingApiKey = canAddApiKey ? (getPendingSecret(req.sessionID, PENDING_API_KEY) || '') : '';
  const keyNameError = req.query.key_error === 'duplicate'
    ? 'That key name is already in use. Choose another name.'
    : req.query.key_error === 'invalid'
      ? `Enter a unique key name with 1-${KEY_NAME_MAX_LENGTH} characters.`
      : '';
  const apiKeyLimitMessage = `Only ${MAX_USER_API_KEYS} API keys per user are allowed.`;
  const existingKeyNames = JSON.stringify(apiKeys.map((apiKey) => apiKey.name)).replaceAll('<', '\\u003c');
  const apiKeyRows = apiKeys.map((apiKey) => `
    <tr>
      <td>${escapeHtml(apiKey.name)}</td>
      <td><code>${escapeHtml(`${apiKey.api_key_prefix || 'ieti_sk_'}...${apiKey.api_key_suffix || ''}`)}</code></td>
      <td>${escapeHtml(apiKey.created_at)}</td>
      <td class="actions"><form class="delete-api-key-form" method="post" action="/portal/key/${apiKey.id}/revoke" data-key-name="${escapeHtml(apiKey.name)}"><button type="submit" class="danger">Delete</button></form></td>
    </tr>
  `).join('');
  render(req, res, {
    title: 'Settings',
    message: '',
    content: `
      <h1>Settings</h1>
      ${req.query.created ? '<div class="notice">API key added.</div>' : ''}
      ${req.query.revoked ? '<div class="notice">API key deleted.</div>' : ''}
      ${req.query.key_error === 'limit' ? `<div class="notice" style="background:#fee;color:#c33">${apiKeyLimitMessage} Delete an existing key before adding another.</div>` : ''}
      ${req.query.name_saved ? '<div class="notice">Name updated.</div>' : ''}
      ${req.query.name_error ? `<div class="notice" style="background:#fee;color:#c33">The name must be at most ${NAME_MAX_LENGTH} characters.</div>` : ''}
      ${req.query.password_error ? '<div class="notice" style="background:#fee;color:#c33">Current password is incorrect, the new password is shorter than 10 characters, or the passwords do not match.</div>' : ''}
      ${req.query.password_saved ? '<div class="notice">Password updated.</div>' : ''}
      <div class="panel" style="margin-top:16px">
        <h2>API keys</h2>
        ${apiKeys.length ? `
        <table>
          <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>${apiKeyRows}</tbody>
        </table>
        ` : '<p class="muted">No API keys configured.</p>'}
        <div class="actions" style="margin-top:16px">
          ${canAddApiKey
            ? '<form method="post" action="/portal/key/regenerate"><button type="submit">Add API key</button></form>'
            : `<span class="muted">${apiKeyLimitMessage}</span>`}
        </div>
      </div>
      <dialog id="delete-api-key-modal" class="modal">
        <h2>Delete API key?</h2>
        <p>This will revoke <strong id="delete-api-key-name"></strong>. Applications using it will stop working.</p>
        <form id="delete-api-key-confirm-form" method="post">
          <div class="actions">
            <button type="button" id="cancel-delete-api-key" class="secondary">Cancel</button>
            <button type="submit" class="danger">Delete</button>
          </div>
        </form>
      </dialog>
      <script>
        (function(){
          var modal = document.getElementById('delete-api-key-modal');
          var confirmForm = document.getElementById('delete-api-key-confirm-form');
          var keyName = document.getElementById('delete-api-key-name');
          var cancelButton = document.getElementById('cancel-delete-api-key');
          function closeModal() {
            if (!modal || !modal.open) return;
            modal.classList.add('is-closing');
            window.setTimeout(function(){ modal.close(); modal.classList.remove('is-closing'); }, 150);
          }
          if (!modal || !confirmForm) return;
          modal.addEventListener('cancel', function(event){ event.preventDefault(); closeModal(); });
          if (cancelButton) cancelButton.addEventListener('click', closeModal);
          document.querySelectorAll('.delete-api-key-form').forEach(function(form){
            form.addEventListener('submit', function(event){
              event.preventDefault();
              confirmForm.action = form.action;
              keyName.textContent = form.dataset.keyName || 'this key';
              modal.showModal();
            });
          });
        })();
      </script>
      ${pendingApiKey ? `
      <dialog id="api-key-modal" class="modal">
        <h2>Add API key</h2>
        <p>Copy this key now. It will not be shown again after you add it.</p>
        <div class="key" style="display:flex;gap:8px;align-items:center;margin:16px 0">
          <code id="new-api-key" style="flex:1;word-break:break-all">${escapeHtml(pendingApiKey)}</code>
          <button type="button" id="copy-key-btn" class="secondary">Copy</button>
        </div>
        <form method="post" action="/portal/key/add">
          <label for="api-key-name">Key name</label>
          <input id="api-key-name" name="key_name" maxlength="${KEY_NAME_MAX_LENGTH}" autocomplete="off" required>
          <p id="api-key-name-error" class="error" style="display:${keyNameError ? 'block' : 'none'}">${escapeHtml(keyNameError)}</p>
          <div class="actions" style="justify-content:flex-end;margin-top:16px">
            <button type="submit" id="add-key-btn" disabled>Add key</button>
          </div>
        </form>
      </dialog>
      <script>
        (function(){
          var modal = document.getElementById('api-key-modal');
          var nameInput = document.getElementById('api-key-name');
          var addButton = document.getElementById('add-key-btn');
          var error = document.getElementById('api-key-name-error');
          var existingNames = new Set(${existingKeyNames}.map(function(name){ return name.toLocaleLowerCase(); }));
          function updateNameState() {
            var value = nameInput.value.trim();
            var duplicate = existingNames.has(value.toLocaleLowerCase());
            var valid = value.length > 0 && value.length <= ${KEY_NAME_MAX_LENGTH} && !/[\\u0000-\\u001f\\u007f]/.test(value) && !duplicate;
            addButton.disabled = !valid;
            if (duplicate) error.textContent = 'That key name is already in use. Choose another name.';
            else if (value.length > ${KEY_NAME_MAX_LENGTH}) error.textContent = 'The key name is too long.';
            else if (value.length > 0 && /[\\u0000-\\u001f\\u007f]/.test(value)) error.textContent = 'The key name contains invalid characters.';
            error.style.display = valid || value.length === 0 ? 'none' : 'block';
          }
          function closeModal() {
            if (!modal || !modal.open) return;
            modal.classList.add('is-closing');
            window.setTimeout(function(){ modal.close(); modal.classList.remove('is-closing'); }, 150);
          }
          if (modal) {
            modal.addEventListener('cancel', function(event){ event.preventDefault(); closeModal(); });
            modal.showModal();
          }
          if (nameInput) { nameInput.addEventListener('input', updateNameState); nameInput.focus(); updateNameState(); }
          var copyButton = document.getElementById('copy-key-btn');
          if (copyButton) copyButton.addEventListener('click', function(){
            navigator.clipboard.writeText(${JSON.stringify(pendingApiKey)}).then(function(){ copyButton.textContent = 'Copied'; });
          });
        })();
      </script>
      ` : ''}
      <div class="panel" style="margin-top:16px">
        <h2>Account</h2>
        <form method="post" action="/portal/settings/name" style="margin-bottom:16px">
          <label>Name</label>
          <input name="name" value="${escapeHtml(user.name)}" maxlength="${NAME_MAX_LENGTH}" required>
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

router.post('/portal/key/regenerate', requireApprovedStudentSession, (req, res) => {
  if (listUserApiKeys(req.portalUser.id).length >= MAX_USER_API_KEYS) {
    return res.status(409).send(`Only ${MAX_USER_API_KEYS} API keys per user are allowed. Delete an existing key before adding another.`);
  }
  setPendingSecret(req.sessionID, PENDING_API_KEY, generateStudentKey());
  res.redirect('/portal/settings?new_key=1');
});

router.post('/portal/key/add', requireApprovedStudentSession, (req, res) => {
  const pendingKey = getPendingSecret(req.sessionID, PENDING_API_KEY);
  if (!pendingKey) return res.redirect('/portal/settings');
  const name = normalizeApiKeyName(req.body.key_name);
  if (!name) return res.redirect('/portal/settings?new_key=1&key_error=invalid');
  if (hasUserApiKeyName(req.portalUser.id, name)) return res.redirect('/portal/settings?new_key=1&key_error=duplicate');
  try {
    createUserApiKey(req.portalUser.id, name, pendingKey);
  } catch (error) {
    if (error.code === 'max_api_keys') {
      return res.status(409).send(`${error.message} Delete an existing key before adding another.`);
    }
    if (String(error.code || '').includes('SQLITE_CONSTRAINT')) {
      return res.redirect('/portal/settings?new_key=1&key_error=duplicate');
    }
    throw error;
  }
  clearPendingSecret(req.sessionID, PENDING_API_KEY);
  res.redirect('/portal/settings?created=1');
});

router.post('/portal/key/dismiss-modal', requireApprovedStudentSession, (req, res) => {
  clearPendingSecret(req.sessionID, PENDING_API_KEY);
  res.redirect('/portal/settings');
});

router.post('/portal/key/:keyId/revoke', requireApprovedStudentSession, (req, res) => {
  const keyId = Number.parseInt(req.params.keyId, 10);
  if (Number.isInteger(keyId)) revokeUserApiKey(req.portalUser.id, keyId);
  res.redirect('/portal/settings?revoked=1');
});

router.get('/portal/opencode.json', requireApprovedStudentSession, (req, res) => {
  const user = req.portalUser;
  const models = getActiveModelsForUser(user);
  const apiKey = '{file:.secrets/agents_server_key}';
  const opencodeConfig = buildOpenCodeConfig({ req, models, apiKey });

  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="opencode.json"',
    'Cache-Control': 'no-store'
  });
  res.send(`${JSON.stringify(opencodeConfig, null, 2)}\n`);
});

function sendClientScript(req, res, filename) {
  const source = fs.readFileSync(path.join(CLIENT_SCRIPT_DIRECTORY, filename), 'utf8');
  // Always embed this server's own API URL. Accepting it from the query string would let a
  // crafted link on this domain hand out a script that sends students' keys elsewhere.
  const defaultBaseUrl = getNormalizedRequestBaseUrl(req);
  const baseUrlReplacement = filename.endsWith('.sh')
    ? defaultBaseUrl.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')
    : defaultBaseUrl.replaceAll("'", "''");
  // Preserve literal replacement tokens such as $& in the URL.
  const script = source.replace('__IETI_DEFAULT_BASE_URL__', () => baseUrlReplacement);
  res.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store'
  });
  res.send(script);
}

router.get('/downloads/set_agents_opencode.sh', (req, res) => {
  sendClientScript(req, res, 'set_agents_opencode.sh');
});

router.get('/downloads/set_agents_opencode.ps1', (req, res) => {
  sendClientScript(req, res, 'set_agents_opencode.ps1');
});

module.exports = router;
