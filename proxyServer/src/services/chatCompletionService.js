const config = require('../config');
const { normalizeChatReasoning, normalizeReasoningEvent } = require('../utils/reasoningHistory');
const { callChatCompletions } = require('./providerService');
const { checkQuota } = require('./quotaService');
const { recordUsage } = require('./usageService');
const { estimateChatTokens, estimateTokensFromText } = require('../utils/tokens');
const { validateRequestPayload } = require('../utils/payloadValidation');
const { apiError } = require('../utils/errors');

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
  let providerSlug = null;
  let providerRequestStarted = false;
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
    const { group } = checkQuota({
      user,
      model,
      estimatedInputTokens,
      requestedMaxTokens: Number(payload.max_tokens || 0)
    });
    timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    providerRequestStarted = true;
    const { upstream, provider, release } = await callChatCompletions({ ...payload, model }, {
      signal: controller.signal,
      providerSlugs: group.provider_slugs
    });
    releaseProvider = release;
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
        isClientDisconnected: () => clientDisconnected
      });
      return;
    }

    const body = normalizeChatReasoning(await upstream.json());
    if (clientDisconnected || responseIsClosed(res)) {
      throw new DOMException('Client disconnected.', 'AbortError');
    }
    const usage = normalizeUsage(body.usage, estimatedInputTokens, body);
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
    const inputTokens = cancelled && !providerRequestStarted ? 0 : estimatedInputTokens;
    recordUsage({
      userId: user?.id,
      model,
      providerSlug,
      inputTokens,
      outputTokens: 0,
      totalTokens: inputTokens,
      wasStreaming,
      status: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'error',
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
  }
}

async function streamResponse({ upstream, res, userId, model, providerSlug, estimatedInputTokens, controller, isClientDisconnected }) {
  let reader;
  let inactivityTimer;
  let outputText = '';
  let reasoningText = '';
  let usageFromStream = null;
  const outputEstimate = () => estimateTokensFromText(outputText) + estimateTokensFromText(reasoningText);
  const inspectEvent = (event) => {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta || {};
      if (typeof delta.content === 'string') outputText += delta.content;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string') reasoningText += reasoning;
      if (parsed.usage) usageFromStream = parsed.usage;
    } catch {
      // Preserve malformed upstream SSE fragments without treating them as usage.
    }
  };
  const writeEvent = (event, separator = '') => {
    if (isClientDisconnected() || responseIsClosed(res)) {
      throw new DOMException('Client disconnected.', 'AbortError');
    }
    inspectEvent(event);
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
    const usage = normalizeUsage(usageFromStream, estimatedInputTokens, null, outputEstimate());
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
    recordUsage({
      userId,
      model,
      providerSlug,
      inputTokens: estimatedInputTokens,
      outputTokens: outputEstimate(),
      wasStreaming: true,
      status: cancelled ? 'cancelled' : 'error',
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

module.exports = { handleChatCompletion };
