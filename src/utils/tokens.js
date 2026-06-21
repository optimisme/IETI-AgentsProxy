function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function stringifyContent(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

function estimateChatTokens(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  let tokens = 0;

  for (const message of messages) {
    tokens += 4;
    tokens += estimateTokensFromText(message.role || '');
    tokens += estimateTokensFromText(stringifyContent(message.content));
    if (message.name) tokens += estimateTokensFromText(message.name);
    if (message.tool_calls) tokens += estimateTokensFromText(JSON.stringify(message.tool_calls));
  }

  if (payload.tools) tokens += estimateTokensFromText(JSON.stringify(payload.tools));
  return tokens + 3;
}

module.exports = { estimateTokensFromText, estimateChatTokens, stringifyContent };
