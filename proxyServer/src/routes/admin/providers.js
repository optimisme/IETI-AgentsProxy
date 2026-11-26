// Admin pages for providers: connection, model mapping, tests, autoconfiguration and duplication.
const express = require('express');
const config = require('../../config');
const { getDb } = require('../../db');
const { requireAdmin } = require('../../middleware/authAdmin');
const { getSetting } = require('../../services/settingsService');
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
const { flash, html } = require('../../utils/html');
const {
  nonNegativeIntegerOrNull,
  optionalText,
  requiredText,
  slug: validateSlug,
  url: validateUrl
} = require('../../utils/validation');
const { activeProviderModel, render, formConflict, formRoute } = require('./shared');
const { providersPage, providerForm, slugTakenNotice, providerPage } = require('../../views/admin/providers');

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

// The server-wide limits a mapping falls back to when it sets none.
function modelDefaults() {
  return { context: getSetting('default_model_context_limit'), output: getSetting('default_model_output_limit') };
}

function findProviderBySlug(db, slug, { exceptId = null } = {}) {
  return db.prepare('SELECT id, name FROM providers WHERE slug = ? AND id IS NOT ?')
    .get(slug, exceptId === null ? null : Number(exceptId)) || null;
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

// The provider form's fields as submitted, valid or not, laid over the stored rows if any,
// so a refused form can be shown again exactly as it was filled in.
function providerFromBody(body, stored = {}) {
  return {
    ...stored,
    slug: body.slug ?? '',
    name: body.name ?? '',
    base_url: body.base_url ?? '',
    max_concurrent_requests: body.max_concurrent_requests ?? '',
    timeout_ms: body.timeout_ms ?? '',
    enabled: body.enabled ? 1 : 0,
    keep_warm_interval_minutes: body.keep_warm_interval_minutes
  };
}

function mappingFromBody(body, stored = {}) {
  // A checkbox is sent as a hidden "0" followed by "1" when ticked.
  const ticked = (name, fallback) => {
    const value = body[name];
    if (value === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(Array.isArray(value) ? value.at(-1) : value).toLowerCase()) ? 1 : 0;
  };
  return {
    ...stored,
    upstream_model: body.upstream_model ?? '',
    context_limit: body.context_limit ?? '',
    output_limit: body.output_limit ?? '',
    supports_text_input: ticked('supports_text_input', 1),
    supports_image_input: ticked('supports_image_input', 1),
    max_images: body.max_images ?? '',
    supports_tools: ticked('supports_tools', 1),
    supports_reasoning: ticked('supports_reasoning', 1),
    reasoning_efforts: [].concat(body.reasoning_efforts ?? []),
    default_reasoning_effort: body.default_reasoning_effort ?? '',
    reasoning_history_field: body.reasoning_history_field ?? '',
    supports_chat_template_kwargs: ticked('supports_chat_template_kwargs', 0),
    supports_parallel_tools: ticked('supports_parallel_tools', 1)
  };
}

function refuseTakenSlug(slug, exceptId = null) {
  const owner = findProviderBySlug(getDb(), slug, { exceptId });
  if (owner) throw formConflict('slug_taken', `The slug ${slug} is already used by another provider.`, slugTakenNotice(slug, owner));
}

router.get('/admin/providers', requireAdmin, (req, res) => {
  const defaults = modelDefaults();
  const providers = listProviders().map((provider) => ({
    ...provider,
    model: activeProviderModel(provider.id),
    pools: poolsForProvider(provider.id)
  }));
  render(req, res, 'settings', {
    title: 'Providers',
    content: providersPage({ defaults, providers }),
    flash: flash(req.query.deleted ? 'Provider deleted.' : (req.query.saved ? 'Provider saved.' : req.query.test || ''))
  });
});

// ---- Pools: balanced sets of providers published under one model alias ----

function showNewProvider(req, res, { values = null, notice = '', status = 200 } = {}) {
  const source = copySourceProvider(values ? values.copy_from : req.query.from);
  if (!values && req.query.from !== undefined && !source) return res.status(404).send('Provider not found');
  res.status(status);
  if (values) {
    return render(req, res, 'settings', {
      title: source ? 'Duplicate Provider' : 'New Provider',
      flash: notice,
      content: providerForm(providerFromBody(values), '/admin/providers', {
        model: mappingFromBody(values), defaults: modelDefaults(), copySource: source, copyApiKey: Boolean(values.copy_api_key)
      })
    });
  }
  if (!source) {
    return render(req, res, 'settings', {
      title: 'New Provider',
      content: html`
        ${providerForm({ enabled: 1, api_key: '' }, '/admin/providers', { defaults: modelDefaults() })}
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
    content: providerForm(copy, '/admin/providers', { model: activeProviderModel(source.id), defaults: modelDefaults(), copySource: source })
  });
}

router.get('/admin/providers/new', requireAdmin, (req, res) => {
  showNewProvider(req, res);
});

router.post('/admin/providers', requireAdmin, formRoute(showNewProvider, (req, res) => {
  const source = copySourceProvider(req.body.copy_from);
  const copyApiKey = Boolean(source && req.body.copy_api_key);
  const form = parseProviderForm(req.body, copyApiKey ? { api_key: source.api_key } : {});
  const mapping = parseModelMappingForm(req.body);
  const db = getDb();
  refuseTakenSlug(form.slug);
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
}));

// The provider's page. After a refused submission it shows the typed values and the reason.
function showProvider(req, res, { values = null, notice = '', status = 200 } = {}) {
  const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  const providerPools = poolsForProvider(provider.id);
  const model = activeProviderModel(provider.id);
  const defaults = modelDefaults();
  const copiedFrom = req.query.copied ? copySourceProvider(req.query.copied) : null;
  // The page has three forms; only the one that was submitted shows typed values.
  const formProvider = values && values.slug !== undefined ? providerFromBody(values, provider) : provider;
  const formModel = values && values.upstream_model !== undefined ? mappingFromBody(values, model) : model;
  const copiedMessage = req.query.copied
    ? `Provider created${copiedFrom ? ` as a copy of ${copiedFrom.name}` : ' as a copy'}. It is ${provider.enabled ? 'enabled' : 'disabled'} and not in any pool yet. Run a test request below, then add it to a pool.`
    : '';
  res.status(status);
  render(req, res, 'settings', {
    title: 'Edit provider',
    flash: notice || flash(copiedMessage || (req.query.saved ? 'Provider saved.' : req.query.test || '')),
    content: providerPage({ defaults, formModel, formProvider, provider, providerPools })
  });
}

router.get('/admin/providers/:id', requireAdmin, (req, res) => {
  showProvider(req, res);
});

router.post('/admin/providers/:id', requireAdmin, formRoute(showProvider, (req, res) => {
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
  refuseTakenSlug(form.slug, provider.id);
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
}));

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

router.post('/admin/providers/:id/mapping', requireAdmin, formRoute(showProvider, (req, res) => {
  const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  const form = parseModelMappingForm(req.body);
  const db = getDb();
  const tx = db.transaction(() => {
    saveActiveModelMapping(db, provider.id, provider.name, form);
  });
  tx();
  res.redirect(`/admin/providers/${provider.id}?saved=1`);
}));

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
