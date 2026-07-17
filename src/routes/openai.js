const express = require('express');
const config = require('../config');
const { authStudent } = require('../middleware/authStudent');
const { studentRateLimit } = require('../middleware/rateLimit');
const { callChatCompletions, getEnabledModelEntries, getPublicModelAliasesForProviderSlugs } = require('../services/providerService');
const { checkQuota } = require('../services/quotaService');
const { recordUsage } = require('../services/usageService');
const { getUserGroup } = require('../services/accessService');
const { estimateChatTokens, estimateTokensFromText } = require('../utils/tokens');
const { validateRequestPayload } = require('../utils/payloadValidation');
const { apiError } = require('../utils/errors');
const {
  chatCompletionToResponse,
  chatUsageToResponses,
  codexModelMetadata,
  createResponseShell,
  outputItemId,
  responsesToChatPayload
} = require('../services/responsesService');

const router = express.Router();

router.get('/v1/models', authStudent, studentRateLimit, (req, res) => {
  const group = getUserGroup(req.student.id);
  const providerSlugs = new Set(group?.provider_slugs || []);
  const models = [...new Set(getEnabledModelEntries()
    .filter((model) => providerSlugs.has(model.id))
    .map((model) => model.publicModel)
    .filter(Boolean))];
  if (req.query.client_version) {
    const entries = getEnabledModelEntries().filter((entry) => providerSlugs.has(entry.id));
    const grouped = new Map();
    for (const entry of entries) {
      if (!entry.publicModel) continue;
      const current = grouped.get(entry.publicModel);
      const contextWindow = Number(entry.limit?.context || config.defaultModelContextLimit);
      grouped.set(entry.publicModel, {
        model: entry.publicModel,
        contextWindow: current ? Math.min(current.contextWindow, contextWindow) : contextWindow,
        capabilities: {
          text: Boolean(current?.capabilities?.text || entry.capabilities?.text),
          image: Boolean(current?.capabilities?.image || entry.capabilities?.image),
          tools: Boolean(current?.capabilities?.tools || entry.capabilities?.tools),
          reasoning: Boolean(current?.capabilities?.reasoning || entry.capabilities?.reasoning),
          parallelTools: Boolean(current?.capabilities?.parallelTools || entry.capabilities?.parallelTools)
        },
        priority: current?.priority || grouped.size + 1
      });
    }
    return res.json({
      models: [...grouped.values()].map(codexModelMetadata)
    });
  }

  return res.json({
    object: 'list',
    data: models.map((model) => ({
      id: model,
      object: 'model',
      created: 0,
      owned_by: 'ieti-agents'
    }))
  });
});

router.post('/v1/chat/completions', authStudent, studentRateLimit, async (req, res, next) => {
  const user = req.student;
  const payload = req.body || {};
  let model = payload.model || '';
  const estimatedInputTokens = estimateChatTokens(payload);
  const requestedMaxTokens = Number(payload.max_tokens || 0);
  const wasStreaming = Boolean(payload.stream);

  let timeout;
  let releaseProvider;
  let providerSlug = null;
  const controller = new AbortController();
  try {
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
    if (!model) {
      const group = getUserGroup(user.id);
      model = getPublicModelAliasesForProviderSlugs(group?.provider_slugs || [])[0] || config.publicModelName;
    }

    const { group } = checkQuota({ user, model, estimatedInputTokens, requestedMaxTokens });
    timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    const providerResponse = await callChatCompletions({ ...payload, model }, { signal: controller.signal, providerSlugs: group.provider_slugs });
    const { upstream, provider, release } = providerResponse;
    releaseProvider = release;
    providerSlug = provider.slug;

    if (wasStreaming) {
      await streamResponse({ upstream, res, userId: user.id, model, providerSlug: provider.slug, estimatedInputTokens });
      return;
    }

    const body = await upstream.json();
    const usage = normalizeUsage(body.usage, estimatedInputTokens, body);
    recordUsage({
      userId: user.id,
      model,
      providerSlug: provider.slug,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      wasStreaming: false,
      status: 'success'
    });
    res.json(body);
  } catch (error) {
    const errorMessage = error.name === 'AbortError' ? 'Provider request timed out.' : error.message;
    const status = error.name === 'AbortError' ? 'timeout' : 'error';
    recordUsage({
      userId: user?.id,
      model,
      providerSlug,
      inputTokens: estimatedInputTokens,
      outputTokens: 0,
      totalTokens: estimatedInputTokens,
      wasStreaming,
      status,
      errorMessage
    });
    if (error.name === 'AbortError') {
      next(apiError(504, 'provider_timeout', 'Provider request timed out.'));
    } else {
      next(error);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    releaseProvider?.();
  }
});

router.post('/v1/responses', authStudent, studentRateLimit, async (req, res, next) => {
  const user = req.student;
  const responsesPayload = req.body || {};
  let chatPayload = {};
  let model = responsesPayload.model || '';
  let estimatedInputTokens = 0;
  let wasStreaming = Boolean(responsesPayload.stream);
  let timeout;
  let releaseProvider;
  let providerSlug = null;
  const controller = new AbortController();

  try {
    chatPayload = responsesToChatPayload(responsesPayload);
    model = chatPayload.model;
    estimatedInputTokens = estimateChatTokens(chatPayload);
    wasStreaming = Boolean(chatPayload.stream);

    if (wasStreaming && !config.enableStreaming) {
      throw apiError(400, 'streaming_disabled', 'Streaming is disabled on this server.');
    }
    validateRequestPayload(chatPayload);

    const { group } = checkQuota({
      user,
      model,
      estimatedInputTokens,
      requestedMaxTokens: Number(chatPayload.max_tokens || 0)
    });
    timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    const providerResponse = await callChatCompletions(chatPayload, {
      signal: controller.signal,
      providerSlugs: group.provider_slugs,
      requiredCapabilities: {
        reasoning: Boolean(responsesPayload.reasoning),
        parallelTools: Boolean(responsesPayload.parallel_tool_calls && chatPayload.tools?.length)
      }
    });
    const { upstream, provider, release } = providerResponse;
    releaseProvider = release;
    providerSlug = provider.slug;

    if (wasStreaming) {
      await streamResponsesCompatibility({
        upstream,
        res,
        userId: user.id,
        model,
        providerSlug,
        estimatedInputTokens,
        responsesPayload
      });
      return;
    }

    const chatBody = await upstream.json();
    const responseBody = chatCompletionToResponse(chatBody, responsesPayload, estimatedInputTokens);
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
    const errorMessage = error.name === 'AbortError' ? 'Provider request timed out.' : error.message;
    recordUsage({
      userId: user?.id,
      model,
      providerSlug,
      inputTokens: estimatedInputTokens,
      outputTokens: 0,
      totalTokens: estimatedInputTokens,
      wasStreaming,
      status: error.name === 'AbortError' ? 'timeout' : 'error',
      errorMessage
    });
    if (error.name === 'AbortError') {
      next(apiError(504, 'provider_timeout', 'Provider request timed out.'));
    } else {
      next(error);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    releaseProvider?.();
  }
});

function writeResponseEvent(res, state, type, fields = {}) {
  const event = { type, sequence_number: state.sequence++, ...fields };
  res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
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

async function streamResponsesCompatibility({ upstream, res, userId, model, providerSlug, estimatedInputTokens, responsesPayload }) {
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
    message: null,
    toolCalls: new Map(),
    usage: null,
    finishReason: null
  };
  writeResponseEvent(res, state, 'response.created', { response });
  writeResponseEvent(res, state, 'response.in_progress', { response });

  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const rawEvent of events) {
        const dataLines = rawEvent.split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());
        for (const data of dataLines) {
          if (!data || data === '[DONE]') continue;
          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          if (chunk.usage) state.usage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) state.finishReason = choice.finish_reason;
          const delta = choice.delta || {};

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
    }

    finishResponseOutputs(res, state);
    response.output = state.outputs.map(({ item }) => item);
    const outputEstimate = estimateTokensFromText(state.message?.text || '') +
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
    response.status = 'failed';
    response.error = { code: 'stream_error', message: 'Streaming failed.' };
    writeResponseEvent(res, state, 'response.failed', { response });
    recordUsage({
      userId,
      model,
      providerSlug,
      inputTokens: estimatedInputTokens,
      outputTokens: estimateTokensFromText(state.message?.text || ''),
      wasStreaming: true,
      status: 'error',
      errorMessage: error.message
    });
    res.end();
  }
}

async function streamResponse({ upstream, res, userId, model, providerSlug, estimatedInputTokens }) {
  res.status(upstream.status);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let buffer = '';
  let outputText = '';
  let usageFromStream = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk);
      buffer += chunk;

      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const event of events) {
        const dataLines = event.split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());
        for (const data of dataLines) {
          if (!data || data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) outputText += delta;
            if (parsed.usage) usageFromStream = parsed.usage;
          } catch {
            // Ignore malformed upstream SSE fragments while preserving the stream.
          }
        }
      }
    }

    const outputEstimate = estimateTokensFromText(outputText);
    const usage = normalizeUsage(usageFromStream, estimatedInputTokens, null, outputEstimate);
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
    recordUsage({
      userId,
      model,
      providerSlug,
      inputTokens: estimatedInputTokens,
      outputTokens: estimateTokensFromText(outputText),
      wasStreaming: true,
      status: 'error',
      errorMessage: error.message
    });
    res.write(`event: error\ndata: ${JSON.stringify({ error: { message: 'Streaming failed.', code: 'stream_error' } })}\n\n`);
    res.end();
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

module.exports = router;
