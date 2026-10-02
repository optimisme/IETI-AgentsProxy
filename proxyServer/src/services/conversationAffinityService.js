const crypto = require('node:crypto');
const { apiError } = require('../utils/errors');

const AFFINITY_TTL_MS = 30 * 60 * 1000;
const MAX_AFFINITY_ENTRIES = 10000;

function opaqueConversationId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.length || value.length > 256 || /\s|[\x00-\x1f\x7f]/.test(value)) {
    throw apiError(400, 'invalid_conversation_id', 'conversation_id must be an opaque string of 1–256 characters without whitespace.');
  }
  return value;
}

function affinityContextFromRequest(req, payload = req.body || {}) {
  return {
    userId: req.student?.id,
    conversationId: opaqueConversationId(payload.conversation_id ?? payload.metadata?.conversation_id ??
      (typeof payload.conversation === 'string' ? payload.conversation : payload.conversation?.id) ??
      req.get?.('x-conversation-id'))
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalMessage(message) {
  let content = message.content ?? '';
  if (Array.isArray(content) && content.every((part) => ['text', 'input_text', 'output_text'].includes(part?.type))) {
    content = content.map((part) => part.text || '').join('');
  }
  return {
    role: message.role === 'developer' ? 'system' : message.role,
    content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {})
  };
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Only hashes, provider identifiers and timestamps survive a request. Completed
// assistant boundaries distinguish continuations from shared initial templates.
function createAffinityStore({ now = Date.now, ttlMs = AFFINITY_TTL_MS, maxEntries = MAX_AFFINITY_ENTRIES } = {}) {
  const entries = new Map();
  function prune() {
    for (const [key, entry] of entries) {
      if (now() - entry.at < ttlMs) break;
      entries.delete(key);
    }
  }
  function remember(key, providerSlug) {
    prune();
    entries.delete(key);
    entries.set(key, { providerSlug, at: now() });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }
  function lookup(key) {
    prune();
    const entry = entries.get(key);
    if (!entry) return null;
    remember(key, entry.providerSlug);
    return entry.providerSlug;
  }
  function request({ userId, model, conversationId = null, messages = [] }) {
    const historyHash = crypto.createHash('sha256');
    const prefixes = [];
    let hasUser = false;
    let hasAssistant = false;
    for (const message of messages) {
      const canonical = canonicalMessage(message);
      historyHash.update(stableJson(canonical)).update('\n');
      if (canonical.role === 'user') hasUser = true;
      if (canonical.role === 'assistant' && hasUser && (canonical.content || canonical.tool_calls?.length)) hasAssistant = true;
      if (hasAssistant && canonical.role !== 'system') {
        prefixes.push(historyHash.copy().digest('hex'));
        if (prefixes.length > 64) prefixes.shift();
      }
    }
    let scope;
    function setPool(slugs) {
      scope = userId === undefined || userId === null ? null : digest(stableJson([userId, model, [...slugs].sort()]));
      if (!scope) return null;
      if (conversationId) return lookup(`${scope}:id:${digest(conversationId)}`);
      for (let index = prefixes.length - 1; index >= 0; index--) {
        const providerSlug = lookup(`${scope}:prefix:${prefixes[index]}`);
        if (providerSlug) return providerSlug;
      }
      return null;
    }
    function complete(providerSlug, assistantMessage) {
      if (!scope) return;
      if (conversationId) {
        remember(`${scope}:id:${digest(conversationId)}`, providerSlug);
        return;
      }
      if (hasAssistant) remember(`${scope}:prefix:${historyHash.copy().digest('hex')}`, providerSlug);
      if (hasUser && assistantMessage && (assistantMessage.content || assistantMessage.tool_calls?.length)) {
        const completedHash = historyHash.copy().update(stableJson(canonicalMessage(assistantMessage))).update('\n').digest('hex');
        remember(`${scope}:prefix:${completedHash}`, providerSlug);
      }
    }
    return { setPool, complete };
  }
  return { request, size: () => { prune(); return entries.size; } };
}

const affinityStore = createAffinityStore();
module.exports = { AFFINITY_TTL_MS, MAX_AFFINITY_ENTRIES, affinityContextFromRequest, affinityStore, createAffinityStore, opaqueConversationId };
