const config = require('../config');
const { getDb } = require('../db');
const { apiError } = require('../utils/errors');

const COMPATIBLE_FIELDS = [
  'model',
  'messages',
  'temperature',
  'top_p',
  'max_tokens',
  'stream',
  'stream_options',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'presence_penalty',
  'frequency_penalty',
  'reasoning_content',
  'response_format',
  'stop'
];

const inFlightByProvider = new Map();

function buildPayload(payload, upstreamModel) {
  const next = {};
  for (const field of COMPATIBLE_FIELDS) {
    if (payload[field] !== undefined) next[field] = payload[field];
  }
  next.model = upstreamModel;
  return next;
}

function chatCompletionsUrl(baseUrl) {
  const clean = String(baseUrl || '').replace(/\/+$/, '');
  return clean.endsWith('/v1') ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`;
}

function getProviderBySlug(slug) {
  return getDb().prepare('SELECT * FROM providers WHERE slug = ?').get(slug);
}

function listProviders() {
  return getDb().prepare('SELECT * FROM providers ORDER BY name ASC').all().map((provider) => ({
    ...provider,
    in_flight: getInFlight(provider.slug)
  }));
}

function getEnabledModelEntries() {
  const rows = getDb().prepare(`
    SELECT
      providers.slug,
      providers.name AS provider_name,
      provider_models.public_model,
      provider_models.name AS model_name,
      provider_models.context_limit,
      provider_models.output_limit,
      provider_models.supports_text_input,
      provider_models.supports_image_input,
      provider_models.supports_tools,
      provider_models.supports_reasoning,
      provider_models.supports_parallel_tools,
      providers.priority
    FROM providers
    JOIN provider_models ON providers.id = provider_models.provider_id
    WHERE providers.enabled = 1 AND provider_models.enabled = 1
    GROUP BY providers.id
    ORDER BY providers.priority DESC, providers.name ASC
  `).all();
  return rows.map((row) => ({
      id: row.slug,
      publicModel: row.public_model,
      name: row.provider_name || row.slug,
      limit: {
        context: Number(row.context_limit || config.defaultModelContextLimit),
        output: Number(row.output_limit || config.defaultModelOutputLimit)
      },
      capabilities: {
        text: Boolean(row.supports_text_input),
        image: Boolean(row.supports_image_input),
        tools: Boolean(row.supports_tools),
        reasoning: Boolean(row.supports_reasoning),
        parallelTools: Boolean(row.supports_parallel_tools)
      }
  }));
}

function getPublicModelAliasesForProviderSlugs(slugs) {
  const allowedSlugs = new Set(normalizeProviderSlugs(slugs));
  if (!allowedSlugs.size) return [];
  return [...new Set(getEnabledModelEntries()
    .filter((model) => allowedSlugs.has(model.id))
    .map((model) => model.publicModel)
    .filter(Boolean))];
}

function getInFlight(slug) {
  return inFlightByProvider.get(slug) || 0;
}

function hasCapacity(provider) {
  const max = Number(provider.max_concurrent_requests || 0);
  return max <= 0 || getInFlight(provider.slug) < max;
}

function randomChoice(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function reserveProvider(provider) {
  inFlightByProvider.set(provider.slug, getInFlight(provider.slug) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlightByProvider.set(provider.slug, Math.max(0, getInFlight(provider.slug) - 1));
  };
}

function reserveProviderForTest(slug) {
  const provider = getProviderBySlug(slug);
  if (!provider) throw new Error(`Provider ${slug} not found.`);
  return reserveProvider(provider);
}

function normalizeProviderSlugs(slugs) {
  if (!slugs) return [];
  const values = Array.isArray(slugs) ? slugs : [slugs];
  return [...new Set(values.map((slug) => String(slug || '').trim()).filter(Boolean))];
}

function chooseProviderModel(publicModelAlias, assignedProviderSlugs = null, requiredCapabilities = {}) {
  const slugs = normalizeProviderSlugs(assignedProviderSlugs);
  const params = { publicModelAlias };
  const providerFilter = slugs.length
    ? `AND providers.slug IN (${slugs.map((_, index) => `@slug${index}`).join(', ')})
       AND provider_models.public_model = @publicModelAlias`
    : 'AND provider_models.public_model = @publicModelAlias';
  slugs.forEach((slug, index) => {
    params[`slug${index}`] = slug;
  });

  const candidates = getDb().prepare(`
    SELECT
      providers.*,
      provider_models.public_model AS public_model_alias,
      provider_models.upstream_model,
      provider_models.context_limit,
      provider_models.output_limit,
      provider_models.supports_text_input,
      provider_models.supports_image_input,
      provider_models.supports_tools,
      provider_models.supports_reasoning,
      provider_models.supports_parallel_tools
    FROM provider_models
    JOIN providers ON providers.id = provider_models.provider_id
    WHERE providers.enabled = 1
      AND provider_models.enabled = 1
      ${providerFilter}
    ORDER BY providers.priority DESC, providers.name ASC, providers.id ASC
  `).all(params);

  if (!candidates.length) {
    throw apiError(404, 'model_not_found', `Model ${publicModelAlias} is not available.`);
  }

  const capableCandidates = candidates.filter((provider) => {
    if (requiredCapabilities.text && !provider.supports_text_input) return false;
    if (requiredCapabilities.image && !provider.supports_image_input) return false;
    if (requiredCapabilities.tools && !provider.supports_tools) return false;
    if (requiredCapabilities.reasoning && !provider.supports_reasoning) return false;
    if (requiredCapabilities.parallelTools && !provider.supports_parallel_tools) return false;
    return true;
  });
  if (!capableCandidates.length) {
    const missing = Object.entries(requiredCapabilities)
      .filter(([, required]) => required)
      .map(([capability]) => capability)
      .join(', ');
    throw apiError(400, 'model_capability_unavailable', `Model ${publicModelAlias} has no assigned provider supporting: ${missing}.`);
  }

  const availableCandidates = capableCandidates.filter(hasCapacity);
  if (!availableCandidates.length) {
    throw apiError(503, 'provider_capacity_exceeded', `All providers for ${publicModelAlias} are at capacity.`);
  }

  const lowestInFlight = Math.min(...availableCandidates.map((provider) => getInFlight(provider.slug)));
  const leastBusyCandidates = availableCandidates.filter((provider) => getInFlight(provider.slug) === lowestInFlight);
  const highestPriority = Math.max(...leastBusyCandidates.map((provider) => Number(provider.priority || 0)));
  const topCandidates = leastBusyCandidates.filter((provider) => Number(provider.priority || 0) === highestPriority);
  const candidate = randomChoice(topCandidates);
  return candidate;
}

function inferRequiredCapabilities(payload) {
  const contentParts = (payload.messages || []).flatMap((message) => Array.isArray(message?.content) ? message.content : []);
  const hasImages = contentParts.some((part) => part?.type === 'image_url' || part?.type === 'input_image');
  const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0 && payload.tool_choice !== 'none';
  return {
    text: true,
    image: hasImages,
    tools: hasTools,
    parallelTools: Boolean(hasTools && payload.parallel_tool_calls),
    reasoning: false
  };
}

async function callChatCompletions(payload, { signal, providerSlug = null, providerSlugs = null, requiredCapabilities = {} } = {}) {
  const inferred = inferRequiredCapabilities(payload);
  const requirements = Object.fromEntries(
    Object.keys(inferred).map((key) => [key, Boolean(inferred[key] || requiredCapabilities[key])])
  );
  const provider = chooseProviderModel(payload.model, providerSlugs || providerSlug, requirements);
  if (!provider.base_url) {
    throw apiError(503, 'provider_misconfigured', `Provider ${provider.slug} has no base URL.`);
  }
  if (!provider.api_key) {
    throw apiError(503, 'provider_misconfigured', `Provider ${provider.slug} has no API key placeholder or API key.`);
  }

  const release = reserveProvider(provider);
  try {
    const response = await fetch(chatCompletionsUrl(provider.base_url), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildPayload(payload, provider.upstream_model)),
      signal
    });

    if (!response.ok) {
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: { message: text || response.statusText } };
      }
      const message = body?.error?.message || response.statusText || `${provider.name} request failed.`;
      const code = response.status === 402 || /balance|insufficient/i.test(message)
        ? 'insufficient_provider_balance'
        : 'provider_error';
      release();
      throw apiError(response.status === 401 ? 502 : response.status, code, message, body);
    }

    return { upstream: response, provider, release };
  } catch (error) {
    release();
    throw error;
  }
}

async function testProvider({ slug, apiKey, baseUrl, model }) {
  const provider = slug ? getProviderBySlug(slug) : null;
  const targetBaseUrl = String(baseUrl || provider?.base_url || '').replace(/\/+$/, '');
  const targetApiKey = apiKey || provider?.api_key || '';
  const targetModel = model || getDb().prepare(`
    SELECT upstream_model
    FROM provider_models
    WHERE provider_id = ?
    ORDER BY public_model ASC
    LIMIT 1
  `).get(provider?.id)?.upstream_model;

  const warnings = [];
  if (provider && !provider.enabled) warnings.push('Provider is disabled.');
  if (!targetBaseUrl) warnings.push('Base URL is missing.');
  if (!targetApiKey) warnings.push('API key is not configured.');
  if (!targetModel) warnings.push('No provider model mapping is configured.');
  if (warnings.length) {
    return {
      ok: false,
      status: 0,
      body: warnings.join(' '),
      errorMessage: warnings.join(' '),
      diagnostics: { warnings, baseUrl: targetBaseUrl, model: targetModel || null }
    };
  }

  let response;
  try {
    response = await fetch(chatCompletionsUrl(targetBaseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${targetApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 8,
        stream: false
      })
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: error.message,
      errorMessage: error.message,
      diagnostics: { warnings, baseUrl: targetBaseUrl, model: targetModel }
    };
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const upstreamMessage = parsed?.error?.message || parsed?.message || null;
  return {
    ok: response.ok,
    status: response.status,
    body: text.slice(0, 1000),
    errorMessage: upstreamMessage,
    diagnostics: { warnings, baseUrl: targetBaseUrl, model: targetModel }
  };
}

module.exports = {
  buildPayload,
  callChatCompletions,
  chatCompletionsUrl,
  chooseProviderModel,
  getEnabledModelEntries,
  getPublicModelAliasesForProviderSlugs,
  getInFlight,
  getProviderBySlug,
  inferRequiredCapabilities,
  listProviders,
  reserveProviderForTest,
  testProvider
};
