const express = require('express');
const config = require('../config');
const { authStudent } = require('../middleware/authStudent');
const { studentRateLimit } = require('../middleware/rateLimit');
const { largeJsonBody } = require('../middleware/bodyParsers');
const { callChatCompletions, getEnabledModelEntries } = require('../services/providerService');
const { failedAttemptUsage, handleChatCompletion, recordFailedAttempt } = require('../services/chatCompletionService');
const { affinityContextFromRequest } = require('../services/conversationAffinityService');
const { providerAvailability } = require('../services/providerAvailabilityService');
const { checkQuota } = require('../services/quotaService');
const { recordUsage } = require('../services/usageService');
const { getUserGroup } = require('../services/accessService');
const { estimateChatTokens, estimateTokensFromText } = require('../utils/tokens');
const { validateRequestPayload } = require('../utils/payloadValidation');
const { apiError } = require('../utils/errors');
const { commonCapabilities } = require('../utils/modelCapabilities');
const {
  chatCompletionToResponse,
  chatUsageToResponses,
  codexModelMetadata,
  createResponseShell,
  outputItemId,
  responsesToChatPayload
} = require('../services/responsesService');

const router = express.Router();

function getPublishedModels(providerSlugs) {
  const allowed = new Set(providerSlugs || []);
  const grouped = new Map();
  for (const entry of getEnabledModelEntries().filter((model) => allowed.has(model.id))) {
    if (!entry.publicModel) continue;
    const current = grouped.get(entry.publicModel);
    const contextWindow = Number(entry.limit?.context || config.defaultModelContextLimit);
    const outputLimit = Number(entry.limit?.output || config.defaultModelOutputLimit);
    grouped.set(entry.publicModel, {
      id: entry.publicModel,
      contextWindow: current ? Math.min(current.contextWindow, contextWindow) : contextWindow,
      outputLimit: current ? Math.min(current.outputLimit, outputLimit) : outputLimit,
      capabilities: commonCapabilities(current?.capabilities, entry.capabilities),
      priority: current?.priority || grouped.size + 1
    });
  }
  return [...grouped.values()];
}

router.get('/v1/models', authStudent, studentRateLimit, (req, res) => {
  const group = getUserGroup(req.student.id);
  const models = getPublishedModels(group?.provider_slugs || []);
  if (req.query.client_version) {
    return res.json({
      models: models.map((model) => codexModelMetadata({ ...model, model: model.id }))
    });
  }

  return res.json({
    object: 'list',
    data: models.map((model) => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: 'ieti-agents'
    }))
  });
});

router.get('/v1/model-capabilities', authStudent, studentRateLimit, (req, res) => {
  const group = getUserGroup(req.student.id);
  const models = getPublishedModels(group?.provider_slugs || []);
  return res.json({
    object: 'ieti.model_capabilities.list',
    schema_version: 1,
    data: models.map((model) => ({
      id: model.id,
      context_window: model.contextWindow,
      max_output_tokens: model.outputLimit,
      reasoning_efforts: model.capabilities.reasoningEfforts,
      default_reasoning_effort: model.capabilities.defaultReasoningEffort,
      supports_chat_template_kwargs: model.capabilities.chatTemplateKwargs,
      capabilities: {
        text: model.capabilities.text,
        image: model.capabilities.image,
        tools: model.capabilities.tools,
        reasoning: model.capabilities.reasoning,
        parallel_tools: model.capabilities.parallelTools
      },
      modalities: {
        input: [
          ...(model.capabilities.text ? ['text'] : []),
          ...(model.capabilities.image ? ['image'] : [])
        ],
        output: ['text']
      }
    }))
  });
});

router.post('/v1/chat/completions', authStudent, studentRateLimit, largeJsonBody, handleChatCompletion);

router.post('/v1/responses', authStudent, studentRateLimit, largeJsonBody, async (req, res, next) => {
  const user = req.student;
  const responsesPayload = req.body || {};
  let chatPayload = {};
  let model = responsesPayload.model || '';
  let estimatedInputTokens = 0;
  let wasStreaming = Boolean(responsesPayload.stream);
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
    chatPayload = responsesToChatPayload(responsesPayload);
    model = chatPayload.model;
    estimatedInputTokens = estimateChatTokens(chatPayload);
    wasStreaming = Boolean(chatPayload.stream);

    if (wasStreaming && !config.enableStreaming) {
      throw apiError(400, 'streaming_disabled', 'Streaming is disabled on this server.');
    }
    validateRequestPayload(chatPayload);

    const { group, maxTokens, release: quotaRelease } = checkQuota({
      user,
      model,
      estimatedInputTokens,
      requestedMaxTokens: Number(chatPayload.max_tokens || 0)
    });
    releaseQuota = quotaRelease;
    if (maxTokens) chatPayload.max_tokens = maxTokens;
    timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    providerRequestStarted = true;
    const providerResponse = await callChatCompletions(chatPayload, {
      signal: controller.signal,
      providerSlugs: group.provider_slugs,
      conversation: affinityContextFromRequest(req, responsesPayload),
      onAttemptFailure: (error) => recordFailedAttempt({ userId: user.id, model, wasStreaming }, error),
      requiredCapabilities: {
        reasoning: Boolean(responsesPayload.reasoning),
        parallelTools: Boolean(responsesPayload.parallel_tool_calls && chatPayload.tools?.length)
      }
    });
    const { upstream, provider, release, complete, fail } = providerResponse;
    releaseProvider = release;
    completeProvider = complete;
    failProvider = fail;
    providerSlug = provider.slug;

    if (wasStreaming) {
      clearTimeout(timeout);
      timeout = undefined;
      await streamResponsesCompatibility({
        upstream,
        res,
        userId: user.id,
        model,
        providerSlug,
        estimatedInputTokens,
        responsesPayload,
        controller,
        completeProvider,
        failProvider,
        isClientDisconnected: () => clientDisconnected
      });
      return;
    }

    const chatBody = await upstream.json();
    if (clientDisconnected || res.destroyed) throw new DOMException('Client disconnected.', 'AbortError');
    const responseBody = chatCompletionToResponse(chatBody, responsesPayload, estimatedInputTokens);
    completeProvider(chatBody.choices?.[0]?.message);
    const usage = responseBody.usage;
    recordUsage({
      userId: user.id,
      model,
      providerSlug,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
      wasStreaming: false,
      status: 'success'
    });
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
    const errorMessage = cancelled ? 'Client disconnected.' : timedOut ? 'Provider request timed out.' : error.message;
    recordUsage({
      userId: user?.id,
      model,
      providerSlug,
      inputTokens,
      outputTokens: upstreamUsage?.outputTokens || 0,
      totalTokens: upstreamUsage?.totalTokens ?? inputTokens,
      wasStreaming,
      status: cancelled ? 'cancelled' : timedOut ? 'timeout' : upstreamUsage?.totalTokens > 0 ? 'upstream_error' : 'error',
      errorMessage
    });
    if (cancelled || res.headersSent) {
      if (!res.destroyed && !res.writableEnded) res.end();
      return;
    }
    if (timedOut) {
      next(apiError(504, 'provider_timeout', 'Provider request timed out.'));
    } else {
      next(error);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    req.removeListener('aborted', disconnect);
    res.removeListener('close', disconnect);
    releaseProvider?.();
    releaseQuota?.();
  }
});

function writeResponseEvent(res, state, type, fields = {}) {
  const event = { type, sequence_number: state.sequence++, ...fields };
  res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
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

function startTextOutput(res, state) {
  if (state.message) return state.message;
  const item = {
    id: outputItemId('msg'),
    type: 'message',
    status: 'in_progress',
    role: 'assistant',
    content: []
  };
  const entry = { item, outputIndex: state.nextOutputIndex++, text: '' };
  state.message = entry;
  state.outputs.push(entry);
  writeResponseEvent(res, state, 'response.output_item.added', {
    output_index: entry.outputIndex,
    item
  });
  writeResponseEvent(res, state, 'response.content_part.added', {
    item_id: item.id,
    output_index: entry.outputIndex,
    content_index: 0,
    part: { type: 'output_text', annotations: [], logprobs: [], text: '' }
  });
  return entry;
}

function startReasoningOutput(res, state) {
  if (state.reasoning) return state.reasoning;
  const item = {
    id: outputItemId('rs'),
    type: 'reasoning',
    summary: [],
    content: []
  };
  const entry = { item, outputIndex: state.nextOutputIndex++, text: '' };
  state.reasoning = entry;
  state.outputs.push(entry);
  writeResponseEvent(res, state, 'response.output_item.added', {
    output_index: entry.outputIndex,
    item
  });
  return entry;
}

function startToolOutput(res, state, index, delta = {}) {
  let entry = state.toolCalls.get(index);
  if (entry) return entry;
  const item = {
    id: outputItemId('fc'),
    type: 'function_call',
    status: 'in_progress',
    call_id: delta.id || outputItemId('call'),
    name: '',
    arguments: ''
  };
  entry = { item, outputIndex: state.nextOutputIndex++, arguments: '' };
  state.toolCalls.set(index, entry);
  state.outputs.push(entry);
  writeResponseEvent(res, state, 'response.output_item.added', {
    output_index: entry.outputIndex,
    item
  });
  return entry;
}

function finishResponseOutputs(res, state) {
  if (state.reasoning) {
    const { item, outputIndex, text } = state.reasoning;
    item.content = [{ type: 'reasoning_text', text }];
    writeResponseEvent(res, state, 'response.output_item.done', {
      output_index: outputIndex,
      item
    });
  }

  if (state.message) {
    const { item, outputIndex, text } = state.message;
    const part = { type: 'output_text', annotations: [], logprobs: [], text };
    writeResponseEvent(res, state, 'response.output_text.done', {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      text,
      logprobs: []
    });
    writeResponseEvent(res, state, 'response.content_part.done', {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part
    });
    item.status = 'completed';
    item.content = [part];
    writeResponseEvent(res, state, 'response.output_item.done', {
      output_index: outputIndex,
      item
    });
  }

  for (const { item, outputIndex, arguments: argumentsText } of state.toolCalls.values()) {
    item.status = 'completed';
    item.arguments = argumentsText;
    writeResponseEvent(res, state, 'response.function_call_arguments.done', {
      item_id: item.id,
      output_index: outputIndex,
      arguments: argumentsText
    });
    writeResponseEvent(res, state, 'response.output_item.done', {
      output_index: outputIndex,
      item
    });
  }
}

async function streamResponsesCompatibility({ upstream, res, userId, model, providerSlug, estimatedInputTokens, responsesPayload, controller, completeProvider, failProvider, isClientDisconnected }) {
  if (isClientDisconnected() || res.destroyed) throw new DOMException('Client disconnected.', 'AbortError');
  res.status(upstream.status);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const response = createResponseShell(responsesPayload);
  const state = {
    sequence: 0,
    nextOutputIndex: 0,
    outputs: [],
    reasoning: null,
    message: null,
    toolCalls: new Map(),
    usage: null,
    finishReason: null
  };
  let streamFinished = false;
  writeResponseEvent(res, state, 'response.created', { response });
  writeResponseEvent(res, state, 'response.in_progress', { response });

  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  const inactivityTimer = createStreamInactivityTimer(controller);
  let buffer = '';

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
        const dataLines = rawEvent.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());
        for (const data of dataLines) {
          if (!data) continue;
          if (data === '[DONE]') { streamFinished = true; continue; }
          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          if (chunk.usage) state.usage = chunk.usage;
          if (chunk.error) throw new Error(chunk.error.message || 'The upstream stream failed.');
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) { state.finishReason = choice.finish_reason; streamFinished = true; }
          const delta = choice.delta || {};

          const reasoningDelta = delta.reasoning ?? delta.reasoning_content;
          if (reasoningDelta) {
            const entry = startReasoningOutput(res, state);
            entry.text += reasoningDelta;
            writeResponseEvent(res, state, 'response.reasoning_text.delta', {
              item_id: entry.item.id,
              output_index: entry.outputIndex,
              content_index: 0,
              delta: reasoningDelta
            });
          }

          if (delta.content) {
            const entry = startTextOutput(res, state);
            entry.text += delta.content;
            writeResponseEvent(res, state, 'response.output_text.delta', {
              item_id: entry.item.id,
              output_index: entry.outputIndex,
              content_index: 0,
              delta: delta.content,
              logprobs: []
            });
          }

          for (const toolDelta of delta.tool_calls || []) {
            const index = Number(toolDelta.index || 0);
            const entry = startToolOutput(res, state, index, toolDelta);
            if (toolDelta.id) entry.item.call_id = toolDelta.id;
            if (toolDelta.function?.name) entry.item.name += toolDelta.function.name;
            const argumentsDelta = toolDelta.function?.arguments || '';
            if (argumentsDelta) {
              entry.arguments += argumentsDelta;
              writeResponseEvent(res, state, 'response.function_call_arguments.delta', {
                item_id: entry.item.id,
                output_index: entry.outputIndex,
                delta: argumentsDelta
              });
            }
          }
        }
      }
      if (done) break;
    }

    if (isClientDisconnected() || res.destroyed) throw new DOMException('Client disconnected.', 'AbortError');
    if (!streamFinished) throw new Error('The upstream stream ended before completion.');
    completeProvider({
      role: 'assistant',
      content: state.message?.text || '',
      ...(state.toolCalls.size ? { tool_calls: [...state.toolCalls.values()].map(({ item, arguments: argumentsText }) => ({
        id: item.call_id, type: 'function', function: { name: item.name, arguments: argumentsText }
      })) } : {})
    });
    finishResponseOutputs(res, state);
    response.output = state.outputs.map(({ item }) => item);
    const outputEstimate = estimateTokensFromText(state.reasoning?.text || '') +
      estimateTokensFromText(state.message?.text || '') +
      estimateTokensFromText([...state.toolCalls.values()].map((entry) => entry.arguments).join(''));
    response.usage = chatUsageToResponses(state.usage, estimatedInputTokens, outputEstimate);

    if (state.finishReason === 'length') {
      response.status = 'incomplete';
      response.incomplete_details = { reason: 'max_output_tokens' };
      writeResponseEvent(res, state, 'response.incomplete', { response });
    } else {
      response.status = 'completed';
      writeResponseEvent(res, state, 'response.completed', { response });
    }

    recordUsage({
      userId,
      model,
      providerSlug,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.total_tokens,
      wasStreaming: true,
      status: 'success'
    });
    res.end();
  } catch (error) {
    controller.abort();
    const cancelled = isClientDisconnected() || res.destroyed;
    if (!cancelled) failProvider?.();
    response.status = 'failed';
    response.error = { code: 'stream_error', message: 'Streaming failed.' };
    if (!cancelled) writeResponseEvent(res, state, 'response.failed', { response });
    const outputEstimate = estimateTokensFromText(state.reasoning?.text || '') +
      estimateTokensFromText(state.message?.text || '') +
      estimateTokensFromText([...state.toolCalls.values()].map((entry) => entry.arguments).join(''));
    const consumed = Boolean(state.usage || outputEstimate > 0);
    const usage = chatUsageToResponses(state.usage, cancelled || consumed ? estimatedInputTokens : 0, outputEstimate);
    recordUsage({
      userId,
      model,
      providerSlug,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
      wasStreaming: true,
      status: cancelled ? 'cancelled' : consumed ? 'upstream_error' : 'error',
      errorMessage: cancelled ? 'Client disconnected.' : error.message
    });
    if (!cancelled) res.end();
  } finally {
    inactivityTimer.clear();
    reader.releaseLock();
  }
}

module.exports = router;
