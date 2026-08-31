const config = require('../config');
const { getDb } = require('../db');
const { apiError } = require('../utils/errors');
const {
  CHAT_TEMPLATE_KWARG_NAMES,
  CHAT_TEMPLATE_KWARG_SET,
  REASONING_EFFORTS,
  normalizeReasoningEffort,
  parseReasoningEfforts
} = require('../utils/reasoning');

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
  'reasoning_effort',
  'chat_template_kwargs',
  'response_format',
  'stop'
];

const inFlightByProvider = new Map();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateReasoningControls(payload = {}) {
  const hasReasoningEffort = payload.reasoning_effort !== undefined && payload.reasoning_effort !== null;
  const reasoningEffort = hasReasoningEffort ? normalizeReasoningEffort(payload.reasoning_effort) : null;
  if (hasReasoningEffort && !reasoningEffort) {
    throw apiError(
      400,
      'invalid_reasoning_effort',
      `reasoning_effort must be one of: ${REASONING_EFFORTS.join(', ')}.`
    );
  }

  const hasChatTemplateKwargs = payload.chat_template_kwargs !== undefined && payload.chat_template_kwargs !== null;
  let chatTemplateKwargs = null;
  if (hasChatTemplateKwargs) {
    if (!isPlainObject(payload.chat_template_kwargs)) {
      throw apiError(400, 'invalid_chat_template_kwargs', 'chat_template_kwargs must be an object.');
    }
    const unknown = Object.keys(payload.chat_template_kwargs)
      .filter((name) => !CHAT_TEMPLATE_KWARG_SET.has(name));
    if (unknown.length) {
      throw apiError(
        400,
        'invalid_chat_template_kwargs',
        `Unsupported chat_template_kwargs: ${unknown.join(', ')}. Allowed fields: ${CHAT_TEMPLATE_KWARG_NAMES.join(', ')}.`
      );
    }
    chatTemplateKwargs = {};
    for (const name of ['enable_thinking', 'preserve_thinking']) {
      if (payload.chat_template_kwargs[name] === undefined) continue;
      if (typeof payload.chat_template_kwargs[name] !== 'boolean') {
        throw apiError(400, 'invalid_chat_template_kwargs', `${name} must be a boolean.`);
      }
      chatTemplateKwargs[name] = payload.chat_template_kwargs[name];
    }
    if (payload.chat_template_kwargs.reasoning_effort !== undefined) {
      const nestedEffort = normalizeReasoningEffort(payload.chat_template_kwargs.reasoning_effort);
      if (!nestedEffort) {
        throw apiError(
          400,
          'invalid_reasoning_effort',
          `chat_template_kwargs.reasoning_effort must be one of: ${REASONING_EFFORTS.join(', ')}.`
        );
      }
      if (reasoningEffort && nestedEffort !== reasoningEffort) {
        throw apiError(400, 'conflicting_reasoning_effort', 'reasoning_effort and chat_template_kwargs.reasoning_effort must match.');
      }
      chatTemplateKwargs.reasoning_effort = nestedEffort;
    }
  }

  const effectiveEffort = reasoningEffort || chatTemplateKwargs?.reasoning_effort || null;
  if (effectiveEffort && effectiveEffort !== 'none' && chatTemplateKwargs?.enable_thinking === false) {
    throw apiError(400, 'conflicting_reasoning_controls', 'enable_thinking=false cannot be combined with an active reasoning_effort.');
  }
  if (effectiveEffort === 'none' && chatTemplateKwargs?.enable_thinking === true) {
    throw apiError(400, 'conflicting_reasoning_controls', 'reasoning_effort=none cannot be combined with enable_thinking=true.');
  }

  return {
    reasoningEffort: effectiveEffort,
    chatTemplateKwargs,
    hasChatTemplateKwargs,
    reasoningRequested: Boolean(effectiveEffort || chatTemplateKwargs?.enable_thinking === true)
  };
}

function buildPayload(payload, upstreamModel) {
  const reasoning = validateReasoningControls(payload);
  const next = {};
  for (const field of COMPATIBLE_FIELDS) {
    if (payload[field] === undefined || payload[field] === null) continue;
    if (field === 'chat_template_kwargs') {
      next[field] = reasoning.chatTemplateKwargs;
    } else if (field === 'reasoning_effort') {
      next[field] = normalizeReasoningEffort(payload[field]);
    } else {
      next[field] = payload[field];
    }
  }
  next.model = upstreamModel;
  return next;
}

function chatCompletionsUrl(baseUrl) {
  const clean = String(baseUrl || '').replace(/\/+$/, '');
  return clean.endsWith('/v1') ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`;
}

function modelsUrl(baseUrl) {
  const clean = String(baseUrl || '').replace(/\/+$/, '');
  return clean.endsWith('/v1') ? `${clean}/models` : `${clean}/v1/models`;
}

function providerRootUrl(baseUrl) {
  const clean = String(baseUrl || '').replace(/\/+$/, '');
  return clean.endsWith('/v1') ? clean.slice(0, -3) : clean;
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
      provider_models.reasoning_efforts,
      provider_models.default_reasoning_effort,
      provider_models.supports_chat_template_kwargs,
      provider_models.supports_parallel_tools,
      providers.priority
    FROM providers
    JOIN provider_models ON providers.id = provider_models.provider_id
    WHERE providers.enabled = 1 AND provider_models.enabled = 1
    ORDER BY providers.priority DESC, providers.name ASC, provider_models.id ASC
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
        reasoningEfforts: parseReasoningEfforts(row.reasoning_efforts) || [],
        reasoningEffortsKnown: row.reasoning_efforts !== null,
        defaultReasoningEffort: normalizeReasoningEffort(row.default_reasoning_effort),
        chatTemplateKwargs: Boolean(row.supports_chat_template_kwargs),
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
      provider_models.reasoning_efforts,
      provider_models.default_reasoning_effort,
      provider_models.supports_chat_template_kwargs,
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
    if (requiredCapabilities.reasoningEffort) {
      if (!provider.supports_reasoning) return false;
      const supportedEfforts = parseReasoningEfforts(provider.reasoning_efforts);
      if (supportedEfforts !== null && !supportedEfforts.includes(requiredCapabilities.reasoningEffort)) return false;
    }
    if (requiredCapabilities.chatTemplateKwargs && !provider.supports_chat_template_kwargs) return false;
    if (requiredCapabilities.parallelTools && !provider.supports_parallel_tools) return false;
    return true;
  });
  if (!capableCandidates.length) {
    if (requiredCapabilities.reasoningEffort) {
      throw apiError(
        400,
        'reasoning_effort_not_supported',
        `Model ${publicModelAlias} does not support reasoning_effort=${requiredCapabilities.reasoningEffort} in the assigned provider pool.`
      );
    }
    if (requiredCapabilities.chatTemplateKwargs) {
      throw apiError(
        400,
        'chat_template_kwargs_not_supported',
        `Model ${publicModelAlias} does not support chat_template_kwargs in the assigned provider pool.`
      );
    }
    const missing = Object.entries(requiredCapabilities)
      .filter(([capability, required]) => required && !['reasoningEffort', 'chatTemplateKwargs'].includes(capability))
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
  const reasoning = validateReasoningControls(payload);
  const contentParts = (payload.messages || []).flatMap((message) => Array.isArray(message?.content) ? message.content : []);
  const hasImages = contentParts.some((part) => part?.type === 'image_url' || part?.type === 'input_image');
  const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0 && payload.tool_choice !== 'none';
  return {
    text: true,
    image: hasImages,
    tools: hasTools,
    parallelTools: Boolean(hasTools && payload.parallel_tool_calls),
    reasoning: reasoning.reasoningRequested,
    reasoningEffort: reasoning.reasoningEffort,
    chatTemplateKwargs: reasoning.hasChatTemplateKwargs
  };
}

async function callChatCompletions(payload, { signal, providerSlug = null, providerSlugs = null, requiredCapabilities = {} } = {}) {
  const inferred = inferRequiredCapabilities(payload);
  const requirements = {
    text: Boolean(inferred.text || requiredCapabilities.text),
    image: Boolean(inferred.image || requiredCapabilities.image),
    tools: Boolean(inferred.tools || requiredCapabilities.tools),
    parallelTools: Boolean(inferred.parallelTools || requiredCapabilities.parallelTools),
    reasoning: Boolean(inferred.reasoning || requiredCapabilities.reasoning),
    reasoningEffort: requiredCapabilities.reasoningEffort || inferred.reasoningEffort || null,
    chatTemplateKwargs: Boolean(inferred.chatTemplateKwargs || requiredCapabilities.chatTemplateKwargs)
  };
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

async function discoverProviderMetadata({ slug, apiKey, baseUrl }) {
  const provider = slug ? getProviderBySlug(slug) : null;
  const targetBaseUrl = String(baseUrl || provider?.base_url || '').replace(/\/+$/, '');
  const targetApiKey = apiKey || provider?.api_key || '';
  const timeoutMs = Math.min(Math.max(Number(provider?.timeout_ms || config.requestTimeoutMs), 1000), 30000);

  if (!targetBaseUrl) {
    return { ok: false, status: 0, errorMessage: 'Base URL is missing.', models: [], warnings: [] };
  }

  const requestJson = async (url) => {
    const response = await fetch(url, {
      headers: targetApiKey ? { Authorization: `Bearer ${targetApiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { response, body, text };
  };

  let modelResponse;
  try {
    modelResponse = await requestJson(modelsUrl(targetBaseUrl));
  } catch (error) {
    return {
      ok: false,
      status: 0,
      errorMessage: `Could not query the upstream model catalog: ${error.message}`,
      models: [],
      warnings: []
    };
  }

  if (!modelResponse.response.ok) {
    const upstreamMessage = modelResponse.body?.error?.message || modelResponse.body?.message || modelResponse.body?.detail;
    return {
      ok: false,
      status: modelResponse.response.status,
      errorMessage: upstreamMessage || 'The upstream provider does not expose a compatible model catalog.',
      models: [],
      warnings: []
    };
  }

  if (!Array.isArray(modelResponse.body?.data)) {
    return {
      ok: false,
      status: modelResponse.response.status,
      errorMessage: 'The upstream /models response does not contain a model list.',
      models: [],
      warnings: []
    };
  }

  const models = modelResponse.body.data.map((model) => {
    const maxModelLen = Number(model?.max_model_len);
    return {
      id: String(model?.id || '').trim(),
      ownedBy: String(model?.owned_by || '').trim() || null,
      root: String(model?.root || '').trim() || null,
      maxModelLen: Number.isFinite(maxModelLen) && maxModelLen > 0 ? maxModelLen : null
    };
  }).filter((model) => model.id);

  if (!models.length) {
    return {
      ok: false,
      status: modelResponse.response.status,
      errorMessage: 'The upstream provider returned no usable models.',
      models: [],
      warnings: []
    };
  }

  const isVllm = models.some((model) => model.ownedBy?.toLowerCase() === 'vllm');
  const warnings = [];
  let version = null;
  if (isVllm) {
    try {
      const versionResponse = await requestJson(`${providerRootUrl(targetBaseUrl)}/version`);
      if (versionResponse.response.ok) {
        version = String(versionResponse.body?.version || '').trim() || null;
      } else if (versionResponse.response.status !== 404) {
        warnings.push(`The optional version endpoint returned HTTP ${versionResponse.response.status}.`);
      }
    } catch (error) {
      warnings.push(`The optional version endpoint could not be queried: ${error.message}`);
    }
  }

  return {
    ok: true,
    status: modelResponse.response.status,
    providerType: isVllm ? 'vllm' : 'openai-compatible',
    version,
    models,
    warnings
  };
}

module.exports = {
  buildPayload,
  callChatCompletions,
  chatCompletionsUrl,
  chooseProviderModel,
  discoverProviderMetadata,
  getEnabledModelEntries,
  getPublicModelAliasesForProviderSlugs,
  getInFlight,
  getProviderBySlug,
  inferRequiredCapabilities,
  listProviders,
  modelsUrl,
  providerRootUrl,
  reserveProviderForTest,
  testProvider
};
