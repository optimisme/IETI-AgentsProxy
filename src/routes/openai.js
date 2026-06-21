const express = require('express');
const config = require('../config');
const { authStudent } = require('../middleware/authStudent');
const { studentRateLimit } = require('../middleware/rateLimit');
const { callChatCompletions, getEnabledModelEntries } = require('../services/providerService');
const { checkQuota } = require('../services/quotaService');
const { recordUsage } = require('../services/usageService');
const { getUserGroup } = require('../services/accessService');
const { estimateChatTokens, estimateTokensFromText } = require('../utils/tokens');
const { apiError } = require('../utils/errors');

const router = express.Router();

router.get('/v1/models', authStudent, studentRateLimit, (req, res) => {
  const group = getUserGroup(req.student.id);
  const providerSlugs = new Set(group?.provider_slugs || []);
  const hasActiveProvider = providerSlugs.size > 0 && getEnabledModelEntries().some((model) => providerSlugs.has(model.id));
  res.json({
    object: 'list',
    data: hasActiveProvider ? [{
      id: config.publicModelName,
      object: 'model',
      created: 0,
      owned_by: 'ieti-agents'
    }] : []
  });
});

router.post('/v1/chat/completions', authStudent, studentRateLimit, async (req, res, next) => {
  const user = req.student;
  const payload = req.body || {};
  const model = payload.model || config.publicModelName;
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
