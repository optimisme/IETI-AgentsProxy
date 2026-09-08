const { deflateSync } = require('node:zlib');
const { prepareAssistantHistory } = require('../utils/reasoningHistory');

// A small synthetic red/blue image. No student content is sent during discovery.
function probeImage() {
  function chunk(type, data) {
    const content = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, content, checksum]);
  }
  const width = 128, height = 128;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels[y * (width * 3 + 1) + 1 + x * 3 + (x < width / 2 ? 0 : 2)] = 255;
  }
  return 'data:image/png;base64,' + Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))
  ]).toString('base64');
}

function missingThinking(result) {
  return [400, 422].includes(result.httpStatus) && /assistant message is missing a thinking field/i.test(result.message);
}

function explicitlyUnsupported(result, feature) {
  if (![400, 422].includes(result.httpStatus)) return false;
  const text = result.message.toLowerCase();
  const names = feature === 'image' ? /image|vision|multi.?modal/ : /tool|function.call/;
  return names.test(text) && /not support|unsupported|does not have|not a multimodal|only support.*text|requires.*(?:parser|enable.auto)|must.*(?:parser|enable.auto)|cannot.*(?:image|tool)/.test(text);
}

async function probeProviderModel({ baseUrl, apiKey = '', model, timeoutMs = 60000, budgetMs = 180000, fetchImpl = fetch, signal, onProgress }) {
  const clean = baseUrl.replace(/\/+$/, '');
  const url = `${clean}${clean.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
  const deadline = Date.now() + budgetMs;
  const settings = {}, results = [];
  let testControls = {};
  const redact = (text) => {
    let value = String(text || '').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
    if (apiKey) value = value.split(apiKey).join('[redacted]');
    return value.slice(0, 1500);
  };
  async function call(name, messages, extra = {}) {
    signal?.throwIfAborted();
    onProgress?.({ activeTest: name, results: results.map((item) => ({ ...item })) });
    const start = Date.now();
    const result = { name, status: 'inconclusive', httpStatus: null, message: '', durationMs: 0 };
    results.push(result);
    if (deadline <= start) {
      result.message = 'Test budget exhausted; existing configuration is unchanged.';
      return result;
    }
    try {
      const response = await fetchImpl(url, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline - start))), ...(signal ? [signal] : [])]),
        body: JSON.stringify({ model, messages, max_tokens: 256, temperature: 0, stream: false, ...testControls, ...extra })
      });
      result.httpStatus = response.status;
      let body;
      try {
        if (extra.stream && response.ok) {
          const raw = await response.text();
          if (response.headers.get('content-type')?.includes('text/event-stream')) {
            let content = '', reasoning = '', finishReason = null, done = false;
            for (const event of raw.split(/\r?\n\r?\n/)) {
              const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
              if (!data) continue;
              if (data === '[DONE]') { done = true; continue; }
              const chunk = JSON.parse(data);
              if (chunk.error) { body = chunk; break; }
              const choice = chunk.choices?.[0];
              content += choice?.delta?.content || '';
              reasoning += choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? '';
              finishReason = choice?.finish_reason || finishReason;
            }
            if (!body && done && finishReason) body = { choices: [{
              message: { role: 'assistant', content, reasoning_content: reasoning }, finish_reason: finishReason
            }] };
          }
        } else body = await response.json();
      } catch (error) {
        if (/timeout|abort/i.test(error.name)) throw error;
        // Invalid JSON/SSE is inconclusive.
      }
      if (!response.ok || body?.error) {
        const error = body?.error?.message || body?.message || body?.detail;
        result.hint = response.status === 401 || response.status === 403 ? 'Check the provider API key and its permissions.'
          : response.status === 429 ? 'Check the provider quota or concurrency limit and try again later.'
          : response.status === 404 ? 'Check the Base URL, chat endpoint and selected model.'
          : response.status >= 500 ? 'Check whether the inference server is ready, and inspect its logs.'
          : 'Review the rejected parameter or message format before changing capability settings.';
        result.message = redact(typeof error === 'string' ? error : error ? JSON.stringify(error) : response.statusText || 'Invalid upstream response.');
      } else if (body?.choices?.[0]?.message?.role === 'assistant') {
        // Keep response content private to the test; diagnostics only include outcomes.
        Object.defineProperty(result, 'assistant', { value: body.choices[0].message });
        Object.defineProperty(result, 'finished', { value: ['stop', 'tool_calls', 'function_call'].includes(body.choices[0].finish_reason) });
        result.message = result.finished ? 'The server returned an assistant message.'
          : body.choices[0].finish_reason === 'length' ? 'The test reached its output token limit; behavior may be inconclusive.'
          : 'The server did not report a completed response; behavior is inconclusive.';
        const reasoning = result.assistant.reasoning_content ?? result.assistant.reasoning;
        if (typeof reasoning === 'string' && reasoning.trim()) settings.supports_reasoning = 1;
      } else {
        result.message = extra.stream ? 'The streaming request did not return valid, completed SSE. OpenCode uses streaming; check the upstream protocol and logs.' : 'The response did not contain a valid assistant message.';
      }
    } catch (error) {
      result.message = /timeout|abort/i.test(error.name) ? 'The test timed out; this does not prove the capability is unsupported.' : redact(error.message);
    }
    result.durationMs = Date.now() - start;
    return result;
  }
  const success = (result) => result.assistant && result.finished && typeof result.assistant.content === 'string' && result.assistant.content.trim();
  function supported(result, message) { result.status = 'supported'; result.message = message; }
  const greeting = [{ role: 'user', content: 'Reply with exactly OK.' }];
  let text = await call('Text completion', greeting);
  if (text.assistant && !text.finished && settings.supports_reasoning) {
    const shorter = await call('Text completion with low reasoning effort', greeting, { reasoning_effort: 'low' });
    if (success(shorter)) {
      text = shorter;
      testControls = { reasoning_effort: 'low' };
      results.push({ name: 'Test parameters', status: 'inconclusive', httpStatus: null,
        message: 'Remaining tests use reasoning_effort=low to fit the test budget. Acceptance alone does not establish the full set of supported reasoning controls.' });
    }
  }
  if (success(text)) {
    settings.supports_text_input = 1;
    supported(text, 'A text completion succeeded.');
  }
  if (!text.assistant) {
    results.push({ name: 'Remaining tests', status: 'inconclusive', httpStatus: null,
      message: 'Skipped because the basic request failed. Check the Base URL, credentials, model availability and the error above.' });
    signal?.throwIfAborted();
    onProgress?.({ activeTest: null, results: results.map((item) => ({ ...item })) });
    return { settings, results };
  }

  const history = [...greeting, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'Reply with exactly OK again.' }];
  const historyResult = await call('Assistant history without reasoning', history);
  if (success(historyResult)) {
    supported(historyResult, 'Ordinary assistant history is accepted; no missing-field workaround is required.');
    settings.reasoning_history_field = null;
  } else if (missingThinking(historyResult)) {
    historyResult.status = 'unsupported';
    const repaired = await call('Assistant history with reasoning_content', prepareAssistantHistory(history, 'reasoning_content'));
    if (success(repaired)) {
      supported(repaired, 'Verified: reasoning_content is accepted, including an empty value for history that has no reasoning. Existing reasoning must still be preserved.');
      settings.reasoning_history_field = 'reasoning_content';
    }
  }

  const tools = [{ type: 'function', function: { name: 'lookup_probe', description: 'Look up a synthetic test code.',
    parameters: { type: 'object', properties: { code: { type: 'string', enum: ['A', 'B'] } }, required: ['code'], additionalProperties: false } } }];
  const toolMessages = [{ role: 'user', content: 'Call lookup_probe twice, once with code A and once with code B. Do not guess the results. After receiving the results, reply with their values.' }];
  let toolResult = await call('Tool calling', toolMessages, { tools, tool_choice: 'auto', parallel_tool_calls: true });
  if ([400, 422].includes(toolResult.httpStatus) && /parallel_tool_calls/i.test(toolResult.message) && /not support|unsupported|not allowed|extra inputs/i.test(toolResult.message)) {
    settings.supports_parallel_tools = 0;
    toolResult.status = 'unsupported';
    toolResult = await call('Tool calling without parallel_tool_calls', toolMessages, { tools, tool_choice: 'auto' });
  }
  const calls = toolResult.assistant?.tool_calls;
  const validCalls = Array.isArray(calls) && calls.length > 0 && calls.length <= 2 && new Set(calls.map((item) => item.id)).size === calls.length && calls.every((item) => {
    try { return item.type === 'function' && typeof item.id === 'string' && item.id && item.function?.name === 'lookup_probe' && ['A', 'B'].includes(JSON.parse(item.function.arguments).code); }
    catch { return false; }
  });
  if (validCalls) {
    supported(toolResult, `The server produced ${calls.length} valid tool call(s). Testing the return of tool results next.`);
    let messages = [...toolMessages, toolResult.assistant, ...calls.map((item) => ({
      role: 'tool', tool_call_id: item.id, content: JSON.parse(item.function.arguments).code === 'A' ? 'violet' : 'amber'
    }))];
    messages = prepareAssistantHistory(messages, settings.reasoning_history_field);
    const roundTrip = await call('Tool result round trip', messages, { tools });
    const expected = calls.map((item) => JSON.parse(item.function.arguments).code === 'A' ? 'violet' : 'amber');
    if (success(roundTrip) && expected.every((value) => roundTrip.assistant.content.toLowerCase().includes(value))) {
      settings.supports_tools = 1;
      supported(roundTrip, 'The server accepted assistant/tool history and used the synthetic tool results. No real tools were executed.');
      if (settings.supports_parallel_tools !== 0 && new Set(calls.map((item) => JSON.parse(item.function.arguments).code)).size === 2) settings.supports_parallel_tools = 1;
    } else {
      toolResult.status = 'inconclusive';
      toolResult.message = 'Tool calls were produced, but the complete tool round trip was not verified. Review the next result.';
    }
  } else if (explicitlyUnsupported(toolResult, 'tools')) {
    settings.supports_tools = 0; settings.supports_parallel_tools = 0;
    toolResult.status = 'unsupported';
  } else if (toolResult.assistant) toolResult.message = 'No valid tool call was produced. Acceptance of the tools parameter alone does not verify tool support.';

  const image = await call('Image input', [{ role: 'user', content: [
    { type: 'text', text: 'Name the color of the left half and then the right half of this image. Reply with only the two color names, in that order.' },
    { type: 'image_url', image_url: { url: probeImage() } }
  ] }]);
  if (success(image) && /^\W*red\W+(?:and\W+)?blue\W*$/i.test(image.assistant.content.trim())) {
    settings.supports_image_input = 1;
    supported(image, 'The model correctly identified the two colors in the synthetic image.');
  } else if (explicitlyUnsupported(image, 'image')) {
    settings.supports_image_input = 0; image.status = 'unsupported';
  } else if (image.assistant) image.message = 'The model did not correctly describe the test image. Image support is inconclusive.';
  const streaming = await call('Streaming assistant history', prepareAssistantHistory(history, settings.reasoning_history_field), { stream: true, max_tokens: 128 });
  if (success(streaming)) supported(streaming, 'The server returned valid SSE and completed a streamed assistant-history request, as used by OpenCode.');
  else streaming.hint = 'OpenCode uses streaming. Review this result before relying on the model, even if non-streaming tests passed.';
  results.push({ name: 'Reasoning output', status: settings.supports_reasoning ? 'supported' : 'inconclusive', httpStatus: null,
    message: settings.supports_reasoning ? 'Nonempty reasoning was returned in reasoning or reasoning_content.' : 'No reasoning output was observed. This does not prove reasoning is unsupported.' });
  results.push({ name: 'Limits and reasoning controls', status: 'inconclusive', httpStatus: null,
    message: 'Tests do not infer maximum context/output limits or selectable reasoning efforts. Use published values or verify these settings manually. One successful sample does not guarantee every future request.' });
  signal?.throwIfAborted();
  onProgress?.({ activeTest: null, results: results.map((item) => ({ ...item })) });
  return { settings, results };
}

module.exports = { probeProviderModel };
