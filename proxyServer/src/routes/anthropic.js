const express = require('express');
const config = require('../config');
const { authStudent } = require('../middleware/authStudent');
const { studentRateLimit } = require('../middleware/rateLimit');
const { largeJsonBody } = require('../middleware/bodyParsers');
const { callChatCompletions, getPublicModelAliasesForProviderSlugs } = require('../services/providerService');
const { failedAttemptUsage, recordFailedAttempt } = require('../services/chatCompletionService');
const { providerAvailability } = require('../services/providerAvailabilityService');
const { checkQuota } = require('../services/quotaService');
const { recordUsage } = require('../services/usageService');
const { getUserGroup } = require('../services/accessService');
const { estimateChatTokens, estimateTokensFromText } = require('../utils/tokens');
const { validateRequestPayload } = require('../utils/payloadValidation');
const { apiError } = require('../utils/errors');
const {
  anthropicContentToChatMessage,
  anthropicErrorBody,
  anthropicToChatPayload,
  chatCompletionToAnthropic,
  chatUsageToAnthropic,
  encodeThinkingSignature,
  messageId,
  parseToolArguments,
  stopReason,
  toolUseId,
  usageTotals
} = require('../services/anthropicService');

const router = express.Router();
const PING_INTERVAL_MS = 15000;

function availableModels(user) {
  return getPublicModelAliasesForProviderSlugs(getUserGroup(user.id)?.provider_slugs || []);
}

function modelNotFound(models, model) {
  const hint = /^claude-/i.test(model)
    ? 'This proxy does not serve Anthropic models. Choose one of its models with --model or ANTHROPIC_MODEL.'
    : 'Choose one of the models assigned to your group.';
  return apiError(404, 'model_not_found', `Model ${model} is not available on this proxy. ${hint} Available models: ${models.join(', ') || 'none'}.`);
}

// Claude Code identifies its session in this header; it keeps a conversation on one provider.
function affinityContext(req) {
  const sessionId = req.get('x-claude-code-session-id');
  const valid = typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 256 && !/\s|[\x00-\x1f\x7f]/.test(sessionId);
  return { userId: req.student?.id, conversationId: valid ? sessionId : null };
}

router.post('/v1/messages/count_tokens', authStudent, largeJsonBody, (req, res, next) => {
  try {
    const chatPayload = anthropicToChatPayload({ ...req.body, stream: false });
    res.json({ input_tokens: estimateChatTokens(chatPayload) });
  } catch (error) {
    next(error);
  }
});

router.post('/v1/messages', authStudent, studentRateLimit, largeJsonBody, async (req, res, next) => {
  const user = req.student;
  const anthropicPayload = req.body || {};
  let model = typeof anthropicPayload.model === 'string' ? anthropicPayload.model : '';
  let estimatedInputTokens = 0;
  const wasStreaming = Boolean(anthropicPayload.stream);
  let timeout;
  let releaseProvider;
  let releaseQuota;
  let providerSlug = null;
  let completeProvider;
  let failProvider;
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
    if (req.aborted || res.destroyed) {
      clientDisconnected = true;
      throw new DOMException('Client disconnected.', 'AbortError');
    }
    const chatPayload = anthropicToChatPayload(anthropicPayload);
    model = chatPayload.model;
    estimatedInputTokens = estimateChatTokens(chatPayload);

    if (wasStreaming && !config.enableStreaming) {
      throw apiError(400, 'streaming_disabled', 'Streaming is disabled on this server.');
    }
    validateRequestPayload(chatPayload);
    // Answer Anthropic clients with not_found_error rather than the quota check's 403.
    const models = availableModels(user);
    if (!models.includes(model)) throw modelNotFound(models, model);

    const { group, maxTokens, release: quotaRelease } = checkQuota({
      user,
      model,
      estimatedInputTokens,
      requestedMaxTokens: Number(chatPayload.max_tokens || 0)
    });
    releaseQuota = quotaRelease;
    if (maxTokens) chatPayload.max_tokens = maxTokens;
    // Only the wait for upstream headers is bounded; a started stream is bounded by inactivity.
    timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    providerRequestStarted = true;
    const { upstream, provider, release, complete, fail } = await callChatCompletions(chatPayload, {
      signal: controller.signal,
      providerSlugs: group.provider_slugs,
      conversation: affinityContext(req),
      onAttemptFailure: (error) => recordFailedAttempt({ userId: user.id, model, wasStreaming }, error)
    });
    releaseProvider = release;
    completeProvider = complete;
    failProvider = fail;
    providerSlug = provider.slug;

    if (wasStreaming) {
      clearTimeout(timeout);
      timeout = undefined;
      await streamAnthropicMessages({
        upstream,
        res,
        userId: user.id,
        model,
        providerSlug,
        estimatedInputTokens,
        controller,
        completeProvider,
        failProvider,
        isClientDisconnected: () => clientDisconnected
      });
      return;
    }

    const chatBody = await upstream.json();
    if (clientDisconnected || res.destroyed) throw new DOMException('Client disconnected.', 'AbortError');
    const responseBody = chatCompletionToAnthropic(chatBody, model, estimatedInputTokens);
    completeProvider(anthropicContentToChatMessage(responseBody.content));
    recordUsage({ userId: user.id, model, providerSlug, ...usageTotals(responseBody.usage), wasStreaming: false, status: 'success' });
    res.json(responseBody);
  } catch (error) {
    const cancelled = clientDisconnected || res.destroyed;
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
      if (!res.destroyed && !res.writableEnded) res.end();
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
});

function writeEvent(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
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

// Anthropic content blocks are strictly sequential, while chat-completions deltas carry
// reasoning, text and indexed tool calls. Each change of kind closes the open block.
function createBlockWriter(res) {
  const state = { nextIndex: 0, open: null, content: [], toolsByIndex: new Map() };

  function close() {
    const open = state.open;
    if (!open) return;
    if (open.block.type === 'thinking') {
      open.block.signature = encodeThinkingSignature(open.block.thinking);
      writeEvent(res, 'content_block_delta', { index: open.index, delta: { type: 'signature_delta', signature: open.block.signature } });
    }
    if (open.block.type === 'tool_use') open.block.input = parseToolArguments(open.arguments);
    writeEvent(res, 'content_block_stop', { index: open.index });
    state.open = null;
  }

  function open(block, key) {
    close();
    const entry = { index: state.nextIndex++, block, key, arguments: '' };
    state.open = entry;
    state.content.push(block);
    const start = block.type === 'tool_use' ? { ...block, input: {} } : { ...block };
    writeEvent(res, 'content_block_start', { index: entry.index, content_block: start });
    return entry;
  }

  function thinking(text) {
    const entry = state.open?.block.type === 'thinking' ? state.open : open({ type: 'thinking', thinking: '', signature: '' }, 'thinking');
    entry.block.thinking += text;
    writeEvent(res, 'content_block_delta', { index: entry.index, delta: { type: 'thinking_delta', thinking: text } });
  }

  function text(value) {
    const entry = state.open?.block.type === 'text' ? state.open : open({ type: 'text', text: '' }, 'text');
    entry.block.text += value;
    writeEvent(res, 'content_block_delta', { index: entry.index, delta: { type: 'text_delta', text: value } });
  }

  function toolDelta(delta) {
    const index = Number(delta.index || 0);
    let tool = state.toolsByIndex.get(index);
    if (!tool) {
      tool = { id: '', name: '', pending: '', entry: null };
      state.toolsByIndex.set(index, tool);
    }
    if (delta.id) tool.id = delta.id;
    if (delta.function?.name) tool.name += delta.function.name;
    const argumentsDelta = delta.function?.arguments || '';
    if (!tool.entry) {
      // The block can only start once the tool name is known.
      tool.pending += argumentsDelta;
      if (!tool.name) return;
      tool.entry = open({ type: 'tool_use', id: toolUseId(tool.id), name: tool.name, input: {} }, `tool:${index}`);
      if (tool.pending) appendArguments(tool.entry, tool.pending);
      return;
    }
    if (!argumentsDelta) return;
    if (state.open !== tool.entry) {
      console.warn('Dropped tool-call arguments that arrived after their block closed.');
      return;
    }
    appendArguments(tool.entry, argumentsDelta);
  }

  function appendArguments(entry, value) {
    entry.arguments += value;
    writeEvent(res, 'content_block_delta', { index: entry.index, delta: { type: 'input_json_delta', partial_json: value } });
  }

  function outputText() {
    return state.content.map((block) => block.thinking || block.text || JSON.stringify(block.input || '')).join('');
  }

  return { close, thinking, text, toolDelta, outputText, state };
}

async function streamAnthropicMessages({ upstream, res, userId, model, providerSlug, estimatedInputTokens, controller, completeProvider, failProvider, isClientDisconnected }) {
  if (isClientDisconnected() || res.destroyed) throw new DOMException('Client disconnected.', 'AbortError');
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const id = messageId();
  writeEvent(res, 'message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: estimatedInputTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    }
  });
  writeEvent(res, 'ping', {});
  // Long reasoning or prefill can leave the connection silent; pings keep intermediaries open.
  const pingTimer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) writeEvent(res, 'ping', {});
  }, PING_INTERVAL_MS);
  pingTimer.unref?.();

  const blocks = createBlockWriter(res);
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  const inactivityTimer = createStreamInactivityTimer(controller);
  let buffer = '';
  let usage = null;
  let finishReason = null;
  let streamFinished = false;
  const outputEstimate = () => estimateTokensFromText(blocks.outputText());

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (isClientDisconnected() || res.destroyed) throw new DOMException('Client disconnected.', 'AbortError');
      if (!done) inactivityTimer.reset();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      if (done && buffer) { events.push(buffer); buffer = ''; }

      for (const rawEvent of events) {
        const data = rawEvent.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        if (data === '[DONE]') { streamFinished = true; continue; }
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.error) throw new Error(chunk.error.message || 'The upstream stream failed.');
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) { finishReason = choice.finish_reason; streamFinished = true; }
        const delta = choice.delta || {};
        const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoningDelta === 'string' && reasoningDelta) blocks.thinking(reasoningDelta);
        if (typeof delta.content === 'string' && delta.content) blocks.text(delta.content);
        for (const toolDelta of delta.tool_calls || []) blocks.toolDelta(toolDelta);
      }
      if (done) break;
    }

    if (!streamFinished) throw new Error('The upstream stream ended before completion.');
    blocks.close();
    const content = blocks.state.content;
    const anthropicUsage = chatUsageToAnthropic(usage, estimatedInputTokens, outputEstimate());
    writeEvent(res, 'message_delta', {
      delta: { stop_reason: stopReason(finishReason, content.some((block) => block.type === 'tool_use')), stop_sequence: null },
      usage: anthropicUsage
    });
    writeEvent(res, 'message_stop', {});
    completeProvider(anthropicContentToChatMessage(content));
    recordUsage({ userId, model, providerSlug, ...usageTotals(anthropicUsage), wasStreaming: true, status: 'success' });
    res.end();
  } catch (error) {
    controller.abort();
    const cancelled = isClientDisconnected() || res.destroyed;
    if (!cancelled) failProvider?.();
    const consumed = Boolean(usage || outputEstimate() > 0);
    const anthropicUsage = chatUsageToAnthropic(usage, cancelled || consumed ? estimatedInputTokens : 0, outputEstimate());
    recordUsage({
      userId,
      model,
      providerSlug,
      ...usageTotals(anthropicUsage),
      wasStreaming: true,
      status: cancelled ? 'cancelled' : consumed ? 'upstream_error' : 'error',
      errorMessage: cancelled ? 'Client disconnected.' : error.message
    });
    if (!cancelled) {
      try {
        writeEvent(res, 'error', { error: { type: 'api_error', message: 'Streaming failed.' } });
        res.end();
      } catch {
        // A disconnected client cannot receive the stream error; usage is already recorded.
      }
    }
  } finally {
    clearInterval(pingTimer);
    inactivityTimer.clear();
    reader.releaseLock();
  }
}

module.exports = router;
