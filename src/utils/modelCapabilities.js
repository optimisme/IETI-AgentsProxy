const { REASONING_EFFORTS } = require('./reasoning');

function commonCapabilities(previous, incoming = {}) {
  const capabilities = {};
  for (const field of ['text', 'image', 'tools', 'reasoning', 'chatTemplateKwargs', 'parallelTools']) {
    capabilities[field] = Boolean(incoming[field] && (!previous || previous[field]));
  }
  capabilities.reasoningEfforts = capabilities.reasoning ? REASONING_EFFORTS.filter((effort) =>
    incoming.reasoningEfforts?.includes(effort) && (!previous || previous.reasoningEfforts?.includes(effort))) : [];
  capabilities.reasoningEffortsKnown = Boolean(incoming.reasoningEffortsKnown && (!previous || previous.reasoningEffortsKnown));
  const defaultEffort = previous && previous.defaultReasoningEffort !== incoming.defaultReasoningEffort
    ? null : incoming.defaultReasoningEffort;
  capabilities.defaultReasoningEffort = capabilities.reasoningEfforts.includes(defaultEffort) ? defaultEffort : null;
  capabilities.parallelTools &&= capabilities.tools;
  capabilities.chatTemplateKwargs &&= capabilities.reasoning;
  return capabilities;
}

module.exports = { commonCapabilities };
