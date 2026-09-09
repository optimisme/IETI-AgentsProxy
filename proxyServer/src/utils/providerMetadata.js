// Only explicit values are eligible for application. Unknown values and configured
// parsers are useful diagnostics, but do not establish model capabilities.
const CAPABILITY_FIELDS = [
  'supports_text_input', 'supports_image_input', 'supports_tools',
  'supports_reasoning', 'supports_chat_template_kwargs', 'supports_parallel_tools'
];
const { parseReasoningEfforts, normalizeReasoningEffort } = require('./reasoning');
const SETTING_FIELDS = ['context_limit', 'output_limit', ...CAPABILITY_FIELDS,
  'reasoning_efforts', 'default_reasoning_effort', 'reasoning_history_field'];

function reasoningSettings(controls) {
  const settings = {};
  if (!controls || typeof controls !== 'object' || Array.isArray(controls)) return settings;
  if (Array.isArray(controls.reasoning_efforts)) {
    settings.reasoning_efforts = JSON.stringify(parseReasoningEfforts(controls.reasoning_efforts));
  }
  if (controls.default_reasoning_effort === null || normalizeReasoningEffort(controls.default_reasoning_effort)) {
    settings.default_reasoning_effort = normalizeReasoningEffort(controls.default_reasoning_effort);
  }
  if (['reasoning', 'reasoning_content'].includes(controls.reasoning_history_field)) {
    settings.reasoning_history_field = controls.reasoning_history_field;
  }
  return settings;
}

function positiveInteger(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function officialModelSettings(model) {
  const settings = {};
  const context = positiveInteger(model?.max_model_len);
  const output = positiveInteger(model?.output_limit);
  if (context !== null) settings.context_limit = context;
  if (output !== null) settings.output_limit = output;
  for (const field of CAPABILITY_FIELDS) {
    if (typeof model?.[field] === 'boolean') settings[field] = Number(model[field]);
  }
  return { ...settings, ...reasoningSettings(model) };
}

module.exports = { CAPABILITY_FIELDS, SETTING_FIELDS, officialModelSettings };
