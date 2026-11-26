// Markup of the admin pages for groups.
const { html, joinHtml } = require('../../utils/html');

function limitValue(value) {
  return value === null || value === undefined ? '' : value;
}

// Keeps the pool list of the group form in order while it is being edited: ticked pools
// first, in the order chosen with the arrows, and the first of them marked as the default.
// The form sends ticked pools top to bottom, and that order is what gets saved. Without
// this script the form still saves, in the order shown.
const POOL_ORDER_SCRIPT = html`
  <script>
    (() => {
      for (const list of document.querySelectorAll('[data-pool-order]')) {
        const rows = () => [...list.querySelectorAll('[data-pool-row]')];
        const ticked = (row) => row.querySelector('input[type="checkbox"]').checked;
        const refresh = () => {
          const chosen = rows().filter(ticked);
          for (const row of rows()) {
            const position = chosen.indexOf(row);
            row.querySelector('[data-pool-default]').hidden = position !== 0;
            row.querySelector('[data-pool-moves]').hidden = position === -1 || chosen.length < 2;
            row.querySelector('[data-pool-up]').disabled = position <= 0;
            row.querySelector('[data-pool-down]').disabled = position === chosen.length - 1;
          }
        };
        list.addEventListener('change', (event) => {
          const row = event.target.closest('[data-pool-row]');
          if (!row) return;
          // A newly ticked pool goes after the other ticked ones; an unticked one drops below them.
          const others = rows().filter((other) => other !== row && ticked(other));
          const last = others.at(-1);
          if (last) last.after(row); else list.prepend(row);
          refresh();
        });
        list.addEventListener('click', (event) => {
          const button = event.target.closest('[data-pool-up], [data-pool-down]');
          if (!button) return;
          const row = button.closest('[data-pool-row]');
          const chosen = rows().filter(ticked);
          const position = chosen.indexOf(row);
          const up = button.hasAttribute('data-pool-up');
          const neighbour = chosen[position + (up ? -1 : 1)];
          if (!neighbour) return;
          if (up) neighbour.before(row); else neighbour.after(row);
          refresh();
          (button.disabled ? row.querySelector('button:not(:disabled)') : button)?.focus();
        });
        refresh();
      }
    })();
  </script>
`;

function groupForm(group = {}, action = '/admin/groups', pools = []) {
  // Ticked pools first, in the group's order; the rest below, as listed (by alias).
  const order = new Map((group.pool_ids || []).map((poolId, index) => [Number(poolId), index]));
  const chosen = pools.filter((pool) => order.has(pool.id)).sort((left, right) => order.get(left.id) - order.get(right.id));
  const ordered = [...chosen, ...pools.filter((pool) => !order.has(pool.id))];
  return html`
    <form method="post" action="${action}" class="panel">
      <label>Name</label><input name="name" value="${group.name}" required>
      <label>Pools <span class="muted" style="display:block;font-weight:400">Students in this group can use the model alias of each ticked pool, in this order: the first one is their default model. Pools are managed on the <a href="/admin/pools">Pools</a> page.</span></label>
      <div class="checkbox-list pool-order" data-pool-order>
        ${ordered.length ? joinHtml(ordered.map((pool) => {
          const position = chosen.indexOf(pool);
          return html`
          <div class="pool-order-row" data-pool-row>
          <label>
            <input name="pool_ids" type="checkbox" value="${pool.id}" style="width:auto" ${position !== -1 ? 'checked' : ''}>
            <code>${pool.alias}</code>
            <span class="muted">${pool.providers.length ? joinHtml(pool.providers.map((provider) => html`${provider.name}${provider.enabled ? '' : ' (disabled)'}`), ', ') : 'no providers'}</span>
          </label>
          <span class="pool-default" data-pool-default ${position === 0 ? '' : 'hidden'}>Default</span>
          <span class="pool-moves" data-pool-moves ${position === -1 || chosen.length < 2 ? 'hidden' : ''}>
            <button type="button" class="secondary small" data-pool-up aria-label="Move ${pool.alias} up" title="Move up" ${position <= 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="secondary small" data-pool-down aria-label="Move ${pool.alias} down" title="Move down" ${position === chosen.length - 1 ? 'disabled' : ''}>↓</button>
          </span>
          </div>
        `;
        })) : html`<p class="muted">No pools configured.</p>`}
      </div>
      ${ordered.length ? POOL_ORDER_SCRIPT : ''}
      <label>Calls per day</label><input name="daily_call_limit" type="number" min="0" value="${limitValue(group.daily_call_limit)}" placeholder="Unlimited">
      <label>Tokens per day</label><input name="daily_token_limit" type="number" min="0" value="${limitValue(group.daily_token_limit)}" placeholder="Unlimited">
      <label>Calls per hour</label><input name="hourly_call_limit" type="number" min="0" value="${limitValue(group.hourly_call_limit)}" placeholder="Unlimited">
      <label>Tokens per hour</label><input name="hourly_token_limit" type="number" min="0" value="${limitValue(group.hourly_token_limit)}" placeholder="Unlimited">
      <p><button type="submit">Save group</button> <a class="button secondary" href="/admin/groups">Cancel</a></p>
    </form>
  `;
}

function groupNameTakenNotice(name, owner) {
  return html`
    <div class="error">
      The name ${name} is already used by <a href="/admin/groups/${owner.id}">another group</a>.
      Nothing was saved. Choose a different name.
    </div>
  `;
}

// Lists a group's pools by alias, each with the providers that serve it.
function groupPoolsSummary(pools) {
  if (!pools.length) return html`<span class="muted">none</span>`;
  return joinHtml(pools.map((pool) => html`
    <div class="group-provider-model">
      <a href="/admin/pools/${pool.id}"><code>${pool.alias}</code></a>
      ${pool.providers.length ? html`<ul>
        ${joinHtml(pool.providers
          .toSorted((left, right) => String(left.name || left.slug).localeCompare(String(right.name || right.slug)))
          .map((provider) => html`<li><a href="/admin/providers/${provider.id}">${provider.name || provider.slug}</a>${provider.enabled ? '' : html` <span class="muted">(disabled)</span>`}</li>`))}
      </ul>` : html`<span class="muted">no providers</span>`}
    </div>
  `));
}

function groupsPage({ groups }) {
  const rows = joinHtml(groups.map((group) => {
    return html`
      <tr>
        <td><a href="/admin/groups/${group.id}">${group.name}</a></td>
        <td>${groupPoolsSummary(group.pools)}</td>
        <td>${group.daily_call_limit ?? html`<span class="muted">unlimited</span>`} / ${group.hourly_call_limit ?? html`<span class="muted">unlimited</span>`}</td>
        <td>${group.daily_token_limit ?? html`<span class="muted">unlimited</span>`} / ${group.hourly_token_limit ?? html`<span class="muted">unlimited</span>`}</td>
        <td>${group.userCount}</td>
        <td><a class="button secondary" href="/admin/groups/${group.id}">Edit</a></td>
      </tr>
    `;
  }));
  return html`
      <p><a class="button" href="/admin/groups/new">Create group</a></p>
      <table><thead><tr><th>Name</th><th>Pools</th><th>Calls day/hour</th><th>Tokens day/hour</th><th>Users</th><th>Actions</th></tr></thead><tbody>${rows || html`<tr><td colspan="6" class="muted">No groups.</td></tr>`}</tbody></table>
    `;
}

// group is the stored group; formGroup is what the form shows, which differs from it only
// when a refused submission is being shown again.
function groupPage({ formGroup, group, pools, users }) {
  const userRows = joinHtml(users.map((user) => html`
    <tr>
      <td><a href="/admin/users/${user.id}">${user.name}</a></td>
      <td>${user.email}</td>
      <td>${user.enabled ? 'enabled' : 'disabled'}</td>
      <td class="actions">
        <form method="post" action="/admin/groups/${group.id}/members/${user.id}/remove" onsubmit="return confirm(${JSON.stringify(`Remove ${user.name} from ${group.name}? They will lose API access until they are assigned to another group.`)});">
          <button type="submit" class="danger-outline small">Remove</button>
        </form>
      </td>
    </tr>
  `));
  return html`
      ${groupForm(formGroup, `/admin/groups/${group.id}`, pools)}
      <h2>Users</h2>
      <table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Actions</th></tr></thead><tbody>${userRows || html`<tr><td colspan="4" class="muted">No users in this group.</td></tr>`}</tbody></table>
    `;
}

module.exports = {
  groupForm,
  groupNameTakenNotice,
  groupPage,
  groupPoolsSummary,
  groupsPage,
  limitValue
};
