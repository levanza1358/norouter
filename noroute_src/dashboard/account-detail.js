/* ---------------- provider detail ---------------- */

async function loadDetail({ quiet = false } = {}) {
  const id = currentDetailId;
  if (!id) return;

  if (!detail && !quiet) detailState = 'loading';
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      detailError = body.error?.message || `Provider "${id}" is not registered.`;
      detail = null;
      detailState = 'error';
    } else {
      const body = await res.json();
      // Switching providers must not keep the previous pool page, filters or
      // selection around.
      if (!quiet && detail?.provider?.id !== body.provider.id) resetAccountsState();
      detail = body;
      detailError = '';
      detailState = 'ready';
    }
  } catch {
    detailError = 'Could not reach the router. Is the server still running?';
    detailState = 'error';
  }

  if (currentDetailId !== id) return;
  renderDetailPage();

  if (detail) {
    $('pageTitle').textContent = detail.provider.name;
    paintDetailMeta();

    // Polling must not refetch a 1,000-row page every two seconds; reload only
    // when the pool size actually changed.
    const poolChanged = !accounts.data || accounts.data.total !== detail.pool.total;
    if (detailTab === 'accounts' && !accounts.loading && (!quiet || poolChanged)) {
      loadAccounts();
    }
  }
}

// Detail identity lives beside the tabs, not only in the shared #tagline: the
// subtitle then reads prefix → format → models → accounts on its own line and
// never collides with the tab row.
function paintDetailMeta() {
  const host = $('detailMeta');
  if (!host) return;
  if (!detail) {
    host.innerHTML = '';
    $('tagline').textContent = 'Accounts, quota and models for this upstream.';
    return;
  }
  const provider = detail.provider || {};
  const meta = [
    provider.prefix || provider.id,
    provider.format ? `${provider.format} compatible` : '',
    `${provider.models || 0} models`,
    `${detail.pool?.total || 0} accounts`,
  ].filter(Boolean);
  host.innerHTML = meta.map((value, index) => (
    `${index ? '<span class="dmeta-item">' : '<span class="dmeta-chip">'}${escapeHtml(value)}</span>`
  )).join('');
  $('tagline').textContent = '';
}

function renderDetailPage() {
  if (!detail) {
    for (const id of ['dAccounts', 'dModels', 'dUpstreamQuota']) {
      const el = $(id);
      if (el) el.innerHTML = '';
    }
    if ($('dModelCount')) $('dModelCount').textContent = '—';
    if ($('tabAccountCount')) $('tabAccountCount').textContent = '0';
    if ($('tabModelCount')) $('tabModelCount').textContent = '0';
    const save = $('saveStrategy');
    if (save) save.disabled = true;
    detailNote($('strategyNote'), '');
    paintDetailMeta();
    return;
  }

  paintDetailMeta();

  const editProvider = $('editProvider');
  if (editProvider) editProvider.onclick = () => openEditProvider(editProvider);

  const removeProvider = $('removeProvider');
  if (removeProvider) {
    removeProvider.hidden = !detail.provider.customProvider;
    removeProvider.onclick = detail.provider.customProvider
      ? () => removeCurrentProvider(removeProvider)
      : null;
  }

  const menu = $('poolMenu');
  const item = $('poolItemCheckin');
  if (menu) {
    const items = detail?.pool?.items || [];
    const checkin = Boolean(detail.provider.config?.checkin || process.env.CODEBUDDY_CN_CHECKIN_URL?.trim());
    menu.hidden = items.length === 0;
    if (item) item.hidden = !checkin;
  }
  renderDetailAccounts();
  renderDetailModels();
  if (detail?.pool) {
    const items = detail.pool.items || [];
    const checkin = Boolean(detail.provider.config?.checkin || process.env.CODEBUDDY_CN_CHECKIN_URL?.trim());
    const menu = $('poolMenu');
    const item = $('poolItemCheckin');
    if (menu) menu.hidden = items.length === 0;
    if (item) item.hidden = !checkin;
  }
  setDetailTab(detailTab, { silent: true });
}

async function removeCurrentProvider(opener = document.activeElement) {
  if (!currentDetailId || !detail?.provider.customProvider) return;
  const name = detail.provider.name;
  openConfirmation({
    title: 'Remove provider?',
    message: `${name} and its routed models will be removed immediately.`,
    confirmLabel: 'Remove provider',
    danger: true,
    run: async () => {
      try {
        const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}`, { method: 'DELETE' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error?.message || `Request failed (${res.status})`);
        }
        await refresh();
        navigate('/providers');
      } catch (err) { detailNote($('dNote'), err.message, 'bad'); }
    },
  }, opener);
}

/* ---------------- account pool ---------------- */

const ACCOUNT_STATUS = {
  active: ['ok', 'Active'],
  cooldown: ['warn', 'Cooling'],
  error: ['bad', 'Error'],
  disabled: ['quiet', 'Paused'],
};

// All pool state lives here. Rows are paginated server-side, so the DOM never
// holds more than one page even when the pool has thousands of accounts.
const accounts = {
  page: 1,
  pageSize: 20,
  q: '',
  status: 'all',
  data: null,
  loading: false,
  requestId: 0,
  selected: new Set(),
  quota: new Map(),
  quotaLoading: new Set(),
  quotaUnavailable: new Set(),
  busy: new Set(),
};

let detailTab = 'accounts';
const quotaPage = { page: 1, data: null, loading: false, requestId: 0, packagePages: new Map() };
let quotaColumns = Number(localStorage.getItem('norouter.quotaColumns')) || 3;
let searchTimer = null;
let accountModalMode = null;
let accountModalOpener = null;
let accountPreviewPayload = null;
let accountPreviewEntries = null;
const modelTests = new Map();
let modelTestBusy = false;
let codexOAuthTimer = null;

function detailApi(path, options) {
  return fetch(`/api/providers/${encodeURIComponent(currentDetailId)}${path}`, options);
}

function setAccountModal(open, mode = accountModalMode) {
  const modal = $('accountModal');
  if (!modal) return;
  if (!open) {
    clearInterval(codexOAuthTimer);
    codexOAuthTimer = null;
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    accountModalMode = null;
    const opener = accountModalOpener;
    accountModalOpener = null;
    requestAnimationFrame(() => opener?.focus?.());
    accountPreviewPayload = null;
    accountPreviewEntries = null;
    $('accountPreview')?.setAttribute('hidden', '');
    $('bulkEditView')?.removeAttribute('hidden');
    return;
  }

  const nextMode = mode === 'bulk' ? 'bulk' : detail?.provider?.oauth ? 'codex-choice' : 'add';
  if (!accountModalMode) accountModalOpener = document.activeElement;
  accountModalMode = nextMode;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  document.querySelectorAll('.account-modal-view').forEach((view) => {
    view.hidden = view.id !== (nextMode === 'bulk' ? 'bulkPanel' : nextMode === 'codex-choice' ? 'codexAccountChoice' : 'addAccountPanel');
  });
  accountPreviewPayload = null;
  accountPreviewEntries = null;
  $('accountPreview')?.setAttribute('hidden', '');
  $('bulkEditView')?.removeAttribute('hidden');
  const title = $('accountModalTitle');
  const subtitle = $('accountModalSubtitle');
  if (title) title.textContent = nextMode === 'bulk' ? 'Bulk add accounts' : 'Add account';
  if (subtitle) subtitle.textContent = nextMode === 'bulk'
    ? 'Paste a JSON array, wrapper object, or one token per line.'
    : nextMode === 'codex-choice'
      ? 'Choose ChatGPT OAuth or the separate OpenAI API key route.'
      : 'Store an operator-supplied provider credential in the local pool.';
  detailNote($(nextMode === 'bulk' ? 'bulkNote' : 'addAccountNote'), '');
  const focusTarget = nextMode === 'bulk'
    ? $('bulkInput')
    : nextMode === 'codex-choice' ? $('startCodexOAuth') : document.querySelector('#addAccountForm input[name="label"]');
  requestAnimationFrame(() => focusTarget?.focus());
}

function closeAccountModal() {
  setAccountModal(false);
}

function relFuture(ms) {
  const diff = Math.round((ms - Date.now()) / 1000);
  if (diff <= 0) return 'expired';
  if (diff < 3600) return `in ${Math.max(1, Math.ceil(diff / 60))}m`;
  if (diff < 86400) return `in ${Math.floor(diff / 3600)}h`;
  return `in ${Math.floor(diff / 86400)}d`;
}

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function paintPoolCounts(counts) {
  if (!counts) return;
  const map = {
    cAll: counts.total,
    cActive: counts.active,
    cCooldown: counts.cooldown,
    cError: counts.error,
    cDisabled: counts.disabled,
  };
  for (const [id, value] of Object.entries(map)) {
    const el = $(id);
    if (el) el.textContent = fmtFull(value);
  }
  if ($('tabAccountCount')) $('tabAccountCount').textContent = fmtFull(counts.total);
}

function paintFilterChips() {
  document.querySelectorAll('[data-status]').forEach((chip) => {
    chip.classList.toggle('is-active', chip.dataset.status === accounts.status);
  });
}

function resetAccountsState() {
  accounts.page = 1;
  accounts.pageSize = 20;
  accounts.q = '';
  accounts.status = 'all';
  accounts.data = null;
  accounts.selected.clear();
  accounts.quota.clear();
  accounts.quotaLoading.clear();
  accounts.quotaUnavailable.clear();
  accounts.busy.clear();
  quotaPage.page = 1;
  quotaPage.data = null;
  quotaPage.loading = false;
  quotaPage.packagePages.clear();
  quotaPage.requestId += 1;
  modelTests.clear();
  modelTestBusy = false;
  const search = $('accountSearch');
  if (search) search.value = '';
  const size = $('accountPageSize');
  if (size) size.value = '20';
  syncCustomSelects();
  closeAccountModal();
  detailTab = 'accounts';
  strategyDirty = false;
  detailNote($('strategyNote'), '');
  paintStrategy({ force: true });
  paintFilterChips();
  updateBulkBar();
}

function setDetailTab(tab, { silent = false } = {}) {
  detailTab = tab;
  document.querySelectorAll('.dtab[data-tab]').forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.dpanel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });
  moveTabIndicator($('dTabs'));
  if (!silent && tab === 'quota') loadUpstreamQuota();
}

function renderDetailAccounts() {
  paintPoolCounts(detail?.pool);
  if ($('tabAccountCount')) {
    $('tabAccountCount').textContent = fmtFull(detail?.pool?.total || 0);
  }
  paintStrategy();
}

/* ---------------- account strategy ---------------- */

const STRATEGY_INFO = {
  'round-robin': 'Shares requests across active accounts.',
  sequential: 'Uses each active account in order.',
  'highest-quota': 'Uses the account with the most remaining quota.',
};

let strategyDirty = false;

// Polling refreshes the detail payload every few seconds; a pending (unsaved)
// selection must survive that repaint or the control would fight the user.
function paintStrategy({ force = false } = {}) {
  const select = $('accountStrategy');
  if (!select) return;
  const current = detail?.provider?.config?.accountStrategy || 'round-robin';
  if (force || !strategyDirty) {
    if (select.value !== current) select.value = current;
    strategyDirty = false;
  }
  const desc = $('strategyDesc');
  const info = STRATEGY_INFO[select.value] || STRATEGY_INFO['round-robin'];
  if (desc) {
    desc.textContent = info;
    desc.hidden = true;
  }
  const title = document.querySelector('.strategy-title');
  if (title) title.title = info;
  const save = $('saveStrategy');
  if (save) save.disabled = !strategyDirty;
  syncCustomSelects();
}

$('accountStrategy')?.addEventListener('change', () => {
  strategyDirty = true;
  const info = STRATEGY_INFO[$('accountStrategy').value];
  const title = document.querySelector('.strategy-title');
  if (title && info) title.title = info;
  if ($('saveStrategy')) $('saveStrategy').disabled = false;
});

$('saveStrategy')?.addEventListener('click', async () => {
  const select = $('accountStrategy');
  if (!select || !currentDetailId) return;
  const button = $('saveStrategy');
  const note = $('strategyNote');
  button.disabled = true;
  detailNote(note, 'Saving strategy…');
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountStrategy: select.value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    detail = body;
    strategyDirty = false;
    paintStrategy({ force: true });
    paintDetailMeta();
    detailNote(note, `Strategy saved: ${select.selectedOptions[0]?.textContent.trim() || select.value}.`, 'ok');
  } catch (err) {
    detailNote(note, err.message, 'bad');
    button.disabled = false;
  }
});

async function loadAccounts() {
  if (!currentDetailId) return;
  const token = (accounts.requestId += 1);
  accounts.loading = true;

  const params = new URLSearchParams({
    page: String(accounts.page),
    pageSize: String(accounts.pageSize),
    status: accounts.status,
  });
  if (accounts.q) params.set('q', accounts.q);

  try {
    const res = await detailApi(`/accounts?${params}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    if (token !== accounts.requestId) return;
    accounts.data = body;
    renderAccounts();
    loadVisibleQuotas(token, body.items);
  } catch (err) {
    if (token !== accounts.requestId) return;
    detailNote($('accountNote'), err.message, 'bad');
  } finally {
    if (token === accounts.requestId) accounts.loading = false;
  }
}

async function loadVisibleQuotas(requestId, items) {
  const eligible = items.filter((account) => account.status === 'active'
    && !accounts.quota.has(account.id)
    && !accounts.quotaLoading.has(account.id)
    && !accounts.quotaUnavailable.has(account.id));
  const workers = Array.from({ length: Math.min(3, eligible.length) }, async () => {
    while (eligible.length) {
      const account = eligible.shift();
      accounts.quotaLoading.add(account.id);
      renderAccounts();
      try {
        const res = await detailApi(`/accounts/${encodeURIComponent(account.id)}/quota`, { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
        if (requestId !== accounts.requestId || !accounts.data?.items.some((item) => item.id === account.id)) continue;
        accounts.quota.set(account.id, body.quota);
      } catch {
        if (requestId === accounts.requestId) accounts.quotaUnavailable.add(account.id);
      } finally {
        accounts.quotaLoading.delete(account.id);
        if (requestId === accounts.requestId) renderAccounts();
      }
    }
  });
  await Promise.all(workers);
}

function quotaCell(quota, accountId) {
  if (accounts.quotaLoading.has(accountId)) return '<span class="muted">Loading…</span>';
  if (accounts.quotaUnavailable.has(accountId)) return '<span class="muted">unavailable</span>';
  if (!quota) return '<span class="muted">—</span>';
  if (quota.quotas) {
    const session = quota.quotas.session;
    const used = Number(session?.used);
    return `<span class="aqnum">${Number.isFinite(used) ? `${Math.round(used)}% used` : 'quota read'}<small>${escapeHtml(quota.plan || 'ChatGPT')}</small></span>`;
  }
  if (!quota.total) return '<span class="muted">no package</span>';
  const pct = Math.min(100, Math.round((quota.used / quota.total) * 100));
  return `<span class="aqbar">
    <span class="aqtrack"><span class="aqfill" style="width:${Math.max(2, pct)}%"></span></span>
    <span class="aqnum">${compact(quota.used)}/${compact(quota.total)}</span>
  </span>`;
}

function accountRowMarkup(account) {
  const [tone, label] = ACCOUNT_STATUS[account.status] || ['quiet', account.status];
  const selected = accounts.selected.has(account.id);
  const expiry = account.expiresAt
    ? `token ${relFuture(account.expiresAt)}`
    : account.hasRefreshToken
      ? 'auto-refresh'
      : 'no expiry';
  const kindLabel = account.kind.replace(/_/g, ' ');
  const quota = accounts.quota.get(account.id);
  const busy = accounts.busy.has(account.id);
  // Each row keeps one primary Check button and a "More" that opens the pool
  // menu. The pool menu is hidden until the pool is loaded (poolDetail) so the
  // check-in item is only offered to providers that can check in.
  return `<tr data-id="${escapeHtml(account.id)}" class="${selected ? 'is-selected' : ''}">
    <td class="acheck"><input type="checkbox" data-select="${escapeHtml(account.id)}" ${selected ? 'checked' : ''} aria-label="Select ${escapeHtml(account.label)}"></td>
    <td class="amain">
      <span class="alabel">${escapeHtml(account.label)}</span>
      <span class="asub">${escapeHtml(account.masked)} · ${escapeHtml(kindLabel)} · ${escapeHtml(account.uid ? `uid ${account.uid}` : expiry)}</span>
      ${account.lastError
        ? `<span class="aerr" title="${escapeHtml(account.lastError)}">Error</span>`
        : ''}
    </td>
    <td>
      <span class="status-pill ${tone}"><span class="dot"></span>${escapeHtml(label)}</span>
    </td>
    <td>${quotaCell(quota, account.id)}</td>
    <td class="r astats">${fmtFull(account.requests)}<span>req · ${account.requests ? compact(account.tokensIn + account.tokensOut) : '—'} tok</span></td>
    <td class="r">${account.lastUsedAt ? relTime(new Date(account.lastUsedAt).toISOString()) : '—'}</td>
    <td class="aactions">
      <button class="btn btn-ghost btn-xs" type="button" data-act="test" data-id="${escapeHtml(account.id)}" ${busy ? 'disabled' : ''}>Check</button>
      <button class="btn btn-ghost btn-xs" type="button" data-act="more" data-id="${escapeHtml(account.id)}" aria-haspopup="menu" aria-label="More actions for ${escapeHtml(account.label)}">More</button>
    </td>
  </tr>`;
}

function renderAccounts() {
  const data = accounts.data;
  if (!data) return;

  paintPoolCounts(data.counts);
  paintFilterChips();

  const body = $('dAccounts');
  if (!body) return;

  if (!data.items.length) {
    const empty = data.counts.total === 0
      ? 'No accounts yet. Add one here, or bulk-import a JSON list.'
      : 'No account matches this filter.';
    body.innerHTML = `<tr><td colspan="7" class="empty" style="border-bottom:0">${empty}</td></tr>`;
  } else {
    body.innerHTML = data.items.map(accountRowMarkup).join('');
    staggerChildren(body, 'tr', `accounts:${data.page}:${data.items.map((item) => item.id).join('|')}`);
  }

  const start = (data.page - 1) * data.pageSize + 1;
  const end = Math.min(data.total, start + data.items.length - 1);
  if ($('accountPageInfo')) {
    $('accountPageInfo').textContent = data.total
      ? `${fmtFull(start)}–${fmtFull(end)} of ${fmtFull(data.total)}`
      : '0 accounts';
  }
  if ($('accountPrev')) $('accountPrev').disabled = data.page <= 1;
  if ($('accountNext')) $('accountNext').disabled = data.page >= data.pages;

  const selectAll = $('selectAllAccounts');
  if (selectAll) {
    const ids = data.items.map((item) => item.id);
    const picked = ids.filter((id) => accounts.selected.has(id)).length;
    selectAll.checked = ids.length > 0 && picked === ids.length;
    selectAll.indeterminate = picked > 0 && picked < ids.length;
  }

  updateBulkBar();
}

function updateBulkBar() {
  const bar = $('bulkActions');
  if (!bar) return;
  bar.hidden = accounts.selected.size === 0;
  if ($('bulkCount')) $('bulkCount').textContent = `${fmtFull(accounts.selected.size)} selected`;
}

// Pool actions run from one "More" button so the user sees Warmup all, Test
// accounts all and Check in All together. Each job is client-driven: it pings
// (answers "Pong") or warms up every enabled account one by one and reports
// "N of M accounts" with a progress bar in the account head.
const POOL_ACTIONS = {
  warmup: { label: 'Warm up all', icon: '↻', note: 'Probing expired parked accounts…' },
  test: { label: 'Test accounts all', icon: '◎', note: 'Sending one real request per account, waiting for each answer…' },
  checkin: { label: 'Check in All', icon: '✓', note: 'Daily check-in for enabled accounts…' },
};

let poolJob = null;

async function runPoolJob(kind) {
  if (!currentDetailId || poolJob) return;
  const action = POOL_ACTIONS[kind];
  if (!action) return;
  poolJob = kind;
  const busy = $('poolBusy');
  if (busy) {
    busy.hidden = false;
    busy.textContent = `${action.icon} ${action.label}…`;
  }
  const note = $('accountNote');
  const total = detail?.pool?.total || 0;
  const head = $('poolHead');
  if (head) {
    head.hidden = false;
    head.innerHTML =
      `<span class="pool-count" id="poolCount">0 of ${total}</span>` +
      `<span class="pool-bar"><span class="pool-fill" id="poolFill"></span></span>`;
  }
  detailNote(note, action.note, '');

  try {
    const res = await detailApi('/accounts', { method: 'GET' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.items) throw new Error(body.error?.message || `Request failed (${res.status})`);
    if (!body.items.length) {
      detailNote(note, `No accounts for ${currentDetailId}.`, 'bad');
      return;
    }
    const items = body.items.filter((item) => item.enabled);
    const started = { n: 0 };

    for (let i = 0; i < items.length; i += 1) {
      const account = items[i];
      started.n += 1;
      renderAccounts();
      try {
        const pingRes = await detailApi(`/accounts/${encodeURIComponent(account.id)}/ping`, { method: 'POST' });
        const pingBody = await pingRes.json().catch(() => ({}));
        if (pingRes.ok && pingBody.ok !== false) {
          detailNote(note, `<span class="ok">${account.label}: ${pingBody.answer || 'answered'}</span>`, 'ok');
        } else {
          detailNote(note, `<span class="bad">${account.label}: ${pingBody.error || 'no answer'}</span>`, 'bad');
        }
      } catch (err) {
        detailNote(note, `<span class="bad">${account.label}: ${err.message}</span>`, 'bad');
      }
      const n = started.n;
      if (head) {
        const count = $('poolCount');
        const fill = $('poolFill');
        if (count) count.textContent = `${n} of ${items.length}`;
        if (fill) fill.style.width = `${Math.round((n / items.length) * 100)}%`;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    if (head) {
      const count = $('poolCount');
      const fill = $('poolFill');
      if (count) count.textContent = `${items.length} of ${items.length}`;
      if (fill) fill.style.width = '100%';
    }

    if (kind === 'checkin') {
      const checkinRes = await detailApi('/accounts/checkin', { method: 'POST' });
      const checkinBody = await checkinRes.json().catch(() => ({}));
      if (!checkinRes.ok) throw new Error(checkinBody.error?.message || `Request failed (${checkinRes.status})`);
      detailNote(note, `${checkinBody.checkedIn || 0} checked in · ${checkinBody.failed || 0} failed.`, 'ok');
    } else {
      detailNote(note, `Done. ${started.n} account${started.n === 1 ? '' : 's'} tested.`, 'ok');
    }
  } catch (err) {
    detailNote(note, err.message, 'bad');
  } finally {
    poolJob = null;
    const busy = $('poolBusy');
    if (busy) busy.hidden = true;
  }
}

for (const kind of Object.keys(POOL_ACTIONS)) {
  $('pool' + kind).addEventListener('click', () => runPoolJob(kind));
}

async function testOne(id) {
  if (!id || accounts.busy.has(id)) return;
  accounts.busy.add(id);
  renderAccounts();
  try {
    const res = await detailApi(`/accounts/${encodeURIComponent(id)}/test`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);

    if (body.quota) accounts.quota.set(id, body.quota);
    if (body.account && accounts.data) {
      const item = accounts.data.items.find((row) => row.id === id);
      if (item) Object.assign(item, body.account);
    }
    detailNote($('accountNote'), body.quota
      ? `Quota: ${compact(body.quota.used)} of ${compact(body.quota.total)} used.`
      : 'Credential accepted.', 'ok');
  } catch (err) {
    detailNote($('accountNote'), err.message, 'bad');
    await loadAccounts();
  } finally {
    accounts.busy.delete(id);
    renderAccounts();
  }
}

async function checkinOne(id) {
  if (!id || accounts.busy.has(id)) return;
  accounts.busy.add(id);
  renderAccounts();
  try {
    const res = await detailApi(`/accounts/${encodeURIComponent(id)}/checkin`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    detailNote($('accountNote'), body.checkin?.message || 'Daily check-in completed.',
      body.checkin?.status === 'inactive' ? '' : 'ok');
  } catch (err) {
    detailNote($('accountNote'), err.message, 'bad');
  } finally {
    accounts.busy.delete(id);
    renderAccounts();
  }
}

async function toggleOne(id) {
  const item = accounts.data?.items.find((row) => row.id === id);
  if (!item || accounts.busy.has(id)) return;
  accounts.busy.add(id);
  renderAccounts();
  try {
    const res = await detailApi(`/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !item.enabled }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
  } catch (err) {
    detailNote($('accountNote'), err.message, 'bad');
  } finally {
    accounts.busy.delete(id);
    await loadAccounts();
  }
}

async function deleteOne(id, { ask = true, opener = document.activeElement } = {}) {
  const item = accounts.data?.items.find((row) => row.id === id);
  if (ask) return openConfirmation({
    title: 'Remove account?',
    message: `${item?.label || 'This account'} will be removed from the pool.`,
    confirmLabel: 'Remove account',
    danger: true,
    run: () => deleteOne(id, { ask: false }),
  }, opener);
  accounts.busy.add(id);
  try {
    const res = await detailApi(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message || `Request failed (${res.status})`);
    }
    accounts.selected.delete(id);
    accounts.quota.delete(id);
  } catch (err) {
    detailNote($('accountNote'), err.message, 'bad');
  } finally {
    accounts.busy.delete(id);
  }
}

async function bulkAction(kind) {
  const ids = [...accounts.selected];
  if (!ids.length) return;
  if (kind === 'delete') return openConfirmation({
    title: `Remove ${ids.length} account${ids.length === 1 ? '' : 's'}?`,
    message: 'Selected accounts will be permanently removed from the pool.',
    confirmLabel: 'Remove accounts',
    danger: true,
    run: () => bulkActionConfirmed(kind, ids),
  });
  return bulkActionConfirmed(kind, ids);
}

async function bulkActionConfirmed(kind, ids) {
  const note = $('accountNote');
  detailNote(note, `${kind === 'delete' ? 'Removing' : 'Updating'} ${ids.length} accounts…`);

  if (kind === 'delete') {
    await Promise.all(ids.map((id) => deleteOne(id, { ask: false })));
  } else {
    const enabled = kind === 'enable';
    await Promise.all(ids.map(async (id) => {
      try {
        await detailApi(`/accounts/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
      } catch {
        // The reload below shows the accounts that did change.
      }
    }));
  }

  accounts.selected.clear();
  detailNote(note, `${ids.length} account${ids.length === 1 ? '' : 's'} updated.`, 'ok');
  await loadAccounts();
}

function parseBulk(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.accounts)) return parsed.accounts;
    return [parsed];
  }
  return trimmed.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[\s,]+/).filter(Boolean);
      return parts.length > 1
        ? { uid: parts[0], access_token: parts[1] }
        : { access_token: line };
    });
}

function quotaPackagesMarkup(accountId, quota) {
  const packages = quota.packages || [];
  const pageSize = 5;
  const pages = Math.max(1, Math.ceil(packages.length / pageSize));
  const page = Math.min(quotaPage.packagePages.get(accountId) || 1, pages);
  const start = (page - 1) * pageSize;
  const rows = packages.slice(start, start + pageSize).map((pkg) => {
    const share = pkg.total ? Math.min(100, Math.round((pkg.used / pkg.total) * 100)) : 0;
    return `<div class="pkg">
      <div class="pkg-top">
        <span class="pkg-name">${escapeHtml(pkg.name)}</span>
        <span class="pkg-num">${compact(pkg.used)} / ${compact(pkg.total)}</span>
      </div>
      <div class="qtrack is-thin"><div class="qfill" style="width:${Math.max(2, share)}%"></div></div>
      <span class="pkg-foot">${pkg.recurring ? 'resets' : 'expires'} ${fmtDate(pkg.resetAt)}</span>
    </div>`;
  }).join('');
  if (packages.length <= pageSize) return rows;
  return `${rows}<div class="package-pager">
    <span>${start + 1}–${Math.min(start + pageSize, packages.length)} of ${packages.length} packages</span>
    <div>
      <button class="btn btn-ghost btn-xs" type="button" data-package-page="prev" data-account-id="${escapeHtml(accountId)}" ${page <= 1 ? 'disabled' : ''}>←</button>
      <button class="btn btn-ghost btn-xs" type="button" data-package-page="next" data-account-id="${escapeHtml(accountId)}" ${page >= pages ? 'disabled' : ''}>→</button>
    </div>
  </div>`;
}

function codexQuotaWindowsMarkup(quota) {
  const rows = Object.entries(quota.quotas || {}).filter(([, window]) => window && typeof window === 'object');
  if (!rows.length) return '<p class="hint">No Codex quota windows returned.</p>';
  return `<div class="codex-quota-windows">${rows.map(([name, window]) => {
    const label = name.replace(/_/g, ' ');
    const used = Number(window.used);
    const total = Number(window.total) || 100;
    const pct = Number.isFinite(used) ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0;
    const reset = window.resetAt ? fmtDate(window.resetAt) : 'no reset time';
    return `<div class="codex-quota-window">
      <div class="pkg-top"><span class="pkg-name">${escapeHtml(label)}</span><span class="pkg-num">${window.unlimited ? 'unlimited' : `${Number.isFinite(used) ? compact(used) : '—'}% used`}</span></div>
      <div class="qtrack is-thin"><div class="qfill" style="width:${Math.max(2, pct)}%"></div></div>
      <span class="pkg-foot">${window.unlimited ? 'no cap' : `resets ${escapeHtml(reset)}`}</span>
    </div>`;
  }).join('')}</div>`;
}

function paintQuotaColumns() {
  quotaColumns = [1, 2, 3, 4, 5].includes(quotaColumns) ? quotaColumns : 3;
  const host = $('dUpstreamQuota');
  host?.style.setProperty('--quota-columns', quotaColumns);
  host?.style.setProperty('--quota-columns-medium', Math.min(2, quotaColumns));
  document.querySelectorAll('[data-quota-columns]').forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.quotaColumns) === quotaColumns));
  });
}

function quotaStatusLabel(status) {
  return status === 'cooldown' ? 'Cooling' : 'Active';
}

function renderCoolingQuotaAccount(account) {
  const retry = account.cooldownUntil > Date.now() ? `Retry ${relFuture(account.cooldownUntil)}` : 'Quota temporarily unavailable.';
  return `<section class="quota-account quota-account-inactive">
    <div class="quota-account-head"><strong>${escapeHtml(account.label)}</strong><span class="status-pill quiet"><span class="dot"></span>Cooling</span></div>
    <p class="hint">${escapeHtml(retry)}</p>
  </section>`;
}

function renderActiveQuotaAccount(account, result) {
  if (result?.error) return `<section class="quota-account">
    <div class="quota-account-head"><strong>${escapeHtml(account.label)}</strong><span class="status-pill bad"><span class="dot"></span>Unavailable</span></div>
    <p class="hint bad">${escapeHtml(result.error)}</p>
  </section>`;
  if (!result?.quota) return `<section class="quota-account">
    <div class="quota-account-head"><strong>${escapeHtml(account.label)}</strong><span class="muted">Loading…</span></div>
  </section>`;
  const quota = result.quota;
  if (quota.quotas) return `<section class="quota-account">
    <div class="quota-account-head"><strong>${escapeHtml(account.label)}</strong><span class="muted">${escapeHtml(account.masked)}</span></div>
    <div class="qtop"><div><div class="stat-big qvalue">${escapeHtml(quota.plan || 'ChatGPT')}</div><div class="qcap">${quota.limitReached ? 'limit reached' : 'available'}${quota.reviewLimitReached ? ' · review limited' : ''}${quota.sparkLimitReached ? ' · spark limited' : ''}</div></div></div>
    ${codexQuotaWindowsMarkup(quota)}
  </section>`;
  const pct = quota.total ? Math.min(100, Math.round((quota.used / quota.total) * 100)) : 0;
  const packages = quotaPackagesMarkup(account.id, quota);
  return `<section class="quota-account">
    <div class="quota-account-head"><strong>${escapeHtml(account.label)}</strong><span class="muted">${escapeHtml(account.masked)}</span></div>
    <div class="qtop"><div class="stat-big qvalue">${compact(quota.used)}</div><div class="qcap">of ${fmtFull(quota.total)}<br><span>${escapeHtml(quota.plan || 'CodeBuddy')}</span></div></div>
    <div class="qtrack"><div class="qfill" style="width:${Math.max(2, pct)}%"></div></div>
    ${packages ? `<div class="pkgs">${packages}</div>` : '<p class="hint">No credit package returned.</p>'}
  </section>`;
}

function renderUpstreamQuota() {
  const host = $('dUpstreamQuota');
  const note = $('upstreamQuotaNote');
  const data = quotaPage.data;
  if (!host || !note) return;
  paintQuotaColumns();

  if (!detail?.provider.quotaSupported) {
    note.textContent = 'This provider publishes no quota endpoint.';
    host.innerHTML = '';
    return;
  }
  if (!data) {
    note.textContent = quotaPage.loading ? 'Reading account quotas…' : 'No quota data yet.';
    host.innerHTML = '';
    $('quotaPageInfo').textContent = 'Loading…';
    $('quotaPrev').disabled = true;
    $('quotaNext').disabled = true;
    return;
  }

  const active = data.items.filter((account) => account.status === 'active');
  const cooling = data.items.filter((account) => account.status === 'cooldown');
  const hidden = data.items.filter((account) => account.status !== 'active' && account.status !== 'cooldown');
  note.textContent = data.error || `${active.length} active · ${cooling.length} non-active${hidden.length ? ` · ${hidden.length} hidden` : ''}.`;
  const activeMarkup = active.length
    ? active.map((account) => renderActiveQuotaAccount(account, data.quotas.get(account.id))).join('')
    : '<p class="quota-group-empty">No active accounts.</p>';
  const coolingMarkup = cooling.length
    ? cooling.map(renderCoolingQuotaAccount).join('')
    : '<p class="quota-group-empty">No non-active accounts.</p>';
  host.innerHTML = `<section class="quota-group"><h3 class="quota-group-title">Active accounts <span>${active.length}</span></h3><div class="quota-group-grid">${activeMarkup}</div></section>
    <section class="quota-group quota-group-muted"><h3 class="quota-group-title">Non-active accounts <span>${cooling.length}</span></h3><div class="quota-group-grid">${coolingMarkup}</div></section>`;

  const start = data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const end = Math.min(data.total, start + data.items.length - 1);
  $('quotaPageInfo').textContent = data.total ? `${start}–${end} of ${data.total}` : '0 accounts';
  $('quotaPrev').disabled = data.page <= 1 || quotaPage.loading;
  $('quotaNext').disabled = data.page >= data.pages || quotaPage.loading;
}

async function loadUpstreamQuota({ reset = false } = {}) {
  if (!detail?.provider.quotaSupported || quotaPage.loading) return;
  if (reset) quotaPage.page = 1;
  const requestId = ++quotaPage.requestId;
  quotaPage.loading = true;
  quotaPage.data = null;
  quotaPage.packagePages.clear();
  renderUpstreamQuota();
  try {
    const res = await detailApi(`/accounts/quota-list?page=${quotaPage.page}&pageSize=5`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Request failed (${res.status})`);
    if (requestId !== quotaPage.requestId) return;
    const quotas = new Map();
    quotaPage.data = { ...data, quotas };
    renderUpstreamQuota();
    const queue = data.items.filter((account) => account.status === 'active');
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const account = queue.shift();
        try {
          const quotaRes = await detailApi(`/accounts/${encodeURIComponent(account.id)}/quota`, { method: 'POST' });
          const body = await quotaRes.json().catch(() => ({}));
          if (!quotaRes.ok) throw new Error(body.error?.message || `Request failed (${quotaRes.status})`);
          quotas.set(account.id, { quota: body.quota });
        } catch (err) {
          quotas.set(account.id, { error: err.message });
        }
        if (requestId === quotaPage.requestId) renderUpstreamQuota();
      }
    }));
  } catch (err) {
    if (requestId === quotaPage.requestId) {
      quotaPage.data = { items: [], total: 0, page: quotaPage.page, pageSize: 5, pages: 1, quotas: new Map(), error: err.message };
      renderUpstreamQuota();
    }
  } finally {
    if (requestId === quotaPage.requestId) {
      quotaPage.loading = false;
      renderUpstreamQuota();
    }
  }
}

function capLabel(value, yes = 'yes', no = 'no') {
  if (value === null || value === undefined) return 'unknown';
  return value ? yes : no;
}

function compactLimit(value) {
  if (!Number.isFinite(value)) return '—';
  return compact(value);
}

function modelCapabilityMarkup(capabilities = {}, modelId = '') {
  const input = capabilities.input || {};
  const reasoning = capabilities.reasoning || {};
  const limits = capabilities.limits || {};
  const items = [
    input.text?.value === true ? ['text', 'Text'] : null,
    input.vision?.value === true ? ['vision', 'Vision'] : null,
    reasoning.supported === true ? ['reasoning', 'Reasoning'] : null,
    reasoning.canDisable === true ? ['thinking', 'Thinking'] : null,
  ].filter(Boolean);
  const icons = {
    text: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 6h14M12 6v12M8 18h8"/></svg>',
    vision: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12s3.2-5 8.5-5 8.5 5 8.5 5-3.2 5-8.5 5-8.5-5-8.5-5Z"/><circle cx="12" cy="12" r="2.2"/></svg>',
    reasoning: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 14 9l6 2-6 2-2 6-2-6-6-2 6-2 2-6Z"/></svg>',
    thinking: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M8.5 15.5a6 6 0 1 1 7 0c-.9.6-1.5 1.2-1.5 2.5h-4c0-1.3-.6-1.9-1.5-2.5Z"/></svg>',
  };
  const summary = items.length
    ? items.map(([key, label]) => `<span class="cap-icon" title="${label}">${icons[key]}<span class="sr-only">${label}</span></span>`).join('')
    : '<span class="cap-icon cap-unknown" title="Capability data unavailable">?</span>';
  return `<button class="model-capability" type="button" data-model-info="${escapeHtml(JSON.stringify(capabilities))}" data-model-name="${escapeHtml(modelId)}" aria-label="View capabilities for ${escapeHtml(modelId)}">${summary}</button>
    <small class="model-limits">${compactLimit(limits.contextWindow)} ctx · ${compactLimit(limits.maxOutputTokens)} out</small>`;
}

function renderDetailModels() {
  const body = $('dModels');
  if (!body) return;

  const models = [...detail.models].sort((a, b) => Number(a.enabled === false) - Number(b.enabled === false));
  const custom = models.filter((m) => m.source === 'custom').length;
  $('dModelCount').textContent = `${models.length} total · ${custom} custom`;
  const fetchButton = $('fetchModels');
  if (fetchButton && detail?.provider.modelDiscovery === false) {
    fetchButton.disabled = true;
    fetchButton.title = 'This provider has no upstream /models endpoint.';
    $('fetchLabel').textContent = 'Catalog bundled';
    detailNote($('fetchNote'), 'This provider uses its bundled catalog; upstream model discovery is not available.');
  } else if (fetchButton) {
    $('fetchLabel').textContent = detail.provider.modelsPath ? 'Fetch Codex catalog' : 'Fetch from provider';
    fetchButton.title = detail.provider.modelsPath ? 'Read the provider catalog endpoint.' : '';
  }
  if ($('tabModelCount')) $('tabModelCount').textContent = fmtFull(models.length);
  if (!models.length) {
    body.innerHTML = '<p class="model-grid-empty">No models in this catalog.</p>';
    return;
  }

  body.innerHTML = models.map((m) => {
    const tokens = m.tokensIn + m.tokensOut;
    const test = modelTests.get(m.id);
    const disabled = m.enabled === false;
    const testing = test?.busy === true;
    const result = testing
      ? '<span class="model-test-result testing"><span class="test-spinner" aria-hidden="true"></span>Testing…</span>'
      : test?.ok
      ? `<span class="model-test-result ok">Pass · ${escapeHtml(test.account?.label || 'active account')}</span>`
      : test?.skipped
        ? `<span class="model-test-result" title="${escapeHtml(test.error || 'Not testable upstream')}">Skipped</span>`
        : test?.error
          ? `<span class="model-test-result bad" title="${escapeHtml(test.error)}">Failed${test.disabled ? ' · disabled' : ''}</span>`
          : '<span class="model-test-result muted">Not tested</span>';
    const plans = m.plans?.length
      ? `<span class="model-plans">${m.plans.map((plan) => `<span class="plan-badge plan-${escapeHtml(plan)}">${escapeHtml(plan)}</span>`).join('')}</span>`
      : '';
    return `<article class="model-card ${disabled ? 'model-disabled' : ''}${testing ? ' model-testing' : ''}" role="listitem">
      <div class="model-card-head">
        <div class="model-card-title"><strong class="model">${escapeHtml(m.id)}</strong>${disabled ? '<span class="model-disabled-label">Disabled</span>' : ''}</div>
        <span class="srcbadge ${m.source}">${escapeHtml(m.source)}</span>
      </div>
      ${plans}
      <div class="model-capability-cell">${modelCapabilityMarkup(m.capabilities, m.id)}</div>
      <div class="model-card-stats" aria-label="Model usage statistics">
        <span><b>${fmtFull(m.requests)}</b> req</span>
        <span><b>${m.requests ? fmtFull(tokens) : '—'}</b> tok</span>
        <span><b>${m.lastMs == null ? '—' : `${m.lastMs} ms`}</b> latency</span>
      </div>
      <div class="model-card-foot"><span class="model-result">${result}</span><span class="model-actions">
        <button class="iconbtn model-action model-test-action${testing ? ' is-testing' : ''}" type="button" data-test-model="${escapeHtml(m.id)}" ${modelTestBusy || testing || disabled ? 'disabled' : ''} title="${testing ? 'Testing model' : 'Test model'}" aria-label="${testing ? 'Testing' : 'Test'} ${escapeHtml(m.id)}">${testing ? '<span class="test-spinner" aria-hidden="true"></span>' : '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6L19 12 8 5.2Z"/></svg>'}</button>
        <button class="iconbtn model-action ${disabled ? 'is-enable' : ''}" type="button" data-toggle-model="${escapeHtml(m.id)}" title="${disabled ? 'Enable model' : 'Disable model'}" aria-label="${disabled ? 'Enable model' : 'Disable model'} ${escapeHtml(m.id)}">${disabled ? '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m5 12 4 4L19 6"/></svg>' : '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>'}</button>
        ${m.source === 'custom' ? `<button class="iconbtn model-action danger" type="button" data-remove-model="${escapeHtml(m.id)}" title="Delete custom model" aria-label="Delete custom model ${escapeHtml(m.id)}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 7h14M10 11v6M14 11v6M8 7l1-3h6l1 3m-9 0 1 14h8l-1-14"/></svg></button>` : ''}
      </span></div>
    </article>`;
  }).join('');
}

function detailNote(el, text, tone = '') {
  if (!el) return;
  el.textContent = text;
  el.className = tone ? `toolnote ${tone}` : 'toolnote';
}

let modelToastSeq = 0;
const modelToastTimers = new WeakMap();
const MODEL_TOAST_MS = 2000;

function closeModelTestToast(toast) {
  if (!toast || toast.classList.contains('is-closing')) return;
  window.clearTimeout(modelToastTimers.get(toast));
  modelToastTimers.delete(toast);
  toast.classList.add('is-closing');
  window.setTimeout(() => toast.remove(), 180);
}

function scheduleModelTestToast(toast) {
  if (!toast || toast.matches(':hover') || toast.contains(document.activeElement)) return;
  window.clearTimeout(modelToastTimers.get(toast));
  modelToastTimers.set(toast, window.setTimeout(() => closeModelTestToast(toast), MODEL_TOAST_MS));
}

function showModelTestToast(result) {
  const host = $('modelTestToasts');
  if (!host || !result) return;

  const ok = result.ok === true;
  const answer = String(ok ? (result.answer || 'The model returned no text.') : (result.error || 'Model test failed.'))
    .slice(0, 1200);
  const account = result.account?.label || 'active account';
  const latency = Number.isFinite(result.latencyMs) ? ` · ${result.latencyMs} ms` : '';
  const toast = document.createElement('article');
  const skipped = result.skipped === true;
  toast.className = `model-test-toast${ok || skipped ? '' : ' is-error'}`;
  toast.dataset.toastId = String(++modelToastSeq);
  toast.innerHTML = `<button class="model-test-toast-close" type="button" aria-label="Close model test result">×</button>
    <div class="model-test-toast-head">
      <strong class="model-test-toast-title">${ok ? 'Model test passed' : skipped ? 'Model test skipped' : 'Model test failed'}</strong>
      <span class="model-test-toast-model">${escapeHtml(result.model || 'unknown model')}</span>
    </div>
    <div class="model-test-toast-answer">${escapeHtml(answer)}</div>
    ${ok || skipped || result.status === 429 ? '' : result.upstreamBody ? `<pre class="model-test-toast-upstream">${escapeHtml(result.upstreamBody)}</pre>` : ''}
    <div class="model-test-toast-meta">${escapeHtml(account)}${latency}${result.disabled ? ' · account disabled' : ''}</div>`;
  host.appendChild(toast);
  while (host.children.length > 3) closeModelTestToast(host.firstElementChild);
  host.scrollTop = host.scrollHeight;
  scheduleModelTestToast(toast);
}

$('modelTestToasts')?.addEventListener('click', (event) => {
  const close = event.target.closest('.model-test-toast-close');
  if (close) closeModelTestToast(close.closest('.model-test-toast'));
});
$('modelTestToasts')?.addEventListener('pointerenter', (event) => {
  const toast = event.target.closest('.model-test-toast');
  if (toast) window.clearTimeout(modelToastTimers.get(toast));
}, true);
$('modelTestToasts')?.addEventListener('pointerleave', (event) => {
  const toast = event.target.closest('.model-test-toast');
  if (toast) scheduleModelTestToast(toast);
}, true);
$('modelTestToasts')?.addEventListener('focusin', (event) => {
  const toast = event.target.closest('.model-test-toast');
  if (toast) window.clearTimeout(modelToastTimers.get(toast));
});
$('modelTestToasts')?.addEventListener('focusout', (event) => {
  const toast = event.target.closest('.model-test-toast');
  if (toast) requestAnimationFrame(() => scheduleModelTestToast(toast));
});

$('addModelForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('newModelInput');
  const note = $('addNote');
  const value = (input?.value || '').trim();
  if (!value || !currentDetailId) return;

  detailNote(note, `Adding ${value}…`);
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    detail = body;
    input.value = '';
    detailNote(note, `${value} added — it is served by /v1 right away.`, 'ok');
    renderDetailModels();
    if (detail) paintDetailMeta();
  } catch (err) {
    detailNote(note, err.message, 'bad');
  }
});

async function runModelTest(model, disableOnError = false) {
  if (!currentDetailId || modelTestBusy) return;
  modelTests.set(model, { busy: true });
  renderDetailModels();
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}/models/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, disableOnError }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    const result = body.results?.[0] || body;
    modelTests.set(model, result);
    showModelTestToast(result);
    detailNote($('modelTestNote'), result.ok
      ? `${model} passed using ${result.account?.label || 'an active account'}.`
      : `${model} failed${result.disabled ? ' and the account was disabled' : ''}.`, result.ok ? 'ok' : 'bad');
    await loadAccounts();
    await refresh();
  } catch (err) {
    modelTests.set(model, { error: err.message });
    detailNote($('modelTestNote'), err.message, 'bad');
  } finally {
    renderDetailModels();
  }
}

let modelTestModeOpener = null;

function closeModelTestMode() {
  const modal = $('modelTestModeModal');
  if (modal.hidden) return;
  modal.hidden = true;
  requestAnimationFrame(() => modelTestModeOpener?.focus?.());
  modelTestModeOpener = null;
}

function openModelTestMode(opener = document.activeElement) {
  if (modelTestBusy) return;
  modelTestModeOpener = opener;
  $('modelTestModeModal').hidden = false;
  $('testAllOnly').focus();
}

async function runAllModelTests(disableOnError) {
  if (!currentDetailId || modelTestBusy || !detail) return;
  modelTestBusy = true;
  const button = $('testAllModels');
  if (button) button.disabled = true;
  // Test all only means models returned by the provider catalog fetch. Custom
  // dashboard labels are local prefixes and cannot be sent upstream as Codex IDs.
  const models = detail.models.filter((item) => item.source === 'catalog').map((item) => item.id);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  try {
    if (!models.length) {
      detailNote($('modelTestNote'), 'No fetched provider models available. Fetch the Codex catalog first.', 'bad');
      return;
    }
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      modelTests.set(model, { busy: true });
      detailNote($('modelTestNote'), `Testing ${index + 1}/${models.length}: ${model}`);
      renderDetailModels();
      try {
        const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}/models/test`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, disableOnError }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
        const result = body.results?.[0] || body;
        modelTests.set(model, result);
        if (result.ok) passed += 1;
        else if (result.skipped) skipped += 1;
        else failed += 1;
        showModelTestToast(result);
        if (!result.ok && disableOnError) await toggleModel(model, false);
      } catch (err) {
        failed += 1;
        modelTests.set(model, { error: err.message });
        showModelTestToast({ model, error: err.message });
        if (disableOnError) await toggleModel(model, false);
      }
      renderDetailModels();
      if (index < models.length - 1) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    detailNote($('modelTestNote'), `${passed} passed · ${failed} failed${skipped ? ` · ${skipped} skipped` : ''}${disableOnError ? ' · failures disabled' : ''}.`, failed ? 'bad' : 'ok');
    await loadAccounts();
    await refresh();
  } finally {
    modelTestBusy = false;
    if (button) button.disabled = false;
    renderDetailModels();
  }
}

$('testAllModels')?.addEventListener('click', (event) => openModelTestMode(event.currentTarget));
$('testAllOnly')?.addEventListener('click', () => { closeModelTestMode(); runAllModelTests(false); });
$('testAllWithDisable')?.addEventListener('click', () => { closeModelTestMode(); runAllModelTests(true); });
$('cancelModelTestMode')?.addEventListener('click', closeModelTestMode);
$('modelTestModeModal')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-model-test-mode-close]')) closeModelTestMode();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('modelTestModeModal').hidden) closeModelTestMode();
});

async function toggleModel(model, enabled) {
  const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}/models/${encodeURIComponent(model)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return detailNote($('modelTestNote'), body.error?.message || `Request failed (${res.status})`, 'bad');
  detail = body;
  renderDetailModels();
  await refresh();
}

function closeModelInfo() {
  $('modelInfoModal').hidden = true;
}
$('closeModelInfo')?.addEventListener('click', closeModelInfo);
$('modelInfoModal')?.addEventListener('click', (event) => { if (event.target.closest('[data-model-info-close]')) closeModelInfo(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('modelInfoModal').hidden) closeModelInfo(); });

$('dModels')?.addEventListener('click', async (event) => {
  const info = event.target.closest('[data-model-info]');
  if (info) {
    let capabilities;
    try { capabilities = JSON.parse(info.dataset.modelInfo); } catch { return; }
    const input = capabilities.input || {};
    const output = capabilities.output || {};
    const reasoning = capabilities.reasoning || {};
    const limits = capabilities.limits || {};
    const modelName = info.dataset.modelName || 'Model capabilities';
    const value = (item) => item?.value === null || item?.value === undefined ? 'Unknown' : item.value ? 'Yes' : 'No';
    const capabilityRows = [
      ['Text input', value(input.text)],
      ['Vision input', value(input.vision)],
      ['PDF input', value(input.pdf)],
      ['Text output', value(output.text)],
      ['JSON output', value(output.json)],
      ['Reasoning', capLabel(reasoning.supported)],
      ['Thinking control', capLabel(reasoning.canDisable)],
      ['Reasoning format', reasoning.format || 'Unknown'],
      ['Context window', compactLimit(limits.contextWindow)],
      ['Max output', compactLimit(limits.maxOutputTokens)],
    ];
    $('modelInfoTitle').textContent = modelName;
    $('modelInfoSubtitle').textContent = capabilities.provenance || 'Capability details';
    $('modelInfoBody').innerHTML = `<div class="model-info-details">${capabilityRows.map(([label, value]) => `<div class="model-info-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(String(value))}</b></div>`).join('')}</div>`;
    $('modelInfoModal').hidden = false;
    $('closeModelInfo').focus();
    return;
  }
  const toggle = event.target.closest('[data-toggle-model]');
  if (toggle) {
    const model = toggle.dataset.toggleModel;
    const row = detail.models.find((item) => item.id === model);
    if (!row) return;
    if (row.enabled !== false) return openConfirmation({
      title: 'Disable model?',
      message: `${model} will stay in the catalog but stop appearing in /v1/models and chat routing.`,
      confirmLabel: 'Disable model',
      danger: true,
      run: () => toggleModel(model, false),
    }, toggle);
    return toggleModel(model, true);
  }
  const testBtn = event.target.closest('[data-test-model]');
  if (testBtn) return runModelTest(testBtn.dataset.testModel);
  const btn = event.target.closest('[data-remove-model]');
  if (!btn || !currentDetailId) return;

  const model = btn.dataset.removeModel;
  openConfirmation({
    title: 'Remove model?',
    message: `${model} will no longer be routed by this provider.`,
    confirmLabel: 'Remove model',
    danger: true,
    run: async () => {
      btn.disabled = true;
      try {
        const res = await fetch(
          `/api/providers/${encodeURIComponent(currentDetailId)}/models/${encodeURIComponent(model)}`,
          { method: 'DELETE' },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
        detail = body;
        detailNote($('addNote'), `${model} removed.`, 'ok');
        renderDetailModels();
      } catch (err) {
        detailNote($('addNote'), err.message, 'bad');
        btn.disabled = false;
      }
    },
  }, btn);
});

$('fetchModels')?.addEventListener('click', async () => {
  if (!currentDetailId) return;
  const btn = $('fetchModels');
  const label = $('fetchLabel');
  const note = $('fetchNote');
  if (detail?.provider.modelDiscovery === false) {
    btn.disabled = true;
    label.textContent = 'Catalog bundled';
    detailNote(note, 'CodeBuddy CN uses its bundled catalog; upstream /models is not available.');
    return;
  }

  btn.disabled = true;
  label.textContent = 'Fetching…';
  detailNote(note, 'Asking the provider for its model list…');
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}/models/fetch`, {
      method: 'POST',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    detail = body;
    const added = body.added || [];
    const accountSummary = Array.isArray(body.accounts)
      ? ` ${body.accounts.filter((account) => !account.error).length}/${body.accounts.length} accounts fetched${body.partial ? '; some accounts failed' : ''}.`
      : '';
    detailNote(note, `Fetched ${body.fetched || 0} model${body.fetched === 1 ? '' : 's'}.${accountSummary}`, body.partial ? 'bad' : 'ok');
    renderDetailModels();
  } catch (err) {
    detailNote(note, err.message, 'bad');
  } finally {
    btn.disabled = false;
    label.textContent = detail?.provider.modelsPath ? 'Fetch Codex catalog' : 'Fetch from provider';
  }
});

