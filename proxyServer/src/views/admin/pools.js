// Markup of the admin pages for pools.
const { tokens } = require('../../routes/admin/shared');
const { html, joinHtml } = require('../../utils/html');

function poolStatus(providerViews) {
  const warning = (text) => html`<span class="pool-status pool-warning"><span aria-hidden="true">⚠</span> ${text}</span>`;
  if (!providerViews.length) return warning('No providers');
  if (!providerViews.some((provider) => provider.serving)) return warning('No provider is serving');
  const limiting = providerViews.filter((provider) => provider.limits.length).length;
  if (limiting) return warning(`${limiting} not aligned`);
  return html`<span class="pool-status pool-ok"><span aria-hidden="true">✓</span> All aligned</span>`;
}

function poolOfferTable(offer) {
  if (!offer) return html`<p class="muted">Students see no model under this alias: no enabled provider with an enabled model mapping is ticked.</p>`;
  const { capabilities } = offer;
  const yesNo = (value) => (value ? 'Yes' : 'No');
  const reasoning = !capabilities.reasoning ? 'No'
    : !capabilities.reasoningEffortsKnown ? 'Yes, levels managed by the provider'
      : capabilities.reasoningEfforts.length ? html`Yes: ${joinHtml(capabilities.reasoningEfforts, ', ')}${capabilities.defaultReasoningEffort ? html` (default ${capabilities.defaultReasoningEffort})` : ''}`
        : 'Yes, no selectable level';
  const rows = [
    ['Context window', tokens(offer.context)],
    ['Maximum output', tokens(offer.output)],
    ['Text input', yesNo(capabilities.text)],
    ['Image input', capabilities.image ? (capabilities.maxImages === null ? 'Yes' : `Yes, up to ${capabilities.maxImages} per request`) : 'No'],
    ['Tool calling', capabilities.tools ? (capabilities.parallelTools ? 'Yes, with parallel calls' : 'Yes, one call at a time') : 'No'],
    ['Reasoning', reasoning],
    ['Chat template overrides', yesNo(capabilities.chatTemplateKwargs)]
  ];
  return html`
    <table class="pool-offer">
      <tbody>${joinHtml(rows.map(([label, value]) => html`<tr><th scope="row">${label}</th><td>${value}</td></tr>`))}</tbody>
    </table>
  `;
}

function poolProvidersTable(providerViews) {
  const rows = joinHtml(providerViews.map((provider) => html`
    <tr>
      <td>
        <a href="/admin/providers/${provider.id}"><strong>${provider.name}</strong></a><br>
        <span class="muted">${provider.slug}</span>
      </td>
      <td>${provider.model.upstream_model ? html`<code>${provider.model.upstream_model}</code>` : html`<span class="muted">none</span>`}</td>
      <td>${provider.serving
        ? html`<span class="status-enabled">Serving</span>`
        : html`<span class="status-disabled">Not serving</span><br><span class="muted">${provider.idle}</span>`}</td>
      <td>${!provider.serving ? html`<span class="muted">—</span>`
        : provider.limits.length
          ? html`<span class="alignment-status alignment-warning"><span aria-hidden="true">⚠</span> Not aligned</span><ul class="pool-limits">${joinHtml(provider.limits.map((note) => html`<li>${note}</li>`))}</ul>`
          : html`<span class="alignment-status alignment-ok"><span aria-hidden="true">✓</span> Aligned</span>`}</td>
    </tr>
  `));
  return html`
    <div class="provider-pool-table">
      <table>
        <thead><tr><th>Provider</th><th>Upstream model</th><th>Status</th><th>Alignment</th></tr></thead>
        <tbody>${rows || html`<tr><td colspan="4" class="muted">No providers in this pool.</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

function poolAliasTakenNotice(alias, owner) {
  return html`
    <div class="error">
      The alias <code>${alias}</code> is already used by <a href="/admin/pools/${owner.id}">another pool</a>.
      Nothing was saved. Choose a different alias.
    </div>
  `;
}

function poolForm(pool = {}, action = '/admin/pools', providers = []) {
  const selected = new Set((pool.providers || []).map((provider) => Number(provider.id)));
  return html`
    <form method="post" action="${action}" class="panel">
      <h2>Pool settings</h2>
      <label>OpenCode model alias <span class="muted" style="display:block;font-weight:400">The model name students see. Requests for it are balanced across the providers ticked below.</span></label>
      <input name="alias" value="${pool.alias}" required>
      <label>Balanced providers <span class="muted" style="display:block;font-weight:400">A provider can be in several pools. Its concurrency limit is shared between them.</span></label>
      <div class="checkbox-list">
        ${providers.length ? joinHtml(providers.map((provider) => html`
          <label>
            <input name="provider_ids" type="checkbox" value="${provider.id}" style="width:auto" ${selected.has(Number(provider.id)) ? 'checked' : ''}>
            ${provider.name} (${provider.slug})
            ${provider.model.upstream_model ? html`<span class="muted">${provider.model.upstream_model}</span>` : html`<span class="muted">No active mapping</span>`}
            ${provider.enabled ? '' : html`<span class="muted">disabled</span>`}
            ${provider.otherPools.length ? html`<span class="muted">· also in ${joinHtml(provider.otherPools.map((other) => other.alias), ', ')}</span>` : ''}
          </label>
        `)) : html`<p class="muted">No providers configured.</p>`}
      </div>
      <div class="form-actions">
        <div class="actions">
          <button type="submit">Save pool</button>
          <a class="button secondary" href="/admin/pools">Cancel</a>
        </div>
        ${pool.id ? html`<button type="submit" form="pool-delete-${pool.id}" class="danger">Delete pool</button>` : ''}
      </div>
    </form>
  `;
}

function poolPageView({ pool, saved, providerViews, groups, providers, offer }) {
  return html`
      <div class="provider-sections">
        ${poolForm(pool, saved ? `/admin/pools/${saved.id}` : '/admin/pools', providers)}
        ${saved ? html`
          <form id="pool-delete-${saved.id}" method="post" action="/admin/pools/${saved.id}/delete" onsubmit="return confirm(${JSON.stringify(`Delete the pool ${saved.alias}? ${groups.length ? `Students in ${groups.map((group) => group.name).join(', ')} will lose this model. ` : ''}Its providers are not deleted.`)});"></form>
          <div class="panel">
            <h2>What students see</h2>
            <p class="muted">Computed from the serving providers below: the smallest limits, and only the capabilities all of them have. Capabilities are set on each provider.</p>
            ${poolOfferTable(offer)}
          </div>
          <div class="panel">
            <h2>Alignment ${poolStatus(providerViews)}</h2>
            <p class="muted">A provider is not aligned when it offers less than another provider of this pool, which lowers what students see. To fix it, run Autoconfigure on that provider or untick it here.</p>
            ${poolProvidersTable(providerViews)}
          </div>
          <div class="panel">
            <h2>Groups using this pool</h2>
            ${groups.length
              ? html`<ul>${joinHtml(groups.map((group) => html`<li><a href="/admin/groups/${group.id}">${group.name}</a></li>`))}</ul>`
              : html`<p class="muted">No group can use this pool yet. Tick it on a group's page.</p>`}
          </div>
        ` : ''}
      </div>
    `;
}

function poolsPage({ pools }) {
  const rows = joinHtml(pools.map((pool) => {
    const { providerViews } = pool;
    return html`
      <tr>
        <td><a href="/admin/pools/${pool.id}"><code>${pool.alias}</code></a></td>
        <td>${providerViews.length
          ? joinHtml(providerViews.map((provider) => html`<a href="/admin/providers/${provider.id}">${provider.name}</a>${provider.serving ? '' : html` <span class="muted">(${provider.idle.toLowerCase()})</span>`}`), html`<br>`)
          : html`<span class="muted">none</span>`}</td>
        <td>${poolStatus(providerViews)}</td>
        <td>${pool.group_count}</td>
        <td><a class="button secondary" href="/admin/pools/${pool.id}">Edit</a></td>
      </tr>
    `;
  }));
  return html`
      <div class="provider-list-heading">
        <div>
          <p class="muted">A pool publishes a set of providers to students under one model alias and balances requests between them. Groups choose which pools their students can use.</p>
        </div>
        <a class="button" href="/admin/pools/new">Add pool</a>
      </div>
      <div class="provider-pool-table">
        <table>
          <thead><tr><th>OpenCode model alias</th><th>Balanced providers</th><th>Alignment</th><th>Groups</th><th>Actions</th></tr></thead>
          <tbody>${rows || html`<tr><td colspan="5" class="muted">No pools.</td></tr>`}</tbody>
        </table>
      </div>
    `;
}

module.exports = {
  poolAliasTakenNotice,
  poolForm,
  poolOfferTable,
  poolPageView,
  poolProvidersTable,
  poolStatus,
  poolsPage
};
