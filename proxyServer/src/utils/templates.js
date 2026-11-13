const fs = require('fs');
const path = require('path');
const { htmlValue } = require('./html');

const viewsDir = path.join(__dirname, '..', 'views');
const cache = new Map();

function loadTemplate(name) {
  if (!cache.has(name)) {
    cache.set(name, fs.readFileSync(path.join(viewsDir, `${name}.html`), 'utf8'));
  }
  return cache.get(name);
}

function renderTemplate(name, data = {}) {
  // One pass with a replacer function: values are inserted literally (no "$" replacement
  // patterns) and inserted text is never scanned again for placeholders.
  return loadTemplate(name).replace(/\{\{([^}]+)}}/g, (_match, key) =>
    Object.hasOwn(data, key) ? htmlValue(data[key]) : '');
}

module.exports = { renderTemplate };
