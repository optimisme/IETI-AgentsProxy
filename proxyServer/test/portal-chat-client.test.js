const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const clientSource = fs.readFileSync(path.join(__dirname, '../assets/portal-chat.js'), 'utf8');

// This fixture implements only the DOM operations the client uses. The real event
// handlers, requests and cancellation logic execute unchanged inside the VM.
class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    this.value = '';
    this._text = '';
    this.options = [];
    this.files = [];
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.clientHeight = 100;
    this.disabled = false;
    this.hidden = false;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  append(...children) {
    this.children.push(...children);
    if (this.tagName === 'select') this.options.push(...children);
  }
  insertBefore(child, target) { this.children.splice(this.children.indexOf(target), 0, child); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  querySelectorAll() { return []; }
  focus() { this.focused = true; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type) {
    return Promise.all((this.listeners.get(type) || []).map((listener) => listener({ preventDefault() {} })));
  }
}

class ImageFile {
  constructor(bytes, type = 'image/png', name = 'fixture.png') {
    this.bytes = Buffer.from(bytes);
    this.type = type;
    this.name = name;
    this.size = this.bytes.length;
  }
  slice(start, end) {
    const slice = this.bytes.subarray(start, end);
    return { arrayBuffer: async () => Uint8Array.from(slice).buffer };
  }
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHCkAAAAASUVORK5CYII=', 'base64');

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

function response(content, { status = 200, reasoning = '' } = {}) {
  return {
    ok: status < 400,
    status,
    redirected: false,
    headers: { get: () => 'application/json' },
    json: async () => status < 400
      ? { choices: [{ message: { role: 'assistant', content, reasoning_content: reasoning } }] }
      : { error: { message: content } }
  };
}

function browser(overrides = {}) {
  const ids = ['portal-chat-config', 'chat-model', 'chat-reset', 'chat-compact', 'chat-messages', 'chat-form', 'chat-input', 'chat-images', 'chat-attachments', 'chat-send', 'chat-stop', 'chat-status', 'chat-budget', 'chat-image-upload'];
  const elements = new Map(ids.map((id) => [id, new Element(id === 'chat-model' ? 'select' : 'div')]));
  const config = {
    models: [
      { id: 'text-model', limit: { context: 32768, output: 4096 }, capabilities: { image: false } },
      { id: 'vision-model', limit: { context: 32768, output: 4096 }, capabilities: { image: true } }
    ],
    csrfToken: 'fixture-csrf-token', streaming: false, harnessTokens: 512, imageTokens: 2048,
    maxOutputTokens: 4096, autoCompactRatio: 0.65,
    imageLimits: { maxImages: 4, maxImageBytes: 4096, maxTotalImageBytes: 8192 },
    ...overrides
  };
  elements.get('portal-chat-config').textContent = JSON.stringify(config);
  elements.get('chat-model').value = config.models[0].id;
  const replies = [];
  const calls = [];
  const sandbox = {
    window: {},
    document: { getElementById: (id) => elements.get(id), createElement: (tag) => new Element(tag) },
    AbortController, TextDecoder, Intl,
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), headers: options.headers, signal: options.signal, credentials: options.credentials });
      const reply = replies.shift();
      if (!reply) throw new Error('No fixture response queued.');
      return typeof reply === 'function' ? reply(calls.at(-1)) : reply;
    },
    FileReader: class {
      readAsDataURL(file) {
        this.result = `data:${file.type};base64,${file.bytes.toString('base64')}`;
        queueMicrotask(() => this.onload());
      }
    }
  };
  vm.runInNewContext(clientSource, sandbox, { filename: 'portal-chat.js' });
  const get = (id) => elements.get(`chat-${id}`);
  return {
    calls, get, config,
    queue: (reply) => replies.push(reply),
    async draft(text) { get('input').value = text; await get('input').dispatch('input'); },
    async submit(text) {
      if (text !== undefined) { get('input').value = text; await get('input').dispatch('input'); }
      return get('form').dispatch('submit');
    },
    click: (id) => get(id).dispatch('click'),
    async select(id) { get('model').value = id; await get('model').dispatch('change'); },
    async upload(...files) { get('images').files = files; await get('images').dispatch('change'); }
  };
}

async function waitForCalls(fixture, count) {
  for (let attempt = 0; attempt < 20 && fixture.calls.length < count; attempt += 1) await Promise.resolve();
  assert.equal(fixture.calls.length, count);
}

test('Reset prevents a late response from restoring the conversation or finishing a new generation', async () => {
  const fixture = browser();
  const old = deferred();
  const fresh = deferred();
  fixture.queue(old.promise);
  const oldSend = fixture.submit('Old conversation');
  await waitForCalls(fixture, 1);
  await fixture.click('reset');
  assert.equal(fixture.calls[0].signal.aborted, true);
  fixture.queue(fresh.promise);
  const freshSend = fixture.submit('Fresh conversation');
  await waitForCalls(fixture, 2);
  old.resolve(response('Late old answer'));
  await oldSend;
  assert.equal(fixture.get('send').disabled, true, 'the new request remains busy');
  assert.equal(fixture.get('stop').hidden, false);
  assert.doesNotMatch(fixture.get('messages').textContent, /Old conversation|Late old answer/);
  fresh.resolve(response('Fresh answer'));
  await freshSend;
  fixture.queue(response('Next answer'));
  await fixture.submit('Continue fresh');
  assert.deepEqual(fixture.calls[2].body.messages.map((message) => message.content), ['Fresh conversation', 'Fresh answer', 'Continue fresh']);
  assert.equal(fixture.calls[2].body.summary, '');
});

test('Reset prevents a late compaction summary from becoming the context of a fresh conversation', async () => {
  const fixture = browser();
  fixture.queue(response('Original answer '.repeat(80)));
  await fixture.submit('Original goal '.repeat(30));
  const lateSummary = deferred();
  fixture.queue(lateSummary.promise);
  const compacting = fixture.click('compact');
  await waitForCalls(fixture, 2);
  await fixture.click('reset');
  lateSummary.resolve(response('Late original summary'));
  await compacting;
  assert.equal(fixture.calls[1].signal.aborted, true);
  assert.match(fixture.get('status').textContent, /reset/i);
  assert.equal(fixture.get('compact').disabled, true);
  fixture.queue(response('Fresh answer'));
  await fixture.submit('Fresh goal');
  assert.equal(fixture.calls[2].body.summary, '');
  assert.deepEqual(fixture.calls[2].body.messages, [{ role: 'user', content: 'Fresh goal' }]);
});

test('Compact forces a summary below 65% and can summarize an already compacted conversation again', async () => {
  const fixture = browser();
  fixture.queue(response('Detailed response '.repeat(80)));
  await fixture.submit('Keep these project goals '.repeat(20));
  fixture.queue(response('Retained project goal: produce a bullet list.'));
  await fixture.click('compact');
  assert.equal(fixture.calls[1].body.compact, true);
  assert.equal(fixture.calls[1].body.messages.length, 2);
  assert.equal(fixture.calls[1].body.summary, '');
  assert.equal(fixture.get('compact').disabled, false, 'the summary remains a conversation even when no recent messages are retained');
  fixture.queue(response('Bullet list.'));
  await fixture.click('compact');
  assert.equal(fixture.calls[2].body.compact, true);
  assert.deepEqual(fixture.calls[2].body.messages, []);
  assert.equal(fixture.calls[2].body.summary, 'Retained project goal: produce a bullet list.');
  fixture.queue(response('Continuation'));
  await fixture.submit('Continue');
  assert.equal(fixture.calls[3].body.summary, 'Bullet list.');
  assert.deepEqual(fixture.calls[3].body.messages, [{ role: 'user', content: 'Continue' }]);
  assert.match(fixture.get('messages').textContent, /Detailed response/, 'compaction preserves the visible transcript');
});

function smallBrowser() {
  return browser({ models: [{ id: 'small-model', limit: { context: 2048, output: 256 }, capabilities: { image: false } }], maxOutputTokens: 256 });
}

test('crossing 65% automatically summarizes existing context before sending the pending user message', async () => {
  const fixture = smallBrowser();
  fixture.queue(response('a'.repeat(1200)));
  await fixture.submit('u'.repeat(2000));
  const compact = deferred();
  fixture.queue(compact.promise);
  fixture.queue(response('Next answer'));
  const pending = 'Pending message '.repeat(6);
  const send = fixture.submit(pending);
  await waitForCalls(fixture, 2);
  assert.equal(fixture.calls[1].body.compact, true);
  assert.deepEqual(fixture.calls[1].body.messages.map((message) => message.content), ['u'.repeat(2000), 'a'.repeat(1200)]);
  assert.equal(fixture.get('input').value, pending, 'the draft is not committed before a valid summary');
  assert.match(fixture.get('status').textContent, /Summarizing/);
  compact.resolve(response('Retained goal.'));
  await send;
  assert.equal(fixture.calls.length, 3);
  assert.equal(fixture.calls[2].body.compact, false);
  assert.equal(fixture.calls[2].body.summary, 'Retained goal.');
  assert.deepEqual(fixture.calls[2].body.messages, [{ role: 'user', content: pending.trim() }]);
  assert.equal(fixture.calls[2].headers['X-CSRF-Token'], 'fixture-csrf-token');
  assert.equal(fixture.calls[2].credentials, 'same-origin');
});

test('failed automatic compaction preserves the original context and pending draft for retry', async () => {
  const fixture = smallBrowser();
  fixture.queue(response('a'.repeat(1200)));
  await fixture.submit('u'.repeat(2000));
  const pending = 'Pending message '.repeat(6);
  fixture.queue(response('Summary provider unavailable.', { status: 503 }));
  await fixture.submit(pending);
  assert.equal(fixture.calls.length, 2, 'the pending message is not sent after a failed summary');
  assert.equal(fixture.get('input').value, pending);
  assert.match(fixture.get('status').textContent, /Summary provider unavailable/);
  assert.doesNotMatch(fixture.get('messages').textContent, /Pending message/);
  fixture.queue(response('Retained goal.'));
  fixture.queue(response('Retry answer'));
  await fixture.submit();
  assert.deepEqual(fixture.calls[2].body, fixture.calls[1].body, 'retry summarizes the same unchanged context');
  assert.equal(fixture.calls[3].body.summary, 'Retained goal.');
  assert.deepEqual(fixture.calls[3].body.messages, [{ role: 'user', content: pending.trim() }]);
});

test('an oversized historical pair is compacted through a fitting prefix without dropping its unsummarized tail', async () => {
  const fixture = smallBrowser();
  const original = 'u'.repeat(4200);
  const answer = 'a'.repeat(1600);
  fixture.queue(response(answer));
  await fixture.submit(original);
  fixture.queue(response('Retained original goal.'));
  fixture.queue(response('Continuation'));
  await fixture.submit('Continue');
  assert.deepEqual(fixture.calls[1].body.messages, [{ role: 'user', content: original }], 'only the fitting oldest prefix is sent for compaction');
  assert.equal(fixture.calls[2].body.summary, 'Retained original goal.');
  assert.deepEqual(fixture.calls[2].body.messages, [{ role: 'assistant', content: answer }, { role: 'user', content: 'Continue' }], 'the entire unsummarized answer remains in context');
  assert.match(fixture.get('messages').textContent, /uuuu/);
  assert.match(fixture.get('messages').textContent, /aaaa/);
});

test('a non-reducing summary keeps the conversation and draft instead of replacing context', async () => {
  const fixture = browser();
  fixture.queue(response('Useful answer '.repeat(30)));
  await fixture.submit('Original user goal '.repeat(20));
  await fixture.draft('Unsent draft');
  fixture.queue(response('An unnecessarily long summary '.repeat(200)));
  await fixture.click('compact');
  assert.equal(fixture.get('input').value, 'Unsent draft');
  assert.match(fixture.get('status').textContent, /did not free enough/);
  fixture.queue(response('Next response'));
  await fixture.submit();
  assert.equal(fixture.calls[2].body.summary, '');
  assert.deepEqual(fixture.calls[2].body.messages.map((message) => message.content), ['Original user goal '.repeat(20).trim(), 'Useful answer '.repeat(30), 'Unsent draft']);
});

test('uploads and image-only messages require vision, and switching to text cannot resend image history', async () => {
  const fixture = browser();
  assert.equal(fixture.get('images').disabled, true);
  assert.equal(fixture.get('image-upload').hidden, true);
  await fixture.upload(new ImageFile(PNG));
  assert.equal(fixture.get('attachments').children.length, 0);
  await fixture.select('vision-model');
  assert.equal(fixture.get('images').disabled, false);
  assert.equal(fixture.get('image-upload').hidden, false);
  await fixture.upload(new ImageFile(PNG));
  assert.equal(fixture.get('attachments').children.length, 1);
  assert.equal(fixture.get('send').disabled, false, 'an image-only message can be sent');
  fixture.queue(response('Image description'));
  await fixture.submit();
  const uploaded = fixture.calls[0].body.messages[0].content;
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].type, 'image_url');
  assert.equal(uploaded[0].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`);
  await fixture.select('text-model');
  await fixture.draft('Continue');
  assert.equal(fixture.get('send').disabled, true);
  await fixture.submit();
  assert.equal(fixture.calls.length, 1);
  assert.match(fixture.get('status').textContent, /vision|Reset/);
  await fixture.click('reset');
  fixture.queue(response('Text answer'));
  await fixture.submit('Fresh text message');
  assert.deepEqual(fixture.calls[1].body.messages, [{ role: 'user', content: 'Fresh text message' }]);
});

test('changing to a model without vision clears pending uploads, while invalid image bytes are rejected', async () => {
  const fixture = browser();
  await fixture.select('vision-model');
  await fixture.upload(new ImageFile(Buffer.from('<svg onload="alert(1)"></svg>'), 'image/png', 'fake.png'));
  assert.equal(fixture.get('attachments').children.length, 0);
  assert.match(fixture.get('status').textContent, /not a valid/);
  await fixture.upload(new ImageFile(PNG));
  await fixture.select('text-model');
  assert.equal(fixture.get('attachments').children.length, 0);
  assert.match(fixture.get('status').textContent, /Pending images removed/);
  fixture.queue(response('Text answer'));
  await fixture.submit('Text only');
  assert.equal(fixture.calls[0].body.messages[0].content, 'Text only');
});

test('historical image limits trigger compaction before the token threshold is reached', async () => {
  const fixture = browser({ imageLimits: { maxImages: 1, maxImageBytes: 4096, maxTotalImageBytes: 8192 } });
  await fixture.select('vision-model');
  await fixture.upload(new ImageFile(PNG));
  fixture.queue(response('First image description.'));
  await fixture.submit();
  await fixture.upload(new ImageFile(PNG));
  fixture.queue(response('Retained first image.'));
  fixture.queue(response('Second image description.'));
  await fixture.submit();
  assert.equal(fixture.calls.length, 3);
  assert.equal(fixture.calls[1].body.compact, true);
  assert.equal(fixture.calls[1].body.messages.length, 2, 'the existing image exchange is summarized first');
  assert.equal(fixture.calls[2].body.summary, 'Retained first image.');
  assert.equal(fixture.calls[2].body.messages.length, 1, 'the new image request contains no historical image attachments');
  assert.equal(fixture.calls[2].body.messages[0].content[0].type, 'image_url');
});

test('streaming handles split UTF-8 and SSE separators and retains assistant reasoning for later requests', async () => {
  const fixture = browser({ streaming: true });
  const encoded = Buffer.from([
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hé🙂' } }] })}\r\n\r\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Careful reasoning.' }, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n'
  ].join(''));
  let offset = 0;
  let cancelled = false;
  fixture.queue({
    ok: true, status: 200, redirected: false,
    headers: { get: () => 'text/event-stream' },
    body: { getReader: () => ({
      async read() { return offset < encoded.length ? { done: false, value: Uint8Array.from([encoded[offset++]]) } : { done: true }; },
      async cancel() { cancelled = true; },
      releaseLock() {}
    }) }
  });
  await fixture.submit('First question');
  assert.equal(cancelled, true);
  assert.match(fixture.get('messages').textContent, /hé🙂/);
  fixture.queue(response('Next answer'));
  await fixture.submit('Follow-up');
  assert.deepEqual(fixture.calls[1].body.messages[1], { role: 'assistant', content: 'hé🙂', reasoning_content: 'Careful reasoning.' });
});
