(() => {
  const number = new Intl.NumberFormat();
  const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

  for (const container of document.querySelectorAll('[data-usage-chart]')) {
    const canvas = container.querySelector('canvas');
    const tooltip = container.querySelector('[data-chart-tooltip]');
    if (!canvas || !tooltip) continue;

    let context;
    let rows;
    try {
      context = canvas.getContext('2d');
      const data = JSON.parse(container.dataset.usage || '[]');
      rows = Array.isArray(data) ? data.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date)).map((row) => ({
        date: row.date,
        calls: Math.max(0, Number(row.calls) || 0),
        tokens: Math.max(0, Number(row.tokens) || 0)
      })).filter((row) => Number.isFinite(row.calls) && Number.isFinite(row.tokens)) : [];
    } catch {
      continue; // The adjacent data table remains available if the chart cannot render.
    }
    if (!context || !rows.length) continue;

    const description = 'Daily token usage for the last 15 days, UTC. Use left and right arrow keys to inspect each day.';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', description);
    tooltip.setAttribute('role', 'status');
    tooltip.setAttribute('aria-live', 'polite');

    let active = -1;
    let width = 0;
    let height = 0;
    let plot;
    let frame = null;
    const peak = Math.max(...rows.map((row) => row.tokens));
    const rawStep = (peak || 4) / 4;
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const step = [1, 2, 5, 10].find((value) => value * magnitude >= rawStep) * magnitude;
    const maximum = Math.max(4, step * 4);
    const tickStep = maximum / 4;

    function showTooltip() {
      if (active < 0 || !plot) {
        tooltip.hidden = true;
        canvas.setAttribute('aria-label', description);
        return;
      }
      const row = rows[active];
      const detail = `${row.date} UTC · ${number.format(row.tokens)} tokens · ${number.format(row.calls)} successful calls`;
      tooltip.textContent = detail;
      tooltip.hidden = false;
      canvas.setAttribute('aria-label', detail);

      const canvasBounds = canvas.getBoundingClientRect();
      const containerBounds = container.getBoundingClientRect();
      const center = canvasBounds.left - containerBounds.left + plot.left + (active + 0.5) * plot.slot;
      const barTop = canvasBounds.top - containerBounds.top + plot.bottom - (row.tokens / maximum) * plot.height;
      const tipWidth = tooltip.offsetWidth;
      const tipHeight = tooltip.offsetHeight;
      tooltip.style.left = `${Math.max(4, Math.min(center - tipWidth / 2, containerBounds.width - tipWidth - 4))}px`;
      tooltip.style.top = `${Math.max(4, barTop - tipHeight - 8)}px`;
    }

    function draw() {
      frame = null;
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      if (width < 100 || height < 100) return;
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.font = '12px system-ui, sans-serif';
      const left = Math.max(42, context.measureText(compact.format(maximum)).width + 14);
      const top = 18;
      const bottom = height - 36;
      const right = width - 20;
      plot = { left, top, bottom, right, height: bottom - top, slot: (right - left) / rows.length };

      context.textAlign = 'right';
      context.textBaseline = 'middle';
      for (let tick = 0; tick <= 4; tick++) {
        const y = bottom - (tick / 4) * plot.height;
        context.strokeStyle = '#e2e8f0';
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(right, y);
        context.stroke();
        context.fillStyle = '#64748b';
        context.fillText(compact.format(tick * tickStep), left - 8, y);
      }

      const barWidth = Math.max(1, Math.min(36, plot.slot * 0.7));
      for (let index = 0; index < rows.length; index++) {
        const center = left + (index + 0.5) * plot.slot;
        const barHeight = (rows[index].tokens / maximum) * plot.height;
        if (index === active) {
          context.fillStyle = '#eff6ff';
          context.fillRect(left + index * plot.slot, top, plot.slot, plot.height);
        }
        context.fillStyle = index === active ? '#1d4ed8' : '#3b82f6';
        context.fillRect(center - barWidth / 2, bottom - barHeight, barWidth, barHeight);
        if (index === active) {
          context.strokeStyle = '#1d4ed8';
          context.lineWidth = 2;
          context.strokeRect(center - barWidth / 2 - 2, bottom - barHeight - 2, barWidth + 4, barHeight + 4);
        }
      }

      // Keep date labels readable on narrow cards while always labelling the last day.
      const labelStride = Math.max(1, Math.ceil(44 / plot.slot));
      const labels = [];
      for (let index = 0; index < rows.length - 1; index += labelStride) labels.push(index);
      if (labels.length && (rows.length - 1 - labels[labels.length - 1]) * plot.slot < 40) labels.pop();
      labels.push(rows.length - 1);
      context.fillStyle = '#64748b';
      context.textAlign = 'center';
      context.textBaseline = 'top';
      for (const index of labels) {
        const date = rows[index].date;
        context.fillText(`${date.slice(8)}/${date.slice(5, 7)}`, left + (index + 0.5) * plot.slot, bottom + 10);
      }
      if (peak === 0) {
        context.fillStyle = '#64748b';
        context.textBaseline = 'middle';
        context.fillText('No tokens recorded in this period', left + (right - left) / 2, top + plot.height / 2, right - left - 16);
      }
      showTooltip();
    }

    function scheduleDraw() {
      if (frame === null) frame = window.requestAnimationFrame(draw);
    }

    function select(index) {
      if (active === index) return;
      active = index;
      scheduleDraw();
    }

    function inspectPointer(event) {
      if (!plot) return;
      const bounds = canvas.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      select(x >= plot.left && x <= plot.right && y >= plot.top && y <= plot.bottom
        ? Math.min(rows.length - 1, Math.floor((x - plot.left) / plot.slot)) : -1);
    }
    canvas.addEventListener('pointermove', inspectPointer);
    canvas.addEventListener('click', inspectPointer);
    canvas.addEventListener('pointerleave', () => select(-1));
    canvas.addEventListener('focus', () => select(rows.length - 1));
    canvas.addEventListener('blur', () => select(-1));
    canvas.addEventListener('keydown', (event) => {
      const actions = {
        ArrowLeft: () => Math.max(0, (active < 0 ? rows.length : active) - 1),
        ArrowRight: () => Math.min(rows.length - 1, active + 1),
        Home: () => 0,
        End: () => rows.length - 1,
        Escape: () => -1
      };
      if (!actions[event.key]) return;
      event.preventDefault();
      select(actions[event.key]());
    });

    if (typeof ResizeObserver === 'function') new ResizeObserver(scheduleDraw).observe(container);
    window.addEventListener('resize', scheduleDraw);
    draw();
  }
})();
