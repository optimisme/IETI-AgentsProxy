const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
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
const { verifyAdminCredentials } = require('../middleware/authAdmin');
const { getUsageTotals, recentUsage } = require('../services/usageService');
const { getSetting } = require('../services/settingsService');
const { getEnabledModelEntries } = require('../services/providerService');
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
const { REASONING_EFFORTS } = require('../utils/reasoning');
const {
  escapeHtml,
  flash,
  getRequestBaseUrl: requestBaseUrl,
  quotaLimitCards,
  trustedHtml
} = require('../utils/html');

const router = express.Router();
const OPENCODE_DEFAULT_OUTPUT_LIMIT = 8192;
const CLIENT_SCRIPT_DIRECTORY = path.resolve(__dirname, '..', '..', 'assets');
const BUILD_LITE_ARCHIVE_FILE = path.join(CLIENT_SCRIPT_DIRECTORY, 'buildlite_harness.zip');

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

function getScriptDefaultBaseUrl(req) {
  const configured = normalizeAgentBaseUrl(req.query?.default_base_url);
  return configured || getNormalizedRequestBaseUrl(req);
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
  const defaultBaseUrl = getScriptDefaultBaseUrl(req);
  const query = defaultBaseUrl ? `?default_base_url=${encodeURIComponent(defaultBaseUrl)}` : '';
  return `${getWebsiteBaseUrl(req)}/downloads/${filename}${query}`;
}

function getClientScriptCommand(req, filename) {
  const scriptUrl = getClientScriptUrl(req, filename);
  if (filename.endsWith('.sh')) {
    return `bash -c "$(curl -fsSL ${shellQuote(scriptUrl)})"`;
  }
  return `$p=Join-Path $env:TEMP 'ieti-set-agents-server.ps1'; Invoke-WebRequest -UseBasicParsing -Uri ${powershellQuote(scriptUrl)} -OutFile $p; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p; Remove-Item $p -Force`;
}

function getBuildLiteScriptCommand(req, filename) {
  const scriptUrl = `${getWebsiteBaseUrl(req)}/downloads/${filename}`;
  if (filename.endsWith('.sh')) {
    return `bash -c "$(curl -fsSL ${shellQuote(scriptUrl)})"`;
  }
  return `$p=Join-Path $env:TEMP 'ieti-set-harness-buildlite.ps1'; Invoke-WebRequest -UseBasicParsing -Uri ${powershellQuote(scriptUrl)} -OutFile $p; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p; Remove-Item $p -Force`;
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
      capabilities: {
        text: false,
        image: false,
        tools: false,
        reasoning: false,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        chatTemplateKwargs: false,
        parallelTools: false
      },
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
    current.capabilities.text ||= entry.capabilities?.text ?? true;
    current.capabilities.image ||= entry.capabilities?.image ?? true;
    current.capabilities.tools ||= entry.capabilities?.tools ?? true;
    current.capabilities.reasoning ||= entry.capabilities?.reasoning ?? true;
    current.capabilities.reasoningEfforts = REASONING_EFFORTS.filter((effort) =>
      current.capabilities.reasoningEfforts.includes(effort) || entry.capabilities?.reasoningEfforts?.includes(effort));
    if (!current.capabilities.defaultReasoningEffort &&
        current.capabilities.reasoningEfforts.includes(entry.capabilities?.defaultReasoningEffort)) {
      current.capabilities.defaultReasoningEffort = entry.capabilities.defaultReasoningEffort;
    }
    current.capabilities.chatTemplateKwargs ||= entry.capabilities?.chatTemplateKwargs ?? false;
    current.capabilities.parallelTools ||= entry.capabilities?.parallelTools ?? true;
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
  req.session.regenerate((error) => {
    if (error) return res.status(500).send('Password saved, but the session could not be created. Log in with your new password.');
    req.session.studentUserId = user.id;
    res.redirect('/portal');
  });
});

router.get('/portal', requireStudentSession, (req, res) => {
  const user = req.portalUser;
  const usage = getUsageTotals(user.id);
  const models = getActiveModelsForUser(user);
  const shellCommand = getClientScriptCommand(req, 'set_agents_opencode.sh');
  const powershellCommand = getClientScriptCommand(req, 'set_agents_opencode.ps1');
  const buildLiteShellCommand = getBuildLiteScriptCommand(req, 'set_harness_buildlite.sh');
  const buildLitePowerShellCommand = getBuildLiteScriptCommand(req, 'set_harness_buildlite.ps1');
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
      ${usageLimitCards(models[0]?.group, usage)}
      <div class="panel" style="margin-top:16px">
        <h2>OpenCode configuration</h2>
        <p>Run the command for your operating system. It downloads the configuration script from this server, stores the IETI Agents key in <code>.secrets/agents_server_key</code>, and updates <code>opencode.json</code>.</p>
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
        <p class="muted">Manage your API keys from <a href="/portal/settings">Settings</a>.</p>
      </div>
      <div class="panel" style="margin-top:16px">
        <h2>BuildLite Configuration</h2>
        <p>Run the command for your operating system. It downloads and extracts the BuildLite harness into the current project folder, keeping <code>.agents/</code> and <code>AGENTS.md</code> at the project root. It then creates <code>.opencode</code> as a link to <code>.agents</code>.</p>
        <label>macOS/Linux</label>
        <div class="command-row">
          <div class="command-scroll"><pre><code id="buildlite-shell-command">${escapeHtml(buildLiteShellCommand)}</code></pre></div>
          <button type="button" class="copy-command secondary" data-copy-command data-copy-target="buildlite-shell-command" data-copy-value="${escapeHtml(buildLiteShellCommand)}" title="Copy BuildLite macOS/Linux command" aria-label="Copy BuildLite macOS/Linux command">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="8" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2-2-2h10c1.1 0 2 .9 2 2"></path></svg>
            <span class="copy-label">Copy</span>
          </button>
        </div>
        <label>Windows PowerShell</label>
        <div class="command-row">
          <div class="command-scroll"><pre><code id="buildlite-powershell-command">${escapeHtml(buildLitePowerShellCommand)}</code></pre></div>
          <button type="button" class="copy-command secondary" data-copy-command data-copy-target="buildlite-powershell-command" data-copy-value="${escapeHtml(buildLitePowerShellCommand)}" title="Copy BuildLite Windows PowerShell command" aria-label="Copy BuildLite Windows PowerShell command">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="8" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2-2-2h10c1.1 0 2 .9 2 2"></path></svg>
            <span class="copy-label">Copy</span>
          </button>
        </div>
        <p class="muted">Linux creates a symbolic link with <code>.opencode -&gt; .agents</code>. Windows creates a directory junction with <code>mklink /J .opencode .agents</code>.</p>
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
              if (button.dataset.copyReady) return;
              button.dataset.copyReady = '1';
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
  const apiKeys = listUserApiKeys(user.id);
  const canAddApiKey = apiKeys.length < MAX_USER_API_KEYS;
  const pendingApiKey = canAddApiKey ? (req.session.pendingStudentApiKey?.key || '') : '';
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
      ${req.query.password_error ? '<div class="notice" style="background:#fee;color:#c33">Current password is incorrect or passwords do not match.</div>' : ''}
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
  if (listUserApiKeys(req.portalUser.id).length >= MAX_USER_API_KEYS) {
    return res.status(409).send(`Only ${MAX_USER_API_KEYS} API keys per user are allowed. Delete an existing key before adding another.`);
  }
  const key = generateStudentKey();
  req.session.pendingStudentApiKey = { key };
  res.redirect('/portal/settings?new_key=1');
});

router.post('/portal/key/add', requireStudentSession, (req, res) => {
  const pending = req.session.pendingStudentApiKey;
  if (!pending?.key) return res.redirect('/portal/settings');
  const name = normalizeApiKeyName(req.body.key_name);
  if (!name) return res.redirect('/portal/settings?new_key=1&key_error=invalid');
  if (hasUserApiKeyName(req.portalUser.id, name)) return res.redirect('/portal/settings?new_key=1&key_error=duplicate');
  try {
    createUserApiKey(req.portalUser.id, name, pending.key);
  } catch (error) {
    if (error.code === 'max_api_keys') {
      return res.status(409).send(`${error.message} Delete an existing key before adding another.`);
    }
    if (String(error.code || '').includes('SQLITE_CONSTRAINT')) {
      return res.redirect('/portal/settings?new_key=1&key_error=duplicate');
    }
    throw error;
  }
  req.session.pendingStudentApiKey = null;
  res.redirect('/portal/settings?created=1');
});

router.post('/portal/key/dismiss-modal', requireStudentSession, (req, res) => {
  req.session.pendingStudentApiKey = null;
  res.redirect('/portal/settings');
});

router.post('/portal/key/:keyId/revoke', requireStudentSession, (req, res) => {
  const keyId = Number.parseInt(req.params.keyId, 10);
  if (Number.isInteger(keyId)) revokeUserApiKey(req.portalUser.id, keyId);
  res.redirect('/portal/settings?revoked=1');
});

router.get('/portal/opencode.json', requireStudentSession, (req, res) => {
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
  const defaultBaseUrl = getScriptDefaultBaseUrl(req);
  const baseUrlReplacement = filename.endsWith('.sh')
    ? defaultBaseUrl.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')
    : defaultBaseUrl.replaceAll("'", "''");
  const buildLiteArchiveUrl = `${getWebsiteBaseUrl(req)}/downloads/buildlite_harness.zip`;
  const buildLiteArchiveReplacement = filename.endsWith('.sh')
    ? buildLiteArchiveUrl.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')
    : buildLiteArchiveUrl.replaceAll("'", "''");
  const script = source
    .replaceAll('__IETI_DEFAULT_BASE_URL__', baseUrlReplacement)
    .replaceAll('__IETI_BUILD_LITE_ZIP_URL__', buildLiteArchiveReplacement);
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

router.get('/downloads/set_harness_buildlite.sh', (req, res) => {
  sendClientScript(req, res, 'set_harness_buildlite.sh');
});

router.get('/downloads/set_harness_buildlite.ps1', (req, res) => {
  sendClientScript(req, res, 'set_harness_buildlite.ps1');
});

router.get('/downloads/buildlite_harness.zip', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.download(BUILD_LITE_ARCHIVE_FILE, 'buildlite_harness.zip', next);
});

module.exports = router;
