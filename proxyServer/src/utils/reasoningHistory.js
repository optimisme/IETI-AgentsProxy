const HISTORY_FIELDS = ['reasoning_content', 'reasoning', 'think', 'think_fast', 'think_faster'];

function prepareAssistantHistory(messages, field) {
  if (!['reasoning', 'reasoning_content'].includes(field) || !Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (message?.role !== 'assistant' || typeof message[field] === 'string') return message;
    const source = HISTORY_FIELDS.find((name) => typeof message[name] === 'string' && message[name].length > 0)
      || HISTORY_FIELDS.find((name) => typeof message[name] === 'string');
    // Enable this only for a configured/verified upstream. Never invent reasoning.
    return { ...message, [field]: source ? message[source] : '' };
  });
}

function normalizeChatReasoning(body) {
  for (const choice of body?.choices || []) {
    for (const message of [choice.message, choice.delta]) {
      if (message && message.reasoning_content == null && typeof message.reasoning === 'string') {
        message.reasoning_content = message.reasoning;
      }
    }
  }
  return body;
}

// Preserve SSE framing/comments and unknown fields while normalizing JSON data.
function normalizeReasoningEvent(event) {
  const lines = event.split(/\r?\n/);
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return event;
  try {
    const parsed = JSON.parse(data);
    const before = JSON.stringify(parsed);
    const after = JSON.stringify(normalizeChatReasoning(parsed));
    if (before === after) return event;
    let replaced = false;
    return lines.filter((line) => {
      if (!line.startsWith('data:')) return true;
      if (replaced) return false;
      replaced = true;
      return true;
    }).map((line) => line.startsWith('data:') ? `data: ${after}` : line).join(event.includes('\r\n') ? '\r\n' : '\n');
  } catch {
    return event;
  }
}

module.exports = { prepareAssistantHistory, normalizeChatReasoning, normalizeReasoningEvent };
