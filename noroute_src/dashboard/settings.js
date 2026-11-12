/* ---------------- settings page ---------------- */

function limitBar(label, used, limit) {
  if (limit == null) return '';
  const ratio = Math.min(1, used / Math.max(limit, 1));
  const tone = ratio >= .8 ? 'bad' : ratio >= .5 ? 'warn' : 'ok';
  return `<div class="key-limit"><span>${label} <b>${compact(used)} / ${compact(limit)}</b></span><i class="${tone}"><em style="width:${Math.max(2, Math.round(ratio * 100))}%"></em></i></div>`;
}

function renderApiKeys() {
  renderCurlExample();
  const list = $('keyList');
  if (!list) return;
  const requireKey = latest?.requireApiKey === true;
  $('keyEndpoint').textContent = `${location.origin}/v1`;
  $('keyTotal').textContent = apiKeys.length;
  $('keyActive').textContent = apiKeys.filter((key) => key.enabled).length;
  $('keyProtection').textContent = requireKey ? 'Protected' : 'Not protected';
  $('requireKeyToggle').checked = requireKey;
  list.innerHTML = apiKeys.length ? apiKeys.map((key) => `<div class="key-row">
    <div class="key-icon" aria-hidden="true">⌁</div>
    <div class="key-main">
      <div class="key-identity"><strong>${escapeHtml(key.name)}</strong><span class="status-pill ${key.status === 'enabled' ? 'ok' : 'bad'}"><span class="dot"></span>${escapeHtml(key.status)}</span></div>
      <small>${key.expiresAt ? `expires ${escapeHtml(new Date(key.expiresAt).toLocaleString())}` : 'no expiry'}</small>
      <code class="key-secret ${key.secret ? 'is-hidden' : 'key-secret-missing'}" id="key-secret-${escapeHtml(key.id)}">${escapeHtml(key.secret || 'No secret stored — rotate to issue one')}</code>
    </div>
    <div class="key-limits">${limitBar('Requests', key.requests, key.requestLimit)}${limitBar('Tokens', key.tokens, key.tokenLimit)}</div>
    <div class="key-row-actions">
      ${key.secret ? `<button class="btn btn-ghost btn-xs" type="button" data-key-show="${escapeHtml(key.id)}">Show</button><button class="btn btn-ghost btn-xs" type="button" data-key-copy="${escapeHtml(key.id)}">Copy</button>` : ''}
      <button class="btn btn-primary btn-xs" type="button" data-key-edit="${escapeHtml(key.id)}">Edit</button>
      <details class="key-more"><summary class="btn btn-ghost btn-xs">More</summary><div class="key-more-menu"><button type="button" data-key-rotate="${escapeHtml(key.id)}">Rotate</button><button type="button" data-key-usage="${escapeHtml(key.id)}">History</button><button type="button" data-key-toggle="${escapeHtml(key.id)}">${key.enabled ? 'Disable' : 'Enable'}</button><button class="danger" type="button" data-key-revoke="${escapeHtml(key.id)}">Revoke key</button></div></details>
    </div>
    <div class="key-history" id="usage-${escapeHtml(key.id)}" hidden></div>
  </div>`).join('') : `<div class="empty key-empty"><strong>No API keys yet</strong><span>Create one to authenticate requests to <code>/v1</code>.</span><button class="btn btn-primary btn-xs" type="button" data-create-key-empty>Create API key</button></div>`;
}

async function loadApiKeys() {
  if (!document.querySelector('[data-page="/api-keys"]')) return;
  try {
    const [keysRes, settingsRes] = await Promise.all([
      fetch('/api/keys', { cache: 'no-store' }),
      fetch('/api/auth-settings', { cache: 'no-store' }),
    ]);
    const keysBody = await keysRes.json();
    const settingsBody = await settingsRes.json();
    if (!keysRes.ok) throw new Error(keysBody.error?.message || 'Could not load API keys.');
    if (!settingsRes.ok) throw new Error(settingsBody.error?.message || 'Could not load auth settings.');
    apiKeys = keysBody.keys || [];
    if (latest) latest.requireApiKey = settingsBody.requireApiKey === true;
    renderApiKeys();
  } catch (err) {
    detailNote($('keyNote'), err.message, 'bad');
  }
}

function draftApiKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `nr_live_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function resetCreateKeyForm() {
  const form = $('createKeyForm');
  if (!form) return;
  form.reset();
  form.elements.secret.value = '';
  detailNote($('createKeyNote'), '', '');
}

function closeKeyModal(id) {
  const modal = $(id);
  if (modal) modal.hidden = true;
  if (id === 'createKeyModal') resetCreateKeyForm();
  if (id === 'editKeyModal') {
    editingApiKeyId = '';
    $('rotateCustomSecret').value = '';
  }
  if (id === 'secretModal') {
    apiKeySecret = '';
    $('secretValue').textContent = '—';
    $('secretValue').classList.add('is-hidden');
    $('toggleSecret').textContent = 'Show token';
  }
}

function openSecretModal(secret) {
  apiKeySecret = secret;
  $('secretValue').textContent = secret;
  $('secretValue').classList.add('is-hidden');
  $('toggleSecret').textContent = 'Show token';
  $('secretModal').hidden = false;
}

function setLimitControl(form, prefix, value) {
  const input = form.elements[`${prefix}Limit`];
  const enabled = form.elements[`${prefix}LimitEnabled`];
  const unit = form.elements[`${prefix}LimitUnit`];
  if (unit) unit.value = value == null ? '' : 'tokens';
  if (enabled) enabled.checked = value != null;
  input.disabled = value == null;
  input.value = value ?? '';
  syncCustomSelects();
}

function setKeyFormValues(form, key) {
  form.elements.name.value = key.name;
  form.dataset.hasSecret = String(Boolean(key.secret));
  form.elements.secret.value = key.secret || '';
  form.elements.secret.placeholder = key.secret ? '' : 'Rotate or enter a replacement token';
  form.elements.expiresAt.value = key.expiresAt ? new Date(key.expiresAt - new Date(key.expiresAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  setLimitControl(form, 'request', key.requestLimit);
  setLimitControl(form, 'token', key.tokenLimit);
}

function keyFormValues(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const unit = values.tokenLimitUnit;
  delete values.tokenLimitUnit;
  delete values.requestLimitEnabled;
  if (values.tokenLimit && unit && unit !== 'tokens') values.tokenLimit += unit;
  return values;
}

let confirmation = null;
let confirmationOpener = null;

function closeConfirmation() {
  $('confirmModal').hidden = true;
  confirmation = null;
  confirmationOpener?.focus();
  confirmationOpener = null;
}

function openConfirmation({ title, message, confirmLabel, danger = false, run }, opener = document.activeElement) {
  confirmation = run;
  confirmationOpener = opener;
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  $('acceptConfirm').textContent = confirmLabel;
  $('acceptConfirm').className = danger ? 'btn danger' : 'btn btn-primary';
  $('confirmModal').hidden = false;
  $('acceptConfirm').focus();
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

$('openCreateKey')?.addEventListener('click', () => {
  const form = $('createKeyForm');
  form?.reset();
  if (form) form.elements.secret.value = draftApiKey();
  $('createKeyModal').hidden = false;
  form?.elements.name.focus();
});
$('generateKeySecret')?.addEventListener('click', () => {
  const input = $('createKeyForm')?.elements.secret;
  if (!input) return;
  input.value = draftApiKey();
  input.focus();
  input.select();
});
for (const form of [$('createKeyForm'), $('editKeyForm')]) {
  form?.elements.requestLimitEnabled?.addEventListener('change', (event) => {
    const input = form.elements.requestLimit;
    input.disabled = !event.currentTarget.checked;
    if (input.disabled) input.value = '';
  });
  form?.elements.tokenLimitUnit?.addEventListener('change', (event) => {
    const input = form.elements.tokenLimit;
    input.disabled = !event.currentTarget.value;
    if (input.disabled) input.value = '';
    if (!input.disabled) input.focus();
  });
}
document.querySelectorAll('[data-confirm-close]').forEach((el) => el.addEventListener('click', closeConfirmation));
$('cancelConfirm')?.addEventListener('click', closeConfirmation);
$('acceptConfirm')?.addEventListener('click', async () => {
  const run = confirmation;
  closeConfirmation();
  await run?.();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('confirmModal').hidden) closeConfirmation(); });
document.querySelectorAll('[data-key-close]').forEach((el) => el.addEventListener('click', () => closeKeyModal('createKeyModal')));
document.querySelectorAll('[data-edit-key-close]').forEach((el) => el.addEventListener('click', () => closeKeyModal('editKeyModal')));
document.querySelectorAll('[data-history-close]').forEach((el) => el.addEventListener('click', () => closeKeyModal('historyModal')));
$('closeSecret')?.addEventListener('click', () => closeKeyModal('secretModal'));
$('toggleSecret')?.addEventListener('click', () => {
  const hidden = $('secretValue').classList.toggle('is-hidden');
  $('toggleSecret').textContent = hidden ? 'Show token' : 'Hide token';
});
$('copySecret')?.addEventListener('click', async () => { if (apiKeySecret) { await copyText(apiKeySecret); $('copySecret').textContent = 'Copied'; } });
$('copyKeyEndpoint')?.addEventListener('click', async () => { await copyText(`${location.origin}/v1`); $('copyKeyEndpoint').textContent = 'Copied'; setTimeout(() => { $('copyKeyEndpoint').textContent = 'Copy'; }, 1200); });
$('createKeyForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const note = $('createKeyNote');
  try {
    const values = keyFormValues(form);
    const res = await fetch('/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not create API key.');
    form.reset();
    closeKeyModal('createKeyModal');
    openSecretModal(body.secret);
    await loadApiKeys();
  } catch (err) { detailNote(note, err.message, 'bad'); }
});
$('editKeyForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editingApiKeyId) return;
  const form = event.currentTarget;
  try {
    const values = keyFormValues(form);
    if (!values.secret && form.dataset.hasSecret === 'true') delete values.secret;
    if (!form.elements.requestLimitEnabled.checked) values.requestLimit = null;
    if (!form.elements.tokenLimitUnit.value) values.tokenLimit = null;
    const res = await fetch(`/api/keys/${encodeURIComponent(editingApiKeyId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not update API key.');
    closeKeyModal('editKeyModal');
    await loadApiKeys();
  } catch (err) { detailNote($('editKeyNote'), err.message, 'bad'); }
});
$('generateEditSecret')?.addEventListener('click', () => {
  const input = $('editKeyForm').elements.secret;
  input.value = draftApiKey();
  input.focus();
  input.select();
});
$('generateRotateSecret')?.addEventListener('click', () => {
  const input = $('rotateCustomSecret');
  input.value = draftApiKey();
  input.focus();
  input.select();
});
$('rotateKeySecret')?.addEventListener('click', (event) => {
  if (!editingApiKeyId) return;
  openConfirmation({
    title: 'Rotate token?',
    message: 'Existing clients will stop working immediately.',
    confirmLabel: 'Rotate token',
    run: async () => {
      try {
        const secret = $('rotateCustomSecret').value.trim();
        const res = await fetch(`/api/keys/${encodeURIComponent(editingApiKeyId)}/rotate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(secret ? { secret } : {}) });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error?.message || 'Could not rotate API key.');
        closeKeyModal('editKeyModal');
        openSecretModal(body.secret);
        await loadApiKeys();
      } catch (err) { detailNote($('editKeyNote'), err.message, 'bad'); }
    },
  }, event.currentTarget);
});
$('requireKeyToggle')?.addEventListener('change', async (event) => {
  const value = event.currentTarget.checked;
  try {
    const res = await fetch('/api/auth-settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requireApiKey: value }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not update API-key protection.');
    if (latest) latest.requireApiKey = body.requireApiKey;
    renderApiKeys();
  } catch (err) { event.currentTarget.checked = !value; detailNote($('keyNote'), err.message, 'bad'); }
});
$('keyList')?.addEventListener('click', async (event) => {
  const createEmpty = event.target.closest('[data-create-key-empty]');
  if (createEmpty) {
    $('openCreateKey')?.click();
    return;
  }
  const history = event.target.closest('[data-key-usage]');
  if (history) {
    const id = history.dataset.keyUsage;
    const key = apiKeys.find((item) => item.id === id);
    const list = $('historyModalList');
    $('historyKeyName').textContent = key?.name || 'API key';
    list.innerHTML = '<span class="toolnote">Loading history…</span>';
    $('historyModal').hidden = false;
    const res = await fetch(`/api/keys/${encodeURIComponent(id)}/usage?days=30`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { list.innerHTML = `<span class="toolnote bad">${escapeHtml(body.error?.message || 'Could not load history.')}</span>`; return; }
    list.innerHTML = body.usage.length ? body.usage.map((item) => `<div><strong>${escapeHtml(item.day)}</strong><span>${fmtFull(item.requests)} requests</span><span>${fmtFull(item.tokensIn + item.tokensOut)} tokens</span></div>`).join('') : '<span class="toolnote">No usage history.</span>';
    return;
  }
  const show = event.target.closest('[data-key-show]');
  const copy = event.target.closest('[data-key-copy]');
  const edit = event.target.closest('[data-key-edit]');
  const rotate = event.target.closest('[data-key-rotate]');
  const toggle = event.target.closest('[data-key-toggle]');
  const revoke = event.target.closest('[data-key-revoke]');
  const id = show?.dataset.keyShow || copy?.dataset.keyCopy || edit?.dataset.keyEdit || rotate?.dataset.keyRotate || toggle?.dataset.keyToggle || revoke?.dataset.keyRevoke;
  if (!id) return;
  const key = apiKeys.find((item) => item.id === id);
  if (!key) return;
  if (show) {
    const secret = $(`key-secret-${id}`);
    const hidden = secret.classList.toggle('is-hidden');
    show.textContent = hidden ? 'Show' : 'Hide';
    return;
  }
  if (copy && key.secret) {
    await copyText(key.secret);
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    return;
  }
  if (edit) {
    editingApiKeyId = key.id;
    $('rotateCustomSecret').value = '';
    setKeyFormValues($('editKeyForm'), key);
    detailNote($('editKeyNote'), '', '');
    $('editKeyModal').hidden = false;
    $('editKeyForm').elements.name.focus();
    return;
  }
  if (rotate) {
    editingApiKeyId = key.id;
    $('rotateCustomSecret').value = '';
    $('rotateKeySecret').click();
    return;
  }
  const run = async () => {
    const method = revoke ? 'DELETE' : 'PATCH';
    const options = { method, headers: { 'content-type': 'application/json' } };
    if (!revoke) options.body = JSON.stringify({ enabled: !key.enabled });
    const res = await fetch(`/api/keys/${encodeURIComponent(id)}`, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return detailNote($('keyNote'), body.error?.message || 'API-key action failed.', 'bad');
    await loadApiKeys();
  };
  if (revoke) return openConfirmation({ title: 'Revoke API key?', message: `${key.name} will stop working immediately and its usage history will be deleted.`, confirmLabel: 'Revoke key', danger: true, run }, revoke);
  await run();
});

function paintSettingsTabs() {
  const tabs = [...document.querySelectorAll('[data-settings-tab]')];
  const active = tabs.find((tab) => tab.dataset.settingsTab === settingsTab) || tabs[0];
  if (!active) return;
  settingsTab = active.dataset.settingsTab;
  tabs.forEach((tab) => {
    const selected = tab === active;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('[role="tabpanel"][data-settings-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== settingsTab;
  });
  moveTabIndicator($('settingsTabs'), '[data-settings-tab].is-active');
}

function renderDashboardAuth() {
  const toggle = $('dashboardAuthToggle');
  if (!toggle) return;
  toggle.checked = dashboardAuth.enabled;
  const warning = $('dashboardAuthWarning');
  if (warning) warning.textContent = dashboardAuth.hasPassword ? '' : 'Default password 123456 is active. Change it before enabling protection.';
}

async function loadDashboardAuth() {
  try {
    const res = await fetch('/api/auth/settings', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not load dashboard password settings.');
    dashboardAuth = body;
    renderDashboardAuth();
  } catch (err) {
    if ($('dashboardAuthNote')) $('dashboardAuthNote').textContent = err.message;
  }
}

$('dashboardAuthToggle')?.addEventListener('change', async (event) => {
  const note = $('dashboardAuthNote');
  try {
    const res = await fetch('/api/auth/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: event.currentTarget.checked }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not update dashboard password protection.');
    dashboardAuth = { ...dashboardAuth, ...body };
    renderDashboardAuth();
    if (note) note.textContent = body.enabled ? 'Dashboard password protection enabled.' : 'Dashboard password protection disabled.';
  } catch (err) {
    event.currentTarget.checked = !event.currentTarget.checked;
    if (note) note.textContent = err.message;
  }
});
$('saveDashboardAuthPassword')?.addEventListener('click', async () => {
  const input = $('dashboardAuthPassword');
  const note = $('dashboardAuthNote');
  try {
    const res = await fetch('/api/auth/password', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: input.value }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not save dashboard password.');
    dashboardAuth = { ...dashboardAuth, ...body };
    input.value = '';
    renderDashboardAuth();
    if (note) note.textContent = 'Dashboard password saved.';
  } catch (err) {
    if (note) note.textContent = err.message;
  }
});

function renderTokenSaver() {
  const ponytail = $('tokenSaverPonytail');
  if (!ponytail) return;
  ponytail.checked = tokenSaver.ponytail.enabled;
  const rtk = $('tokenSaverRtk');
  if (rtk) rtk.checked = tokenSaver.rtk.enabled;
  const caveman = $('tokenSaverCaveman');
  if (caveman) caveman.checked = tokenSaver.caveman.enabled;
  const note = $('tokenSaverNote');
  if (note && tokenSaverLoading) note.textContent = 'Loading…';
}

async function loadTokenSaver() {
  tokenSaverLoading = true;
  let loaded = false;
  try {
    const res = await fetch('/api/token-saver', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not load Token Saver settings.');
    tokenSaver = body;
    loaded = true;
  } catch (err) {
    const note = $('tokenSaverNote');
    if (note) note.textContent = err.message;
  } finally {
    tokenSaverLoading = false;
    if (loaded) {
      const note = $('tokenSaverNote');
      if (note) note.textContent = '';
      renderTokenSaver();
    }
  }
}

async function patchTokenSaver(patch) {
  const note = $('tokenSaverNote');
  try {
    const res = await fetch('/api/token-saver', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not save Token Saver settings.');
    tokenSaver = body;
    renderTokenSaver();
    if (note) note.textContent = 'Saved';
  } catch (err) {
    renderTokenSaver();
    if (note) note.textContent = err.message;
  }
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

function renderRequestLog(rows) {
  const table = $('requestLogTable');
  if (!table) return;
  table.innerHTML = rows.length
    ? rows.map((r) => `<tr>
        <td class="mono">${fmtTime(r.at)}</td>
        <td class="r">${r.status == null ? '—' : r.status}</td>
        <td>${escapeHtml(r.provider || '—')}</td>
        <td class="model">${escapeHtml(r.model || '—')}</td>
        <td class="r">${fmtFull(r.tokensIn)}</td>
        <td class="r">${fmtFull(r.tokensOut)}</td>
        <td class="r">${r.ms == null ? '—' : r.ms + ' ms'}</td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="empty" style="border-bottom:0">No chat requests recorded yet.</td></tr>';
}

async function loadRequestLog() {
  const note = $('requestLogNote');
  try {
    const res = await fetch('/api/request-log', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not load request log.');
    renderRequestLog(body.requests || []);
    if (note) note.textContent = '';
  } catch (err) {
    if (note) note.textContent = err.message;
  }
}

$('clearRequestLog')?.addEventListener('click', async () => {
  const note = $('requestLogNote');
  try {
    const res = await fetch('/api/request-log', { method: 'DELETE' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not clear request log.');
    renderRequestLog([]);
    if (note) note.textContent = 'Cleared';
  } catch (err) {
    if (note) note.textContent = err.message;
  }
});

let webhookSettings = { enabled: false, url: '' };

function renderWebhook() {
  const toggle = $('webhookToggle');
  const url = $('webhookUrl');
  if (toggle) toggle.checked = webhookSettings.enabled;
  if (url) url.value = webhookSettings.url || '';
}

async function loadWebhook() {
  const note = $('webhookNote');
  try {
    const res = await fetch('/api/webhook', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not load webhook settings.');
    webhookSettings = body;
    renderWebhook();
    if (note) note.textContent = '';
  } catch (err) {
    if (note) note.textContent = err.message;
  }
}

async function saveWebhook(patch) {
  const note = $('webhookNote');
  try {
    const res = await fetch('/api/webhook', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not save webhook settings.');
    webhookSettings = body;
    renderWebhook();
    if (note) note.textContent = 'Saved';
  } catch (err) {
    renderWebhook();
    if (note) note.textContent = err.message;
  }
}

$('webhookToggle')?.addEventListener('change', (event) => {
  saveWebhook({ enabled: event.currentTarget.checked });
});
$('webhookUrl')?.addEventListener('change', (event) => {
  saveWebhook({ url: event.currentTarget.value.trim() });
});

function renderReplyFilters() {
  const verbosity = $('replyVerbosity');
  const coding = $('replyCoding');
  renderReplyLanguageTrigger();
  renderReplyLanguageGrid();
  if (verbosity) {
    verbosity.value = replyFilters.verbosity;
    syncCustomSelects();
  }
  if (coding) coding.checked = replyFilters.coding;
}

async function loadReplyFilters() {
  const note = $('replyFiltersNote');
  replyFiltersLoading = true;
  if (note) note.textContent = 'Loading…';
  try {
    const res = await fetch('/api/reply-filters', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not load Reply style settings.');
    replyFilters = body;
    renderReplyFilters();
    if (note) note.textContent = '';
  } catch (err) {
    if (note) note.textContent = err.message;
  } finally {
    replyFiltersLoading = false;
  }
}

async function patchReplyFilters(patch) {
  const note = $('replyFiltersNote');
  try {
    const res = await fetch('/api/reply-filters', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not save Reply style settings.');
    replyFilters = body;
    renderReplyFilters();
    if (note) note.textContent = 'Saved';
  } catch (err) {
    renderReplyFilters();
    if (note) note.textContent = err.message;
  }
}

function renderDashboardConnect() {
  const base = $('baseUrl');
  if (base) base.textContent = `${location.origin}/v1`;
  const output = $('dashboardApiKey');
  const button = $('copyApiKey');
  const key = apiKeys.find((item) => item.enabled && item.secret);
  dashboardApiKeySecret = key?.secret || '';
  if (output) output.textContent = key?.masked || 'Not configured';
  if (button) button.disabled = !dashboardApiKeySecret;
}

async function loadAutostart() {
  const toggle = $('autostartToggle');
  const note = $('autostartNote');
  if (!toggle) return;
  try {
    const res = await fetch('/api/settings/autostart', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not load autostart status.');
    toggle.checked = body.enabled;
    toggle.disabled = !body.supported;
    if (!body.supported) detailNote(note, `Autostart is not supported on ${body.platform}.`, 'bad');
  } catch (err) {
    toggle.disabled = true;
    detailNote(note, err.message, 'bad');
  }
}

async function loadDashboardApiKey() {
  try {
    const res = await fetch('/api/keys', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not load API key.');
    apiKeys = body.keys || [];
    renderDashboardConnect();
  } catch {
    dashboardApiKeySecret = '';
    renderDashboardConnect();
  }
}

function renderSettings(data) {
  if (!$('sBaseUrl')) return;
  const ready = data.providers.filter((p) => isReady(p.credential)).length;
  $('sBaseUrl').textContent = `${location.origin}/v1`;
  $('sProviders').textContent = `${ready} of ${data.providers.length} ready`;
  $('sTokenEnv').textContent = 'SQLite account pool';
  $('sStatus').textContent = ready === data.providers.length ? 'ready' : `${ready} of ${data.providers.length} providers ready`;
  $('sUptime').textContent = uptime(data.uptimeSeconds);
  $('sPort').textContent = location.host;
  const portInput = $('serverPort');
  if (portInput && document.activeElement !== portInput) portInput.value = data.port || Number(location.port) || 5555;
  $('sRequireKey').textContent = data.requireApiKey ? 'enabled' : 'disabled';
  paintSettingsTabs();
  renderDashboardAuth();
  renderTokenSaver();
}

