const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/dashboard-usage.js'), 'utf8');

function chart(data, { contextAvailable = true } = {}) {
  const events = {};
  const attributes = {};
  const draws = [];
  const frames = [];
  const bounds = { left: 10, top: 20, width: 600, height: 280 };
  const context = new Proxy({ measureText: (text) => ({ width: text.length * 7 }) }, {
    get(target, property) {
      if (property in target) return target[property];
      return (...arguments_) => draws.push({ method: property, arguments: arguments_ });
    }
  });
  const canvas = {
    getContext: () => contextAvailable ? context : null,
    getBoundingClientRect: () => bounds,
    setAttribute: (name, value) => { attributes[name] = value; },
    addEventListener: (name, listener) => { events[name] = listener; }
  };
  const tooltip = {
    hidden: true, offsetWidth: 280, offsetHeight: 35, style: {},
    setAttribute() {}
  };
  const container = {
    dataset: { usage: typeof data === 'string' ? data : JSON.stringify(data) },
    querySelector: (selector) => selector === 'canvas' ? canvas : tooltip,
    getBoundingClientRect: () => bounds
  };
  const windowEvents = {};
  vm.runInNewContext(source, {
    document: { querySelectorAll: () => [container] },
    window: {
      devicePixelRatio: 2,
      requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
      addEventListener: (name, listener) => { windowEvents[name] = listener; }
    },
    Intl
  });
  return {
    canvas, tooltip, attributes, draws, bounds, events,
    flush: () => { while (frames.length) frames.shift()(); },
    resize: () => windowEvents.resize(),
    key: (key) => {
      let prevented = false;
      events.keydown({ key, preventDefault: () => { prevented = true; } });
      while (frames.length) frames.shift()();
      return prevented;
    }
  };
}

const rows = Array.from({ length: 15 }, (_, index) => ({
  date: `2026-09-${String(16 + index).padStart(2, '0')}`,
  calls: index + 1,
  tokens: index * 1000
}));

test('daily chart renders at display density and resizes without invalid geometry', () => {
  const view = chart(rows);
  assert.equal(view.canvas.width, 1200);
  assert.equal(view.canvas.height, 560);
  assert.ok(view.draws.some((draw) => draw.method === 'fillRect'));
  assert.ok(view.draws.every((draw) => draw.arguments.every((value) => typeof value !== 'number' || Number.isFinite(value))));

  view.bounds.width = 220;
  view.resize();
  view.flush();
  assert.equal(view.canvas.width, 440);
  assert.equal(view.canvas.height, 560);
});

test('keyboard inspection exposes UTC dates and charged usage, then hides on blur', () => {
  const view = chart(rows);
  view.events.focus();
  view.flush();
  assert.equal(view.tooltip.hidden, false);
  assert.match(view.tooltip.textContent, /2026-09-30 UTC.*14.?000 tokens.*15 completed or stopped calls/);
  assert.equal(view.attributes['aria-label'], view.tooltip.textContent);
  assert.equal(view.key('ArrowLeft'), true);
  assert.match(view.tooltip.textContent, /2026-09-29 UTC/);
  view.key('Home');
  assert.match(view.tooltip.textContent, /2026-09-16 UTC.*0 tokens.*1 completed or stopped calls/);
  view.key('ArrowLeft');
  assert.match(view.tooltip.textContent, /2026-09-16 UTC/);
  view.key('End');
  assert.match(view.tooltip.textContent, /2026-09-30 UTC/);
  assert.equal(view.key('Tab'), false);
  view.events.blur();
  view.flush();
  assert.equal(view.tooltip.hidden, true);
  assert.match(view.attributes['aria-label'], /Use left and right arrow keys/);
});

test('pointer inspection stays within the plot and hides on leave', () => {
  const view = chart(rows);
  view.events.pointermove({ clientX: 300, clientY: 150 });
  view.flush();
  assert.equal(view.tooltip.hidden, false);
  assert.match(view.tooltip.textContent, /UTC.*tokens.*completed or stopped calls/);
  assert.ok(Number.parseFloat(view.tooltip.style.left) >= 4);
  assert.ok(Number.parseFloat(view.tooltip.style.top) >= 4);
  view.events.pointerleave();
  view.flush();
  assert.equal(view.tooltip.hidden, true);
  view.events.click({ clientX: 300, clientY: 150 });
  view.flush();
  assert.equal(view.tooltip.hidden, false);
});

test('zero usage renders a usable chart and unavailable canvas preserves the fallback', () => {
  const view = chart(rows.map((row) => ({ ...row, calls: 0, tokens: 0 })));
  assert.ok(view.draws.some((draw) => draw.method === 'fillText' && draw.arguments[0] === 'No tokens recorded in this period'));
  assert.ok(view.draws.every((draw) => draw.arguments.every((value) => typeof value !== 'number' || Number.isFinite(value))));
  view.events.focus();
  view.flush();
  assert.match(view.tooltip.textContent, /0 tokens.*0 completed or stopped calls/);

  assert.deepEqual(Object.keys(chart(rows, { contextAvailable: false }).events), []);
  assert.deepEqual(Object.keys(chart('invalid JSON').events), []);
  assert.deepEqual(Object.keys(chart([]).events), []);
});
