// Markup of the admin page for server settings.
const { html } = require('../../utils/html');

function serverPage({ cleanupStatus, defaultConcurrentRequests, retentionDays, settings }) {
  const content = html`
    <div class="server-sections">
      <form method="post" action="/admin/server" class="panel">
        <h2>Server settings</h2>
        <label>Public base URL. Leave empty to use the current request host.</label><input name="public_base_url" value="${settings.public_base_url || ''}" placeholder="https://subdomain.example.com">
        <label>Default daily token limit</label><input name="default_daily_token_limit" type="number" value="${settings.default_daily_token_limit}">
        <label>OpenCode model context limit</label><input name="default_model_context_limit" type="number" value="${settings.default_model_context_limit}">
        <label>OpenCode model output limit</label><input name="default_model_output_limit" type="number" value="${settings.default_model_output_limit}">
        <label>Max output tokens per request</label><input name="max_tokens_per_request" type="number" value="${settings.max_tokens_per_request}">
        <label>Max image bytes</label><input name="max_image_bytes" type="number" value="${settings.max_image_bytes}">
        <label>Max total image bytes</label><input name="max_total_image_bytes" type="number" value="${settings.max_total_image_bytes}">
        <label><input name="allow_video_input" type="checkbox" value="true" style="width:auto" ${settings.allow_video_input === 'true' ? 'checked' : ''}> Allow video input</label>
        <label>Max requests per minute</label><input name="max_requests_per_minute" type="number" value="${settings.max_requests_per_minute}">
        <label>Max concurrent requests per user</label><input name="max_concurrent_requests_per_user" type="number" min="1" value="${settings.max_concurrent_requests_per_user || defaultConcurrentRequests}">
        <label><input name="maintenance_mode" type="checkbox" value="true" style="width:auto" ${settings.maintenance_mode === 'true' ? 'checked' : ''}> Maintenance mode</label>
        <p><button>Save server settings</button></p>
      </form>
      <section class="panel">
        <h2>Usage log cleanup</h2>
        <p class="muted">Deletes usage/error records older than ${retentionDays} days, checkpoints the WAL, and runs VACUUM.</p>
        <p>Last cleanup: ${cleanupStatus.lastRunAt ? cleanupStatus.lastRunAt : html`<span class="muted">never</span>`}</p>
        <form method="post" action="/admin/server/cleanup-usage" onsubmit="return window.confirm('Clean usage logs older than ' + this.retention_days.value + ' days and compact the SQLite database?');">
          <label>Days to keep</label><input id="cleanup-retention-days" name="retention_days" type="number" min="1" value="${retentionDays}">
          <p><button class="danger">Clean logs older than <span id="cleanup-retention-label">${retentionDays}</span> days</button></p>
        </form>
      </section>
    </div>
    <script>
      (function () {
        const input = document.getElementById('cleanup-retention-days');
        const label = document.getElementById('cleanup-retention-label');
        if (!input || !label) return;
        input.addEventListener('input', () => {
          label.textContent = input.value || '${retentionDays}';
        });
      })();
    </script>
  `;
  return content;
}

module.exports = {
  serverPage
};
