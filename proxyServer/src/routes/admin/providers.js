// Admin pages for providers: connection, model mapping, tests, autoconfiguration and duplication.
const express = require('express');
const config = require('../../config');
const { getDb } = require('../../db');
const { requireAdmin } = require('../../middleware/authAdmin');
const { getSetting, maskSecret } = require('../../services/settingsService');
const {
  discoverProviderMetadata,
  listProviders,
  testProvider,
  reserveProviderForTest
} = require('../../services/providerService');
const { probeProviderModel, AUTOCONFIGURE_TOTAL_STAGES } = require('../../services/providerProbeService');
const { SETTING_FIELDS } = require('../../utils/providerMetadata');
const { poolsForProvider } = require('../../services/poolService');
const { apiError } = require('../../utils/errors');
const {
  REASONING_EFFORTS,
  normalizeReasoningEffort,
  parseReasoningEfforts,
  serializeReasoningEfforts
} = require('../../utils/reasoning');
const { escapeHtml, flash } = require('../../utils/html');
const {
  nonNegativeIntegerOrNull,
  optionalText,
  requiredText,
  slug: validateSlug,
  url: validateUrl
} = require('../../utils/validation');
const { activeProviderModel, render, tokens } = require('./shared');

const router = express.Router();

function slugify(value) {
  return validateSlug(value, 'Provider slug');
}

function testResultPayload(label, result) {
  const detailParts = [];
  if (result.errorMessage) detailParts.push(`Upstream error: ${result.errorMessage}`);
  if (result.diagnostics?.warnings?.length) detailParts.push(`Configuration: ${result.diagnostics.warnings.join(' ')}`);
  if (result.diagnostics?.baseUrl) detailParts.push(`Base URL: ${result.diagnostics.baseUrl}`);
  if (result.diagnostics?.model) detailParts.push(`Model: ${result.diagnostics.model}`);
  return {
    ok: result.ok,
    status: result.status,
    message: `${label} ${result.ok ? 'passed' : 'failed'}${result.status ? ` with status ${result.status}` : ''}.`,
    detail: detailParts.join('\n'),
    body: result.body
  };
}

function parseProviderForm(body, existingProvider = {}) {
  const name = requiredText(body.name, 'Name', { max: 160 });
  const keepWarmInterval = body.keep_warm_interval_minutes === undefined ? 0 : body.keep_warm_interval_minutes;
  if (![0, 1, 5, '0', '1', '5'].includes(keepWarmInterval)) {
    throw apiError(400, 'invalid_form', 'Keep warm calling must be Never, 1 min, or 5 min.');
  }
  return {
    slug: slugify(body.slug || name),
    name,
    baseUrl: validateUrl(body.base_url, 'Base URL'),
    apiKey: optionalText(body.api_key, { max: 4096 }) || existingProvider.api_key || 'local',
    enabled: body.enabled ? 1 : 0,
    keepWarmIntervalMinutes: Number(keepWarmInterval),
    maxConcurrentRequests: nonNegativeIntegerOrNull(body.max_concurrent_requests, 'Maximum concurrent requests'),
    timeoutMs: nonNegativeIntegerOrNull(body.timeout_ms, 'Timeout milliseconds')
  };
}

function isProviderApiKeyOnlyForm(body) {
  return Object.prototype.hasOwnProperty.call(body, 'api_key') &&
    !Object.prototype.hasOwnProperty.call(body, 'name') &&
    !Object.prototype.hasOwnProperty.call(body, 'base_url') &&
    !Object.prototype.hasOwnProperty.call(body, 'slug');
}

function parseModelMappingForm(body) {
  const capabilityValue = (name, fallback = 1) => {
    const value = body[name];
    if (value === undefined) return fallback;
    const selected = Array.isArray(value) ? value.at(-1) : value;
    return ['1', 'true', 'yes', 'on'].includes(String(selected).toLowerCase()) ? 1 : 0;
  };
  const supportsReasoning = capabilityValue('supports_reasoning');
  const supportsImageInput = capabilityValue('supports_image_input');
  const reasoningHistoryField = optionalText(body.reasoning_history_field);
  if (reasoningHistoryField && !['reasoning', 'reasoning_content'].includes(reasoningHistoryField)) {
    throw apiError(400, 'invalid_form', 'Reasoning history field must be reasoning or reasoning_content.');
  }
  const hasReasoningEffortFields = Object.prototype.hasOwnProperty.call(body, 'reasoning_efforts_present');
  const requestedEfforts = Array.isArray(body.reasoning_efforts)
    ? body.reasoning_efforts
    : (body.reasoning_efforts === undefined ? [] : [body.reasoning_efforts]);
  const reasoningEfforts = supportsReasoning
    ? (hasReasoningEffortFields ? parseReasoningEfforts(requestedEfforts) : null)
    : [];
  const requestedDefaultEffort = normalizeReasoningEffort(body.default_reasoning_effort);
  if (body.default_reasoning_effort && !requestedDefaultEffort) {
    throw apiError(400, 'invalid_form', `Default reasoning effort must be one of: ${REASONING_EFFORTS.join(', ')}.`);
  }
  if (requestedDefaultEffort && !reasoningEfforts?.includes(requestedDefaultEffort)) {
    throw apiError(400, 'invalid_form', 'Default reasoning effort must also be selected as a supported level.');
  }
  return {
    upstreamModel: requiredText(body.upstream_model, 'Upstream model name', { max: 255 }),
    contextLimit: nonNegativeIntegerOrNull(body.context_limit, 'Context limit'),
    outputLimit: nonNegativeIntegerOrNull(body.output_limit, 'Output limit'),
    supportsTextInput: capabilityValue('supports_text_input'),
    supportsImageInput,
    maxImages: supportsImageInput ? (nonNegativeIntegerOrNull(body.max_images, 'Max images per request') || null) : null,
    supportsTools: capabilityValue('supports_tools'),
    supportsReasoning,
    reasoningHistoryField: reasoningHistoryField || null,
    reasoningEfforts: serializeReasoningEfforts(reasoningEfforts),
    defaultReasoningEffort: supportsReasoning ? requestedDefaultEffort : null,
    supportsChatTemplateKwargs: supportsReasoning ? capabilityValue('supports_chat_template_kwargs', 0) : 0,
    supportsParallelTools: capabilityValue('supports_parallel_tools')
  };
}

function saveActiveModelMapping(db, providerId, providerName, form) {
  const existing = db.prepare(`
    SELECT id
    FROM provider_models
    WHERE provider_id = ?
    ORDER BY enabled DESC, updated_at DESC, id DESC
    LIMIT 1
  `).get(providerId);
  if (existing) {
    db.prepare('DELETE FROM provider_models WHERE provider_id = ? AND id != ?').run(providerId, existing.id);
  }
  if (existing) {
    db.prepare(`
      UPDATE provider_models
      SET upstream_model = ?, name = ?, enabled = 1, context_limit = ?, output_limit = ?,
          supports_text_input = ?, supports_image_input = ?, max_images = ?, supports_tools = ?, supports_reasoning = ?,
          reasoning_efforts = ?, default_reasoning_effort = ?, reasoning_history_field = ?, supports_chat_template_kwargs = ?, supports_parallel_tools = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      form.upstreamModel,
      providerName,
      form.contextLimit,
      form.outputLimit,
      form.supportsTextInput,
      form.supportsImageInput,
      form.maxImages,
      form.supportsTools,
      form.supportsReasoning,
      form.reasoningEfforts,
      form.defaultReasoningEffort,
      form.reasoningHistoryField,
      form.supportsChatTemplateKwargs,
      form.supportsParallelTools,
      existing.id
    );
  } else {
    db.prepare(`
      INSERT INTO provider_models
        (provider_id, upstream_model, name, enabled, context_limit, output_limit,
         supports_text_input, supports_image_input, max_images, supports_tools, supports_reasoning,
         reasoning_efforts, default_reasoning_effort, reasoning_history_field, supports_chat_template_kwargs, supports_parallel_tools)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      providerId,
      form.upstreamModel,
      providerName,
      form.contextLimit,
      form.outputLimit,
      form.supportsTextInput,
      form.supportsImageInput,
      form.maxImages,
      form.supportsTools,
      form.supportsReasoning,
      form.reasoningEfforts,
      form.defaultReasoningEffort,
      form.reasoningHistoryField,
      form.supportsChatTemplateKwargs,
      form.supportsParallelTools
    );
  }
}

function providerModelContract(model = {}) {
  return {
    contextLimit: Number(model.context_limit || getSetting('default_model_context_limit')),
    outputLimit: Number(model.output_limit || getSetting('default_model_output_limit')),
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
    return value.length ? value.join(', ') : 'none selectable';
  }
  if (field === 'defaultReasoningEffort') return value || 'provider default';
  if (field === 'maxImages') return value === null ? 'unlimited' : String(value);
  return value ? 'supported' : 'not supported';
}

function modelCapabilitySummary(model) {
  const contract = providerModelContract(model);
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
    ? capabilities.map((capability) => `<span class="feature-chip">${escapeHtml(capability)}</span>`).join('')
    : '<span class="muted">No capabilities declared</span>';
}

function modelMappingFields(provider = {}, model = activeProviderModel(provider.id)) {
  const capability = (name) => model[name] === undefined || Number(model[name]) === 1;
  const reasoningEfforts = parseReasoningEfforts(model.reasoning_efforts) || [];
  const defaultReasoningEffort = normalizeReasoningEffort(model.default_reasoning_effort) || '';
  return `
    <h2>Active Model Mapping</h2>
    <label>Upstream model name</label><input name="upstream_model" value="${escapeHtml(model.upstream_model || '')}" required>
    <label>Context limit</label><input name="context_limit" type="number" min="0" value="${escapeHtml(model.context_limit ?? getSetting('default_model_context_limit'))}">
    <label>Output limit</label><input name="output_limit" type="number" min="0" value="${escapeHtml(model.output_limit ?? getSetting('default_model_output_limit'))}">
    <h3>Capabilities</h3>
    <p class="muted">Capabilities are aggregated and published automatically to Codex and OpenCode.</p>
    <input type="hidden" name="supports_text_input" value="0"><label><input name="supports_text_input" type="checkbox" value="1" style="width:auto" ${capability('supports_text_input') ? 'checked' : ''}> Text input</label>
    <input type="hidden" name="supports_image_input" value="0"><label><input name="supports_image_input" type="checkbox" value="1" style="width:auto" ${capability('supports_image_input') ? 'checked' : ''}> Image input</label>
    <div class="max-images-field">
      <label>Max images per request <span class="muted" style="display:block;font-weight:400">Blank or 0 means unlimited. Set it to the upstream's own cap (for example vLLM <code>--limit-mm-per-prompt</code>) so oversized requests are rejected before they reach the provider.</span></label>
      <input name="max_images" type="number" min="0" value="${escapeHtml(model.max_images ?? '')}" placeholder="Unlimited">
    </div>
    <input type="hidden" name="supports_tools" value="0"><label><input name="supports_tools" type="checkbox" value="1" style="width:auto" ${capability('supports_tools') ? 'checked' : ''}> Tool calling</label>
    <input type="hidden" name="supports_reasoning" value="0"><label><input name="supports_reasoning" type="checkbox" value="1" style="width:auto" ${capability('supports_reasoning') ? 'checked' : ''}> Reasoning</label>
    <fieldset style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:8px 0 12px">
      <legend>Reasoning controls</legend>
      <p class="muted">Select only levels accepted by this upstream model. Leave all levels unselected for models with provider-managed reasoning and no selectable effort.</p>
      <input type="hidden" name="reasoning_efforts_present" value="1">
      <div class="actions">
        ${REASONING_EFFORTS.map((effort) => `<label><input name="reasoning_efforts" type="checkbox" value="${effort}" style="width:auto" ${reasoningEfforts.includes(effort) ? 'checked' : ''}> ${effort}</label>`).join('')}
      </div>
      <label>Reasoning history field</label>
      <select name="reasoning_history_field">
        <option value="">Forward history unchanged</option>
        ${['reasoning', 'reasoning_content'].map((field) => `<option value="${field}" ${model.reasoning_history_field === field ? 'selected' : ''}>${field}</option>`).join('')}
      </select>
      <p class="muted">For upstreams requiring reasoning in assistant history. Existing reasoning is preserved; missing history uses an empty string.</p>
      <label>Default reasoning effort</label>
      <select name="default_reasoning_effort">
        <option value="">Provider default</option>
        ${REASONING_EFFORTS.map((effort) => `<option value="${effort}" ${defaultReasoningEffort === effort ? 'selected' : ''}>${effort}</option>`).join('')}
      </select>
      <input type="hidden" name="supports_chat_template_kwargs" value="0"><label><input name="supports_chat_template_kwargs" type="checkbox" value="1" style="width:auto" ${Number(model.supports_chat_template_kwargs || 0) === 1 ? 'checked' : ''}> Allow restricted vLLM chat template overrides</label>
      <p class="muted">Only <code>enable_thinking</code>, <code>preserve_thinking</code>, and <code>reasoning_effort</code> are accepted.</p>
    </fieldset>
    <input type="hidden" name="supports_parallel_tools" value="0"><label><input name="supports_parallel_tools" type="checkbox" value="1" style="width:auto" ${capability('supports_parallel_tools') ? 'checked' : ''}> Parallel tool calls</label>
  `;
}

function findProviderBySlug(db, slug, { exceptId = null } = {}) {
  return db.prepare('SELECT id, name FROM providers WHERE slug = ? AND id IS NOT ?')
    .get(slug, exceptId === null ? null : Number(exceptId)) || null;
}

function slugTakenNotice(slug, owner) {
  return `
    <div class="error">
      The slug <code>${escapeHtml(slug)}</code> is already used by <a href="/admin/providers/${owner.id}">${escapeHtml(owner.name)}</a>.
      Nothing was saved. Choose a different slug.
    </div>
  `;
}

function copySourceProvider(value) {
  const id = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(id) && id > 0
    ? getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id) || null
    : null;
}

// First free "<slug>-copy", "<slug>-copy-2", ... for a duplicated provider.
function copySlug(db, slug) {
  for (let index = 1; ; index += 1) {
    const candidate = `${slug}-copy${index > 1 ? `-${index}` : ''}`;
    if (!findProviderBySlug(db, candidate)) return candidate;
  }
}

// Turns parsed form values back into row-shaped objects so a rejected form can be shown again.
function providerFormState(form, mapping) {
  return {
    provider: {
      slug: form.slug,
      name: form.name,
      base_url: form.baseUrl,
      enabled: form.enabled,
      keep_warm_interval_minutes: form.keepWarmIntervalMinutes,
      max_concurrent_requests: form.maxConcurrentRequests,
      timeout_ms: form.timeoutMs
    },
    model: {
      upstream_model: mapping.upstreamModel,
      context_limit: mapping.contextLimit,
      output_limit: mapping.outputLimit,
      supports_text_input: mapping.supportsTextInput,
      supports_image_input: mapping.supportsImageInput,
      max_images: mapping.maxImages,
      supports_tools: mapping.supportsTools,
      supports_reasoning: mapping.supportsReasoning,
      reasoning_efforts: mapping.reasoningEfforts,
      default_reasoning_effort: mapping.defaultReasoningEffort,
      reasoning_history_field: mapping.reasoningHistoryField,
      supports_chat_template_kwargs: mapping.supportsChatTemplateKwargs,
      supports_parallel_tools: mapping.supportsParallelTools
    }
  };
}

function providerForm(provider = {}, action = '/admin/providers', { model, copySource = null, copyApiKey = true } = {}) {
  const deleteFormId = provider.id ? `provider-delete-${provider.id}` : '';
  const deleteModalId = provider.id ? `provider-delete-modal-${provider.id}` : '';
  const autoconfigureModalId = provider.id ? `provider-autoconfigure-modal-${provider.id}` : '';
  const providerTestModalId = provider.id ? `provider-test-modal-${provider.id}` : '';
  const keepWarmSelectId = `provider-keep-warm-${provider.id || 'new'}`;
  return `
    <form method="post" action="${action}" class="panel" data-provider-settings-form>
      <h2>Provider Settings</h2>
      <label>Provider slug</label><input name="slug" value="${escapeHtml(provider.slug)}" required>
      <label>Name</label><input name="name" value="${escapeHtml(provider.name)}" required>
      <label>Base URL${copySource ? ` <span class="muted" style="display:block;font-weight:400">Copied from ${escapeHtml(copySource.name)}. Change it if the copy points at a different server.</span>` : ''}</label><input name="base_url" value="${escapeHtml(provider.base_url)}" placeholder="http://127.0.0.1:8001" required>
      <label>Maximum concurrent requests. Blank or 0 means infinite.</label><input name="max_concurrent_requests" type="number" min="0" value="${escapeHtml(provider.max_concurrent_requests ?? '')}">
      <label>Timeout milliseconds. Blank uses the server default.</label><input name="timeout_ms" type="number" min="0" value="${escapeHtml(provider.timeout_ms ?? '')}">
      <label><input name="enabled" type="checkbox" value="1" style="width:auto" ${provider.enabled === 0 ? '' : 'checked'}> Provider enabled</label>
      <label for="${keepWarmSelectId}">Keep warm calling</label>
      <select id="${keepWarmSelectId}" name="keep_warm_interval_minutes">
        ${[[0, 'Never'], [1, '1 min'], [5, '5 min']].map(([minutes, label]) => `<option value="${minutes}" ${Number(provider.keep_warm_interval_minutes || 0) === minutes ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <p class="muted">No calls are sent when set to Never. Other options send a tiny completion at the selected interval when this provider and a model are enabled. May consume billable tokens; does not use student quota.</p>
      ${copySource ? `
        <input type="hidden" name="copy_from" value="${copySource.id}">
        ${copySource.api_key ? `<label><input name="copy_api_key" type="checkbox" value="1" style="width:auto" ${copyApiKey ? 'checked' : ''}> Use the same API key as ${escapeHtml(copySource.name)}</label>` : ''}
      ` : ''}
      ${model ? modelMappingFields(provider, model) : modelMappingFields(provider)}
      <div class="form-actions">
        <div class="actions">
          <button type="submit">Save provider</button>
          ${provider.id ? `<button type="button" class="danger" data-open-modal="${deleteModalId}">Delete provider</button>` : ''}
          ${provider.id ? `<button type="button" class="secondary" data-autoconfigure-url="/admin/providers/${provider.id}/autoconfigure.json" data-autoconfigure-modal="${autoconfigureModalId}">Autoconfigure</button>` : ''}
        </div>
        ${provider.id ? `<a class="button secondary" href="/admin/providers/new?from=${provider.id}">Duplicate provider</a>` : ''}
      </div>
    </form>
    ${provider.id ? `
      <form id="${deleteFormId}" method="post" action="/admin/providers/${provider.id}/delete"></form>
      <dialog id="${deleteModalId}" class="modal" aria-labelledby="${deleteModalId}-title">
        <h2 id="${deleteModalId}-title">Delete provider?</h2>
        <p>This will permanently delete <strong>${escapeHtml(provider.name)}</strong> (<code>${escapeHtml(provider.slug)}</code>), its model mapping, and its group assignments.</p>
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
  return provider.api_key ? `configured (${maskSecret(provider.api_key)})` : 'not configured';
}

router.get('/admin/providers', requireAdmin, (req, res) => {
  const rows = listProviders().map((provider) => {
    const model = activeProviderModel(provider.id);
    const contract = model.id ? providerModelContract(model) : null;
    const pools = poolsForProvider(provider.id);
    return `
      <tr>
        <td>
          <a href="/admin/providers/${provider.id}"><strong>${escapeHtml(provider.name)}</strong></a><br>
          <span class="muted">${escapeHtml(provider.slug)}</span>
        </td>
        <td>${model.upstream_model ? `<code>${escapeHtml(model.upstream_model)}</code>` : '<span class="muted">none</span>'}</td>
        <td>${contract ? `${escapeHtml(alignmentValue(contract.contextLimit, 'contextLimit'))} / ${escapeHtml(alignmentValue(contract.outputLimit, 'outputLimit'))}` : '<span class="muted">—</span>'}</td>
        <td><div class="feature-chips">${contract ? modelCapabilitySummary(model) : '<span class="muted">—</span>'}</div></td>
        <td>
          <span class="${provider.enabled ? 'status-enabled' : 'status-disabled'}">${provider.enabled ? 'Enabled' : 'Disabled'}</span><br>
          <span class="muted">API key ${provider.api_key ? 'configured' : 'missing'}</span>
        </td>
        <td>${pools.length
          ? pools.map((pool) => `<a href="/admin/pools/${pool.id}"><code>${escapeHtml(pool.alias)}</code></a>`).join('<br>')
          : '<span class="alignment-status alignment-warning" title="Students cannot reach a provider that is in no pool"><span aria-hidden="true">⚠</span> Not in a pool</span>'}</td>
        <td><a class="button secondary" href="/admin/providers/${provider.id}">Edit</a></td>
      </tr>
    `;
  }).join('');
  const content = `
    <div class="provider-list-heading">
      <div>
        <p class="muted">A provider is one upstream server and the model it serves. Students reach providers through <a href="/admin/pools">pools</a>, which set the model alias and balance requests.</p>
      </div>
      <a class="button" href="/admin/providers/new">Add provider</a>
    </div>
    <div class="provider-pool-table">
      <table>
        <thead><tr><th>Provider</th><th>Upstream model</th><th>Context / output</th><th>Features</th><th>Status</th><th>Pools</th><th>Actions</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="muted">No providers.</td></tr>'}</tbody>
      </table>
    </div>
  `;
  render(req, res, 'settings', {
    title: 'Providers',
    content,
    flash: flash(req.query.deleted ? 'Provider deleted.' : (req.query.saved ? 'Provider saved.' : req.query.test || ''))
  });
});

// ---- Pools: balanced sets of providers published under one model alias ----

router.get('/admin/providers/new', requireAdmin, (req, res) => {
  const source = copySourceProvider(req.query.from);
  if (req.query.from !== undefined && !source) return res.status(404).send('Provider not found');
  if (!source) {
    return render(req, res, 'settings', {
      title: 'New Provider',
      content: `
        ${providerForm({ enabled: 1, api_key: '' })}
      `
    });
  }
  // Pool memberships are not copied, so the copy serves nobody until it is added to a pool.
  const copy = {
    slug: copySlug(getDb(), source.slug),
    name: `Copy of ${source.name}`.slice(0, 160),
    base_url: source.base_url,
    enabled: source.enabled,
    keep_warm_interval_minutes: source.keep_warm_interval_minutes,
    max_concurrent_requests: source.max_concurrent_requests,
    timeout_ms: source.timeout_ms
  };
  render(req, res, 'settings', {
    title: 'Duplicate Provider',
    flash: flash(`This is a copy of ${source.name}. Nothing is saved until you press Save provider. The copy is ${source.enabled ? 'enabled' : 'disabled'} like the original and is not in any pool.`),
    content: providerForm(copy, '/admin/providers', { model: activeProviderModel(source.id), copySource: source })
  });
});

router.post('/admin/providers', requireAdmin, (req, res) => {
  const source = copySourceProvider(req.body.copy_from);
  const copyApiKey = Boolean(source && req.body.copy_api_key);
  const form = parseProviderForm(req.body, copyApiKey ? { api_key: source.api_key } : {});
  const mapping = parseModelMappingForm(req.body);
  const db = getDb();
  const slugOwner = findProviderBySlug(db, form.slug);
  if (slugOwner) {
    const state = providerFormState(form, mapping);
    res.status(409);
    return render(req, res, 'settings', {
      title: source ? 'Duplicate Provider' : 'New Provider',
      flash: slugTakenNotice(form.slug, slugOwner),
      content: providerForm(state.provider, '/admin/providers', { model: state.model, copySource: source, copyApiKey })
    });
  }
  const providerId = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO providers
        (slug, name, kind, base_url, api_key, enabled, keep_warm_interval_minutes, max_concurrent_requests, timeout_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      form.slug,
      form.name,
      'openai-compatible',
      form.baseUrl,
      form.apiKey,
      form.enabled,
      form.keepWarmIntervalMinutes,
      form.maxConcurrentRequests,
      form.timeoutMs
    );
    saveActiveModelMapping(db, result.lastInsertRowid, form.name, mapping);
    return result.lastInsertRowid;
  })();
  res.redirect(`/admin/providers/${providerId}?${source ? `copied=${source.id}` : 'saved=1'}`);
});

router.get('/admin/providers/:id', requireAdmin, (req, res) => {
  const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  const providerPools = poolsForProvider(provider.id);
  const copiedFrom = req.query.copied ? copySourceProvider(req.query.copied) : null;
  const slugOwner = req.query.slug_taken ? findProviderBySlug(getDb(), String(req.query.slug_taken), { exceptId: provider.id }) : null;
  const copiedMessage = req.query.copied
    ? `Provider created${copiedFrom ? ` as a copy of ${copiedFrom.name}` : ' as a copy'}. It is ${provider.enabled ? 'enabled' : 'disabled'} and not in any pool yet. Run a test request below, then add it to a pool.`
    : '';
  render(req, res, 'settings', {
    title: 'Edit provider',
    flash: slugOwner
      ? slugTakenNotice(String(req.query.slug_taken), slugOwner)
      : flash(copiedMessage || (req.query.saved ? 'Provider saved.' : req.query.test || '')),
    content: `
      <div class="provider-sections">
        <div class="panel">
          <h2>Pools</h2>
          ${providerPools.length
            ? `<p>Published to students as ${providerPools.map((pool) => `<a href="/admin/pools/${pool.id}"><code>${escapeHtml(pool.alias)}</code></a>`).join(', ')}.</p>`
            : '<p><span class="alignment-status alignment-warning"><span aria-hidden="true">⚠</span> Not in a pool</span> Students cannot reach this provider until it is added to a <a href="/admin/pools">pool</a>.</p>'}
        </div>
        ${providerForm(provider, `/admin/providers/${provider.id}`)}
        <div class="panel">
          <h2>Provider API key</h2>
          <form id="provider-api-key-save-${provider.id}" method="post" action="/admin/providers/${provider.id}">
            <label>API key or local placeholder</label><input name="api_key" type="password" autocomplete="off" placeholder="${provider.api_key ? 'Leave blank to keep current value' : 'local'}">
          </form>
          <p class="muted">API key: ${escapeHtml(providerApiKeyStatus(provider))}</p>
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
    `
  });
});

router.post('/admin/providers/:id', requireAdmin, (req, res) => {
  const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  if (isProviderApiKeyOnlyForm(req.body)) {
    const apiKey = optionalText(req.body.api_key, { max: 4096 });
    if (apiKey) {
      getDb().prepare('UPDATE providers SET api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(apiKey, provider.id);
    }
    return res.redirect(`/admin/providers/${provider.id}?saved=1`);
  }
  const form = parseProviderForm(req.body, provider);
  const mapping = parseModelMappingForm(req.body);
  const db = getDb();
  if (findProviderBySlug(db, form.slug, { exceptId: provider.id })) {
    return res.redirect(`/admin/providers/${provider.id}?slug_taken=${encodeURIComponent(form.slug)}`);
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE providers
      SET slug = ?, name = ?, kind = ?, base_url = ?, api_key = ?, enabled = ?, keep_warm_interval_minutes = ?,
          max_concurrent_requests = ?, timeout_ms = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      form.slug,
      form.name,
      'openai-compatible',
      form.baseUrl,
      form.apiKey,
      form.enabled,
      form.keepWarmIntervalMinutes,
      form.maxConcurrentRequests,
      form.timeoutMs,
      provider.id
    );
    saveActiveModelMapping(db, provider.id, form.name, mapping);
  })();
  res.redirect(`/admin/providers/${provider.id}?saved=1`);
});

router.post('/admin/providers/:id/clear-key', requireAdmin, (req, res) => {
  const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  getDb().prepare('UPDATE providers SET api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('', provider.id);
  res.redirect(`/admin/providers/${provider.id}?saved=1`);
});

router.post('/admin/providers/:id/delete', requireAdmin, (req, res) => {
  const provider = getDb().prepare('SELECT id FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  getDb().prepare('DELETE FROM providers WHERE id = ?').run(provider.id);
  res.redirect('/admin/providers?deleted=1');
});

router.post('/admin/providers/:id/test', requireAdmin, async (req, res, next) => {
  try {
    const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
    if (!provider) return res.status(404).send('Provider not found');
    const result = await testProvider({ slug: provider.slug });
    res.redirect(`/admin/providers/${provider.id}?test=${encodeURIComponent(`${provider.name} test ${result.ok ? 'passed' : 'failed'} with status ${result.status}.`)}`);
  } catch (error) {
    next(error);
  }
});

router.post('/admin/providers/:id/test.json', requireAdmin, async (req, res, next) => {
  try {
    const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
    if (!provider) return res.status(404).json({ ok: false, message: 'Provider not found.' });
    if (!provider.api_key) {
      return res.status(502).json({
        ok: false,
        status: 0,
        message: 'Server test request failed.',
        detail: 'API key is not configured.'
      });
    }
    const discovery = await discoverProviderMetadata({ slug: provider.slug });
    if (!discovery.ok) {
      return res.status(502).json({
        ok: false,
        status: discovery.status,
        message: `Server test request failed${discovery.status ? ` with status ${discovery.status}` : ''}.`,
        detail: discovery.errorMessage
      });
    }
    const detail = [
      `Protocol: ${discovery.providerType}`,
      discovery.version ? `Server version: ${discovery.version}` : '',
      `Available models: ${discovery.models.map((model) => model.id).join(', ')}`,
      ...discovery.warnings
    ].filter(Boolean).join('\n');
    return res.json({
      ok: true,
      status: discovery.status,
      message: `Server test request passed with status ${discovery.status}.`,
      detail
    });
  } catch (error) {
    next(error);
  }
});

router.post('/admin/providers/:id/autoconfigure.json', requireAdmin, async (req, res, next) => {
  const streaming = req.body?.stream_progress === true;
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const emit = (event) => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); };
  const respond = (status, body) => {
    if (res.destroyed) return;
    if (!streaming || !res.headersSent) return res.status(status).json(body);
    emit({ type: 'result', ...body });
    return res.end();
  };
  try {
    const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
    if (!provider) return res.status(404).json({ ok: false, message: 'Provider not found.' });

    if (streaming) {
      res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      emit({ type: 'progress', activeTest: 'Reading the provider model catalog', stage: 1,
        totalStages: AUTOCONFIGURE_TOTAL_STAGES, completedStages: 0, results: [] });
    }
    const discovery = await discoverProviderMetadata({
      signal: controller.signal,
      slug: provider.slug,
      baseUrl: req.body?.base_url === undefined ? provider.base_url : validateUrl(req.body.base_url, 'Base URL'),
    });
    if (!discovery.ok) {
      return respond(502, {
        ok: false,
        message: 'Autoconfiguration failed.',
        detail: `Model catalog${discovery.status ? ` (HTTP ${discovery.status})` : ''}: ${discovery.errorMessage}`,
        upstreamStatus: discovery.status,
        models: []
      });
    }

    controller.signal.throwIfAborted();
    const current = activeProviderModel(provider.id);
    const preferredModel = optionalText(req.body?.preferred_model, { max: 255 }) || current.upstream_model || '';
    const selected = discovery.models.find((model) => model.id === preferredModel) ||
      (discovery.models.length === 1 ? discovery.models[0] : null);
    if (selected) {
      const release = reserveProviderForTest(provider.slug);
      try {
        const probe = await probeProviderModel({
          signal: controller.signal,
          onProgress: streaming ? (progress) => emit({ type: 'progress', model: selected.id, ...progress }) : undefined,
          baseUrl: req.body?.base_url === undefined ? provider.base_url : validateUrl(req.body.base_url, 'Base URL'),
          apiKey: provider.api_key, model: selected.id,
          timeoutMs: Math.min(Math.max(Number(provider.timeout_ms || config.requestTimeoutMs), 1000), 60000)
        });
        selected.probes = probe.results;
        for (const [field, value] of Object.entries(probe.settings)) {
          if (selected.settings[field] !== undefined && selected.settings[field] !== value) {
            discovery.warnings.push(`${field}: the test result conflicts with the published value. The published value is kept; review this discrepancy before saving.`);
          }
        }
        const published = selected.settings;
        selected.settings = { ...probe.settings, ...published };
        if (selected.settings.supports_tools === 0 && published.supports_parallel_tools === undefined) {
          selected.settings.supports_parallel_tools = 0;
        }
      } finally { release(); }
    }
    const shouldApply = req.body?.apply === true || String(req.body?.apply || '').toLowerCase() === 'true';
    const detectedContextLimit = selected?.maxModelLen || null;
    const detected = [
      `Protocol: ${discovery.providerType}`,
      discovery.version ? `Server version: ${discovery.version}` : '',
      `Available models: ${discovery.models.map((model) => model.id).join(', ')}`,
      selected ? `Selected model: ${selected.id}` : 'Selected model: choose one before applying.',
      selected?.root ? `Model root: ${selected.root}` : '',
      selected
        ? (detectedContextLimit ? `Context limit: ${detectedContextLimit}` : 'Context limit: not published; existing value will be kept.')
        : '',
      selected?.settings.output_limit ? `Output limit: ${selected.settings.output_limit}` : 'Output limit: not published; existing value will be kept.',
      'Official published values take priority. Only verified behavior or explicit capability rejections supplement them. Inconclusive values keep existing settings.',
      ...(selected?.probes || []).map((probe) => `${probe.name}: ${probe.status}${probe.httpStatus ? ` (HTTP ${probe.httpStatus})` : ''}\n  ${probe.message}${probe.hint ? `\n  Next step: ${probe.hint}` : ''}`),
      selected ? `Values to apply: ${JSON.stringify(selected.settings)}` : '',
      ...discovery.warnings
    ].filter(Boolean);

    if (!shouldApply) {
      return respond(200, {
        ok: true,
        message: 'Configuration discovered. Review it before applying.',
        detail: detected.join('\n'),
        providerType: discovery.providerType,
        version: discovery.version,
        models: discovery.models,
        selectedModel: selected?.id || null,
        applied: null
      });
    }

    if (!selected) {
      return respond(409, {
        ok: false,
        message: 'Choose an upstream model before applying the configuration.',
        detail: `Available models: ${discovery.models.map((model) => model.id).join(', ')}`,
        models: discovery.models,
        selectedModel: null,
        applied: null
      });
    }

    const modelIdentity = requiredText(selected.id, 'Upstream model name', { max: 255 });
    const db = getDb();
    db.transaction(() => {
      if (current.id) {
        db.prepare(`
          UPDATE provider_models SET upstream_model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(modelIdentity, current.id);
      } else {
        db.prepare(`
          INSERT INTO provider_models
            (provider_id, upstream_model, name, enabled, context_limit, output_limit,
             supports_text_input, supports_image_input, supports_tools, supports_reasoning, supports_parallel_tools)
          VALUES (?, ?, ?, 1, ?, ?, 1, 0, 0, 0, 0)
        `).run(
          provider.id,
          modelIdentity,
          provider.name,
          Number(getSetting('default_model_context_limit')),
          Number(getSetting('default_model_output_limit'))
        );
      }
      const mapping = activeProviderModel(provider.id);
      const fields = SETTING_FIELDS
        .filter((field) => selected.settings[field] !== undefined);
      if (fields.length) {
        db.prepare(`UPDATE provider_models SET ${fields.map((field) => `${field} = ?`).join(', ')},
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(...fields.map((field) => selected.settings[field]), mapping.id);
      }
    })();

    const updated = activeProviderModel(provider.id);
    return respond(200, {
      ok: true,
      message: 'Autoconfiguration applied.',
      detail: detected.join('\n'),
      providerType: discovery.providerType,
      version: discovery.version,
      models: discovery.models,
      selectedModel: selected.id,
      applied: {
        upstreamModel: updated.upstream_model,
        contextLimit: updated.context_limit,
        outputLimit: updated.output_limit
      }
    });
  } catch (error) {
    if (res.destroyed) return;
    if (streaming && res.headersSent) return respond(error.status || 500, {
      ok: false, message: error.message || 'Provider testing failed.', models: []
    });
    next(error);
  }
});

router.post('/admin/providers/:id/mapping', requireAdmin, (req, res) => {
  const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  const form = parseModelMappingForm(req.body);
  const db = getDb();
  const tx = db.transaction(() => {
    saveActiveModelMapping(db, provider.id, provider.name, form);
  });
  tx();
  res.redirect(`/admin/providers/${provider.id}?saved=1`);
});

router.post('/admin/providers/:id/mapping/test.json', requireAdmin, async (req, res, next) => {
  try {
    const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
    const model = activeProviderModel(req.params.id);
    if (!provider) return res.status(404).json({ ok: false, message: 'Provider not found.' });
    if (!model.upstream_model) return res.status(404).json({ ok: false, message: 'Active model mapping is not configured.' });
    const result = await testProvider({ slug: provider.slug, model: model.upstream_model });
    res.status(result.ok ? 200 : 502).json(testResultPayload('Mapping test request', result));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
