(() => {
  'use strict';

  const DEFAULT_HARNESS_TOKENS = 512;
  const DEFAULT_IMAGE_TOKENS = 2048;
  const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const finitePositive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

  function estimateTextTokens(text) {
    return Math.ceil(String(text || '').length / 4);
  }

  function estimateMessageTokens(message, imageTokens = DEFAULT_IMAGE_TOKENS) {
    let tokens = 8 + estimateTextTokens(message.reasoning_content);
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text') tokens += estimateTextTokens(part.text);
        else if (part.type === 'image_url') tokens += imageTokens;
      }
    } else {
      tokens += estimateTextTokens(message.content);
    }
    return tokens;
  }

  function estimateContextTokens(messages, summary = '', imageTokens = DEFAULT_IMAGE_TOKENS) {
    return messages.reduce((total, message) => total + estimateMessageTokens(message, imageTokens), 0)
      + (summary ? 8 + estimateTextTokens(summary) : 0);
  }

  function getBudget(model, config = {}) {
    const context = Math.floor(finitePositive(model?.limit?.context, 32768));
    const reserve = Math.max(1, Math.min(
      Math.floor(finitePositive(model?.limit?.output, 4096)),
      Math.floor(finitePositive(config.maxOutputTokens, 4096)),
      Math.max(1, Math.floor(context / 4))
    ));
    const harness = Math.floor(finitePositive(config.harnessTokens, DEFAULT_HARNESS_TOKENS));
    return { context, reserve, harness, input: Math.max(0, context - reserve - harness) };
  }

  function hasImages(messages) {
    return messages.some((message) => Array.isArray(message.content)
      && message.content.some((part) => part.type === 'image_url'));
  }

  function imageUsage(messages) {
    let count = 0;
    let bytes = 0;
    for (const message of messages) {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part.type !== 'image_url') continue;
        count += 1;
        const data = String(part.image_url?.url || '').split(',')[1] || '';
        bytes += Math.max(0, Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0));
      }
    }
    return { count, bytes };
  }

  function imagesFit(messages, limits) {
    if (!limits) return true;
    const usage = imageUsage(messages);
    return usage.count <= limits.count && usage.bytes <= limits.total;
  }

  // Only complete recent turns survive a summary; a small conversation can be summarized in full.
  function chooseCompaction(messages, summary, pending, inputBudget, imageTokens = DEFAULT_IMAGE_TOKENS, calibration = 1, imageLimits = null) {
    let retain = messages.length > 4 ? 4 : 0;
    while (retain > 0) {
      const recent = messages.slice(-retain);
      const pendingMessages = pending ? [...recent, pending] : recent;
      if (estimateContextTokens(pendingMessages, '', imageTokens) * calibration < inputBudget * 0.45
        && imagesFit(pendingMessages, imageLimits)) break;
      retain -= 2;
    }
    let cut = messages.length - retain;
    // A reply can push retained context above the input budget. Summarize a fitting
    // prefix and keep every unsummarized message rather than sending an oversized call.
    let fitting = 0;
    for (let index = 0; index < cut; index += 1) {
      if (estimateContextTokens(messages.slice(0, index + 1), summary, imageTokens) * calibration > inputBudget) break;
      fitting = index + 1;
    }
    cut = fitting;
    return { older: messages.slice(0, cut), recent: messages.slice(cut), summary };
  }

  function parseSSEFrame(frame) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return null;
    if (data.trim() === '[DONE]') return { done: true };
    return { data: JSON.parse(data) };
  }

  function imageSignatureMatches(bytes, type) {
    if (type === 'image/png') return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (type === 'image/webp') return bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70
      && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
    return false;
  }

  const helpers = { estimateTextTokens, estimateMessageTokens, estimateContextTokens, getBudget, hasImages, imageUsage, imagesFit, chooseCompaction, parseSSEFrame, imageSignatureMatches };
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  if (typeof window !== 'undefined') window.IETIChat = Object.freeze(helpers);
  if (typeof document === 'undefined') return;

  const configNode = document.getElementById('portal-chat-config');
  if (!configNode) return;
  let config;
  try { config = JSON.parse(configNode.textContent); } catch { return; }
  const byId = (id) => document.getElementById(id);
  const ui = {
    model: byId('chat-model'), reset: byId('chat-reset'), compact: byId('chat-compact'),
    messages: byId('chat-messages'), form: byId('chat-form'), input: byId('chat-input'),
    images: byId('chat-images'), attachments: byId('chat-attachments'), send: byId('chat-send'),
    stop: byId('chat-stop'), status: byId('chat-status'), budget: byId('chat-budget')
  };
  if (Object.values(ui).some((element) => !element)) return;
  const imageUpload = byId('chat-image-upload');
  const imageUploadButton = byId('chat-upload');
  const models = Array.isArray(config.models) ? config.models : [];
  const imageTokens = finitePositive(config.imageTokens, DEFAULT_IMAGE_TOKENS);
  const ratio = Math.min(0.95, Math.max(0.1, finitePositive(config.autoCompactRatio, 0.65)));
  const imageLimits = {
    count: Math.floor(finitePositive(config.imageLimits?.maxImages, 4)),
    each: finitePositive(config.imageLimits?.maxImageBytes, 4 * 1024 * 1024),
    total: finitePositive(config.imageLimits?.maxTotalImageBytes, 8 * 1024 * 1024)
  };
  const calibration = new Map();
  const number = new Intl.NumberFormat();
  let context = [];
  let transcript = [];
  let summary = '';
  let attachments = [];
  let generation = 0;
  let busy = false;
  let uploadsInFlight = 0;
  let controller = null;

  if (!ui.model.options.length) {
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name || model.id;
      ui.model.append(option);
    }
  }

  const selectedModel = () => models.find((model) => model.id === ui.model.value) || models[0];
  const projection = (messages, currentSummary = summary, model = selectedModel()) => Math.ceil(
    estimateContextTokens(messages, currentSummary, imageTokens) * (calibration.get(model?.id) || 1)
  );

  function status(text, isError = false) {
    ui.status.textContent = text;
    ui.status.classList.toggle('chat-status-error', isError);
  }

  function pendingMessage(text = ui.input.value, images = attachments) {
    return {
      role: 'user',
      content: images.length
        ? [...(text.trim() ? [{ type: 'text', text: text.trim() }] : []), ...images.map((image) => ({ type: 'image_url', image_url: { url: image.data, detail: 'auto' } }))]
        : text.trim()
    };
  }

  function updateControls() {
    const model = selectedModel();
    const unsupportedImages = model?.capabilities?.image !== true && hasImages(context);
    ui.model.disabled = busy || uploadsInFlight > 0;
    ui.input.disabled = busy || !model;
    ui.images.disabled = busy || uploadsInFlight > 0 || !model || model.capabilities?.image !== true;
    if (imageUploadButton) imageUploadButton.disabled = ui.images.disabled;
    if (imageUpload) imageUpload.hidden = !model || model.capabilities?.image !== true;
    ui.images.setAttribute('aria-describedby', 'chat-status');
    ui.compact.disabled = busy || uploadsInFlight > 0 || !(context.length || summary) || unsupportedImages;
    ui.send.disabled = busy || uploadsInFlight > 0 || !model || unsupportedImages || !(ui.input.value.trim() || attachments.length);
    ui.stop.hidden = !busy;
    ui.stop.disabled = !busy;
    const budget = getBudget(model, config);
    const hasPending = Boolean(ui.input.value.trim() || attachments.length);
    const estimate = projection(hasPending ? [...context, pendingMessage()] : context);
    ui.budget.textContent = model
      ? `Approx. ${number.format(estimate)} / ${number.format(budget.input)} input tokens · Auto compact at ${Math.round(ratio * 100)}%`
      : 'No active models are available.';
    ui.budget.classList.toggle('chat-budget-full', estimate > budget.input);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  function renderMarkdown(node, text) {
    if (!window.marked?.parse || !window.DOMPurify?.sanitize) {
      node.textContent = text;
      return;
    }
    const renderer = new window.marked.Renderer();
    renderer.html = (token) => escapeHtml(typeof token === 'string' ? token : token.text || '');
    const html = window.marked.parse(text, { gfm: true, breaks: true, renderer });
    node.innerHTML = window.DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 's', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'hr'],
      ALLOWED_ATTR: ['href', 'title', 'start'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false
    });
    for (const link of node.querySelectorAll('a')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }

  function contentText(content) {
    return Array.isArray(content) ? content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : String(content || '');
  }

  function nearBottom() {
    return ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 120;
  }

  function drawMessage(message) {
    const follow = nearBottom();
    if (!message.node) {
      const article = document.createElement('article');
      article.className = `chat-message chat-message-${message.role}`;
      const label = document.createElement('div');
      label.className = 'chat-message-label';
      label.textContent = message.role === 'assistant' ? (message.model || 'Assistant') : message.role === 'user' ? 'You' : 'Chat';
      const body = document.createElement('div');
      body.className = message.role === 'assistant' ? 'chat-markdown' : 'chat-user-content';
      article.append(label, body);
      if (message.role === 'assistant') {
        const details = document.createElement('details');
        details.className = 'chat-reasoning';
        details.hidden = true;
        const heading = document.createElement('summary');
        heading.textContent = 'Reasoning';
        const reasoning = document.createElement('pre');
        details.append(heading, reasoning);
        article.insertBefore(details, body);
        message.reasoningNode = reasoning;
        message.reasoningDetails = details;
      }
      if (message.role === 'user' && Array.isArray(message.content)) {
        const images = document.createElement('div');
        images.className = 'chat-message-images';
        for (const part of message.content.filter((part) => part.type === 'image_url')) {
          const image = document.createElement('img');
          image.src = part.image_url.url;
          image.alt = 'Uploaded image';
          images.append(image);
        }
        article.append(images);
      }
      message.node = article;
      message.body = body;
      ui.messages.append(article);
    }
    const text = contentText(message.content);
    if (message.role === 'assistant') {
      renderMarkdown(message.body, text || (message.reasoning_content ? '' : '…'));
      message.reasoningDetails.hidden = !message.reasoning_content;
      message.reasoningNode.textContent = message.reasoning_content || '';
    } else {
      message.body.textContent = text;
    }
    if (follow) ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  function renderTranscript() {
    ui.messages.replaceChildren();
    if (!transcript.length) {
      const empty = document.createElement('p');
      empty.className = 'chat-empty';
      empty.textContent = 'Start a conversation with one of your active models. Messages remain only in this page until you reset or reload it.';
      ui.messages.append(empty);
    } else {
      for (const message of transcript) {
        delete message.node;
        delete message.body;
        drawMessage(message);
      }
    }
  }

  function renderAttachments() {
    ui.attachments.replaceChildren();
    attachments.forEach((attachment, index) => {
      const card = document.createElement('div');
      card.className = 'chat-attachment';
      const image = document.createElement('img');
      image.src = attachment.data;
      image.alt = attachment.name;
      const name = document.createElement('span');
      name.textContent = attachment.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary';
      remove.textContent = 'Remove';
      remove.disabled = busy;
      remove.setAttribute('aria-label', `Remove ${attachment.name}`);
      remove.addEventListener('click', () => {
        attachments.splice(index, 1);
        renderAttachments();
        updateControls();
      });
      card.append(image, name, remove);
      ui.attachments.append(card);
    });
  }

  function requestMessages(messages) {
    return messages.map((message) => ({ role: message.role, content: message.content, ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) }));
  }

  async function post(body, signal) {
    const response = await fetch('/portal/chat/completions', {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': config.csrfToken },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      let message = `Chat request failed (${response.status}).`;
      try {
        const error = await response.json();
        message = error.error?.message || error.message || message;
      } catch { /* Use the HTTP status when a proxy returns another body format. */ }
      throw new Error(message);
    }
    if (response.redirected || response.headers.get('content-type')?.includes('text/html')) {
      throw new Error('Your session has expired. Sign in again to continue.');
    }
    return response;
  }

  function calibrate(usage, messages, currentSummary, model) {
    const reported = Number(usage?.prompt_tokens);
    if (!Number.isFinite(reported) || reported <= 0) return;
    const estimated = estimateContextTokens(messages, currentSummary, imageTokens) + getBudget(model, config).harness;
    calibration.set(model.id, Math.max(calibration.get(model.id) || 1, reported / Math.max(1, estimated)));
  }

  async function compactConversation(model, signal, operation, pending = null) {
    if (!(context.length || summary)) return false;
    const budget = getBudget(model, config);
    const split = chooseCompaction(context, summary, pending, budget.input, imageTokens, calibration.get(model.id) || 1, imageLimits);
    if (!split.older.length && !summary) {
      throw new Error('The oldest message is too large to summarize with this model. Choose a model with a larger context or use Reset. Your conversation is unchanged.');
    }
    if (projection(split.older, summary, model) > budget.input) {
      throw new Error('The previous summary exceeds this model’s context budget. Choose a model with a larger context or use Reset.');
    }
    status('Summarizing conversation…');
    const response = await post({ model: model.id, messages: requestMessages(split.older), summary, compact: true, stream: false }, signal);
    const result = await response.json();
    if (operation !== generation) return false;
    if (result.error) throw new Error(result.error.message || 'The conversation could not be summarized.');
    const nextSummary = result.choices?.[0]?.message?.content;
    if (typeof nextSummary !== 'string' || !nextSummary.trim()) throw new Error('The model returned an empty summary. Your previous conversation is unchanged.');
    calibrate(result.usage, split.older, summary, model);
    const candidate = nextSummary.trim();
    const previousTokens = projection(context, summary, model);
    const nextTokens = projection(split.recent, candidate, model);
    const nextWithPending = projection(pending ? [...split.recent, pending] : split.recent, candidate, model);
    if (nextTokens >= previousTokens || nextWithPending > budget.input
      || !imagesFit(pending ? [...split.recent, pending] : split.recent, imageLimits)) {
      throw new Error('The summary did not free enough context. Your conversation is unchanged; shorten your message or use Reset.');
    }
    summary = candidate;
    context = split.recent;
    updateControls();
    return true;
  }

  async function consumeStream(response, assistant, operation, model, requestContext, requestSummary) {
    if (!response.body?.getReader) throw new Error('This browser cannot read streaming responses.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    let finishedChoice = false;
    const consumeFrame = (frame) => {
      const event = parseSSEFrame(frame);
      if (!event) return;
      if (event.done) { done = true; return; }
      const payload = event.data;
      if (payload.error) throw new Error(payload.error.message || 'The model could not finish its response.');
      const choice = payload.choices?.[0];
      const delta = choice?.delta || {};
      if (typeof delta.content === 'string') assistant.content += delta.content;
      if (typeof delta.reasoning_content === 'string') assistant.reasoning_content += delta.reasoning_content;
      if (choice?.finish_reason) finishedChoice = true;
      calibrate(payload.usage, requestContext, requestSummary, model);
      if (operation === generation) drawMessage(assistant);
    };
    try {
      while (!done) {
        const part = await reader.read();
        if (operation !== generation) return;
        buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
        // CRLF and LF can both be split across network chunks.
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          consumeFrame(frame);
          if (done) break;
        }
        if (buffer.length > 1024 * 1024) throw new Error('The streaming response contained an oversized event.');
        if (part.done) {
          if (!done && buffer.trim()) consumeFrame(buffer);
          if (!done && !finishedChoice) throw new Error('The connection ended before the response finished.');
          break;
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* Abort and already-closed streams need no further action. */ }
      reader.releaseLock();
    }
  }

  function beginOperation() {
    busy = true;
    controller = new AbortController();
    generation += 1;
    updateControls();
    renderAttachments();
    return { operation: generation, signal: controller.signal };
  }

  function finishOperation(operation) {
    if (operation !== generation) return;
    busy = false;
    controller = null;
    renderAttachments();
    updateControls();
    ui.input.focus();
  }

  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const model = selectedModel();
    if (busy || uploadsInFlight || !model || !(ui.input.value.trim() || attachments.length)) return;
    if (model.capabilities?.image !== true && (attachments.length || hasImages(context))) {
      status('This conversation contains images. Choose a model with vision or use Reset before selecting a text-only model.', true);
      return;
    }
    const draft = ui.input.value;
    const draftImages = attachments.slice();
    const user = pendingMessage(draft, draftImages);
    const { operation, signal } = beginOperation();
    let assistant;
    let sent = false;
    try {
      const budget = getBudget(model, config);
      if (!imagesFit([user], imageLimits)) throw new Error('This message has too many images or exceeds the total image upload limit. Remove an image before sending.');
      if ((context.length || summary) && (projection([...context, user], summary, model) >= budget.input * ratio
        || !imagesFit([...context, user], imageLimits))) {
        await compactConversation(model, signal, operation, user);
      }
      if (operation !== generation) return;
      if (projection([...context, user], summary, model) > budget.input) {
        throw new Error('This message is too large for the selected model’s context. Shorten it, remove images, or use Reset.');
      }
      if (!imagesFit([...context, user], imageLimits)) throw new Error('The conversation contains too many images. Use Compact or Reset before sending another image.');
      context.push(user);
      transcript.push(user);
      ui.input.value = '';
      attachments = [];
      renderAttachments();
      assistant = { role: 'assistant', content: '', reasoning_content: '', model: model.id };
      transcript.push(assistant);
      renderTranscript();
      sent = true;
      status('Generating response…');
      const requestContext = context.slice();
      const requestSummary = summary;
      const response = await post({ model: model.id, messages: requestMessages(requestContext), summary: requestSummary, compact: false, stream: config.streaming === true }, signal);
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        await consumeStream(response, assistant, operation, model, requestContext, requestSummary);
      } else {
        const result = await response.json();
        if (operation !== generation) return;
        if (result.error) throw new Error(result.error.message || 'The model could not finish its response.');
        const message = result.choices?.[0]?.message;
        assistant.content = typeof message?.content === 'string' ? message.content : '';
        assistant.reasoning_content = typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';
        calibrate(result.usage, requestContext, requestSummary, model);
        drawMessage(assistant);
      }
      if (operation !== generation) return;
      if (!assistant.content && !assistant.reasoning_content) throw new Error('The model returned an empty response.');
      context.push(assistant);
      status('Ready.');
    } catch (error) {
      if (operation !== generation) return;
      const partial = Boolean(assistant?.content || assistant?.reasoning_content);
      if (sent && partial) {
        context.push(assistant);
      } else if (sent) {
        context = context.filter((message) => message !== user);
        transcript = transcript.filter((message) => message !== user && message !== assistant);
        ui.input.value = draft;
        attachments = draftImages;
        renderTranscript();
      }
      status(signal.aborted ? (partial ? 'Response stopped.' : 'Stopped. Your message is ready to send again.') : error.message || 'The request failed.', !signal.aborted);
    } finally {
      finishOperation(operation);
    }
  });

  ui.compact.addEventListener('click', async () => {
    const model = selectedModel();
    if (busy || uploadsInFlight || !model || !(context.length || summary)) return;
    if (model.capabilities?.image !== true && hasImages(context)) {
      status('Choose a model with vision to summarize this conversation, or use Reset.', true);
      return;
    }
    const { operation, signal } = beginOperation();
    try {
      const pending = ui.input.value.trim() || attachments.length ? pendingMessage() : null;
      await compactConversation(model, signal, operation, pending);
      if (operation === generation) status('Conversation compacted. The transcript stays visible; future messages use the summary and recent exchanges.');
    } catch (error) {
      if (operation === generation) status(signal.aborted ? 'Compaction stopped. Your conversation is unchanged.' : error.message || 'Compaction failed. Your conversation is unchanged.', !signal.aborted);
    } finally {
      finishOperation(operation);
    }
  });

  ui.stop.addEventListener('click', () => controller?.abort());
  ui.reset.addEventListener('click', () => {
    generation += 1;
    controller?.abort();
    controller = null;
    busy = false;
    uploadsInFlight = 0;
    context = [];
    transcript = [];
    summary = '';
    attachments = [];
    ui.input.value = '';
    ui.images.value = '';
    renderTranscript();
    renderAttachments();
    status('Conversation reset.');
    updateControls();
    ui.input.focus();
  });
  ui.model.addEventListener('change', () => {
    const model = selectedModel();
    if (model?.capabilities?.image !== true) {
      const removed = attachments.length;
      attachments = [];
      ui.images.value = '';
      renderAttachments();
      status(hasImages(context)
        ? 'This conversation contains images. Choose a model with vision or use Reset to chat with this model.'
        : removed ? 'Pending images removed: this model does not support vision.' : 'Ready.');
    } else {
      status('Ready. Image uploads are available for this model.');
    }
    updateControls();
  });
  ui.input.addEventListener('input', updateControls);
  imageUploadButton?.addEventListener('click', () => {
    if (!ui.images.disabled) ui.images.click();
  });

  function readDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.onabort = () => reject(new Error('Image upload cancelled.'));
      reader.readAsDataURL(file);
    });
  }

  ui.images.addEventListener('change', async () => {
    if (busy || selectedModel()?.capabilities?.image !== true) { ui.images.value = ''; return; }
    const files = Array.from(ui.images.files || []);
    ui.images.value = '';
    if (!files.length) return;
    const operation = generation;
    uploadsInFlight += 1;
    updateControls();
    try {
      for (const file of files) {
        if (operation !== generation) return;
        if (!ALLOWED_IMAGE_TYPES.has(file.type)) throw new Error('Upload PNG, JPEG, or WebP images only.');
        if (attachments.length >= imageLimits.count) throw new Error(`You can attach up to ${imageLimits.count} images to one message.`);
        if (!file.size || file.size > imageLimits.each) throw new Error(`${file.name} exceeds the ${number.format(Math.floor(imageLimits.each / 1024))} KB image limit.`);
        if (attachments.reduce((total, image) => total + image.bytes, 0) + file.size > imageLimits.total) throw new Error('The selected images exceed the total upload limit.');
        const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
        if (!imageSignatureMatches(bytes, file.type)) throw new Error(`${file.name} is not a valid PNG, JPEG, or WebP image.`);
        const data = await readDataUrl(file);
        if (operation !== generation) return;
        attachments.push({ name: file.name, bytes: file.size, data });
        renderAttachments();
      }
      status('Images ready.');
    } catch (error) {
      if (operation === generation) status(error.message || 'Could not upload this image.', true);
    } finally {
      if (operation === generation) {
        uploadsInFlight -= 1;
        updateControls();
      }
    }
  });

  renderTranscript();
  renderAttachments();
  status(models.length ? 'Ready.' : 'No active models are available for your account.');
  updateControls();
})();
