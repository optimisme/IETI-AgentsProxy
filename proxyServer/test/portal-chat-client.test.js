const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
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
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.style = {};
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
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  append(...children) {
    for (const child of children) {
      child.remove();
      child.parentNode = this;
      this.children.push(child);
      if (this.tagName === 'select') this.options.push(child);
    }
  }
  insertBefore(child, target) {
    child.remove();
    child.parentNode = this;
    this.children.splice(this.children.indexOf(target), 0, child);
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this._text = '';
    this.children = [];
    if (this.tagName === 'select') this.options = [];
    this.append(...children);
  }
  remove() {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    parent.children.splice(parent.children.indexOf(this), 1);
    if (parent.tagName === 'select') parent.options.splice(parent.options.indexOf(this), 1);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelectorAll() { return []; }
  focus() { this.focused = true; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type, options = {}) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
    this.lastEvent = event;
    return Promise.all((this.listeners.get(type) || []).map((listener) => listener(event)));
  }
  requestSubmit() {
    this.requestSubmitCount = (this.requestSubmitCount || 0) + 1;
    this.lastSubmission = this.dispatch('submit');
    return this.lastSubmission;
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

function response(content, { status = 200, reasoning = '', usage, finishReason = 'stop' } = {}) {
  return {
    ok: status < 400,
    status,
    redirected: false,
    headers: { get: () => 'application/json' },
    json: async () => status < 400
      ? { choices: [{ message: { role: 'assistant', content, reasoning_content: reasoning }, finish_reason: finishReason }], usage }
      : { error: { message: content } }
  };
}

function browser(overrides = {}) {
  const ids = ['portal-chat-config', 'chat-model', 'chat-reset', 'chat-compact', 'chat-messages', 'chat-form', 'chat-input', 'chat-images', 'chat-attachments', 'chat-send', 'chat-stop', 'chat-status', 'chat-budget', 'chat-image-upload', 'chat-state'];
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
  elements.get('chat-model').value = config.models[0]?.id || '';
  const replies = [];
  const calls = [];
  const copied = [];
  const copyReplies = [];
  let timerNow = 0;
  let nextTimer = 1;
  const timers = new Map();
  const setTimeout = (callback, delay = 0) => {
    const id = nextTimer++;
    timers.set(id, { callback, due: timerNow + delay });
    return id;
  };
  const clearTimeout = (id) => timers.delete(id);
  const navigator = {
    clipboard: {
      async writeText(text) {
        copied.push(text);
        const result = copyReplies.shift();
        if (result instanceof Error) throw result;
        if (result) await result;
      }
    }
  };
  const sandbox = {
    crypto: webcrypto,
    window: { navigator, setTimeout, clearTimeout },
    navigator,
    setTimeout, clearTimeout,
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
    calls, get, config, copied,
    advanceTime(milliseconds) {
      const until = timerNow + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        timerNow = timer.due;
        timer.callback();
      }
      timerNow = until;
    },
    pendingTimers: () => timers.size,
    queue: (reply) => replies.push(reply),
    queueCopy: (reply) => copyReplies.push(reply),
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

function descendants(element, predicate) {
  return element.children.flatMap((child) => [
    ...(predicate(child) ? [child] : []),
    ...descendants(child, predicate)
  ]);
}

function imageCount(fixture) {
  return descendants(fixture.get('messages'), (element) => element.tagName === 'img').length;
}

function summaryCards(fixture) {
  return descendants(fixture.get('messages'), (element) => (element.className || '').split(/\s+/).includes('chat-summary'));
}

function compactionCards(fixture) {
  return descendants(fixture.get('messages'), (element) => (element.className || '').split(/\s+/).includes('chat-compaction'));
}

function compactPercent(fixture) {
  const match = fixture.get('budget').textContent.match(/^(\d+)% to compact\b/);
  assert.ok(match, 'the footer shows the remaining percentage in its token budget row');
  return Number(match[1]);
}

async function settle() {
  for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
}

function messageCopyButtons(fixture) {
  // With Markdown libraries absent in this fixture, messages contain only the
  // complete-message controls, while code and table controls are browser-tested.
  return descendants(fixture.get('messages'), (element) => element.tagName === 'button');
}

async function waitForText(fixture, text) {
  for (let attempt = 0; attempt < 30 && !fixture.get('messages').textContent.includes(text); attempt += 1) await Promise.resolve();
  assert.ok(fixture.get('messages').textContent.includes(text), `Expected message text: ${text}`);
}

test('Enter sends through the form once while a busy or empty composer does not submit', async () => {
  const fixture = browser();
  await fixture.get('input').dispatch('keydown', { key: 'Enter' });
  assert.equal(fixture.get('form').requestSubmitCount || 0, 0, 'an empty composer cannot submit');
  const pending = deferred();
  fixture.queue(pending.promise);
  await fixture.draft('Send this with Enter');
  await fixture.get('input').dispatch('keydown', { key: 'Enter' });
  assert.equal(fixture.get('input').lastEvent.defaultPrevented, true, 'plain Enter does not insert a newline');
  await waitForCalls(fixture, 1);
  assert.equal(fixture.get('form').requestSubmitCount, 1);
  assert.deepEqual(fixture.calls[0].body.messages, [{ role: 'user', content: 'Send this with Enter' }]);
  await fixture.get('input').dispatch('keydown', { key: 'Enter' });
  assert.equal(fixture.get('form').requestSubmitCount, 1, 'Enter cannot double-submit a running generation');
  assert.equal(fixture.calls.length, 1);
  pending.resolve(response('Answer to the Enter question.'));
  await fixture.get('form').lastSubmission;
  assert.match(fixture.get('messages').textContent, /Answer to the Enter question/);
});

test('Shift+Enter and IME composition keep native text entry without sending a message', async () => {
  const fixture = browser();
  await fixture.draft('Draft with a second line');
  for (const event of [
    { key: 'Enter', shiftKey: true },
    { key: 'Enter', isComposing: true },
    { key: 'Enter', keyCode: 229 },
    { key: 'Escape' }
  ]) {
    await fixture.get('input').dispatch('keydown', event);
    assert.equal(fixture.get('input').lastEvent.defaultPrevented, false, 'the browser retains its native editing behavior');
    assert.equal(fixture.get('input').value, 'Draft with a second line');
  }
  assert.equal(fixture.get('form').requestSubmitCount || 0, 0);
  assert.equal(fixture.calls.length, 0);
});

test('the composer indicator is green when ready, red while generating, and exposes provider errors', async () => {
  const fixture = browser();
  const indicator = fixture.get('state');
  assert.equal(indicator.attributes.get('data-state'), 'ready');
  assert.equal(indicator.classes.has('chat-status-indicator-red'), false);
  assert.match(indicator.title, /Ready/);
  assert.equal(indicator.attributes.get('aria-label'), indicator.title);
  assert.equal(fixture.get('status').classes.has('visually-hidden'), true, 'ready text does not occupy composer space');

  const pending = deferred();
  fixture.queue(pending.promise);
  const sending = fixture.submit('Question while watching status');
  await waitForCalls(fixture, 1);
  assert.equal(indicator.attributes.get('data-state'), 'busy');
  assert.equal(indicator.classes.has('chat-status-indicator-red'), true);
  assert.match(indicator.title, /Generating response/);
  assert.equal(indicator.attributes.get('aria-label'), indicator.title);
  assert.equal(fixture.get('status').classes.has('visually-hidden'), true);
  pending.resolve(response('Finished answer.'));
  await sending;
  assert.equal(indicator.attributes.get('data-state'), 'ready');
  assert.equal(indicator.classes.has('chat-status-indicator-red'), false);
  assert.match(indicator.title, /Ready/);

  fixture.queue(response('The provider is unavailable.', { status: 503 }));
  await fixture.submit('Question that fails');
  assert.equal(indicator.attributes.get('data-state'), 'error');
  assert.equal(indicator.classes.has('chat-status-indicator-red'), true);
  assert.match(indicator.title, /The provider is unavailable/);
  assert.equal(indicator.attributes.get('aria-label'), indicator.title);
  assert.equal(fixture.get('status').classes.has('visually-hidden'), false, 'actionable errors remain visible');
  assert.equal(fixture.get('status').classes.has('chat-status-error'), true);
  await fixture.click('reset');
  assert.equal(indicator.attributes.get('data-state'), 'ready');
  assert.equal(indicator.classes.has('chat-status-indicator-red'), false);
  assert.equal(fixture.get('status').classes.has('visually-hidden'), true);
});

test('a composer without active models shows a red unavailable indicator and cannot send with Enter', async () => {
  const fixture = browser({ models: [] });
  const indicator = fixture.get('state');
  assert.equal(indicator.attributes.get('data-state'), 'unavailable');
  assert.equal(indicator.classes.has('chat-status-indicator-red'), true);
  assert.match(indicator.title, /No active models/);
  assert.equal(indicator.attributes.get('aria-label'), indicator.title);
  await fixture.draft('No model can handle this');
  await fixture.get('input').dispatch('keydown', { key: 'Enter' });
  assert.equal(fixture.get('send').disabled, true);
  assert.equal(fixture.get('form').requestSubmitCount || 0, 0);
  assert.equal(fixture.calls.length, 0);
});

test('Reset prevents a late response from restoring the conversation or finishing a new generation', async () => {
  const fixture = browser();
  const old = deferred();
  const fresh = deferred();
  fixture.queue(old.promise);
  const oldSend = fixture.submit('Old conversation');
  await waitForCalls(fixture, 1);
  const previousConversationId = fixture.calls[0].body.conversation_id;
  assert.match(previousConversationId, /^[0-9a-f-]{36}$/);
  await fixture.click('reset');
  assert.equal(fixture.calls[0].signal.aborted, true);
  fixture.queue(fresh.promise);
  const freshSend = fixture.submit('Fresh conversation');
  await waitForCalls(fixture, 2);
  const nextConversationId = fixture.calls[1].body.conversation_id;
  assert.notEqual(nextConversationId, previousConversationId, 'Reset also starts fresh affinity while the old request finishes');
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
  assert.equal(fixture.calls[2].body.conversation_id, nextConversationId, 'following turns preserve the new conversation identity');
});

test('separate pages have independent opaque identifiers and model changes preserve the page conversation', async () => {
  const first = browser();
  const second = browser();
  first.queue(response('First answer.'));
  second.queue(response('Other answer.'));
  await first.submit('Shared first-message template.');
  await second.submit('Shared first-message template.');
  const id = first.calls[0].body.conversation_id;
  assert.notEqual(id, second.calls[0].body.conversation_id, 'identical initial messages do not identify different page conversations');
  assert.doesNotMatch(id, /Shared|template|text-model/);
  await first.select('vision-model');
  first.queue(response('Answer with the other model.'));
  await first.submit('Continue with another model.');
  assert.equal(first.calls[1].body.conversation_id, id);
  assert.equal(first.calls[1].body.model, 'vision-model');
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
  assert.equal(fixture.get('messages').children.length, 1, 'one summary replaces the old visible exchange');
  assert.equal(summaryCards(fixture).length, 1);
  assert.match(summaryCards(fixture)[0].textContent, /Conversation summary/);
  assert.match(fixture.get('messages').textContent, /Retained project goal: produce a bullet list\./);
  assert.doesNotMatch(fixture.get('messages').textContent, /Keep these project goals|Detailed response/);
  fixture.queue(response('Bullet list.'));
  await fixture.click('compact');
  assert.equal(fixture.calls[2].body.compact, true);
  assert.deepEqual(fixture.calls[2].body.messages, []);
  assert.equal(fixture.calls[2].body.summary, 'Retained project goal: produce a bullet list.');
  assert.equal(fixture.get('messages').children.length, 1, 'repeated compaction replaces the existing summary');
  assert.equal(summaryCards(fixture).length, 1);
  assert.match(fixture.get('messages').textContent, /Bullet list\./);
  assert.doesNotMatch(fixture.get('messages').textContent, /Retained project goal|Detailed response/);
  const summaryNode = summaryCards(fixture)[0];
  fixture.queue(response('Continuation'));
  await fixture.submit('Continue');
  assert.equal(fixture.calls[3].body.summary, 'Bullet list.');
  assert.deepEqual(fixture.calls[3].body.messages, [{ role: 'user', content: 'Continue' }]);
  assert.ok(fixture.calls.every((call) => call.body.conversation_id === fixture.calls[0].body.conversation_id), 'summary requests and compacted continuations retain the same opaque identity');
  assert.equal(fixture.get('messages').children.length, 3, 'the summary and new exchange stay visible');
  assert.equal(summaryCards(fixture)[0], summaryNode, 'normal sends append new messages without redrawing the existing summary');
  assert.doesNotMatch(fixture.get('messages').textContent, /Detailed response/);
  await fixture.click('reset');
  assert.doesNotMatch(fixture.get('messages').textContent, /Bullet list|Continuation/);
  assert.match(fixture.get('messages').textContent, /Start a conversation/);
  assert.equal(summaryCards(fixture).length, 0);
  assert.equal(fixture.get('compact').disabled, true);
});

function smallBrowser() {
  return browser({ models: [{ id: 'small-model', limit: { context: 2048, output: 256 }, capabilities: { image: false } }], maxOutputTokens: 256 });
}

test('the footer starts at 100% and reaches zero only at the exact compaction threshold', async () => {
  const fixture = smallBrowser();
  assert.equal(compactPercent(fixture), 100);
  // 1280 usable input tokens × 65% = 832. The draft adds eight message
  // framing tokens, so these drafts project 831 and exactly 832 tokens.
  await fixture.draft('u'.repeat(3292));
  assert.equal(compactPercent(fixture), 1, 'rounding cannot advertise zero before the threshold');
  await fixture.draft('u'.repeat(3296));
  assert.equal(compactPercent(fixture), 0);
  fixture.advanceTime(600);
  await settle();
  assert.equal(fixture.calls.length, 0, 'a draft without any conversation has nothing to compact');
  await fixture.draft('Shorter draft');
  assert.ok(compactPercent(fixture) > 0);
  await fixture.click('reset');
  assert.equal(compactPercent(fixture), 100);
});

test('the footer accounts for attached images and provider-reported ordinary prompt usage', async () => {
  const fixture = browser();
  await fixture.draft('Describe the design.');
  const textOnly = compactPercent(fixture);
  await fixture.select('vision-model');
  await fixture.upload(new ImageFile(PNG));
  assert.ok(compactPercent(fixture) < textOnly, 'an image consumes remaining context before it is sent');
  await fixture.click('reset');
  assert.equal(compactPercent(fixture), 100);

  const ordinary = browser();
  const calibrated = browser();
  ordinary.queue(response('a'.repeat(1000)));
  calibrated.queue(response('a'.repeat(1000), { usage: { prompt_tokens: 4000, completion_tokens: 250 } }));
  await ordinary.submit('u'.repeat(1000));
  await calibrated.submit('u'.repeat(1000));
  assert.ok(compactPercent(calibrated) < compactPercent(ordinary), 'reported prompt usage corrects the estimate used by the footer');
  assert.ok(compactPercent(calibrated) > 0, 'this ordinary reply is still below the compaction threshold');
});

test('compaction displays progress in the conversation until its summary completes', async () => {
  const fixture = browser();
  fixture.queue(response('Original answer '.repeat(80)));
  await fixture.submit('Original project goal '.repeat(30));
  const previousNodes = [...fixture.get('messages').children];
  const pending = deferred();
  fixture.queue(pending.promise);
  const compacting = fixture.click('compact');
  await waitForCalls(fixture, 2);
  const cards = compactionCards(fixture);
  assert.equal(cards.length, 1, 'the conversation contains a visible progress card while the provider is pending');
  assert.equal(cards[0].hidden, false);
  assert.match(cards[0].textContent, /compact|summari/i);
  assert.ok(cards[0].attributes.get('role') === 'progressbar'
    || descendants(cards[0], (element) => element.attributes.get('role') === 'progressbar').length > 0,
  'compaction progress is accessible as a progressbar');
  assert.equal(fixture.get('messages').attributes.get('aria-busy'), 'true');
  assert.ok(previousNodes.every((node) => fixture.get('messages').children.includes(node)), 'progress does not discard the original transcript');
  pending.resolve(response('Retained project goal.'));
  await compacting;
  assert.equal(compactionCards(fixture).length, 0);
  assert.notEqual(fixture.get('messages').attributes.get('aria-busy'), 'true');
  assert.equal(summaryCards(fixture).length, 1);
});

test('failed, stopped and reset compaction remove progress and preserve the applicable conversation', async (context) => {
  for (const ending of ['failure', 'stop', 'reset']) {
    await context.test(ending, async () => {
      const fixture = browser();
      fixture.queue(response('Original answer '.repeat(80)));
      await fixture.submit('Original goal '.repeat(30));
      const original = fixture.get('messages').textContent;
      const originalNodes = [...fixture.get('messages').children];
      const pending = deferred();
      fixture.queue(pending.promise);
      const compacting = fixture.click('compact');
      await waitForCalls(fixture, 2);
      assert.equal(compactionCards(fixture).length, 1);
      if (ending !== 'failure') {
        await fixture.click(ending);
        assert.equal(fixture.calls[1].signal.aborted, true);
        assert.equal(compactionCards(fixture).length, 0, 'Stop and Reset remove stale progress immediately');
      }
      pending.resolve(ending === 'failure'
        ? response('Summary service unavailable.', { status: 503 })
        : response('Late summary that must never replace the transcript.'));
      await compacting;
      assert.equal(compactionCards(fixture).length, 0);
      assert.notEqual(fixture.get('messages').attributes.get('aria-busy'), 'true');
      assert.equal(summaryCards(fixture).length, 0);
      if (ending === 'reset') {
        assert.match(fixture.get('messages').textContent, /Start a conversation/);
      } else {
        assert.equal(fixture.get('messages').textContent, original);
        assert.deepEqual(fixture.get('messages').children, originalNodes);
      }
    });
  }
});

test('an answer reaching zero schedules idle compaction without another Send', async () => {
  const fixture = smallBrowser();
  fixture.queue(response('a'.repeat(1296)));
  await fixture.submit('u'.repeat(2000));
  assert.equal(compactPercent(fixture), 0);
  const pending = deferred();
  fixture.queue(pending.promise);
  fixture.advanceTime(599);
  await settle();
  assert.equal(fixture.calls.length, 1);
  fixture.advanceTime(1);
  await waitForCalls(fixture, 2);
  assert.equal(fixture.calls[1].body.compact, true);
  assert.equal(compactionCards(fixture).length, 1);
  assert.equal(fixture.get('input').value, '');
  pending.resolve(response('Retained goal after the large answer.'));
  await settle();
  assert.equal(fixture.calls.length, 2, 'automatic compaction sends no invented user turn');
  assert.equal(compactionCards(fixture).length, 0);
  assert.equal(summaryCards(fixture).length, 1);
  assert.ok(compactPercent(fixture) > 0);
});

test('a draft reaching zero compacts while idle and leaves that draft unsent', async () => {
  const fixture = smallBrowser();
  fixture.queue(response('a'.repeat(1200)));
  await fixture.submit('u'.repeat(2000));
  await fixture.draft('p'.repeat(28));
  assert.equal(compactPercent(fixture), 1);
  fixture.advanceTime(600);
  await settle();
  assert.equal(fixture.calls.length, 1, 'a positive remaining percentage does not compact');
  await fixture.draft('p'.repeat(29));
  assert.equal(compactPercent(fixture), 0);
  fixture.queue(response('Retained goal for this pending draft.'));
  fixture.advanceTime(600);
  await waitForCalls(fixture, 2);
  await settle();
  assert.equal(fixture.calls[1].body.compact, true);
  assert.deepEqual(fixture.calls[1].body.messages.map((message) => message.content), ['u'.repeat(2000), 'a'.repeat(1200)]);
  assert.equal(fixture.get('input').value, 'p'.repeat(29));
  assert.equal(fixture.calls.length, 2, 'the typed draft remains unsubmitted');
  assert.doesNotMatch(fixture.get('messages').textContent, /pppp/);
  assert.ok(compactPercent(fixture) > 0);
});

test('failed idle compaction does not retry unchanged context until the user changes it', async () => {
  const fixture = smallBrowser();
  fixture.queue(response('a'.repeat(1296)));
  await fixture.submit('u'.repeat(2000));
  const original = fixture.get('messages').textContent;
  fixture.queue(response('Summary service unavailable.', { status: 503 }));
  fixture.advanceTime(600);
  await waitForCalls(fixture, 2);
  await settle();
  assert.match(fixture.get('status').textContent, /Summary service unavailable/);
  assert.equal(fixture.get('messages').textContent, original);
  for (let retry = 0; retry < 3; retry += 1) {
    fixture.advanceTime(600);
    await fixture.get('input').dispatch('input');
    await settle();
  }
  assert.equal(fixture.calls.length, 2, 'unchanged state cannot cause a failing automatic request loop');
  fixture.queue(response('Retained goal after editing the draft.'));
  await fixture.draft('A new draft');
  fixture.advanceTime(600);
  await waitForCalls(fixture, 3);
  await settle();
  assert.equal(fixture.calls[2].body.compact, true);
  assert.equal(summaryCards(fixture).length, 1);
});

test('streamed content updates the countdown while busy and compacts only after the response finishes', async () => {
  const fixture = browser({
    models: [{ id: 'small-model', limit: { context: 2048, output: 256 }, capabilities: { image: false } }],
    maxOutputTokens: 256, streaming: true
  });
  const end = deferred();
  const answer = 'a'.repeat(1296);
  let reads = 0;
  fixture.queue({
    ok: true, status: 200, redirected: false,
    headers: { get: () => 'text/event-stream' },
    body: { getReader: () => ({
      read: async () => reads++ === 0
        ? { done: false, value: Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`) }
        : end.promise,
      async cancel() {},
      releaseLock() {}
    }) }
  });
  const sending = fixture.submit('u'.repeat(2000));
  await waitForText(fixture, answer);
  assert.equal(compactPercent(fixture), 0, 'streamed assistant text already consumes context in the footer');
  fixture.advanceTime(600);
  await settle();
  assert.equal(fixture.calls.length, 1, 'an in-flight generation cannot start compaction');
  const summary = deferred();
  fixture.queue(summary.promise);
  end.resolve({ done: false, value: Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) });
  await sending;
  fixture.advanceTime(600);
  await waitForCalls(fixture, 2);
  assert.equal(fixture.calls[1].body.compact, true);
  assert.deepEqual(fixture.calls[1].body.messages.map((message) => message.content), ['u'.repeat(2000), answer]);
  summary.resolve(response('Retained goal from the completed stream.'));
  await settle();
  assert.equal(summaryCards(fixture).length, 1);
  assert.ok(compactPercent(fixture) > 0);
});

test('full-message Copy preserves user and model Markdown without labels or private reasoning', async () => {
  const fixture = browser();
  const question = 'Please review this snippet:\n\n```java\nint a = 3;\n```';
  const answer = '## Result\n\n| Name | Value |\n| --- | --- |\n| a | 3 |\n\nThe value is **three**.';
  fixture.queue(response(answer, { reasoning: 'Private chain of reasoning, excluded from copying.' }));
  await fixture.submit(question);
  const [userCopy, modelCopy] = messageCopyButtons(fixture);
  assert.equal(messageCopyButtons(fixture).length, 2);
  assert.equal(userCopy.textContent, 'Copy request');
  assert.equal(userCopy.attributes.get('aria-label'), 'Copy request');
  assert.equal(modelCopy.textContent, 'Copy response');
  assert.equal(modelCopy.attributes.get('aria-label'), 'Copy response');
  const assistantHeading = descendants(fixture.get('messages'), (element) => (element.className || '').split(/\s+/).includes('chat-message-heading-assistant'))[0];
  assert.ok(assistantHeading, 'the assistant heading groups its attribution and adjacent Copy response control');
  assert.equal(assistantHeading.children[0].textContent, 'Answered by: text-model');
  assert.equal(assistantHeading.children[1], modelCopy, 'the full response control immediately follows its attribution in the same heading');
  await userCopy.dispatch('click');
  await modelCopy.dispatch('click');
  assert.deepEqual(fixture.copied, [question, answer], 'clipboard contains the original Markdown, not rendered or labeled message text');
  assert.doesNotMatch(fixture.copied[1], /Private chain|text-model|Answered by:|Copy response/);
});

test('Copy feedback restores the original caption and accessibility labels after two seconds, including repeat clicks', async () => {
  const fixture = browser();
  fixture.queue(response('Answer'));
  await fixture.submit('Question');
  const buttons = messageCopyButtons(fixture);
  for (const button of buttons) await button.dispatch('click');
  fixture.advanceTime(1999);
  for (const button of buttons) {
    assert.equal(button.textContent, 'Copied');
    assert.equal(button.attributes.get('aria-label'), 'Copied to clipboard.');
  }
  fixture.advanceTime(1);
  for (const [index, caption] of ['Copy request', 'Copy response'].entries()) {
    assert.equal(buttons[index].textContent, caption);
    assert.equal(buttons[index].title, caption);
    assert.equal(buttons[index].attributes.get('aria-label'), caption);
  }
  assert.equal(fixture.pendingTimers(), 0, 'finished feedback timers release their message references');

  const answerCopy = buttons[1];
  await answerCopy.dispatch('click');
  fixture.advanceTime(1500);
  await answerCopy.dispatch('click');
  fixture.advanceTime(500);
  assert.equal(answerCopy.textContent, 'Copied', 'the first copy cannot reset feedback for a later copy');
  fixture.advanceTime(1499);
  assert.equal(answerCopy.textContent, 'Copied');
  fixture.advanceTime(1);
  assert.equal(answerCopy.textContent, 'Copy response');
  assert.equal(fixture.pendingTimers(), 0);
});

test('Copy keeps image-message text but never includes uploaded image data', async () => {
  const fixture = browser();
  await fixture.select('vision-model');
  await fixture.upload(new ImageFile(PNG));
  fixture.queue(response('Image answer.'));
  await fixture.submit('What does **this image** show?');
  const userCopy = messageCopyButtons(fixture)[0];
  await userCopy.dispatch('click');
  assert.equal(fixture.copied[0], 'What does **this image** show?');
  assert.doesNotMatch(fixture.copied[0], /data:image|base64/);

  await fixture.click('reset');
  await fixture.upload(new ImageFile(PNG));
  fixture.queue(response('Image-only answer.'));
  await fixture.submit();
  const imageOnlyCopy = messageCopyButtons(fixture)[0];
  assert.equal(imageOnlyCopy.disabled, true, 'an image-only user message has no text to copy');
  assert.equal(fixture.copied.length, 1);
});

test('Copy confirms clipboard success and allows retry after denied access without changing chat availability', async () => {
  const fixture = browser();
  fixture.queue(response('Answer with **Markdown**.'));
  await fixture.submit('Question');
  const button = messageCopyButtons(fixture)[1];
  const originalStatus = fixture.get('status').textContent;
  const indicator = fixture.get('state');

  fixture.queueCopy(new Error('Clipboard permission denied.'));
  await button.dispatch('click');
  assert.equal(button.textContent, 'Copy failed');
  assert.equal(button.disabled, false, 'a failed copy can be retried');
  assert.equal(fixture.get('status').textContent, originalStatus);
  assert.equal(indicator.attributes.get('data-state'), 'ready', 'clipboard failure does not mark the model unavailable');
  assert.equal(indicator.classes.has('chat-status-indicator-red'), false);
  fixture.advanceTime(2000);
  assert.equal(button.textContent, 'Copy response', 'failure feedback also expires without requiring a retry');
  assert.equal(button.title, 'Copy response');
  assert.equal(button.attributes.get('aria-label'), 'Copy response');
  await button.dispatch('click');
  assert.equal(button.textContent, 'Copied');
  assert.equal(button.disabled, false);
  assert.deepEqual(fixture.copied, ['Answer with **Markdown**.', 'Answer with **Markdown**.']);
  assert.equal(fixture.calls.length, 1, 'copying does not send requests to the model');
});

test('Copy reads the latest partial and completed streaming answer and excludes streamed reasoning', async () => {
  const fixture = browser({ streaming: true });
  const firstChunk = deferred();
  const secondChunk = deferred();
  let readCount = 0;
  const encode = (payload) => Uint8Array.from(Buffer.from(`data: ${JSON.stringify(payload)}\n\n`));
  fixture.queue({
    ok: true, status: 200, redirected: false,
    headers: { get: () => 'text/event-stream' },
    body: { getReader: () => ({
      read() { readCount += 1; return readCount === 1 ? firstChunk.promise : secondChunk.promise; },
      async cancel() {},
      releaseLock() {}
    }) }
  });
  const sending = fixture.submit('Show code.');
  await waitForCalls(fixture, 1);
  const button = messageCopyButtons(fixture)[1];
  assert.equal(button.disabled, true, 'the initial ellipsis is not copied as answer text');
  firstChunk.resolve({ done: false, value: encode({ choices: [{ delta: { content: '# Example\n\n', reasoning_content: 'Private streamed reasoning.' } }] }) });
  await waitForText(fixture, '# Example');
  assert.equal(button.disabled, false);
  await button.dispatch('click');
  assert.deepEqual(fixture.copied, ['# Example\n\n']);

  const finalChunk = `${Buffer.from(encode({ choices: [{ delta: { content: '```java\nint a = 3;\n```' }, finish_reason: 'stop' }] })).toString()}data: [DONE]\n\n`;
  secondChunk.resolve({ done: false, value: Uint8Array.from(Buffer.from(finalChunk)) });
  await sending;
  assert.equal(messageCopyButtons(fixture)[1], button, 'the answer keeps the same full-message button as it streams');
  await button.dispatch('click');
  assert.equal(fixture.copied[1], '# Example\n\n```java\nint a = 3;\n```');
  assert.doesNotMatch(fixture.copied[1], /Private streamed reasoning|Reasoning|text-model/);
});

test('compacting and Reset discard old message Copy controls with the old transcript', async () => {
  const fixture = browser();
  const question = 'Old goals '.repeat(100);
  const answer = 'Old answer '.repeat(200);
  fixture.queue(response(answer));
  await fixture.submit(question);
  const oldButtons = messageCopyButtons(fixture);
  assert.equal(oldButtons.length, 2);
  await oldButtons[1].dispatch('click');
  fixture.advanceTime(1999);
  fixture.queue(response('Retained goal: continue this project.'));
  await fixture.click('compact');
  assert.equal(messageCopyButtons(fixture).length, 0, 'the summary replaces the old visible message controls');
  assert.equal(summaryCards(fixture).length, 1);
  const compactedText = fixture.get('messages').textContent;
  fixture.advanceTime(1);
  assert.equal(fixture.get('messages').textContent, compactedText, 'expired feedback on detached controls cannot redraw compacted messages');
  assert.equal(fixture.pendingTimers(), 0);
  fixture.queue(response('Latest answer'));
  await fixture.submit('Continue');
  const latestButtons = messageCopyButtons(fixture);
  assert.equal(latestButtons.length, 2);
  assert.ok(latestButtons.every((button) => !oldButtons.includes(button)));
  await latestButtons[1].dispatch('click');
  assert.deepEqual(fixture.copied, [answer, 'Latest answer']);
  await fixture.click('reset');
  fixture.advanceTime(2000);
  assert.equal(messageCopyButtons(fixture).length, 0);
  assert.match(fixture.get('messages').textContent, /Start a conversation/);
  assert.equal(fixture.pendingTimers(), 0, 'Reset does not leave long-lived feedback timers');
});

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
  assert.equal(fixture.get('messages').children.length, 3, 'the summary replaces the old exchange before appending the new one');
  assert.equal(summaryCards(fixture).length, 1);
  assert.match(fixture.get('messages').textContent, /Retained goal\./);
  assert.match(fixture.get('messages').textContent, /Pending message/);
  assert.match(fixture.get('messages').textContent, /Next answer/);
  assert.doesNotMatch(fixture.get('messages').textContent, /uuuu|aaaa/);
});

test('automatic compaction replaces older exchanges while keeping the two most recent exchanges visible', async () => {
  const fixture = browser();
  const oldestQuestion = 'Old project instructions '.repeat(2500);
  const oldestAnswer = 'Old answer '.repeat(400);
  const recent = ['Recent question one '.repeat(20), 'Recent answer one '.repeat(20), 'Recent question two '.repeat(20), 'Recent answer two '.repeat(20)];
  fixture.queue(response(oldestAnswer));
  await fixture.submit(oldestQuestion);
  fixture.queue(response(recent[1]));
  await fixture.submit(recent[0]);
  fixture.queue(response(recent[3]));
  await fixture.submit(recent[2]);
  fixture.queue(response('Summary of the oldest project instructions.'));
  fixture.queue(response('Latest answer'));
  const pending = 'Latest question '.repeat(400);
  await fixture.submit(pending);
  assert.equal(fixture.calls.length, 5);
  assert.equal(fixture.calls[3].body.compact, true);
  assert.deepEqual(fixture.calls[3].body.messages.map((message) => message.content), [oldestQuestion.trim(), oldestAnswer]);
  assert.deepEqual(fixture.calls[4].body.messages.map((message) => message.content), [...recent.map((message, index) => index % 2 === 0 ? message.trim() : message), pending.trim()]);
  assert.equal(fixture.get('messages').children.length, 7, 'one summary replaces the old exchange, with two retained and one new exchange');
  assert.equal(summaryCards(fixture).length, 1);
  const visible = fixture.get('messages').textContent;
  assert.match(visible, /Summary of the oldest project instructions/);
  assert.doesNotMatch(visible, /Old project instructions|Old answer/);
  for (const message of recent) assert.ok(visible.includes(message.trim()));
  assert.match(visible, /Latest question|Latest answer/);
});

test('failed automatic compaction preserves the original context and pending draft for retry', async () => {
  const fixture = smallBrowser();
  fixture.queue(response('a'.repeat(1200)));
  await fixture.submit('u'.repeat(2000));
  const before = fixture.get('messages').textContent;
  const beforeNodes = [...fixture.get('messages').children];
  const pending = 'Pending message '.repeat(6);
  fixture.queue(response('Summary provider unavailable.', { status: 503 }));
  await fixture.submit(pending);
  assert.equal(fixture.calls.length, 2, 'the pending message is not sent after a failed summary');
  assert.equal(fixture.get('input').value, pending);
  assert.match(fixture.get('status').textContent, /Summary provider unavailable/);
  assert.doesNotMatch(fixture.get('messages').textContent, /Pending message/);
  assert.equal(fixture.get('messages').textContent, before, 'a failed summary leaves the visible old exchange unchanged');
  assert.deepEqual(fixture.get('messages').children, beforeNodes, 'a failed summary does not rebuild or replace the old DOM');
  assert.equal(summaryCards(fixture).length, 0);
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
  assert.doesNotMatch(fixture.get('messages').textContent, /uuuu/, 'only the summarized prefix is removed from the visible transcript');
  assert.match(fixture.get('messages').textContent, /Retained original goal/);
  assert.match(fixture.get('messages').textContent, /aaaa/);
  assert.equal(fixture.get('messages').children.length, 4, 'the summary, unsummarized answer and latest exchange remain visible');
});

test('multiple fitting compaction passes carry each prefix and commit only after enough context is freed', async () => {
  const fixture = smallBrowser();
  const original = 'u'.repeat(4200);
  const answer = 'a'.repeat(4600);
  fixture.queue(response(answer));
  await fixture.submit(original);
  const originalNodes = [...fixture.get('messages').children];
  const first = deferred();
  const second = deferred();
  fixture.queue(first.promise);
  fixture.queue(second.promise);
  fixture.queue(response('Continuation after all necessary summaries.'));
  const sending = fixture.submit('Continue');
  await waitForCalls(fixture, 2);
  assert.deepEqual(fixture.calls[1].body.messages, [{ role: 'user', content: original }]);
  const firstProgress = compactionCards(fixture)[0].textContent;
  first.resolve(response('Retained original goal.'));
  await waitForCalls(fixture, 3);
  assert.equal(fixture.calls[2].body.compact, true, 'a prefix-only summary still above 65% needs another pass');
  assert.equal(fixture.calls[2].body.summary, 'Retained original goal.');
  assert.deepEqual(fixture.calls[2].body.messages, [{ role: 'assistant', content: answer }], 'the unsummarized answer is included in the next fitting request');
  assert.equal(fixture.get('input').value, 'Continue');
  assert.equal(summaryCards(fixture).length, 0, 'an intermediate summary is not committed');
  assert.ok(originalNodes.every((node) => fixture.get('messages').children.includes(node)));
  assert.equal(compactionCards(fixture).length, 1);
  assert.notEqual(compactionCards(fixture)[0].textContent, firstProgress, 'progress reflects the additional summarization pass');
  second.resolve(response('Retained original goal and the complete answer.'));
  await sending;
  assert.equal(fixture.calls.length, 4);
  assert.equal(fixture.calls[3].body.compact, false);
  assert.equal(fixture.calls[3].body.summary, 'Retained original goal and the complete answer.');
  assert.deepEqual(fixture.calls[3].body.messages, [{ role: 'user', content: 'Continue' }]);
  assert.equal(compactionCards(fixture).length, 0);
  assert.equal(summaryCards(fixture).length, 1);
  assert.doesNotMatch(fixture.get('messages').textContent, /uuuu|aaaa/);
});

test('a later compaction-pass failure rolls back all summaries and permits a complete retry', async () => {
  const fixture = smallBrowser();
  const original = 'u'.repeat(4200);
  const answer = 'a'.repeat(4600);
  fixture.queue(response(answer));
  await fixture.submit(original);
  const before = fixture.get('messages').textContent;
  const beforeNodes = [...fixture.get('messages').children];
  fixture.queue(response('Intermediate retained goal.'));
  fixture.queue(response('Second summary service unavailable.', { status: 503 }));
  await fixture.submit('Continue');
  assert.equal(fixture.calls.length, 3, 'a failed later pass prevents the pending ordinary message');
  assert.equal(fixture.calls[2].body.summary, 'Intermediate retained goal.');
  assert.deepEqual(fixture.calls[2].body.messages, [{ role: 'assistant', content: answer }]);
  assert.equal(fixture.get('messages').textContent, before);
  assert.deepEqual(fixture.get('messages').children, beforeNodes);
  assert.equal(summaryCards(fixture).length, 0);
  assert.equal(compactionCards(fixture).length, 0);
  assert.equal(fixture.get('input').value, 'Continue');
  assert.match(fixture.get('status').textContent, /Second summary service unavailable/);
  fixture.advanceTime(1800);
  await settle();
  assert.equal(fixture.calls.length, 3, 'the failure is not retried automatically with unchanged context');

  fixture.queue(response('Intermediate retained goal.'));
  fixture.queue(response('Retained complete conversation.'));
  fixture.queue(response('Continuation'));
  await fixture.submit();
  assert.deepEqual(fixture.calls[3].body, fixture.calls[1].body, 'retry starts from the full original context');
  assert.deepEqual(fixture.calls[4].body, fixture.calls[2].body);
  assert.equal(fixture.calls[5].body.summary, 'Retained complete conversation.');
  assert.deepEqual(fixture.calls[5].body.messages, [{ role: 'user', content: 'Continue' }]);
});

test('Reset during a later compaction pass cannot restore old context or finish a fresh request', async () => {
  const fixture = smallBrowser();
  fixture.queue(response('a'.repeat(4600)));
  await fixture.submit('u'.repeat(4200));
  const oldId = fixture.calls[0].body.conversation_id;
  const lateSummary = deferred();
  fixture.queue(response('Intermediate old goal.'));
  fixture.queue(lateSummary.promise);
  const oldSending = fixture.submit('Old continuation');
  await waitForCalls(fixture, 3);
  assert.equal(fixture.calls[2].body.compact, true);
  assert.equal(fixture.calls[2].body.summary, 'Intermediate old goal.');
  await fixture.click('reset');
  assert.equal(compactionCards(fixture).length, 0);
  assert.equal(fixture.calls[2].signal.aborted, true);
  const freshAnswer = deferred();
  fixture.queue(freshAnswer.promise);
  const freshSending = fixture.submit('Fresh goal');
  await waitForCalls(fixture, 4);
  assert.notEqual(fixture.calls[3].body.conversation_id, oldId);
  lateSummary.resolve(response('Late complete old summary.'));
  await oldSending;
  assert.equal(fixture.get('send').disabled, true, 'the fresh request remains busy after the old operation settles');
  assert.equal(fixture.get('stop').hidden, false);
  assert.equal(summaryCards(fixture).length, 0);
  assert.doesNotMatch(fixture.get('messages').textContent, /Old continuation|Intermediate old goal|Late complete old summary|uuuu|aaaa/);
  freshAnswer.resolve(response('Fresh answer'));
  await freshSending;
  fixture.queue(response('Next fresh answer'));
  await fixture.submit('Keep going');
  assert.equal(fixture.calls[4].body.summary, '');
  assert.deepEqual(fixture.calls[4].body.messages.map((message) => message.content), ['Fresh goal', 'Fresh answer', 'Keep going']);
});

test('compaction has a bounded pass count and preserves the entire transcript when the bound is insufficient', async () => {
  const fixture = browser({ models: [
    { id: 'large-model', limit: { context: 32768, output: 4096 }, capabilities: { image: false } },
    { id: 'small-model', limit: { context: 2048, output: 256 }, capabilities: { image: false } }
  ] });
  for (let turn = 0; turn < 10; turn += 1) {
    fixture.queue(response(`${turn}${'a'.repeat(1999)}`));
    await fixture.submit(`${turn}${'u'.repeat(1999)}`);
  }
  assert.equal(fixture.calls.length, 10);
  const before = fixture.get('messages').textContent;
  const beforeNodes = [...fixture.get('messages').children];
  await fixture.select('small-model');
  for (let pass = 0; pass < 9; pass += 1) fixture.queue(response(`Retained goals through pass ${pass}.`));
  await fixture.click('compact');
  assert.equal(fixture.calls.length, 18, 'compaction stops after eight summary requests');
  assert.ok(fixture.calls.slice(10).every((call) => call.body.compact));
  assert.match(fixture.get('status').textContent, /8 passes/);
  assert.equal(fixture.get('messages').textContent, before);
  assert.deepEqual(fixture.get('messages').children, beforeNodes);
  assert.equal(summaryCards(fixture).length, 0);
  assert.equal(compactionCards(fixture).length, 0);
  fixture.advanceTime(1800);
  await settle();
  assert.equal(fixture.calls.length, 18, 'the exhausted attempt cannot restart automatically');
});

test('truncated or content-filtered summaries cannot replace the original conversation', async (context) => {
  for (const finishReason of ['length', 'content_filter']) {
    await context.test(finishReason, async () => {
      const fixture = browser();
      const original = 'Original goal '.repeat(30);
      const answer = 'Original answer '.repeat(80);
      fixture.queue(response(answer));
      await fixture.submit(original);
      const before = fixture.get('messages').textContent;
      const beforeNodes = [...fixture.get('messages').children];
      await fixture.draft('Preserve this unsent draft');
      fixture.queue(response('A short but incomplete summary.', { finishReason }));
      await fixture.click('compact');
      assert.equal(fixture.get('messages').textContent, before);
      assert.deepEqual(fixture.get('messages').children, beforeNodes);
      assert.equal(summaryCards(fixture).length, 0);
      assert.equal(compactionCards(fixture).length, 0);
      assert.equal(fixture.get('input').value, 'Preserve this unsent draft');
      assert.equal(fixture.get('status').classes.has('chat-status-error'), true);
      fixture.queue(response('Continued without the incomplete summary.'));
      await fixture.submit();
      assert.equal(fixture.calls[2].body.summary, '');
      assert.deepEqual(fixture.calls[2].body.messages.map((message) => message.content), [original.trim(), answer, 'Preserve this unsent draft']);
    });
  }
});

test('summary-request usage cannot inflate ordinary conversation calibration', async () => {
  const fixture = browser();
  fixture.queue(response('Original answer '.repeat(80)));
  await fixture.submit('Original goal '.repeat(30));
  fixture.queue(response('Retained goal.', { usage: { prompt_tokens: 999999, completion_tokens: 5 } }));
  await fixture.click('compact');
  assert.equal(summaryCards(fixture).length, 1, 'large summary-request overhead does not make a valid summary fail');
  assert.ok(compactPercent(fixture) > 95);
  const draft = 'n'.repeat(8000);
  await fixture.draft(draft);
  assert.ok(compactPercent(fixture) > 0, 'summary usage cannot force ordinary drafts to an artificial zero');
  fixture.advanceTime(600);
  await settle();
  assert.equal(fixture.calls.length, 2);
  fixture.queue(response('Ordinary continuation'));
  await fixture.submit();
  assert.equal(fixture.calls[2].body.compact, false);
  assert.equal(fixture.calls[2].body.summary, 'Retained goal.');
  assert.deepEqual(fixture.calls[2].body.messages, [{ role: 'user', content: draft }]);
});

test('a non-reducing summary keeps the conversation and draft instead of replacing context', async () => {
  const fixture = browser();
  fixture.queue(response('Useful answer '.repeat(30)));
  await fixture.submit('Original user goal '.repeat(20));
  const before = fixture.get('messages').textContent;
  const beforeNodes = [...fixture.get('messages').children];
  await fixture.draft('Unsent draft');
  fixture.queue(response('An unnecessarily long summary '.repeat(200)));
  await fixture.click('compact');
  assert.equal(fixture.get('input').value, 'Unsent draft');
  assert.match(fixture.get('status').textContent, /did not free enough/);
  assert.equal(fixture.get('messages').textContent, before);
  assert.deepEqual(fixture.get('messages').children, beforeNodes, 'a non-reducing summary leaves the visible DOM unchanged');
  assert.equal(summaryCards(fixture).length, 0);
  fixture.queue(response('Next response'));
  await fixture.submit();
  assert.equal(fixture.calls[2].body.summary, '');
  assert.deepEqual(fixture.calls[2].body.messages.map((message) => message.content), ['Original user goal '.repeat(20).trim(), 'Useful answer '.repeat(30), 'Unsent draft']);
});

test('an oversized unsent draft rejects compaction before any summary request is billed', async () => {
  const fixture = smallBrowser();
  fixture.queue(response('Original answer'));
  await fixture.submit('Original goal');
  const before = fixture.get('messages').textContent;
  const beforeNodes = [...fixture.get('messages').children];
  const oversized = 'd'.repeat(6000);
  await fixture.draft(oversized);
  await fixture.click('compact');
  assert.equal(fixture.calls.length, 1, 'a summary cannot make a draft that alone exceeds the hard input budget fit');
  assert.equal(fixture.get('input').value, oversized);
  assert.equal(fixture.get('messages').textContent, before);
  assert.deepEqual(fixture.get('messages').children, beforeNodes);
  assert.equal(compactionCards(fixture).length, 0);
  assert.equal(summaryCards(fixture).length, 0);
  assert.match(fixture.get('status').textContent, /message is too large.*Shorten it.*conversation is unchanged/i);
  assert.equal(fixture.get('status').classes.has('chat-status-error'), true);
  fixture.advanceTime(600);
  await settle();
  assert.equal(fixture.calls.length, 1, 'unchanged invalid drafts do not trigger a billed automatic retry');
  fixture.queue(response('Continued original conversation'));
  await fixture.submit('Shortened draft');
  assert.equal(fixture.calls[1].body.compact, false);
  assert.equal(fixture.calls[1].body.summary, '');
  assert.deepEqual(fixture.calls[1].body.messages.map((message) => message.content), ['Original goal', 'Original answer', 'Shortened draft']);
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

test('manual compaction removes image nodes and replaces their exchange with a text summary', async () => {
  const fixture = browser();
  await fixture.select('vision-model');
  await fixture.upload(new ImageFile(PNG));
  fixture.queue(response('The picture shows the original design.'));
  await fixture.submit('Describe this image.');
  assert.equal(imageCount(fixture), 1);
  fixture.queue(response('Retained visual detail: the original design is blue.'));
  await fixture.click('compact');
  assert.equal(fixture.calls[1].body.compact, true);
  assert.equal(imageCount(fixture), 0, 'compacted images are no longer retained as visible DOM nodes');
  assert.equal(summaryCards(fixture).length, 1);
  assert.equal(fixture.get('messages').children.length, 1);
  assert.match(fixture.get('messages').textContent, /Retained visual detail/);
  assert.doesNotMatch(fixture.get('messages').textContent, /Describe this image|The picture shows/);
  await fixture.select('text-model');
  fixture.queue(response('Text-only continuation.'));
  await fixture.submit('Continue using the retained design.');
  assert.equal(fixture.calls[2].body.summary, 'Retained visual detail: the original design is blue.');
  assert.equal(fixture.calls[2].body.messages.length, 1, 'summarized images do not remain in model context');
});

test('historical image limits trigger compaction before the token threshold is reached', async () => {
  const fixture = browser({ imageLimits: { maxImages: 1, maxImageBytes: 4096, maxTotalImageBytes: 8192 } });
  await fixture.select('vision-model');
  await fixture.upload(new ImageFile(PNG));
  fixture.queue(response('First image description.'));
  await fixture.submit();
  assert.equal(imageCount(fixture), 1);
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
  assert.equal(imageCount(fixture), 1, 'the old image node is removed when its exchange is summarized');
  assert.equal(fixture.get('messages').children.length, 3);
  assert.equal(summaryCards(fixture).length, 1);
  assert.match(fixture.get('messages').textContent, /Retained first image|Second image description/);
  assert.doesNotMatch(fixture.get('messages').textContent, /First image description/);
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
