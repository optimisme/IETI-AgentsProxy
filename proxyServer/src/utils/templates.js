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
  let html = loadTemplate(name);
  for (const [key, value] of Object.entries(data)) {
    html = html.replaceAll(`{{${key}}}`, htmlValue(value));
  }
  return html.replaceAll(/\{\{[^}]+}}/g, '');
}

module.exports = { renderTemplate };
