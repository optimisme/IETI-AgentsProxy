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
  validatePoolAlias,
  positiveIds
} = require('../../services/poolService');
const { apiError } = require('../../utils/errors');
const { REASONING_EFFORTS } = require('../../utils/reasoning');
const { flash } = require('../../utils/html');
const { activeProviderModel, render, tokens, formConflict, formRoute } = require('./shared');
const { poolPageView, poolsPage, poolAliasTakenNotice } = require('../../views/admin/pools');

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

// Every provider, with its mapping and the other pools it is in, for the pool form's checklist.
function poolFormProviders(pool) {
  return listProviders().map((provider) => ({
    ...provider,
    model: activeProviderModel(provider.id),
    otherPools: poolsForProvider(provider.id).filter((other) => Number(other.id) !== Number(pool.id))
  }));
}

function parsePoolForm(body) {
  return { alias: validatePoolAlias(body.alias), providerIds: validProviderIds(body.provider_ids) };
}

function poolPage(req, res, pool, { status = 200, notice = '' } = {}) {
  const saved = pool.id ? getPool(pool.id) : null;
  const providerViews = saved ? poolProviderViews(saved) : [];
  const groups = saved ? groupsForPool(saved.id) : [];
  const message = req.query.saved ? 'Pool saved.' : '';
  const providers = poolFormProviders(pool);
  const offer = saved ? poolOffer(saved) : null;
  res.status(status);
  render(req, res, 'settings', {
    title: saved ? 'Edit pool' : 'New pool',
    flash: notice || flash(message),
    content: poolPageView({ pool, saved, providerViews, groups, providers, offer })
  });
}

router.get('/admin/pools', requireAdmin, (req, res) => {
  const pools = listPools().map((pool) => ({ ...pool, providerViews: poolProviderViews(pool) }));
  render(req, res, 'settings', {
    title: 'Pools',
    flash: flash(req.query.deleted ? 'Pool deleted.' : ''),
    content: poolsPage({ pools })
  });
});

// The pool form's fields as submitted, valid or not.
function poolFromBody(body, id) {
  return { id, alias: body.alias ?? '', providers: positiveIds(body.provider_ids).map((providerId) => ({ id: providerId })) };
}

function refuseTakenAlias(alias, exceptId = null) {
  const owner = findPoolByAlias(alias, { exceptId });
  if (owner) throw formConflict('alias_taken', `The alias ${alias} is already used by another pool.`, poolAliasTakenNotice(alias, owner));
}

router.get('/admin/pools/new', requireAdmin, (req, res) => {
  poolPage(req, res, {});
});

router.post('/admin/pools', requireAdmin, formRoute(
  (req, res, { values, notice, status }) => poolPage(req, res, poolFromBody(values), { status, notice }),
  (req, res) => {
    const form = parsePoolForm(req.body);
    refuseTakenAlias(form.alias);
    res.redirect(`/admin/pools/${createPool(form)}?saved=1`);
  }
));

router.get('/admin/pools/:id', requireAdmin, (req, res) => {
  const pool = getPool(req.params.id);
  if (!pool) return res.status(404).send('Pool not found');
  poolPage(req, res, pool);
});

router.post('/admin/pools/:id', requireAdmin, formRoute(
  (req, res, { values, notice, status }) => poolPage(req, res, poolFromBody(values, Number(req.params.id)), { status, notice }),
  (req, res) => {
    const pool = getPool(req.params.id);
    if (!pool) return res.status(404).send('Pool not found');
    const form = parsePoolForm(req.body);
    refuseTakenAlias(form.alias, pool.id);
    updatePool(pool.id, form);
    res.redirect(`/admin/pools/${pool.id}?saved=1`);
  }
));

router.post('/admin/pools/:id/delete', requireAdmin, (req, res) => {
  if (!deletePool(Number(req.params.id) || 0)) return res.status(404).send('Pool not found');
  res.redirect('/admin/pools?deleted=1');
});

module.exports = router;
