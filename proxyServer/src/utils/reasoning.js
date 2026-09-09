const REASONING_EFFORTS = Object.freeze([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]);

const REASONING_EFFORT_SET = new Set(REASONING_EFFORTS);
const CHAT_TEMPLATE_KWARG_NAMES = Object.freeze([
  'enable_thinking',
  'preserve_thinking',
  'reasoning_effort'
]);
const CHAT_TEMPLATE_KWARG_SET = new Set(CHAT_TEMPLATE_KWARG_NAMES);

function normalizeReasoningEffort(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const effort = String(value).trim().toLowerCase();
  return REASONING_EFFORT_SET.has(effort) ? effort : null;
}

function parseReasoningEfforts(value) {
  if (value === undefined || value === null) return null;
  let values = value;
  if (typeof values === 'string') {
    const text = values.trim();
    if (!text) return [];
    try {
      values = JSON.parse(text);
    } catch {
      values = text.split(',');
    }
  }
  if (!Array.isArray(values)) return [];
  const selected = new Set(values.map(normalizeReasoningEffort).filter(Boolean));
  return REASONING_EFFORTS.filter((effort) => selected.has(effort));
}

function serializeReasoningEfforts(value) {
  const efforts = parseReasoningEfforts(value);
  return efforts === null ? null : JSON.stringify(efforts);
}

module.exports = {
  CHAT_TEMPLATE_KWARG_NAMES,
  CHAT_TEMPLATE_KWARG_SET,
  REASONING_EFFORTS,
  REASONING_EFFORT_SET,
  normalizeReasoningEffort,
  parseReasoningEfforts,
  serializeReasoningEfforts
};
