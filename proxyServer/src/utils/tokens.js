const IMAGE_TOKEN_ESTIMATE = 1024;

function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function estimateContentTokens(content) {
  if (content === undefined || content === null) return 0;
  if (typeof content === 'string') return estimateTokensFromText(content);

  if (Array.isArray(content)) {
    return content.reduce((tokens, part) => {
      if (!part || typeof part !== 'object') return tokens;
      if (part.type === 'text') return tokens + estimateTokensFromText(part.text || '');
      if (part.type === 'image_url' || part.type === 'input_image') return tokens + IMAGE_TOKEN_ESTIMATE;
      return tokens + estimateTokensFromText(JSON.stringify(part));
    }, 0);
  }

  return estimateTokensFromText(JSON.stringify(content));
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
    tokens += estimateContentTokens(message.content);
    if (message.name) tokens += estimateTokensFromText(message.name);
    if (message.tool_calls) tokens += estimateTokensFromText(JSON.stringify(message.tool_calls));
  }

  if (payload.tools) tokens += estimateTokensFromText(JSON.stringify(payload.tools));
  return tokens + 3;
}

module.exports = { IMAGE_TOKEN_ESTIMATE, estimateContentTokens, estimateTokensFromText, estimateChatTokens, stringifyContent };
