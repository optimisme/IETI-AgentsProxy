const crypto = require('node:crypto');
const config = require('../config');
const { getSetting } = require('./settingsService');
const { apiError } = require('../utils/errors');

// Thinking signatures are opaque to Anthropic clients. Ours carry the reasoning itself, so a
// thinking block sent back later restores the exact reasoning_content even after a reload.
const SIGNATURE_PREFIX = 'ieti1.';
const TOOL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
// Claude Code prepends a per-request attribution line to the system prompt; it carries no
// instructions and would defeat upstream prefix caching.
const BILLING_HEADER_PATTERN = /^x-anthropic-billing-header:/i;

function messageId() {
  return `msg_${crypto.randomUUID().replaceAll('-', '')}`;
}

function toolUseId(value) {
  const id = typeof value === 'string' ? value : '';
  return id && TOOL_ID_PATTERN.test(id) ? id : `toolu_${crypto.randomUUID().replaceAll('-', '')}`;
}

function encodeThinkingSignature(text) {
  return SIGNATURE_PREFIX + Buffer.from(String(text || ''), 'utf8').toString('base64');
}

function decodeThinkingSignature(signature) {
  if (typeof signature !== 'string' || !signature.startsWith(SIGNATURE_PREFIX)) return null;
  try {
    return Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function normalizeText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
}

function parseToolArguments(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter((block) => block && typeof block === 'object') : [];
}

function imageBlockToPart(block) {
  const source = block.source || {};
  if (source.type === 'base64') {
    return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  }
  // Remote URLs are forwarded so request validation rejects them with its usual message.
  if (source.type === 'url' && source.url) return { type: 'image_url', image_url: { url: source.url } };
  return null;
}

function systemToText(system) {
  if (system === undefined || system === null) return '';
  if (typeof system === 'string') return system;
  return blocksOf(system)
    .filter((block) => block.type === 'text' && !BILLING_HEADER_PATTERN.test(String(block.text || '').trim()))
    .map((block) => normalizeText(block.text))
    .filter(Boolean)
    .join('\n\n');
}

function toolResultToMessages(block) {
  const textParts = [];
  const images = [];
  if (typeof block.content === 'string') {
    textParts.push(block.content);
  } else {
    for (const part of blocksOf(block.content)) {
      if (part.type === 'text') textParts.push(normalizeText(part.text));
      else if (part.type === 'image') {
        const image = imageBlockToPart(part);
        if (image) images.push(image);
      }
    }
  }
  let text = textParts.join('\n');
  if (block.is_error) text = `Error: ${text}`;
  if (!text && images.length) text = 'The tool returned the attached image(s).';
  const messages = [{ role: 'tool', tool_call_id: block.tool_use_id, content: text }];
  // Most chat-completions providers only accept text in tool messages, so tool images
  // follow as a user message.
  if (images.length) {
    messages.push({ role: 'user', content: [{ type: 'text', text: 'Image output from the previous tool call:' }, ...images] });
  }
  return messages;
}

function userMessageToChat(content) {
  const toolMessages = [];
  const parts = [];
  for (const block of blocksOf(content)) {
    if (block.type === 'text') parts.push({ type: 'text', text: normalizeText(block.text) });
    else if (block.type === 'image') {
      const image = imageBlockToPart(block);
      if (image) parts.push(image);
    } else if (block.type === 'tool_result') toolMessages.push(...toolResultToMessages(block));
  }
  const messages = [...toolMessages];
  if (parts.length) {
    messages.push({
      role: 'user',
      content: parts.every((part) => part.type === 'text') ? parts.map((part) => part.text).join('') : parts
    });
  }
  return messages;
}

function assistantMessageToChat(content) {
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const block of blocksOf(content)) {
    if (block.type === 'text') text += normalizeText(block.text);
    else if (block.type === 'thinking') {
      reasoning += decodeThinkingSignature(block.signature) ?? normalizeText(block.thinking);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
      });
    }
  }
  if (!text && !toolCalls.length) return [];
  return [{
    role: 'assistant',
    content: toolCalls.length && !text ? null : text,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    // DeepSeek-style thinking mode needs the reasoning of an unfinished tool loop back;
    // reasoning from ordinary turns is not part of the history.
    ...(toolCalls.length && reasoning ? { reasoning_content: reasoning } : {})
  }];
}

function toolToChat(tool) {
  // Anthropic server tools (web search, code execution, ...) have no schema and no
  // counterpart upstream.
  if (!tool || typeof tool !== 'object' || !tool.name || !tool.input_schema) return null;
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema
    }
  };
}

function toolChoiceToChat(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'tool' && toolChoice.name) return { type: 'function', function: { name: toolChoice.name } };
  return undefined;
}

function maxTokensPerRequest() {
  const parsed = Number(getSetting('max_tokens_per_request', config.maxTokensPerRequest));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : config.maxTokensPerRequest;
}

function anthropicToChatPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw apiError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  if (!payload.model || typeof payload.model !== 'string') {
    throw apiError(400, 'invalid_request', 'model is required.');
  }
  if (!Array.isArray(payload.messages)) {
    throw apiError(400, 'invalid_request', 'messages must be an array.');
  }

  const messages = [];
  const system = systemToText(payload.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const message of payload.messages) {
    if (message?.role === 'user') messages.push(...userMessageToChat(message.content));
    else if (message?.role === 'assistant') messages.push(...assistantMessageToChat(message.content));
  }

  const tools = Array.isArray(payload.tools) ? payload.tools.map(toolToChat).filter(Boolean) : [];
  const toolChoice = tools.length ? toolChoiceToChat(payload.tool_choice) : undefined;
  // Claude Code asks for far more output than course quotas allow; clamp instead of failing.
  const requestedMaxTokens = Number(payload.max_tokens);
  const maxTokens = Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
    ? Math.min(Math.floor(requestedMaxTokens), maxTokensPerRequest())
    : undefined;
  const stop = Array.isArray(payload.stop_sequences) ? payload.stop_sequences.filter((value) => typeof value === 'string') : [];

  return {
    model: payload.model,
    messages,
    stream: Boolean(payload.stream),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(stop.length ? { stop } : {}),
    ...(tools.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(tools.length && payload.tool_choice?.disable_parallel_tool_use ? { parallel_tool_calls: false } : {}),
    ...(payload.stream ? { stream_options: { include_usage: true } } : {})
  };
}

function stopReason(finishReason, hasToolCalls) {
  if (hasToolCalls || finishReason === 'tool_calls' || finishReason === 'function_call') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  return 'end_turn';
}

function chatUsageToAnthropic(usage, estimatedInputTokens = 0, estimatedOutputTokens = 0) {
  const promptTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? estimatedInputTokens) || 0;
  const cached = Math.min(promptTokens, Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0) || 0);
  return {
    input_tokens: promptTokens - cached,
    output_tokens: Number(usage?.completion_tokens ?? usage?.output_tokens ?? estimatedOutputTokens) || 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached
  };
}

function usageTotals(usage) {
  const inputTokens = usage.input_tokens + usage.cache_read_input_tokens;
  return { inputTokens, outputTokens: usage.output_tokens, totalTokens: inputTokens + usage.output_tokens };
}

function chatCompletionToAnthropic(body, model, estimatedInputTokens = 0) {
  const choice = body?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  const reasoning = normalizeText(message.reasoning_content ?? message.reasoning ?? '');
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: encodeThinkingSignature(reasoning) });
  const text = normalizeText(message.content ?? '');
  if (text) content.push({ type: 'text', text });
  for (const toolCall of message.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: toolUseId(toolCall.id),
      name: toolCall.function?.name || '',
      input: parseToolArguments(toolCall.function?.arguments)
    });
  }
  return {
    id: messageId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason(choice.finish_reason, Boolean(message.tool_calls?.length)),
    stop_sequence: null,
    usage: chatUsageToAnthropic(body?.usage, estimatedInputTokens)
  };
}

// The assistant message as the client will send it back, for conversation affinity.
function anthropicContentToChatMessage(content) {
  const toolUses = content.filter((block) => block.type === 'tool_use');
  const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  return {
    role: 'assistant',
    content: toolUses.length && !text ? null : text,
    ...(toolUses.length ? {
      tool_calls: toolUses.map((block) => ({
        id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
      }))
    } : {})
  };
}

const ERROR_TYPES = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'billing_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  503: 'overloaded_error',
  529: 'overloaded_error'
};

function anthropicErrorType(status) {
  return ERROR_TYPES[status] || (status >= 500 ? 'api_error' : 'invalid_request_error');
}

function anthropicErrorBody(status, message) {
  return { type: 'error', error: { type: anthropicErrorType(status), message } };
}

module.exports = {
  anthropicContentToChatMessage,
  anthropicErrorBody,
  anthropicErrorType,
  anthropicToChatPayload,
  chatCompletionToAnthropic,
  chatUsageToAnthropic,
  decodeThinkingSignature,
  encodeThinkingSignature,
  messageId,
  parseToolArguments,
  stopReason,
  toolUseId,
  usageTotals
};
