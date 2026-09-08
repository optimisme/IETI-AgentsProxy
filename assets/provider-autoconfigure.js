(() => {
  const labels = {
    upstream_model: 'Upstream model', context_limit: 'Context limit', output_limit: 'Output limit',
    supports_text_input: 'Text input', supports_image_input: 'Image input', supports_tools: 'Tool calling',
    supports_reasoning: 'Reasoning', supports_parallel_tools: 'Parallel tools',
    supports_chat_template_kwargs: 'Chat template overrides', reasoning_efforts: 'Reasoning levels',
    default_reasoning_effort: 'Default reasoning level', reasoning_history_field: 'Reasoning history field'
  };
  const capabilities = Object.keys(labels).filter((field) => field.startsWith('supports_'));
  for (const trigger of document.querySelectorAll('button[data-autoconfigure-url]')) {
    const form = trigger.closest('[data-provider-settings-form]');
    const modal = document.getElementById(trigger.dataset.autoconfigureModal);
    if (!form || !modal || modal.dataset.initialized) continue;
    modal.dataset.initialized = 'true';
    const find = (name) => modal.querySelector(`[data-autoconfigure-${name}]`);
    const title = find('title'), status = find('status'), progress = find('progress'), elapsed = find('elapsed');
    const progressBar = progress.querySelector('progress');
    const picker = find('picker'), modelSelect = find('model'), review = find('review');
    const results = find('results'), settingsTable = find('settings'), help = find('help');
    const diagnostics = find('diagnostics'), detail = find('detail');
    const cancel = modal.querySelector('[data-cancel-autoconfigure]');
    const retry = modal.querySelector('[data-retry-autoconfigure]');
    const apply = modal.querySelector('[data-apply-autoconfigure]');
    let controller = null, timer = null, selected = null, preferred = '';

    // Neither Escape nor native light dismissal may discard a running test or its results.
    modal.addEventListener('cancel', (event) => event.preventDefault());
    modal.setAttribute('closedby', 'none');
    const close = () => {
      if (typeof modal.close === 'function') modal.close();
      else modal.removeAttribute('open');
    };
    function stopBusy() {
      clearInterval(timer);
      timer = null;
      progress.hidden = true;
      trigger.disabled = false;
      trigger.textContent = 'Autoconfigure';
      modal.removeAttribute('aria-busy');
      cancel.textContent = 'Cancel';
    }
    cancel.addEventListener('click', () => {
      const pending = controller;
      controller = null;
      pending?.abort();
      stopBusy();
      selected = null;
      close();
      trigger.focus();
    });
    function renderResults(items = [], activeTest = null) {
      results.replaceChildren();
      for (const item of items) {
        const li = document.createElement('li');
        const heading = document.createElement('div');
        heading.className = 'test-heading';
        const name = document.createElement('strong');
        name.textContent = item.name;
        const state = document.createElement('span');
        state.className = `test-state test-${item.status}`;
        state.textContent = ({ supported: 'Passed', unsupported: 'Rejected', inconclusive: 'Needs review' })[item.status] || 'Needs review';
        heading.append(name, state);
        li.append(heading);
        const explanation = document.createElement('p');
        explanation.className = 'muted';
        explanation.textContent = [item.httpStatus ? `HTTP ${item.httpStatus}.` : '', item.message, item.hint].filter(Boolean).join(' ');
        li.append(explanation);
        results.append(li);
      }
      if (activeTest) {
        const li = document.createElement('li');
        li.textContent = `${activeTest} — running…`;
        results.append(li);
      }
    }
    function currentValue(field) {
      if (capabilities.includes(field)) return Number(form.querySelector(`input[type="checkbox"][name="${field}"]`)?.checked);
      if (field === 'reasoning_efforts') return JSON.stringify([...form.querySelectorAll('input[type="checkbox"][name="reasoning_efforts"]:checked')].map((input) => input.value));
      return form.querySelector(`[name="${field}"]`)?.value || null;
    }
    function displayValue(field, value) {
      if (capabilities.includes(field)) return Number(value) ? 'Enabled' : 'Disabled';
      if (field === 'reasoning_efforts') {
        const efforts = typeof value === 'string' ? JSON.parse(value) : value;
        return Array.isArray(efforts) && efforts.length ? efforts.join(', ') : 'No selectable levels';
      }
      if (field === 'reasoning_history_field') return value || 'Forward unchanged';
      if (field === 'default_reasoning_effort') return value || 'Provider default';
      if (field.endsWith('_limit')) return value ? `${Number(value).toLocaleString()} tokens` : 'Server default';
      return String(value ?? 'Not set');
    }
    function renderSettings(model) {
      settingsTable.replaceChildren();
      for (const [field, value] of Object.entries({ upstream_model: model.id, ...model.settings })) {
        if (!Object.hasOwn(labels, field)) continue;
        const row = document.createElement('tr');
        for (const text of [labels[field], displayValue(field, currentValue(field)), displayValue(field, value)]) {
          const cell = document.createElement('td');
          cell.textContent = text;
          row.append(cell);
        }
        settingsTable.append(row);
      }
    }
    function receiveResult(body) {
      stopBusy();
      if (!body.ok) throw new Error(body.detail || body.message || body.error?.message || 'Provider testing failed.');
      const models = Array.isArray(body.models) ? body.models : [];
      selected = models.find((model) => model.id === body.selectedModel) || null;
      modelSelect.replaceChildren();
      if (!selected) {
        const placeholder = document.createElement('option');
        placeholder.textContent = 'Choose a model to test';
        placeholder.value = '';
        placeholder.disabled = placeholder.selected = true;
        modelSelect.append(placeholder);
      }
      for (const model of models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.id;
        option.selected = model.id === selected?.id;
        modelSelect.append(option);
      }
      modelSelect.disabled = false;
      picker.hidden = models.length <= 1 && Boolean(selected);
      detail.textContent = body.detail || '';
      diagnostics.hidden = !detail.textContent;
      if (selected) {
        title.textContent = 'Review detected settings';
        status.textContent = `Tests finished for ${selected.id}. Nothing has been saved yet.`;
        help.textContent = 'Review the detected values below. Apply and save updates this provider; Cancel discards these results.';
        renderSettings(selected);
        renderResults(selected.probes);
        review.hidden = false;
        apply.disabled = false;
        apply.hidden = false;
        apply.focus();
      } else {
        title.textContent = 'Choose a model';
        status.textContent = 'The provider exposes several models. Choose one to test its capabilities.';
        help.textContent = 'Nothing has been changed or saved.';
        modelSelect.focus();
      }
    }
    async function start(model = '') {
      if (controller) return;
      preferred = model;
      selected = null;
      const active = new AbortController();
      controller = active;
      trigger.disabled = true;
      trigger.textContent = 'Testing provider…';
      title.textContent = 'Testing provider';
      status.className = '';
      status.textContent = `Stage 1/${progressBar.max} — Reading the provider model catalog…`;
      progressBar.value = 0;
      progressBar.setAttribute('aria-valuetext', status.textContent);
      help.textContent = 'Nothing has been saved. Cancel stops testing. These small synthetic requests may incur provider charges.';
      progress.hidden = false;
      picker.hidden = review.hidden = diagnostics.hidden = retry.hidden = true;
      apply.disabled = true;
      apply.hidden = true;
      cancel.textContent = 'Cancel testing';
      results.replaceChildren();
      const started = Date.now();
      elapsed.textContent = '0 seconds elapsed';
      timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        elapsed.textContent = `${seconds} ${seconds === 1 ? 'second' : 'seconds'} elapsed`;
      }, 1000);
      if (!modal.open) {
        if (typeof modal.showModal === 'function') modal.showModal();
        else modal.setAttribute('open', '');
      }
      cancel.focus();
      let received = false;
      const event = (body) => {
        if (controller !== active) return;
        if (body.type === 'progress') {
          progressBar.max = body.totalStages;
          progressBar.value = body.completedStages;
          status.textContent = body.activeTest
            ? `Stage ${body.stage}/${body.totalStages} — ${body.activeTest}…`
            : 'Preparing the results…';
          progressBar.setAttribute('aria-valuetext', body.activeTest ? status.textContent
            : `${body.completedStages}/${body.totalStages} stages completed`);
          renderResults(body.results, body.activeTest);
        } else if (body.type === 'result' || body.ok !== undefined || body.error) {
          received = true;
          receiveResult(body);
        }
      };
      try {
        const response = await fetch(trigger.dataset.autoconfigureUrl, {
          method: 'POST', credentials: 'same-origin', signal: active.signal,
          headers: { Accept: 'application/x-ndjson, application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ preferred_model: model || form.querySelector('[name="upstream_model"]')?.value || '',
            base_url: form.querySelector('[name="base_url"]')?.value, apply: false, stream_progress: true })
        });
        if (response.headers.get('content-type')?.includes('application/x-ndjson')) {
          const reader = response.body.getReader(), decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { value, done } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) if (line.trim()) event(JSON.parse(line));
            if (done) { if (buffer.trim()) event(JSON.parse(buffer)); break; }
          }
        } else event(await response.json());
        if (!received && controller === active) throw new Error('The connection ended before testing finished. Nothing has been saved. Try again.');
      } catch (error) {
        if (controller !== active) return;
        title.textContent = 'Testing could not finish';
        status.className = 'error';
        status.textContent = error.message || 'Connection failed. Try again.';
        help.textContent = 'Nothing has been changed or saved. Retry the test or cancel to return to the provider settings.';
        retry.hidden = false;
        apply.disabled = true;
      } finally {
        if (controller === active) { controller = null; stopBusy(); }
      }
    }
    trigger.addEventListener('click', () => start());
    retry.addEventListener('click', () => start(preferred));
    modelSelect.addEventListener('change', () => start(modelSelect.value));
    apply.addEventListener('click', () => {
      if (controller || !selected) return;
      const values = { upstream_model: selected.id, ...selected.settings };
      for (const [field, value] of Object.entries(values)) {
        if (!Object.hasOwn(labels, field)) continue;
        if (field === 'reasoning_efforts') {
          const efforts = JSON.parse(value || '[]');
          form.querySelectorAll('input[type="checkbox"][name="reasoning_efforts"]').forEach((input) => { input.checked = Array.isArray(efforts) && efforts.includes(input.value); });
        } else if (capabilities.includes(field)) {
          const input = form.querySelector(`input[type="checkbox"][name="${field}"]`);
          if (input) input.checked = Boolean(value);
        } else {
          const input = form.querySelector(`[name="${field}"]`);
          if (input) input.value = value ?? '';
        }
      }
      if (!form.checkValidity()) {
        status.className = 'error';
        status.textContent = 'The provider form has missing or invalid fields. Cancel to review those fields before saving. No settings have been saved.';
        return;
      }
      close();
      form.requestSubmit();
    });
  }
})();
