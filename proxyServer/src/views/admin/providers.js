// Markup of the admin pages for providers.
const {
  parseReasoningEfforts,
  normalizeReasoningEffort,
  REASONING_EFFORTS
} = require('../../utils/reasoning');
const { AUTOCONFIGURE_TOTAL_STAGES } = require('../../services/providerProbeService');
const { maskSecret } = require('../../services/settingsService');
const { joinHtml, html } = require('../../utils/html');

function providerModelContract(model = {}, defaults = {}) {
  return {
    contextLimit: Number(model.context_limit || defaults.context),
    outputLimit: Number(model.output_limit || defaults.output),
    text: Number(model.supports_text_input) === 1,
    image: Number(model.supports_image_input) === 1,
    maxImages: Number(model.supports_image_input) === 1 && Number(model.max_images) > 0 ? Number(model.max_images) : null,
    tools: Number(model.supports_tools) === 1,
    reasoning: Number(model.supports_reasoning) === 1,
    reasoningEfforts: parseReasoningEfforts(model.reasoning_efforts),
    defaultReasoningEffort: normalizeReasoningEffort(model.default_reasoning_effort),
    chatTemplateKwargs: Number(model.supports_chat_template_kwargs) === 1,
    parallelTools: Number(model.supports_parallel_tools) === 1
  };
}

function alignmentValue(value, field) {
  if (field === 'contextLimit' || field === 'outputLimit') return Number(value || 0).toLocaleString('en-US');
  if (field === 'reasoningEfforts') {
    if (value === null) return 'provider managed';
    return value.length ? joinHtml(value, ', ') : 'none selectable';
  }
  if (field === 'defaultReasoningEffort') return value || 'provider default';
  if (field === 'maxImages') return value === null ? 'unlimited' : String(value);
  return value ? 'supported' : 'not supported';
}

function modelCapabilitySummary(model, defaults) {
  const contract = providerModelContract(model, defaults);
  const capabilities = [
    contract.text ? 'Text' : null,
    contract.image ? (contract.maxImages === null ? 'Images' : `Images (max ${contract.maxImages})`) : null,
    contract.tools ? 'Tools' : null,
    contract.parallelTools ? 'Parallel tools' : null,
    contract.reasoning
      ? `Reasoning: ${alignmentValue(contract.reasoningEfforts, 'reasoningEfforts')}`
      : null,
    contract.chatTemplateKwargs ? 'Chat template overrides' : null
  ].filter(Boolean);
  return capabilities.length
    ? joinHtml(capabilities.map((capability) => html`<span class="feature-chip">${capability}</span>`))
    : html`<span class="muted">No capabilities declared</span>`;
}

function modelMappingFields(model = {}, defaults = {}) {
  const capability = (name) => model[name] === undefined || Number(model[name]) === 1;
  const reasoningEfforts = parseReasoningEfforts(model.reasoning_efforts) || [];
  const defaultReasoningEffort = normalizeReasoningEffort(model.default_reasoning_effort) || '';
  return html`
    <h2>Active Model Mapping</h2>
    <label>Upstream model name</label><input name="upstream_model" value="${model.upstream_model || ''}" required>
    <label>Context limit</label><input name="context_limit" type="number" min="0" value="${model.context_limit ?? defaults.context}">
    <label>Output limit</label><input name="output_limit" type="number" min="0" value="${model.output_limit ?? defaults.output}">
    <h3>Capabilities</h3>
    <p class="muted">Capabilities are aggregated and published automatically to Codex and OpenCode.</p>
    <input type="hidden" name="supports_text_input" value="0"><label><input name="supports_text_input" type="checkbox" value="1" style="width:auto" ${capability('supports_text_input') ? 'checked' : ''}> Text input</label>
    <input type="hidden" name="supports_image_input" value="0"><label><input name="supports_image_input" type="checkbox" value="1" style="width:auto" ${capability('supports_image_input') ? 'checked' : ''}> Image input</label>
    <div class="max-images-field">
      <label>Max images per request <span class="muted" style="display:block;font-weight:400">Blank or 0 means unlimited. Set it to the upstream's own cap (for example vLLM <code>--limit-mm-per-prompt</code>) so oversized requests are rejected before they reach the provider.</span></label>
      <input name="max_images" type="number" min="0" value="${model.max_images ?? ''}" placeholder="Unlimited">
    </div>
    <input type="hidden" name="supports_tools" value="0"><label><input name="supports_tools" type="checkbox" value="1" style="width:auto" ${capability('supports_tools') ? 'checked' : ''}> Tool calling</label>
    <input type="hidden" name="supports_reasoning" value="0"><label><input name="supports_reasoning" type="checkbox" value="1" style="width:auto" ${capability('supports_reasoning') ? 'checked' : ''}> Reasoning</label>
    <fieldset style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:8px 0 12px">
      <legend>Reasoning controls</legend>
      <p class="muted">Select only levels accepted by this upstream model. Leave all levels unselected for models with provider-managed reasoning and no selectable effort.</p>
      <input type="hidden" name="reasoning_efforts_present" value="1">
      <div class="actions">
        ${joinHtml(REASONING_EFFORTS.map((effort) => html`<label><input name="reasoning_efforts" type="checkbox" value="${effort}" style="width:auto" ${reasoningEfforts.includes(effort) ? 'checked' : ''}> ${effort}</label>`))}
      </div>
      <label>Reasoning history field</label>
      <select name="reasoning_history_field">
        <option value="">Forward history unchanged</option>
        ${joinHtml(['reasoning', 'reasoning_content'].map((field) => html`<option value="${field}" ${model.reasoning_history_field === field ? 'selected' : ''}>${field}</option>`))}
      </select>
      <p class="muted">For upstreams requiring reasoning in assistant history. Existing reasoning is preserved; missing history uses an empty string.</p>
      <label>Default reasoning effort</label>
      <select name="default_reasoning_effort">
        <option value="">Provider default</option>
        ${joinHtml(REASONING_EFFORTS.map((effort) => html`<option value="${effort}" ${defaultReasoningEffort === effort ? 'selected' : ''}>${effort}</option>`))}
      </select>
      <input type="hidden" name="supports_chat_template_kwargs" value="0"><label><input name="supports_chat_template_kwargs" type="checkbox" value="1" style="width:auto" ${Number(model.supports_chat_template_kwargs || 0) === 1 ? 'checked' : ''}> Allow restricted vLLM chat template overrides</label>
      <p class="muted">Only <code>enable_thinking</code>, <code>preserve_thinking</code>, and <code>reasoning_effort</code> are accepted.</p>
    </fieldset>
    <input type="hidden" name="supports_parallel_tools" value="0"><label><input name="supports_parallel_tools" type="checkbox" value="1" style="width:auto" ${capability('supports_parallel_tools') ? 'checked' : ''}> Parallel tool calls</label>
  `;
}

function slugTakenNotice(slug, owner) {
  return html`
    <div class="error">
      The slug <code>${slug}</code> is already used by <a href="/admin/providers/${owner.id}">${owner.name}</a>.
      Nothing was saved. Choose a different slug.
    </div>
  `;
}

function providerForm(provider = {}, action = '/admin/providers', { model = {}, defaults = {}, copySource = null, copyApiKey = true } = {}) {
  const deleteFormId = provider.id ? html`provider-delete-${provider.id}` : '';
  const deleteModalId = provider.id ? html`provider-delete-modal-${provider.id}` : '';
  const autoconfigureModalId = provider.id ? html`provider-autoconfigure-modal-${provider.id}` : '';
  const providerTestModalId = provider.id ? html`provider-test-modal-${provider.id}` : '';
  const keepWarmSelectId = html`provider-keep-warm-${provider.id || 'new'}`;
  return html`
    <form method="post" action="${action}" class="panel" data-provider-settings-form>
      <h2>Provider Settings</h2>
      <label>Provider slug</label><input name="slug" value="${provider.slug}" required>
      <label>Name</label><input name="name" value="${provider.name}" required>
      <label>Base URL${copySource ? html` <span class="muted" style="display:block;font-weight:400">Copied from ${copySource.name}. Change it if the copy points at a different server.</span>` : ''}</label><input name="base_url" value="${provider.base_url}" placeholder="http://127.0.0.1:8001" required>
      <label>Maximum concurrent requests. Blank or 0 means infinite.</label><input name="max_concurrent_requests" type="number" min="0" value="${provider.max_concurrent_requests ?? ''}">
      <label>Timeout milliseconds. Blank uses the server default.</label><input name="timeout_ms" type="number" min="0" value="${provider.timeout_ms ?? ''}">
      <label><input name="enabled" type="checkbox" value="1" style="width:auto" ${provider.enabled === 0 ? '' : 'checked'}> Provider enabled</label>
      <label for="${keepWarmSelectId}">Keep warm calling</label>
      <select id="${keepWarmSelectId}" name="keep_warm_interval_minutes">
        ${joinHtml([[0, 'Never'], [1, '1 min'], [5, '5 min']].map(([minutes, label]) => html`<option value="${minutes}" ${Number(provider.keep_warm_interval_minutes || 0) === minutes ? 'selected' : ''}>${label}</option>`))}
      </select>
      <p class="muted">No calls are sent when set to Never. Other options send a tiny completion at the selected interval when this provider and a model are enabled. May consume billable tokens; does not use student quota.</p>
      ${copySource ? html`
        <input type="hidden" name="copy_from" value="${copySource.id}">
        ${copySource.api_key ? html`<label><input name="copy_api_key" type="checkbox" value="1" style="width:auto" ${copyApiKey ? 'checked' : ''}> Use the same API key as ${copySource.name}</label>` : ''}
      ` : ''}
      ${modelMappingFields(model, defaults)}
      <div class="form-actions">
        <div class="actions">
          <button type="submit">Save provider</button>
          ${provider.id ? html`<button type="button" class="danger" data-open-modal="${deleteModalId}">Delete provider</button>` : ''}
          ${provider.id ? html`<button type="button" class="secondary" data-autoconfigure-url="/admin/providers/${provider.id}/autoconfigure.json" data-autoconfigure-modal="${autoconfigureModalId}">Autoconfigure</button>` : ''}
        </div>
        ${provider.id ? html`<a class="button secondary" href="/admin/providers/new?from=${provider.id}">Duplicate provider</a>` : ''}
      </div>
    </form>
    ${provider.id ? html`
      <form id="${deleteFormId}" method="post" action="/admin/providers/${provider.id}/delete"></form>
      <dialog id="${deleteModalId}" class="modal" aria-labelledby="${deleteModalId}-title">
        <h2 id="${deleteModalId}-title">Delete provider?</h2>
        <p>This will permanently delete <strong>${provider.name}</strong> (<code>${provider.slug}</code>), its model mapping, and its group assignments.</p>
        <p class="muted">Existing usage history is preserved under the provider slug.</p>
        <div class="actions">
          <button type="button" class="secondary" data-close-modal>Cancel</button>
          <button type="submit" form="${deleteFormId}" class="danger">Delete provider</button>
        </div>
      </dialog>
      <dialog id="${autoconfigureModalId}" class="modal autoconfigure-modal" closedby="none" aria-labelledby="${autoconfigureModalId}-title" data-autoconfigure-url="/admin/providers/${provider.id}/autoconfigure.json">
        <h2 id="${autoconfigureModalId}-title" data-autoconfigure-title>Autoconfigure provider</h2>
        <p data-autoconfigure-status role="status" aria-live="polite">Connecting to the provider...</p>
        <div data-autoconfigure-progress>
          <progress max="${AUTOCONFIGURE_TOTAL_STAGES}" value="0" aria-label="Completed autoconfigure stages"></progress>
          <p class="muted">Catalog · Text · Assistant history · Tools · Images · Streaming. Retries stay within the same stage.</p>
          <p class="muted"><span data-autoconfigure-elapsed>0 seconds elapsed</span> · Tests can take up to four minutes.</p>
        </div>
        <p data-autoconfigure-help class="muted">Nothing has been saved. You can cancel testing at any time.</p>
        <div data-autoconfigure-picker hidden>
          <label for="${autoconfigureModalId}-model">Upstream model</label>
          <select id="${autoconfigureModalId}-model" data-autoconfigure-model disabled></select>
        </div>
        <section data-autoconfigure-review hidden>
          <h3>Settings to save</h3>
          <div class="autoconfigure-table"><table><thead><tr><th>Setting</th><th>Current</th><th>Detected</th></tr></thead><tbody data-autoconfigure-settings></tbody></table></div>
          <p class="muted">Official values take priority. Settings that could not be verified keep their current values.</p>
        </section>
        <ul data-autoconfigure-results class="autoconfigure-results" aria-label="Test results"></ul>
        <details data-autoconfigure-diagnostics hidden><summary>Technical details</summary><p data-autoconfigure-detail class="muted" style="white-space:pre-wrap;overflow-wrap:anywhere"></p></details>
        <div class="actions">
          <button type="button" class="secondary" data-cancel-autoconfigure>Cancel</button>
          <button type="button" class="secondary" data-retry-autoconfigure hidden>Try again</button>
          <button type="button" data-apply-autoconfigure hidden disabled>Apply and save</button>
        </div>
      </dialog>
      <script src="/admin/assets/provider-autoconfigure.js" defer></script>
      <dialog id="${providerTestModalId}" class="modal" aria-labelledby="${providerTestModalId}-title">
        <h2 id="${providerTestModalId}-title" data-test-title>Provider test result</h2>
        <p data-test-status class="muted" aria-live="polite">Running test request...</p>
        <p data-test-detail class="muted" style="white-space:pre-wrap"></p>
        <div class="actions">
          <button type="button" class="secondary" data-close-modal>Close</button>
        </div>
      </dialog>
    ` : ''}
  `;
}

function providerApiKeyStatus(provider) {
  return provider.api_key ? html`configured (${maskSecret(provider.api_key)})` : 'not configured';
}

function providersPage({ defaults, providers }) {
  const rows = joinHtml(providers.map((provider) => {
    const { model, pools } = provider;
    const contract = model.id ? providerModelContract(model, defaults) : null;
    return html`
      <tr>
        <td>
          <a href="/admin/providers/${provider.id}"><strong>${provider.name}</strong></a><br>
          <span class="muted">${provider.slug}</span>
        </td>
        <td>${model.upstream_model ? html`<code>${model.upstream_model}</code>` : html`<span class="muted">none</span>`}</td>
        <td>${contract ? html`${alignmentValue(contract.contextLimit, 'contextLimit')} / ${alignmentValue(contract.outputLimit, 'outputLimit')}` : html`<span class="muted">—</span>`}</td>
        <td><div class="feature-chips">${contract ? modelCapabilitySummary(model, defaults) : html`<span class="muted">—</span>`}</div></td>
        <td>
          <span class="${provider.enabled ? 'status-enabled' : 'status-disabled'}">${provider.enabled ? 'Enabled' : 'Disabled'}</span><br>
          <span class="muted">API key ${provider.api_key ? 'configured' : 'missing'}</span>
        </td>
        <td>${pools.length
          ? joinHtml(pools.map((pool) => html`<a href="/admin/pools/${pool.id}"><code>${pool.alias}</code></a>`), html`<br>`)
          : html`<span class="alignment-status alignment-warning" title="Students cannot reach a provider that is in no pool"><span aria-hidden="true">⚠</span> Not in a pool</span>`}</td>
        <td><a class="button secondary" href="/admin/providers/${provider.id}">Edit</a></td>
      </tr>
    `;
  }));
  const content = html`
    <div class="provider-list-heading">
      <div>
        <p class="muted">A provider is one upstream server and the model it serves. Students reach providers through <a href="/admin/pools">pools</a>, which set the model alias and balance requests.</p>
      </div>
      <a class="button" href="/admin/providers/new">Add provider</a>
    </div>
    <div class="provider-pool-table">
      <table>
        <thead><tr><th>Provider</th><th>Upstream model</th><th>Context / output</th><th>Features</th><th>Status</th><th>Pools</th><th>Actions</th></tr></thead>
        <tbody>${rows || html`<tr><td colspan="7" class="muted">No providers.</td></tr>`}</tbody>
      </table>
    </div>
  `;
  return content;
}

// provider is the stored provider; formProvider and formModel are what the settings form
// shows, which differ from the stored values only when a refused submission is shown again.
function providerPage({ defaults, formModel, formProvider, provider, providerPools }) {
  return html`
      <div class="provider-sections">
        <div class="panel">
          <h2>Pools</h2>
          ${providerPools.length
            ? html`<p>Published to students as ${joinHtml(providerPools.map((pool) => html`<a href="/admin/pools/${pool.id}"><code>${pool.alias}</code></a>`), ', ')}.</p>`
            : html`<p><span class="alignment-status alignment-warning"><span aria-hidden="true">⚠</span> Not in a pool</span> Students cannot reach this provider until it is added to a <a href="/admin/pools">pool</a>.</p>`}
        </div>
        ${providerForm(formProvider, `/admin/providers/${provider.id}`, { model: formModel, defaults })}
        <div class="panel">
          <h2>Provider API key</h2>
          <form id="provider-api-key-save-${provider.id}" method="post" action="/admin/providers/${provider.id}">
            <label>API key or local placeholder</label><input name="api_key" type="password" autocomplete="off" placeholder="${provider.api_key ? 'Leave blank to keep current value' : 'local'}">
          </form>
          <p class="muted">API key: ${providerApiKeyStatus(provider)}</p>
          <form id="provider-api-key-delete-${provider.id}" method="post" action="/admin/providers/${provider.id}/clear-key"></form>
          <div class="actions">
            <button type="submit" form="provider-api-key-save-${provider.id}">Save API key</button>
            <button type="submit" form="provider-api-key-delete-${provider.id}" class="danger" ${provider.api_key ? '' : 'disabled'}>Delete API key</button>
          </div>
        </div>
        <div class="panel">
          <h2>Test provider</h2>
          <div class="actions">
            <button type="button" data-test-url="/admin/providers/${provider.id}/test.json" data-test-modal="provider-test-modal-${provider.id}" data-test-title="Server test request result" data-test-running="Running server test request...">Run server test request</button>
            <button type="button" class="secondary" data-test-url="/admin/providers/${provider.id}/mapping/test.json" data-test-modal="provider-test-modal-${provider.id}" data-test-title="Mapping request result" data-test-running="Running mapping request...">Run mapping request</button>
          </div>
        </div>
      </div>
      <script>
        document.querySelectorAll('[data-test-url]').forEach((button) => {
          button.addEventListener('click', async () => {
            const target = document.getElementById(button.dataset.resultTarget);
            const modal = document.getElementById(button.dataset.testModal);
            const modalTitle = modal?.querySelector('[data-test-title]');
            const modalStatus = modal?.querySelector('[data-test-status]');
            const modalDetail = modal?.querySelector('[data-test-detail]');
            const originalText = button.textContent;
            const clearResult = () => {
              if (!target) return;
              window.clearTimeout(target._clearTimer);
              target._clearTimer = window.setTimeout(() => {
                target.className = 'muted';
                target.textContent = '';
              }, 2000);
            };
            button.disabled = true;
            button.textContent = 'Running...';
            if (modal && modalStatus && modalDetail) {
              if (modalTitle) modalTitle.textContent = button.dataset.testTitle || 'Provider test result';
              modalStatus.className = 'muted';
              modalStatus.textContent = button.dataset.testRunning || 'Running test request...';
              modalDetail.textContent = '';
              if (typeof modal.showModal === 'function') modal.showModal();
              else modal.setAttribute('open', '');
            }
            if (target) {
              window.clearTimeout(target._clearTimer);
              target.className = 'muted';
              target.textContent = 'Running test request...';
            }
            try {
              const response = await fetch(button.dataset.testUrl, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { Accept: 'application/json' }
              });
              const body = await response.json();
              const message = body.message || (response.ok ? 'Test completed.' : 'Test failed.');
              if (modalStatus && modalDetail) {
                modalStatus.className = body.ok ? 'notice' : 'error';
                modalStatus.textContent = message;
                modalDetail.textContent = body.detail || '';
              }
              if (target) {
                target.className = body.ok ? 'notice' : 'error';
                target.textContent = [message, body.detail || ''].filter(Boolean).join('\\n');
                clearResult();
              }
            } catch (error) {
              if (modalStatus && modalDetail) {
                modalStatus.className = 'error';
                modalStatus.textContent = error.message || 'Test request failed.';
                modalDetail.textContent = '';
              }
              if (target) {
                target.className = 'error';
                target.textContent = error.message || 'Test request failed.';
                clearResult();
              }
            } finally {
              button.disabled = false;
              button.textContent = originalText;
            }
          });
        });

        document.querySelectorAll('[data-open-modal]').forEach((button) => {
          button.addEventListener('click', () => {
            const modal = document.getElementById(button.dataset.openModal);
            if (!modal) return;
            if (typeof modal.showModal === 'function') modal.showModal();
            else modal.setAttribute('open', '');
          });
        });
        document.querySelectorAll('[data-close-modal]').forEach((button) => {
          button.addEventListener('click', () => {
            const modal = button.closest('dialog');
            if (!modal) return;
            if (typeof modal.close === 'function') modal.close();
            else modal.removeAttribute('open');
          });
        });
      </script>
    `;
}

module.exports = {
  alignmentValue,
  modelCapabilitySummary,
  modelMappingFields,
  providerApiKeyStatus,
  providerForm,
  providerModelContract,
  providerPage,
  providersPage,
  slugTakenNotice
};
