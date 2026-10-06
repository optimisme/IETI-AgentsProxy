const config = require('../config');
const { normalizeChatReasoning, normalizeReasoningEvent } = require('../utils/reasoningHistory');
const { callChatCompletions } = require('./providerService');
const { checkQuota } = require('./quotaService');
const { recordUsage } = require('./usageService');
const { estimateChatTokens, estimateTokensFromText } = require('../utils/tokens');
const { validateRequestPayload } = require('../utils/payloadValidation');
const { apiError } = require('../utils/errors');
const { affinityContextFromRequest } = require('./conversationAffinityService');
const { providerAvailability } = require('./providerAvailabilityService');

function failedAttemptUsage(error) {
  const usage = error.upstreamUsage;
  const inputTokens = Math.max(0, Number(usage?.prompt_tokens ?? usage?.input_tokens) || 0);
  const outputTokens = Math.max(0, Number(usage?.completion_tokens ?? usage?.output_tokens) || 0);
  return { inputTokens, outputTokens, totalTokens: Math.max(0, Number(usage?.total_tokens) || inputTokens + outputTokens) };
}

function recordFailedAttempt({ userId, model, wasStreaming }, error) {
  recordUsage({ userId, model, wasStreaming, providerSlug: error.providerSlug, ...failedAttemptUsage(error), status: 'upstream_retry', errorMessage: error.message });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function responseIsClosed(res) {
  return res.destroyed || res.writableEnded;
}

function createStreamInactivityTimer(controller) {
  let timer;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), config.streamInactivityTimeoutMs);
  };
  const clear = () => clearTimeout(timer);
  reset();
  return { clear, reset };
}

async function handleChatCompletion(req, res, next) {
  const user = req.student;
  const payload = req.body || {};
  const model = payload.model || '';
  const wasStreaming = Boolean(payload.stream);
  let estimatedInputTokens = 0;
  let timeout;
  let releaseProvider;
  let releaseQuota;
  let providerSlug = null;
  let providerRequestStarted = false;
  let completeProvider;
  let failProvider;
  let clientDisconnected = false;
  const controller = new AbortController();
  const disconnect = () => {
    if (res.writableEnded) return;
    clientDisconnected = true;
    controller.abort();
  };
  req.once('aborted', disconnect);
  res.once('close', disconnect);

  try {
    estimatedInputTokens = estimateChatTokens(payload);
    if (req.aborted || responseIsClosed(res)) {
      clientDisconnected = true;
      throw new DOMException('Client disconnected.', 'AbortError');
    }
    if (!Array.isArray(payload.messages)) {
      throw apiError(400, 'invalid_request', 'messages must be an array.');
    }
    if (!model) {
      throw apiError(503, 'no_models_available', 'No enabled provider models are available.');
    }
    if (wasStreaming && !config.enableStreaming) {
      throw apiError(400, 'streaming_disabled', 'Streaming is disabled on this server.');
    }
    validateRequestPayload(payload);
    const { group, maxTokens, release: quotaRelease } = checkQuota({
      user,
      model,
      estimatedInputTokens,
      requestedMaxTokens: Number(payload.max_tokens || 0)
    });
    releaseQuota = quotaRelease;
    timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    // Always request streamed usage so accounting uses the provider's real token counts.
    const streamOptions = isPlainObject(payload.stream_options) ? payload.stream_options : {};
    const upstreamPayload = {
      ...payload,
      model,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(wasStreaming ? { stream_options: { ...streamOptions, include_usage: true } } : {})
    };
    providerRequestStarted = true;
    const { upstream, provider, release, complete, fail } = await callChatCompletions(upstreamPayload, {
      signal: controller.signal,
      providerSlugs: group.provider_slugs,
      conversation: affinityContextFromRequest(req),
      onAttemptFailure: (error) => recordFailedAttempt({ userId: user.id, model, wasStreaming }, error)
    });
    releaseProvider = release;
    completeProvider = complete;
    failProvider = fail;
    providerSlug = provider.slug;

    if (wasStreaming) {
      clearTimeout(timeout);
      timeout = undefined;
      await streamResponse({
        upstream,
        res,
        userId: user.id,
        model,
        providerSlug,
        estimatedInputTokens,
        controller,
        completeProvider,
        failProvider,
        forwardUsageChunks: streamOptions.include_usage === true,
        isClientDisconnected: () => clientDisconnected
      });
      return;
    }

    const body = normalizeChatReasoning(await upstream.json());
    if (clientDisconnected || responseIsClosed(res)) {
      throw new DOMException('Client disconnected.', 'AbortError');
    }
    const usage = normalizeUsage(body.usage, estimatedInputTokens, body);
    completeProvider(body.choices?.[0]?.message);
    recordUsage({
      userId: user.id,
      model,
      providerSlug,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      wasStreaming: false,
      status: 'success'
    });
    res.json(body);
  } catch (error) {
    const cancelled = clientDisconnected || responseIsClosed(res);
    const timedOut = !cancelled && error.name === 'AbortError';
    if (!cancelled) {
      if (failProvider) failProvider();
      else if (timedOut && error.providerSlug) providerAvailability.failed(error.providerSlug);
    }
    const upstreamUsage = error.upstreamAttempt && !(cancelled && providerRequestStarted && !error.upstreamUsage) ? failedAttemptUsage(error) : null;
    const inputTokens = upstreamUsage?.inputTokens ?? (cancelled && !providerRequestStarted ? 0 : estimatedInputTokens);
    providerSlug = error.providerSlug || providerSlug;
    recordUsage({
      userId: user?.id,
      model,
      providerSlug,
      inputTokens,
      outputTokens: upstreamUsage?.outputTokens || 0,
      totalTokens: upstreamUsage?.totalTokens ?? inputTokens,
      wasStreaming,
      status: cancelled ? 'cancelled' : timedOut ? 'timeout' : upstreamUsage?.totalTokens > 0 ? 'upstream_error' : 'error',
      errorMessage: cancelled ? 'Client disconnected.' : timedOut ? 'Provider request timed out.' : error.message
    });
    if (cancelled || res.headersSent) {
      if (!responseIsClosed(res)) res.end();
      return;
    }
    next(timedOut ? apiError(504, 'provider_timeout', 'Provider request timed out.') : error);
  } finally {
    if (timeout) clearTimeout(timeout);
    req.removeListener('aborted', disconnect);
    res.removeListener('close', disconnect);
    releaseProvider?.();
    releaseQuota?.();
  }
}

async function streamResponse({ upstream, res, userId, model, providerSlug, estimatedInputTokens, controller, isClientDisconnected, completeProvider, failProvider, forwardUsageChunks = true }) {
  let reader;
  let inactivityTimer;
  let outputText = '';
  let reasoningText = '';
  let usageFromStream = null;
  let streamFinished = false;
  const toolCalls = new Map();
  const outputEstimate = () => estimateTokensFromText(outputText) + estimateTokensFromText(reasoningText) +
    estimateTokensFromText([...toolCalls.values()].map((entry) => entry.function.arguments).join(''));
  const inspectEvent = (event) => {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { streamFinished = true; return; }
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Preserve malformed upstream SSE fragments without treating them as usage.
      return;
    }
    if (parsed.usage) usageFromStream = parsed.usage;
    if (parsed.error) throw new Error(parsed.error.message || 'The upstream stream failed.');
    if (parsed.choices?.some((choice) => choice.finish_reason)) streamFinished = true;
    const delta = parsed.choices?.[0]?.delta || {};
    if (typeof delta.content === 'string') outputText += delta.content;
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string') reasoningText += reasoning;
    for (const tool of delta.tool_calls || []) {
      const index = Number(tool.index || 0);
      const entry = toolCalls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tool.id) entry.id = tool.id;
      if (tool.type) entry.type = tool.type;
      entry.function.name += tool.function?.name || '';
      entry.function.arguments += tool.function?.arguments || '';
      toolCalls.set(index, entry);
    }
    return Boolean(parsed.usage) && Array.isArray(parsed.choices) && parsed.choices.length === 0;
  };
  const writeEvent = (event, separator = '') => {
    if (isClientDisconnected() || responseIsClosed(res)) {
      throw new DOMException('Client disconnected.', 'AbortError');
    }
    const usageOnlyChunk = inspectEvent(event);
    // Clients that did not ask for usage do not expect the final chunk with no choices.
    if (usageOnlyChunk && !forwardUsageChunks) return;
    res.write(normalizeReasoningEvent(event) + separator);
  };

  try {
    if (isClientDisconnected() || responseIsClosed(res)) {
      throw new DOMException('Client disconnected.', 'AbortError');
    }
    res.status(upstream.status);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    const decoder = new TextDecoder();
    reader = upstream.body.getReader();
    inactivityTimer = createStreamInactivityTimer(controller);
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      inactivityTimer.reset();
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/(\r?\n\r?\n)/);
      buffer = events.pop() || '';
      for (let index = 0; index < events.length; index += 2) {
        writeEvent(events[index], events[index + 1]);
      }
    }
    buffer += decoder.decode();
    if (buffer) writeEvent(buffer);
    if (isClientDisconnected() || responseIsClosed(res)) {
      throw new DOMException('Client disconnected.', 'AbortError');
    }
    if (!streamFinished) throw new Error('The upstream stream ended before completion.');
    const usage = normalizeUsage(usageFromStream, estimatedInputTokens, null, outputEstimate());
    completeProvider({ role: 'assistant', content: outputText, ...(toolCalls.size ? { tool_calls: [...toolCalls.values()] } : {}) });
    recordUsage({
      userId,
      model,
      providerSlug,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      wasStreaming: true,
      status: 'success'
    });
    res.end();
  } catch (error) {
    controller.abort();
    const cancelled = isClientDisconnected() || responseIsClosed(res);
    if (!cancelled) failProvider?.();
    const consumed = Boolean(usageFromStream || outputEstimate() > 0);
    const usage = normalizeUsage(usageFromStream, cancelled || consumed ? estimatedInputTokens : 0, null, outputEstimate());
    recordUsage({
      userId,
      model,
      providerSlug,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      wasStreaming: true,
      status: cancelled ? 'cancelled' : consumed ? 'upstream_error' : 'error',
      errorMessage: cancelled ? 'Client disconnected.' : error.message
    });
    if (!cancelled) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: { message: 'Streaming failed.', code: 'stream_error' } })}\n\n`);
        res.end();
      } catch {
        // A disconnected client cannot receive the stream error; usage is already recorded.
      }
    }
  } finally {
    inactivityTimer?.clear();
    reader?.releaseLock();
  }
}

function normalizeUsage(usage, estimatedInputTokens, body, estimatedOutputTokens = null) {
  const promptTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? estimatedInputTokens;
  const completionTokens = usage?.completion_tokens ?? usage?.output_tokens ?? estimatedOutputTokens ?? estimateTokensFromText(JSON.stringify(body?.choices || ''));
  return {
    inputTokens: Number(promptTokens) || 0,
    outputTokens: Number(completionTokens) || 0,
    totalTokens: Number(usage?.total_tokens) || ((Number(promptTokens) || 0) + (Number(completionTokens) || 0))
  };
}

module.exports = { failedAttemptUsage, handleChatCompletion, recordFailedAttempt };
