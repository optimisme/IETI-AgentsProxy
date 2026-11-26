// Admin pages for pools: the alias students see, its balanced providers, and what they add up to.
const express = require('express');
const { getDb } = require('../../db');
const { requireAdmin } = require('../../middleware/authAdmin');
const { getEnabledModelEntries, listProviders } = require('../../services/providerService');
const { commonCapabilities } = require('../../utils/modelCapabilities');
const {
  createPool,
  deletePool,
  findPoolByAlias,
  getPool,
  groupsForPool,
  listPools,
  poolsForProvider,
  updatePool,
  validatePoolAlias
} = require('../../services/poolService');
const { apiError } = require('../../utils/errors');
const { REASONING_EFFORTS } = require('../../utils/reasoning');
const { escapeHtml, flash } = require('../../utils/html');
const { activeProviderModel, render, tokens } = require('./shared');

const router = express.Router();

function validProviderIds(value) {
  const values = Array.isArray(value)
    ? value
    : value === undefined || value === null || String(value).trim() === ''
      ? []
      : [value];
  const ids = [...new Set(values.map((item) => Number(item)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return [];
  const valid = getDb().prepare(`SELECT id FROM providers WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((row) => row.id);
  if (valid.length !== ids.length) throw apiError(400, 'invalid_form', 'Providers must be valid.');
  return ids;
}

// What students get under a pool's alias, computed as GET /v1/models computes it: the
// smallest limits and only the capabilities every serving provider has. Capabilities are
// defined once, on each provider; a pool has none of its own.
function poolOffer(pool) {
  const entries = getEnabledModelEntries().filter((entry) => entry.poolId === pool.id);
  if (!entries.length) return null;
  return entries.reduce((offer, entry) => ({
    context: offer ? Math.min(offer.context, entry.limit.context) : entry.limit.context,
    output: offer ? Math.min(offer.output, entry.limit.output) : entry.limit.output,
    capabilities: commonCapabilities(offer?.capabilities, entry.capabilities)
  }), null);
}

const POOL_CAPABILITY_LABELS = [
  ['text', 'text input'],
  ['image', 'image input'],
  ['tools', 'tool calling'],
  ['parallelTools', 'parallel tool calls'],
  ['reasoning', 'reasoning'],
  ['chatTemplateKwargs', 'chat template overrides']
];

// How one serving provider holds the pool back, compared with the best any provider in the
// pool offers. An empty list means the provider is aligned with the others.
function poolProviderLimits(entry, entries) {
  const notes = [];
  const bestContext = Math.max(...entries.map((other) => other.limit.context));
  const bestOutput = Math.max(...entries.map((other) => other.limit.output));
  if (entry.limit.context < bestContext) notes.push(`Limits the context to ${tokens(entry.limit.context)} (others allow ${tokens(bestContext)})`);
  if (entry.limit.output < bestOutput) notes.push(`Limits the output to ${tokens(entry.limit.output)} (others allow ${tokens(bestOutput)})`);
  for (const [field, label] of POOL_CAPABILITY_LABELS) {
    if (!entry.capabilities[field] && entries.some((other) => other.capabilities[field])) notes.push(`Has no ${label}`);
  }
  if (entry.capabilities.image) {
    const unlimited = entries.some((other) => other.capabilities.image && other.capabilities.maxImages === null);
    const most = Math.max(...entries.filter((other) => other.capabilities.image).map((other) => other.capabilities.maxImages || 0));
    const own = entry.capabilities.maxImages;
    if (own !== null && (unlimited || own < most)) notes.push(`Limits images to ${own} per request`);
  }
  if (entry.capabilities.reasoning) {
    const reasoning = entries.filter((other) => other.capabilities.reasoning);
    const missing = REASONING_EFFORTS.filter((effort) =>
      !entry.capabilities.reasoningEfforts.includes(effort) && reasoning.some((other) => other.capabilities.reasoningEfforts.includes(effort)));
    if (missing.length) notes.push(`Does not accept reasoning level${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`);
  }
  return notes;
}

// Every provider ticked in the pool with what it is doing there: serving (and how it limits
// the pool, if it does) or the reason it is not serving.
function poolProviderViews(pool) {
  const entries = getEnabledModelEntries().filter((entry) => entry.poolId === pool.id);
  const bySlug = new Map(entries.map((entry) => [entry.id, entry]));
  return pool.providers.map((provider) => {
    const model = activeProviderModel(provider.id);
    const entry = bySlug.get(provider.slug);
    const idle = !provider.enabled ? 'Provider disabled'
      : !model.id ? 'No model mapping'
        : !entry ? 'Model mapping disabled'
          : '';
    return { ...provider, model, serving: Boolean(entry), idle, limits: entry ? poolProviderLimits(entry, entries) : [] };
  });
}

function poolStatus(providerViews) {
  const warning = (text) => `<span class="pool-status pool-warning"><span aria-hidden="true">⚠</span> ${text}</span>`;
  if (!providerViews.length) return warning('No providers');
  if (!providerViews.some((provider) => provider.serving)) return warning('No provider is serving');
  const limiting = providerViews.filter((provider) => provider.limits.length).length;
  if (limiting) return warning(`${limiting} not aligned`);
  return '<span class="pool-status pool-ok"><span aria-hidden="true">✓</span> All aligned</span>';
}

function poolOfferTable(offer) {
  if (!offer) return '<p class="muted">Students see no model under this alias: no enabled provider with an enabled model mapping is ticked.</p>';
  const { capabilities } = offer;
  const yesNo = (value) => (value ? 'Yes' : 'No');
  const reasoning = !capabilities.reasoning ? 'No'
    : !capabilities.reasoningEffortsKnown ? 'Yes, levels managed by the provider'
      : capabilities.reasoningEfforts.length ? `Yes: ${capabilities.reasoningEfforts.join(', ')}${capabilities.defaultReasoningEffort ? ` (default ${capabilities.defaultReasoningEffort})` : ''}`
        : 'Yes, no selectable level';
  const rows = [
    ['Context window', tokens(offer.context)],
    ['Maximum output', tokens(offer.output)],
    ['Text input', yesNo(capabilities.text)],
    ['Image input', capabilities.image ? (capabilities.maxImages === null ? 'Yes' : `Yes, up to ${capabilities.maxImages} per request`) : 'No'],
    ['Tool calling', capabilities.tools ? (capabilities.parallelTools ? 'Yes, with parallel calls' : 'Yes, one call at a time') : 'No'],
    ['Reasoning', reasoning],
    ['Chat template overrides', yesNo(capabilities.chatTemplateKwargs)]
  ];
  return `
    <table class="pool-offer">
      <tbody>${rows.map(([label, value]) => `<tr><th scope="row">${label}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</tbody>
    </table>
  `;
}

function poolProvidersTable(providerViews) {
  const rows = providerViews.map((provider) => `
    <tr>
      <td>
        <a href="/admin/providers/${provider.id}"><strong>${escapeHtml(provider.name)}</strong></a><br>
        <span class="muted">${escapeHtml(provider.slug)}</span>
      </td>
      <td>${provider.model.upstream_model ? `<code>${escapeHtml(provider.model.upstream_model)}</code>` : '<span class="muted">none</span>'}</td>
      <td>${provider.serving
        ? '<span class="status-enabled">Serving</span>'
        : `<span class="status-disabled">Not serving</span><br><span class="muted">${escapeHtml(provider.idle)}</span>`}</td>
      <td>${!provider.serving ? '<span class="muted">—</span>'
        : provider.limits.length
          ? `<span class="alignment-status alignment-warning"><span aria-hidden="true">⚠</span> Not aligned</span><ul class="pool-limits">${provider.limits.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`
          : '<span class="alignment-status alignment-ok"><span aria-hidden="true">✓</span> Aligned</span>'}</td>
    </tr>
  `).join('');
  return `
    <div class="provider-pool-table">
      <table>
        <thead><tr><th>Provider</th><th>Upstream model</th><th>Status</th><th>Alignment</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted">No providers in this pool.</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

function poolAliasTakenNotice(alias, owner) {
  return `
    <div class="error">
      The alias <code>${escapeHtml(alias)}</code> is already used by <a href="/admin/pools/${owner.id}">another pool</a>.
      Nothing was saved. Choose a different alias.
    </div>
  `;
}

function poolForm(pool = {}, action = '/admin/pools') {
  const selected = new Set((pool.providers || []).map((provider) => Number(provider.id)));
  const providers = listProviders().map((provider) => ({
    ...provider,
    model: activeProviderModel(provider.id),
    otherPools: poolsForProvider(provider.id).filter((other) => Number(other.id) !== Number(pool.id))
  }));
  return `
    <form method="post" action="${action}" class="panel">
      <h2>Pool settings</h2>
      <label>OpenCode model alias <span class="muted" style="display:block;font-weight:400">The model name students see. Requests for it are balanced across the providers ticked below.</span></label>
      <input name="alias" value="${escapeHtml(pool.alias)}" required>
      <label>Balanced providers <span class="muted" style="display:block;font-weight:400">A provider can be in several pools. Its concurrency limit is shared between them.</span></label>
      <div class="checkbox-list">
        ${providers.length ? providers.map((provider) => `
          <label>
            <input name="provider_ids" type="checkbox" value="${provider.id}" style="width:auto" ${selected.has(Number(provider.id)) ? 'checked' : ''}>
            ${escapeHtml(provider.name)} (${escapeHtml(provider.slug)})
            ${provider.model.upstream_model ? `<span class="muted">${escapeHtml(provider.model.upstream_model)}</span>` : '<span class="muted">No active mapping</span>'}
            ${provider.enabled ? '' : '<span class="muted">disabled</span>'}
            ${provider.otherPools.length ? `<span class="muted">· also in ${provider.otherPools.map((other) => escapeHtml(other.alias)).join(', ')}</span>` : ''}
          </label>
        `).join('') : '<p class="muted">No providers configured.</p>'}
      </div>
      <div class="form-actions">
        <div class="actions">
          <button type="submit">Save pool</button>
          <a class="button secondary" href="/admin/pools">Cancel</a>
        </div>
        ${pool.id ? `<button type="submit" form="pool-delete-${pool.id}" class="danger">Delete pool</button>` : ''}
      </div>
    </form>
  `;
}

function parsePoolForm(body) {
  return { alias: validatePoolAlias(body.alias), providerIds: validProviderIds(body.provider_ids) };
}

function poolPage(req, res, pool, { status = 200, notice = '' } = {}) {
  const saved = pool.id ? getPool(pool.id) : null;
  const providerViews = saved ? poolProviderViews(saved) : [];
  const groups = saved ? groupsForPool(saved.id) : [];
  const message = req.query.saved ? 'Pool saved.' : '';
  res.status(status);
  render(req, res, 'settings', {
    title: saved ? 'Edit pool' : 'New pool',
    flash: notice || flash(message),
    content: `
      <div class="provider-sections">
        ${poolForm(pool, saved ? `/admin/pools/${saved.id}` : '/admin/pools')}
        ${saved ? `
          <form id="pool-delete-${saved.id}" method="post" action="/admin/pools/${saved.id}/delete" onsubmit="return confirm(${escapeHtml(JSON.stringify(`Delete the pool ${saved.alias}? ${groups.length ? `Students in ${groups.map((group) => group.name).join(', ')} will lose this model. ` : ''}Its providers are not deleted.`))});"></form>
          <div class="panel">
            <h2>What students see</h2>
            <p class="muted">Computed from the serving providers below: the smallest limits, and only the capabilities all of them have. Capabilities are set on each provider.</p>
            ${poolOfferTable(poolOffer(saved))}
          </div>
          <div class="panel">
            <h2>Alignment ${poolStatus(providerViews)}</h2>
            <p class="muted">A provider is not aligned when it offers less than another provider of this pool, which lowers what students see. To fix it, run Autoconfigure on that provider or untick it here.</p>
            ${poolProvidersTable(providerViews)}
          </div>
          <div class="panel">
            <h2>Groups using this pool</h2>
            ${groups.length
              ? `<ul>${groups.map((group) => `<li><a href="/admin/groups/${group.id}">${escapeHtml(group.name)}</a></li>`).join('')}</ul>`
              : '<p class="muted">No group can use this pool yet. Tick it on a group\'s page.</p>'}
          </div>
        ` : ''}
      </div>
    `
  });
}

router.get('/admin/pools', requireAdmin, (req, res) => {
  const rows = listPools().map((pool) => {
    const providerViews = poolProviderViews(pool);
    return `
      <tr>
        <td><a href="/admin/pools/${pool.id}"><code>${escapeHtml(pool.alias)}</code></a></td>
        <td>${providerViews.length
          ? providerViews.map((provider) => `<a href="/admin/providers/${provider.id}">${escapeHtml(provider.name)}</a>${provider.serving ? '' : ` <span class="muted">(${escapeHtml(provider.idle.toLowerCase())})</span>`}`).join('<br>')
          : '<span class="muted">none</span>'}</td>
        <td>${poolStatus(providerViews)}</td>
        <td>${pool.group_count}</td>
        <td><a class="button secondary" href="/admin/pools/${pool.id}">Edit</a></td>
      </tr>
    `;
  }).join('');
  render(req, res, 'settings', {
    title: 'Pools',
    flash: flash(req.query.deleted ? 'Pool deleted.' : ''),
    content: `
      <div class="provider-list-heading">
        <div>
          <p class="muted">A pool publishes a set of providers to students under one model alias and balances requests between them. Groups choose which pools their students can use.</p>
        </div>
        <a class="button" href="/admin/pools/new">Add pool</a>
      </div>
      <div class="provider-pool-table">
        <table>
          <thead><tr><th>OpenCode model alias</th><th>Balanced providers</th><th>Alignment</th><th>Groups</th><th>Actions</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="muted">No pools.</td></tr>'}</tbody>
        </table>
      </div>
    `
  });
});

router.get('/admin/pools/new', requireAdmin, (req, res) => {
  poolPage(req, res, {});
});

router.post('/admin/pools', requireAdmin, (req, res) => {
  const form = parsePoolForm(req.body);
  const owner = findPoolByAlias(form.alias);
  if (owner) {
    return poolPage(req, res, { alias: form.alias, providers: form.providerIds.map((id) => ({ id })) }, { status: 409, notice: poolAliasTakenNotice(form.alias, owner) });
  }
  res.redirect(`/admin/pools/${createPool(form)}?saved=1`);
});

router.get('/admin/pools/:id', requireAdmin, (req, res) => {
  const pool = getPool(req.params.id);
  if (!pool) return res.status(404).send('Pool not found');
  poolPage(req, res, pool);
});

router.post('/admin/pools/:id', requireAdmin, (req, res) => {
  const pool = getPool(req.params.id);
  if (!pool) return res.status(404).send('Pool not found');
  const form = parsePoolForm(req.body);
  const owner = findPoolByAlias(form.alias, { exceptId: pool.id });
  if (owner) {
    return poolPage(req, res, { id: pool.id, alias: form.alias, providers: form.providerIds.map((id) => ({ id })) }, { status: 409, notice: poolAliasTakenNotice(form.alias, owner) });
  }
  updatePool(pool.id, form);
  res.redirect(`/admin/pools/${pool.id}?saved=1`);
});

router.post('/admin/pools/:id/delete', requireAdmin, (req, res) => {
  if (!deletePool(Number(req.params.id) || 0)) return res.status(404).send('Pool not found');
  res.redirect('/admin/pools?deleted=1');
});

module.exports = router;
