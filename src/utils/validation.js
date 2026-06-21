const { apiError } = require('./errors');

function requiredText(value, fieldName, { max = 255 } = {}) {
  const text = String(value || '').trim();
  if (!text) throw apiError(400, 'invalid_form', `${fieldName} is required.`);
  if (text.length > max) throw apiError(400, 'invalid_form', `${fieldName} is too long.`);
  return text;
}

function optionalText(value, { max = 255 } = {}) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length > max) throw apiError(400, 'invalid_form', 'Value is too long.');
  return text;
}

function email(value) {
  const text = requiredText(value, 'Email', { max: 320 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw apiError(400, 'invalid_form', 'Email must be valid.');
  }
  return text;
}

function nonNegativeIntegerOrNull(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw apiError(400, 'invalid_form', `${fieldName} must be a non-negative integer.`);
  }
  return parsed;
}

function slug(value, fieldName = 'Slug') {
  const text = requiredText(value, fieldName, { max: 80 })
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!text) throw apiError(400, 'invalid_form', `${fieldName} is required.`);
  return text;
}

function url(value, fieldName = 'URL') {
  const text = requiredText(value, fieldName, { max: 2048 }).replace(/\/+$/, '');
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported protocol');
  } catch {
    throw apiError(400, 'invalid_form', `${fieldName} must be an HTTP or HTTPS URL.`);
  }
  return text;
}

module.exports = {
  email,
  nonNegativeIntegerOrNull,
  optionalText,
  requiredText,
  slug,
  url
};
