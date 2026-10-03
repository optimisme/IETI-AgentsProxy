const config = require('../config');
const { getDb } = require('../db');
const { chatCompletionsUrl, getInFlight, reserveProviderForTest } = require('./providerService');

const KEEP_WARM_INTERVAL_MS = 60000;
const KEEP_WARM_TIMEOUT_MS = 30000;

function createProviderKeepWarmService({ database = getDb, fetchImpl = fetch, logger = console, now = Date.now } = {}) {
  const active = new Map();
  const lastAttemptAt = new Map();
  let timer;
  let stopped = false;

  async function warm(provider, checkedAt) {
    // Existing traffic already keeps the provider warm. Leave its capacity for students.
    if (active.has(provider.id) || getInFlight(provider.slug) > 0) return;
    const previousAttempt = lastAttemptAt.get(provider.id);
    const intervalMs = provider.keep_warm_interval_minutes * KEEP_WARM_INTERVAL_MS;
    if (previousAttempt !== undefined && checkedAt - previousAttempt < intervalMs) return;
    const controller = new AbortController();
    active.set(provider.id, controller);
    let release;
    try {
      release = reserveProviderForTest(provider.slug);
      // Anchor the cadence so a delayed callback does not skip the following minute.
      lastAttemptAt.set(provider.id, previousAttempt === undefined ? checkedAt
        : previousAttempt + Math.floor((checkedAt - previousAttempt) / intervalMs) * intervalMs);
      const timeoutMs = Math.max(1, Math.min(
        Number(provider.timeout_ms || config.requestTimeoutMs), KEEP_WARM_TIMEOUT_MS
      ));
      const response = await fetchImpl(chatCompletionsUrl(provider.base_url), {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${provider.api_key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: provider.upstream_model,
          messages: [{ role: 'user', content: 'Reply OK.' }],
          max_tokens: Math.min(8, Number(provider.output_limit) || 8),
          stream: false
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
      });
      // Keep the timeout and capacity reservation until the response body finishes.
      await response.text();
      if (!response.ok) logger.warn(`Keep warm failed for provider ${provider.id}: HTTP ${response.status}.`);
    } catch {
      // Never log upstream bodies, URLs, credentials or student content.
      if (!controller.signal.aborted) logger.warn(`Keep warm failed for provider ${provider.id}: request failed or timed out.`);
    } finally {
      release?.();
      active.delete(provider.id);
    }
  }

  async function runOnce() {
    if (stopped) return;
    const checkedAt = now();
    try {
      const providers = database().prepare(`
        SELECT providers.*, provider_models.upstream_model, provider_models.output_limit
        FROM providers
        JOIN provider_models ON provider_models.id = (
          SELECT id FROM provider_models
          WHERE provider_id = providers.id AND enabled = 1 AND supports_text_input = 1
          ORDER BY updated_at DESC, id DESC LIMIT 1
        )
        WHERE providers.enabled = 1 AND providers.keep_warm_interval_minutes IN (1, 5)
          AND TRIM(providers.base_url) != '' AND TRIM(providers.api_key) != ''
          AND TRIM(provider_models.upstream_model) != ''
      `).all();
      const eligibleIds = new Set(providers.map((provider) => provider.id));
      for (const id of lastAttemptAt.keys()) {
        if (!eligibleIds.has(id)) lastAttemptAt.delete(id);
      }
      await Promise.all(providers.map((provider) => warm(provider, checkedAt)));
    } catch {
      logger.warn('Keep warm could not read provider settings. It will retry on the next interval.');
    }
  }

  function start() {
    if (timer) return;
    stopped = false;
    void runOnce();
    timer = setInterval(() => { void runOnce(); }, KEEP_WARM_INTERVAL_MS);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    lastAttemptAt.clear();
    for (const controller of active.values()) controller.abort();
  }

  return { start, stop, runOnce };
}

module.exports = { createProviderKeepWarmService, KEEP_WARM_INTERVAL_MS };
