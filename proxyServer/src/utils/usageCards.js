const { escapeHtml } = require('./html');

function formatUsageNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function dailyUsageCard(rows) {
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const totalCalls = rows.reduce((sum, row) => sum + row.calls, 0);
  return `
    <section class="panel dashboard-card" aria-labelledby="daily-usage-heading">
      <div class="dashboard-card-heading">
        <h2 id="daily-usage-heading">Daily usage</h2>
        <p class="muted">Last 15 days, including today · UTC</p>
      </div>
      <div class="dashboard-usage-totals">
        <span><strong>${formatUsageNumber(totalTokens)}</strong> tokens</span>
        <span><strong>${formatUsageNumber(totalCalls)}</strong> completed or stopped calls</span>
      </div>
      <div class="dashboard-chart" data-usage-chart data-usage="${escapeHtml(JSON.stringify(rows))}">
        <canvas tabindex="0" role="img" aria-label="Daily token usage for the last 15 days, UTC. Use left and right arrow keys to inspect each day." aria-describedby="daily-usage-help">Daily token usage. Exact values are available in the daily usage table below.</canvas>
        <div class="dashboard-chart-tooltip" data-chart-tooltip role="status" hidden></div>
      </div>
      <p class="muted dashboard-chart-help" id="daily-usage-help">Completed requests and stopped generations, including charged failed generations. Reported tokens from retried attempts are included without counting extra calls. Hover, tap, or use arrow keys to inspect a day.</p>
      <details class="dashboard-chart-data">
        <summary>View daily usage table</summary>
        <div class="table-scroll">
          <table>
            <caption class="visually-hidden">Daily completed or stopped usage, UTC</caption>
            <thead><tr><th scope="col">Day (UTC)</th><th scope="col">Calls</th><th scope="col">Tokens</th></tr></thead>
            <tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.date)}</td><td>${formatUsageNumber(row.calls)}</td><td>${formatUsageNumber(row.tokens)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </details>
    </section>
  `;
}

module.exports = { dailyUsageCard, formatUsageNumber };
