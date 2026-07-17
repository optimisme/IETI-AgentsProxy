const crypto = require('node:crypto');
const { apiError } = require('../utils/errors');

const CODEX_BASE_INSTRUCTIONS = `You are a coding agent working in the user's workspace. Be precise, safe, and helpful. Follow the user's instructions and every applicable AGENTS.md file. Use the available tools to inspect and modify the workspace, keep the user informed with concise progress updates before tool calls, and continue until the requested outcome is genuinely complete. Respect the configured sandbox and approval policy. Do not claim that commands, tests, deployments, or external actions succeeded unless you verified them. Prefer focused changes that preserve existing behavior, use apply_patch for file edits, and run relevant tests before reporting completion.`;

function responseId() {
  return `resp_${crypto.randomUUID().replaceAll('-', '')}`;
}

function outputItemId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function normalizeText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
}

function responsesContentToChat(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return normalizeText(content);

  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      parts.push({ type: 'text', text: normalizeText(part.text) });
      continue;
    }
    if (part.type === 'input_image' || part.type === 'image_url') {
      const url = part.image_url?.url || part.image_url || part.url;
      if (!url) continue;
      const imageUrl = { url };
      if (part.detail) imageUrl.detail = part.detail;
      parts.push({ type: 'image_url', image_url: imageUrl });
      continue;
    }
    parts.push({ type: 'text', text: normalizeText(part) });
  }

  if (!parts.length) return '';
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text).join('');
  }
  return parts;
}

function responseToolToChat(tool) {
  if (!tool || typeof tool !== 'object' || !tool.name) return null;
  if (tool.type !== 'function' && tool.type !== 'custom') return null;

  let parameters = tool.parameters;
  if (!parameters || typeof parameters !== 'object') {
    parameters = {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Tool input.' }
      },
      required: ['input'],
      additionalProperties: false
    };
  }

  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters,
      ...(tool.strict !== undefined ? { strict: tool.strict } : {})
    }
  };
}

function responseToolChoiceToChat(toolChoice) {
  if (toolChoice === undefined) return undefined;
  if (typeof toolChoice === 'string') return toolChoice;
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  if ((toolChoice.type === 'function' || toolChoice.type === 'custom') && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return undefined;
}

function appendInputItem(messages, item) {
  if (typeof item === 'string') {
    messages.push({ role: 'user', content: item });
    return;
  }
  if (!item || typeof item !== 'object') return;

  if (item.type === 'message' || (!item.type && item.role)) {
    const role = item.role === 'developer' ? 'system' : item.role;
    if (!['system', 'user', 'assistant'].includes(role)) return;
    messages.push({ role, content: responsesContentToChat(item.content) });
    return;
  }

  if (item.type === 'function_call' || item.type === 'custom_tool_call') {
    const callId = item.call_id || item.id || outputItemId('call');
    let argumentsText = item.arguments;
    if (item.type === 'custom_tool_call' && argumentsText === undefined) {
      argumentsText = JSON.stringify({ input: normalizeText(item.input) });
    }
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: callId,
        type: 'function',
        function: {
          name: item.name,
          arguments: normalizeText(argumentsText || '{}')
        }
      }]
    });
    return;
  }

  if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
    messages.push({
      role: 'tool',
      tool_call_id: item.call_id,
      content: normalizeText(item.output)
    });
  }
}

function responsesToChatPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw apiError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  if (!payload.model) {
    throw apiError(503, 'no_models_available', 'No enabled provider models are available.');
  }

  const messages = [];
  if (payload.instructions) {
    messages.push({ role: 'system', content: normalizeText(payload.instructions) });
  }
  if (typeof payload.input === 'string') {
    messages.push({ role: 'user', content: payload.input });
  } else if (Array.isArray(payload.input)) {
    for (const item of payload.input) appendInputItem(messages, item);
  } else {
    throw apiError(400, 'invalid_request', 'input must be a string or an array.');
  }

  const systemMessages = messages.filter((message) => message.role === 'system');
  const nonSystemMessages = messages.filter((message) => message.role !== 'system');
  const normalizedMessages = systemMessages.length
    ? [{
        role: 'system',
        content: systemMessages.map((message) => normalizeText(message.content)).filter(Boolean).join('\n\n')
      }, ...nonSystemMessages]
    : nonSystemMessages;

  const tools = Array.isArray(payload.tools)
    ? payload.tools.map(responseToolToChat).filter(Boolean)
    : undefined;
  const toolChoice = responseToolChoiceToChat(payload.tool_choice);
  const textFormat = payload.text?.format;

  return {
    model: payload.model,
    messages: normalizedMessages,
    stream: Boolean(payload.stream),
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.max_output_tokens !== undefined ? { max_tokens: payload.max_output_tokens } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(payload.parallel_tool_calls !== undefined ? { parallel_tool_calls: payload.parallel_tool_calls } : {}),
    ...(payload.stream ? { stream_options: { include_usage: true } } : {}),
    ...(textFormat?.type === 'json_schema' ? {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: textFormat.name || 'response',
          schema: textFormat.schema || {},
          ...(textFormat.strict !== undefined ? { strict: textFormat.strict } : {})
        }
      }
    } : {}),
    ...(textFormat?.type === 'json_object' ? { response_format: { type: 'json_object' } } : {})
  };
}

function createResponseShell(payload, id = responseId()) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    error: null,
    incomplete_details: null,
    instructions: payload.instructions ?? null,
    max_output_tokens: payload.max_output_tokens ?? null,
    model: payload.model,
    output: [],
    parallel_tool_calls: payload.parallel_tool_calls ?? true,
    previous_response_id: payload.previous_response_id ?? null,
    reasoning: payload.reasoning ?? null,
    store: payload.store ?? false,
    temperature: payload.temperature ?? null,
    text: payload.text ?? { format: { type: 'text' } },
    tool_choice: payload.tool_choice ?? 'auto',
    tools: payload.tools ?? [],
    top_p: payload.top_p ?? null,
    truncation: payload.truncation ?? 'disabled',
    usage: null,
    user: payload.user ?? null,
    metadata: payload.metadata ?? {}
  };
}

function chatUsageToResponses(usage, estimatedInputTokens = 0, estimatedOutputTokens = 0) {
  const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? estimatedInputTokens) || 0;
  const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? estimatedOutputTokens) || 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: Number(usage?.prompt_tokens_details?.cached_tokens ?? 0) || 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: Number(usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0 },
    total_tokens: Number(usage?.total_tokens) || inputTokens + outputTokens
  };
}

function chatMessageToOutput(message = {}) {
  const output = [];
  if (message.content !== undefined && message.content !== null && normalizeText(message.content) !== '') {
    output.push({
      id: outputItemId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        annotations: [],
        logprobs: [],
        text: normalizeText(message.content)
      }]
    });
  }
  for (const toolCall of message.tool_calls || []) {
    output.push({
      id: outputItemId('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: toolCall.id || outputItemId('call'),
      name: toolCall.function?.name || '',
      arguments: normalizeText(toolCall.function?.arguments || '{}')
    });
  }
  return output;
}

function chatCompletionToResponse(body, payload, estimatedInputTokens = 0) {
  const response = createResponseShell(payload, body.id?.startsWith('resp_') ? body.id : responseId());
  response.status = 'completed';
  response.output = chatMessageToOutput(body.choices?.[0]?.message || {});
  response.usage = chatUsageToResponses(body.usage, estimatedInputTokens);
  return response;
}

function codexModelMetadata({ model, contextWindow, capabilities = {}, priority = 1 }) {
  const safeContextWindow = Math.max(1024, Number(contextWindow) || 65536);
  const supportsText = capabilities.text !== false;
  const supportsImage = capabilities.image !== false;
  const supportsTools = capabilities.tools !== false;
  const supportsReasoning = capabilities.reasoning !== false;
  const supportsParallelTools = supportsTools && capabilities.parallelTools !== false;
  return {
    slug: model,
    display_name: model,
    description: 'Virtual IETI model routed to the provider pool assigned to the student group.',
    default_reasoning_level: supportsReasoning ? 'medium' : null,
    supported_reasoning_levels: supportsReasoning
      ? [{ effort: 'medium', description: 'Provider-managed reasoning level.' }]
      : [],
    shell_type: supportsTools ? 'default' : 'disabled',
    visibility: 'list',
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: CODEX_BASE_INSTRUCTIONS,
    model_messages: null,
    include_skills_usage_instructions: true,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'bytes', limit: 40000 },
    supports_parallel_tool_calls: supportsParallelTools,
    supports_image_detail_original: false,
    context_window: safeContextWindow,
    max_context_window: safeContextWindow,
    auto_compact_token_limit: Math.floor(safeContextWindow * 0.9),
    effective_context_window_percent: 90,
    experimental_supported_tools: [],
    input_modalities: [
      ...(supportsText ? ['text'] : []),
      ...(supportsImage ? ['image'] : [])
    ],
    supports_search_tool: false,
    use_responses_lite: false,
    auto_review_model_override: null,
    tool_mode: null,
    multi_agent_version: null
  };
}

module.exports = {
  chatCompletionToResponse,
  chatMessageToOutput,
  chatUsageToResponses,
  codexModelMetadata,
  createResponseShell,
  outputItemId,
  responseId,
  responsesContentToChat,
  responsesToChatPayload
};
