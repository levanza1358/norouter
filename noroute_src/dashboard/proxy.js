/* ---------------- proxy egress ---------------- */

const PROXY_PAGE_SIZE = 5;
const PROXY_NOTE_HOLD_MS = 4000;
const PROXY_SOURCE_LABELS = { manual: 'Manual', import: 'Imported', scrape: 'Scraped' };
const PROXY_SCRAPE_ERRORS = {
  fetch_failed: 'None of the selected sources returned a proxy list.',
  scrape_failed: 'The scrape stopped before finishing.',
  partial: 'Some sources were unreachable; the rest were imported.',
};
// Mirrors the server defaults so the page can paint before the first snapshot
// and still render sensible values if a field is ever missing.
const PROXY_SETTINGS_DEFAULTS = {
  enabled: false,
  strategy: 'round-robin',
  strict: false,
  autoDisableAfter: 3,
  scrape: { auto: false, intervalMinutes: 360, limit: 120 },
};

let proxyData = null;
let proxyRequestId = 0;
let proxySettingsRequestId = 0;
let proxyPoolPage = 1;
let proxyEditingId = '';
let proxyAssignProviderId = '';
let proxyAssignMode = 'global';
let proxySaving = 0;
let proxyFormBusy = false;
let proxyAssignBusy = false;

function proxySettings() {
  const settings = proxyData?.settings || {};
  const scrape = settings.scrape || {};
  const defaults = PROXY_SETTINGS_DEFAULTS;
  return {
    ...defaults,
    ...settings,
    autoDisableAfter: Number.isInteger(settings.autoDisableAfter)
      ? settings.autoDisableAfter
      : defaults.autoDisableAfter,
    scrape: { ...defaults.scrape, ...scrape },
  };
}

// Same rule the server applies before handing a proxy to a request.
function proxyUsable(row, settings) {
  if (!row?.enabled) return false;
  const limit = Number(settings?.autoDisableAfter ?? PROXY_SETTINGS_DEFAULTS.autoDisableAfter);
  return limit === 0 || Number(row.failCount || 0) < limit;
}

function proxyNote(el, text, tone = '') {
  if (!el) return;
  el.className = tone ? `toolnote ${tone}` : 'toolnote';
  el.textContent = text || '';
  delete el.dataset.holdUntil;
}

// Action feedback outlives the two-second poll, but a running job always wins.
function proxyHoldNote(el, text, tone = 'ok') {
  if (!el) return;
  proxyNote(el, text, tone);
  el.dataset.holdUntil = String(Date.now() + PROXY_NOTE_HOLD_MS);
}

function proxyNoteHeld(el) {
  if (!el) return false;
  const until = Number(el.dataset.holdUntil || 0);
  if (until && Date.now() < until) return true;
  if (until) delete el.dataset.holdUntil;
  return false;
}

function setInputValue(input, value) {
  if (!input || input === document.activeElement) return;
  const next = value == null ? '' : String(value);
  if (input.value !== next) input.value = next;
}

function proxyApi(url, options = {}) {
  return fetch(url, { cache: 'no-store', ...options }).then(async (res) => {
    let body = {};
    try { body = await res.json(); } catch { body = {}; }
    return { res, body };
  });
}

function proxyJson(method, payload) {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) };
}

function proxyError(body, fallback) {
  const error = body?.error;
  if (error && typeof error === 'object' && error.message) return String(error.message);
  if (typeof error === 'string' && error) return error;
  return fallback;
}

function proxyInteger(input, min, max) {
  const raw = String(input?.value ?? '').trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function proxySourceName(id) {
  const names = { proxifly: 'Proxifly', monosans: 'monosans', thespeedx: 'TheSpeedX', geonode: 'Geonode' };
  if (names[id]) return names[id];
  const text = String(id || '');
  return text ? text[0].toUpperCase() + text.slice(1) : 'Unknown';
}

function proxyPinnedCounts() {
  const counts = {};
  for (const assignment of Object.values(proxyData?.assignments || {})) {
    if (assignment?.mode === 'pinned' && assignment.proxyId) {
      counts[assignment.proxyId] = (counts[assignment.proxyId] || 0) + 1;
    }
  }
  return counts;
}

function proxyLabelFor(id) {
  const row = (proxyData?.proxies || []).find((item) => item.id === id);
  return row ? row.label : 'missing proxy';
}

async function loadProxy({ quiet = false } = {}) {
  if (currentPath !== '/proxy') return;
  const requestId = ++proxyRequestId;
  const list = $('proxyList');
  if (!quiet && !proxyData && list) {
    list.innerHTML = `<div class="empty key-empty"><strong>Loading the pool…</strong><span>Reading saved proxies and routing rules.</span></div>`;
  }
  try {
    const { res, body } = await proxyApi('/api/proxy');
    if (!res.ok) throw new Error(proxyError(body, 'Could not load the proxy pool.'));
    if (requestId !== proxyRequestId || currentPath !== '/proxy') return;
    // A snapshot that started before an in-flight settings save must not put
    // the old values back on screen.
    const pendingSettings = proxySaving ? proxyData?.settings : null;
    proxyData = body;
    if (pendingSettings) proxyData.settings = pendingSettings;
    paintProxy();
  } catch (err) {
    if (requestId !== proxyRequestId || currentPath !== '/proxy') return;
    if (!proxyData && list) {
      list.innerHTML = `<div class="empty key-empty"><strong>Could not load the pool</strong><span>${escapeHtml(err.message)}</span><button class="btn btn-ghost btn-xs" type="button" data-proxy-retry>Retry</button></div>`;
    }
    proxyHoldNote($('proxyPoolNote'), err.message, 'bad');
  }
}

function paintProxy() {
  if (!proxyData) return;
  const settings = proxySettings();
  paintProxyStats(settings);
  paintProxyEgress(settings);
  paintProxyScrape(settings, proxyData.scrape);
  paintProxyAssignments();
  paintProxyPool();
}

function paintProxyStats(settings) {
  const rows = proxyData.proxies || [];
  const stats = proxyData.stats || {};
  $('proxyTotal').textContent = fmtFull(rows.length);
  $('proxyEnabledCount').textContent = fmtFull(rows.filter((row) => proxyUsable(row, settings)).length);
  $('proxyHealthy').textContent = fmtFull(rows.filter((row) => row.status === 'ok').length);
  $('proxyProxied').textContent = fmtFull(stats.proxied || 0);
}

function paintProxyEgress(settings) {
  const rows = proxyData.proxies || [];
  const usable = rows.filter((row) => proxyUsable(row, settings));
  if (!proxySaving) {
    const enabled = $('proxyEnabled');
    if (enabled) enabled.checked = settings.enabled;
    const strict = $('proxyStrict');
    if (strict) strict.checked = settings.strict;
    setInputValue($('proxyAutoDisable'), settings.autoDisableAfter);
    document.querySelectorAll('[data-proxy-strategy]').forEach((tab) => {
      const active = tab.dataset.proxyStrategy === settings.strategy;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-pressed', String(active));
    });
    syncToggleLabels();
  }

  const note = $('proxyEgressNote');
  if (proxyNoteHeld(note)) return;
  const stats = proxyData.stats || {};
  const summary = `${fmtFull(usable.length)} usable · ${fmtFull(stats.proxied || 0)} proxied · ${fmtFull(stats.fallbackDirect || 0)} direct fallbacks`;
  if (!settings.enabled) {
    proxyNote(note, 'Egress is direct: the pool is saved but not used.');
  } else if (!usable.length) {
    proxyNote(note, settings.strict
      ? 'Strict is on and no proxy is usable — data-plane requests will fail.'
      : 'No proxy is usable; data-plane requests fall back to a direct connection.',
    settings.strict ? 'bad' : '');
  } else {
    const last = stats.lastError;
    proxyNote(note, last ? `${summary} · last failure ${last.code}` : summary, last ? 'bad' : '');
  }
}

function paintProxyScrape(settings, scrape) {
  if (!proxySaving) {
    const auto = $('scrapeAuto');
    if (auto) auto.checked = settings.scrape.auto;
    setInputValue($('scrapeInterval'), settings.scrape.intervalMinutes);
    setInputValue($('scrapeLimit'), settings.scrape.limit);
    syncToggleLabels();
  }

  const running = Boolean(scrape?.running);
  const now = $('scrapeNow');
  if (now) now.disabled = running;
  paintProxyScrapeSources(scrape);

  const state = $('scrapeState');
  if (state) {
    let label = 'idle';
    let tone = 'chip-quiet';
    if (running) {
      label = 'scraping';
    } else if (scrape?.error) {
      label = 'failed';
      tone = 'chip-bad';
    } else if (scrape?.finishedAt) {
      label = 'done';
      tone = 'chip-ok';
    }
    state.className = `chip ${tone}`;
    state.textContent = label;
  }

  const note = $('scrapeNote');
  if (!note) return;
  if (running) {
    proxyNote(note, `Probing candidates · ${fmtFull(scrape.tested || 0)} tested · ${fmtFull(scrape.passed || 0)} reachable · ${fmtFull(scrape.added || 0)} added.`);
    return;
  }
  if (proxyNoteHeld(note)) return;
  if (scrape?.error) {
    proxyNote(note, PROXY_SCRAPE_ERRORS[scrape.error] || 'The scrape failed.', 'bad');
  } else if (scrape?.finishedAt) {
    proxyNote(note, `Last scrape tested ${fmtFull(scrape.tested || 0)} · ${fmtFull(scrape.passed || 0)} reachable · ${fmtFull(scrape.added || 0)} added · ${fmtFull(scrape.duplicates || 0)} duplicates.`);
  } else {
    proxyNote(note, 'No scrape has run yet.');
  }
}

function paintProxyScrapeSources(scrape) {
  const host = $('scrapeSourceList');
  if (!host) return;
  const sources = Array.isArray(scrape?.sources) ? scrape.sources : [];
  if (!sources.length) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = sources.map((source) => {
    const status = source.status || 'pending';
    let detail = 'not run';
    if (status === 'ok') detail = `${fmtFull(source.found || 0)} found`;
    else if (status === 'failed') detail = 'unreachable';
    else if (scrape?.running) detail = 'waiting…';
    return `<div class="proxy-source-row">
      <span class="proxy-source-name">${escapeHtml(proxySourceName(source.id))}</span>
      <span class="proxy-source-count ${escapeHtml(status)}">${escapeHtml(detail)}</span>
    </div>`;
  }).join('');
}

function paintProxyAssignments() {
  const host = $('proxyProviderList');
  if (!host) return;
  const providers = Array.isArray(proxyData.providers) ? proxyData.providers : [];
  const assignments = proxyData.assignments || {};
  const rows = providers.map((provider) => ({
    provider,
    assignment: assignments[provider.id] || { mode: 'global', proxyId: '' },
  }));
  const custom = rows.filter(({ assignment }) => assignment.mode !== 'global').length;
  $('proxyAssignCount').textContent = custom ? `${fmtFull(custom)} custom` : `${fmtFull(rows.length)} providers`;

  if (!rows.length) {
    host.innerHTML = `<div class="empty key-empty"><strong>No providers</strong><span>Add a provider before routing its traffic.</span></div>`;
    return;
  }

  const signature = rows.map(({ provider, assignment }) => [provider.id, provider.name, provider.prefix, assignment.mode, assignment.proxyId]);
  if (!dashboardSignature('proxy.providers', signature)) return;

  host.innerHTML = rows.map(({ provider, assignment }) => {
    const pinned = assignment.mode === 'pinned' ? proxyLabelFor(assignment.proxyId) : '';
    const label = assignment.mode === 'pinned'
      ? `Pinned · ${pinned}`
      : assignment.mode === 'direct' ? 'Direct' : 'Global pool';
    return `<div class="proxy-provider-row">
      <div class="proxy-provider-main">
        <strong>${escapeHtml(provider.name || provider.id)}</strong>
        <code>${escapeHtml(provider.prefix || provider.id)}</code>
      </div>
      <span class="chip chip-quiet proxy-provider-mode">${escapeHtml(label)}</span>
      <button class="btn btn-ghost btn-xs" type="button" data-proxy-assign="${escapeHtml(provider.id)}">Route</button>
    </div>`;
  }).join('');
  staggerChildren(host, '.proxy-provider-row', 'proxy.providers');
}

function paintProxyPool() {
  const list = $('proxyList');
  if (!list) return;
  const rows = Array.isArray(proxyData.proxies) ? proxyData.proxies : [];
  const testing = proxyData.testing || { running: false };
  const running = Boolean(testing.running);

  const testAll = $('testAllProxies');
  if (testAll) testAll.disabled = running || !rows.length;
  $('proxyPoolCount').textContent = `${fmtFull(rows.length)} saved`;

  const note = $('proxyPoolNote');
  if (running) {
    proxyNote(note, `Testing pool · ${fmtFull(testing.tested || 0)} probed · ${fmtFull(testing.ok || 0)} ok · ${fmtFull(testing.failed || 0)} failed.`);
  } else if (!proxyNoteHeld(note)) {
    proxyNote(note, '');
  }

  if (!rows.length) {
    $('proxyPager').hidden = true;
    if (dashboardSignature('proxy.pool', ['empty', running])) {
      list.innerHTML = `<div class="empty key-empty"><strong>No proxies saved</strong><span>Add one manually, import a list, or scrape the free pools.</span><button class="btn btn-primary btn-xs" type="button" data-proxy-empty-add>Add proxy</button></div>`;
    }
    return;
  }

  const pinned = proxyPinnedCounts();
  const pinnedSignature = Object.entries(pinned).sort(([a], [b]) => a.localeCompare(b));
  const signature = [
    'pool',
    proxyPoolPage,
    running,
    testing.tested || 0,
    testing.ok || 0,
    testing.failed || 0,
    pinnedSignature,
    rows.map((row) => [
      row.id, row.label, row.maskedUrl, row.enabled, row.status, row.latencyMs,
      row.failCount, row.lastChecked, row.lastError, row.source, row.updatedAt,
    ]),
  ];
  if (!dashboardSignature('proxy.pool', signature)) return;

  proxyPoolPage = paintUsagePager({
    pager: $('proxyPager'),
    info: $('proxyPageInfo'),
    btns: $('proxyPageBtns'),
    items: rows,
    page: proxyPoolPage,
    pageSize: PROXY_PAGE_SIZE,
    noun: 'proxies',
    onSelect: (page) => { proxyPoolPage = page; paintProxyPool(); },
  });
  const visible = usagePageSlice(rows, proxyPoolPage, PROXY_PAGE_SIZE).items;
  list.innerHTML = visible.map((row) => proxyRowMarkup(row, pinned[row.id] || 0, running)).join('');
  staggerChildren(list, '.proxy-row', `proxy.pool.${proxyPoolPage}.${rows.length}`);
}

function proxyRowMarkup(row, pinnedCount, testing) {
  const enabled = Boolean(row.enabled);
  const benched = enabled && !proxyUsable(row, proxySettings());
  const tone = row.status === 'ok' ? 'ok' : row.status === 'fail' ? 'bad' : 'quiet';
  const status = row.status === 'ok' ? 'reachable' : row.status === 'fail' ? 'failed' : 'unverified';
  const latency = row.latencyMs == null ? '—' : `${fmtFull(row.latencyMs)} ms`;
  const checked = row.lastChecked ? `Checked ${relTime(row.lastChecked)}` : 'Never probed';
  const source = PROXY_SOURCE_LABELS[row.source] || row.source || 'Manual';
  const chips = [
    row.hasAuth ? '<span class="chip chip-quiet">auth</span>' : '',
    benched ? '<span class="chip chip-bad">benched</span>' : '',
    pinnedCount ? `<span class="chip chip-quiet">pinned ×${fmtFull(pinnedCount)}</span>` : '',
  ].join('');
  return `<div class="key-row proxy-row${enabled ? '' : ' is-off'}">
    <div class="key-icon" aria-hidden="true">⇄</div>
    <div class="key-main">
      <div class="key-identity">
        <strong>${escapeHtml(row.label || row.maskedUrl)}</strong>
        <span class="status-pill ${tone}"><span class="dot"></span>${status}</span>
        ${chips}
      </div>
      <code class="proxy-url">${escapeHtml(row.maskedUrl)}</code>
      <small class="proxy-meta">${escapeHtml(source)} · ${escapeHtml(checked)}${row.lastError ? ` · <span class="proxy-last-error">${escapeHtml(row.lastError)}</span>` : ''}</small>
    </div>
    <div class="key-limits proxy-metrics">
      <div class="proxy-metric"><span>Latency</span><b>${escapeHtml(latency)}</b></div>
      <div class="proxy-metric"><span>Failures</span><b>${fmtFull(row.failCount || 0)}</b></div>
    </div>
    <div class="key-row-actions proxy-row-actions">
      <label class="mini-toggle proxy-row-toggle"><input type="checkbox" data-proxy-toggle="${escapeHtml(row.id)}"${enabled ? ' checked' : ''}><span></span><b>${enabled ? 'On' : 'Off'}</b></label>
      <button class="btn btn-ghost btn-xs" type="button" data-proxy-test="${escapeHtml(row.id)}"${testing ? ' disabled' : ''}>Test</button>
      <button class="btn btn-ghost btn-xs" type="button" data-proxy-edit="${escapeHtml(row.id)}">Rename</button>
      <details class="key-more"><summary class="btn btn-ghost btn-xs">More</summary><div class="key-more-menu"><button class="danger" type="button" data-proxy-delete="${escapeHtml(row.id)}">Delete proxy</button></div></details>
    </div>
  </div>`;
}

function mergedProxySettings(patch) {
  const current = proxySettings();
  const next = { ...current, ...patch };
  if (patch.scrape) next.scrape = { ...current.scrape, ...patch.scrape };
  return next;
}

async function saveProxySettings(patch, okText, noteEl = $('proxyEgressNote')) {
  if (!proxyData) return false;
  const previous = proxySettings();
  const requestId = ++proxySettingsRequestId;
  proxySaving += 1;
  proxyData.settings = mergedProxySettings(patch);
  paintProxy();
  try {
    const { res, body } = await proxyApi('/api/proxy', proxyJson('PATCH', patch));
    if (!res.ok) throw new Error(proxyError(body, 'Could not save proxy settings.'));
    proxySaving = Math.max(0, proxySaving - 1);
    if (requestId === proxySettingsRequestId) {
      proxyData.settings = body.settings || proxyData.settings;
      paintProxy();
      proxyHoldNote(noteEl, okText, 'ok');
    }
    return true;
  } catch (err) {
    proxySaving = Math.max(0, proxySaving - 1);
    if (requestId === proxySettingsRequestId) {
      proxyData.settings = previous;
      paintProxy();
      proxyHoldNote(noteEl, err.message, 'bad');
    }
    return false;
  }
}

async function updateProxyRow(id, patch, previous) {
  const row = (proxyData?.proxies || []).find((item) => item.id === id);
  if (!row) return;
  Object.assign(row, patch);
  paintProxy();
  try {
    const { res, body } = await proxyApi(`/api/proxies/${encodeURIComponent(id)}`, proxyJson('PATCH', patch));
    if (!res.ok) throw new Error(proxyError(body, 'Could not update the proxy.'));
    if (body.proxy && row) Object.assign(row, body.proxy);
    paintProxy();
  } catch (err) {
    if (row) Object.assign(row, previous);
    paintProxy();
    proxyHoldNote($('proxyPoolNote'), err.message, 'bad');
  }
}

function closeProxyModal(id) {
  const modal = $(id);
  if (!modal) return;
  modal.hidden = true;
  if (id === 'proxyEditModal') proxyEditingId = '';
}

function openProxyAdd() {
  const form = $('proxyForm');
  form?.reset();
  if (form) form.elements.url.value = '';
  proxyNote($('proxyFormNote'), '', '');
  syncCustomSelects();
  $('proxyModal').hidden = false;
  form?.elements.url.focus();
}

function openProxyImport() {
  const form = $('proxyImportForm');
  form?.reset();
  proxyNote($('proxyImportNote'), '', '');
  $('proxyImportModal').hidden = false;
  form?.elements.text.focus();
}

function openProxyEdit(id) {
  const row = (proxyData?.proxies || []).find((item) => item.id === id);
  if (!row) return;
  proxyEditingId = id;
  const form = $('proxyEditForm');
  form?.reset();
  if (form) form.elements.label.value = row.label;
  proxyNote($('proxyEditNote'), '', '');
  $('proxyEditModal').hidden = false;
  form?.elements.label.focus();
  form?.elements.label.select();
}

function paintProxyAssignModes() {
  document.querySelectorAll('[data-assign-mode]').forEach((tab) => {
    const active = tab.dataset.assignMode === proxyAssignMode;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-pressed', String(active));
  });
  const field = $('proxyAssignTargetField');
  if (field) field.hidden = proxyAssignMode !== 'pinned';
  const save = $('proxyAssignSave');
  if (save) save.disabled = proxyAssignMode === 'pinned' && !$('proxyAssignTarget')?.value;
}

function openProxyAssign(providerId) {
  const provider = (proxyData?.providers || []).find((item) => item.id === providerId);
  if (!provider) return;
  proxyAssignProviderId = provider.id;
  const assignment = proxyData.assignments?.[provider.id] || { mode: 'global', proxyId: '' };
  proxyAssignMode = assignment.mode;
  $('proxyAssignDesc').textContent = `${provider.name || provider.id} · ${provider.prefix || provider.id}`;

  const target = $('proxyAssignTarget');
  const options = (proxyData.proxies || []).filter((row) => row.enabled);
  target.innerHTML = options.length
    ? options.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.label)} · ${escapeHtml(row.maskedUrl)}</option>`).join('')
    : '<option value="">No enabled proxy</option>';
  if (assignment.proxyId && options.some((row) => row.id === assignment.proxyId)) {
    target.value = assignment.proxyId;
  }
  syncCustomSelects();

  if (proxyAssignMode === 'pinned' && !options.length) {
    proxyNote($('proxyAssignModalNote'), 'Enable a proxy first, then pin it here.', 'bad');
  } else {
    proxyNote($('proxyAssignModalNote'), '', '');
  }
  paintProxyAssignModes();
  $('proxyAssignModal').hidden = false;
  $('proxyAssignSave').focus();
}

async function saveProxyAssignment() {
  if (proxyAssignBusy || !proxyAssignProviderId) return;
  const target = $('proxyAssignTarget');
  const proxyId = proxyAssignMode === 'pinned' ? String(target?.value || '') : '';
  if (proxyAssignMode === 'pinned' && !proxyId) {
    proxyNote($('proxyAssignModalNote'), 'Pick an enabled proxy to pin.', 'bad');
    return;
  }
  const save = $('proxyAssignSave');
  proxyAssignBusy = true;
  if (save) { save.disabled = true; save.textContent = 'Applying…'; }
  proxyNote($('proxyAssignModalNote'), 'Saving…', '');
  try {
    const { res, body } = await proxyApi(
      `/api/proxy/providers/${encodeURIComponent(proxyAssignProviderId)}`,
      proxyJson('PUT', { mode: proxyAssignMode, proxyId }),
    );
    if (!res.ok) throw new Error(proxyError(body, 'Could not save the assignment.'));
    if (proxyData) proxyData.assignments = body.assignments || proxyData.assignments;
    $('proxyAssignModal').hidden = true;
    paintProxy();
    const name = (proxyData?.providers || []).find((item) => item.id === proxyAssignProviderId)?.name || proxyAssignProviderId;
    const via = proxyAssignMode === 'global'
      ? 'the global pool'
      : proxyAssignMode === 'direct' ? 'a direct connection' : 'its pinned proxy';
    proxyHoldNote($('proxyAssignNote'), `${name} now routes via ${via}.`, 'ok');
  } catch (err) {
    proxyNote($('proxyAssignModalNote'), err.message, 'bad');
  } finally {
    proxyAssignBusy = false;
    if (save) { save.disabled = false; save.textContent = 'Apply'; }
    paintProxyAssignModes();
  }
}

async function submitProxy(event) {
  event.preventDefault();
  if (proxyFormBusy) return;
  const form = event.currentTarget;
  const note = $('proxyFormNote');
  const url = String(form.elements.url.value || '').trim();
  const host = String(form.elements.host.value || '').trim();
  const port = String(form.elements.port.value || '').trim();
  let payload;
  if (url) {
    payload = { url };
  } else {
    if (!host || !port) {
      proxyNote(note, 'Enter a proxy URL, or a host and port.', 'bad');
      return;
    }
    payload = {
      protocol: form.elements.protocol.value,
      host,
      port: Number(port),
      username: String(form.elements.username.value || ''),
      password: String(form.elements.password.value || ''),
    };
  }
  payload.test = form.elements.test.checked;
  const label = String(form.elements.label.value || '').trim();
  if (label) payload.label = label;

  proxyFormBusy = true;
  const submit = form.querySelector('button[type="submit"]');
  if (submit) { submit.disabled = true; submit.textContent = 'Adding…'; }
  proxyNote(note, payload.test ? 'Saving and probing the proxy…' : 'Saving the proxy…', '');
  try {
    const { res, body } = await proxyApi('/api/proxies', proxyJson('POST', payload));
    if (!res.ok) throw new Error(proxyError(body, 'Could not add the proxy.'));
    $('proxyModal').hidden = true;
    await loadProxy({ quiet: true });
    const probe = payload.test === false || !body.test
      ? 'not probed yet'
      : body.test.ok ? `probe ok in ${fmtFull(body.test.latencyMs || 0)} ms` : 'probe failed';
    proxyHoldNote($('proxyPoolNote'), `${body.proxy?.maskedUrl || 'Proxy'} saved · ${probe}.`, body.test && !body.test.ok ? 'bad' : 'ok');
  } catch (err) {
    proxyNote(note, err.message, 'bad');
  } finally {
    proxyFormBusy = false;
    if (submit) { submit.disabled = false; submit.textContent = 'Add proxy'; }
  }
}

async function submitProxyImport(event) {
  event.preventDefault();
  if (proxyFormBusy) return;
  const form = event.currentTarget;
  const note = $('proxyImportNote');
  const text = String(form.elements.text.value || '').trim();
  if (!text) {
    proxyNote(note, 'Paste at least one proxy URL.', 'bad');
    return;
  }
  proxyFormBusy = true;
  const submit = form.querySelector('button[type="submit"]');
  if (submit) { submit.disabled = true; submit.textContent = 'Importing…'; }
  proxyNote(note, 'Importing and checking each line…', '');
  try {
    const { res, body } = await proxyApi('/api/proxies/import', proxyJson('POST', { text }));
    if (!res.ok) throw new Error(proxyError(body, 'Could not import proxies.'));
    $('proxyImportModal').hidden = true;
    form.reset();
    await loadProxy({ quiet: true });
    proxyHoldNote(
      $('proxyPoolNote'),
      `${fmtFull(body.added)} added · ${fmtFull(body.duplicates)} duplicates · ${fmtFull(body.invalid)} invalid.`,
      body.added ? 'ok' : '',
    );
  } catch (err) {
    proxyNote(note, err.message, 'bad');
  } finally {
    proxyFormBusy = false;
    if (submit) { submit.disabled = false; submit.textContent = 'Import'; }
  }
}

async function submitProxyEdit(event) {
  event.preventDefault();
  if (proxyFormBusy || !proxyEditingId) return;
  const form = event.currentTarget;
  const note = $('proxyEditNote');
  const label = String(form.elements.label.value || '').trim();
  if (!label) {
    proxyNote(note, 'Enter a label.', 'bad');
    return;
  }
  proxyFormBusy = true;
  const submit = form.querySelector('button[type="submit"]');
  if (submit) { submit.disabled = true; submit.textContent = 'Saving…'; }
  proxyNote(note, 'Saving…', '');
  try {
    const { res, body } = await proxyApi(`/api/proxies/${encodeURIComponent(proxyEditingId)}`, proxyJson('PATCH', { label }));
    if (!res.ok) throw new Error(proxyError(body, 'Could not rename the proxy.'));
    const row = (proxyData?.proxies || []).find((item) => item.id === proxyEditingId);
    if (row && body.proxy) Object.assign(row, body.proxy);
    $('proxyEditModal').hidden = true;
    proxyEditingId = '';
    paintProxy();
    proxyHoldNote($('proxyPoolNote'), `Renamed to ${label}.`, 'ok');
  } catch (err) {
    proxyNote(note, err.message, 'bad');
  } finally {
    proxyFormBusy = false;
    if (submit) { submit.disabled = false; submit.textContent = 'Save label'; }
  }
}

function deleteProxyRow(id) {
  const row = (proxyData?.proxies || []).find((item) => item.id === id);
  if (!row) return;
  const opener = document.querySelector(`[data-proxy-delete="${id}"]`);
  openConfirmation({
    title: 'Delete proxy',
    message: `Remove ${row.label} (${row.maskedUrl}) from the pool? Providers pinned to it fall back to the global pool.`,
    confirmLabel: 'Delete proxy',
    danger: true,
    run: async () => {
      try {
        const { res, body } = await proxyApi(`/api/proxies/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(proxyError(body, 'Could not delete the proxy.'));
        await loadProxy({ quiet: true });
        proxyHoldNote($('proxyPoolNote'), `${row.maskedUrl} deleted.`, 'ok');
      } catch (err) {
        proxyHoldNote($('proxyPoolNote'), err.message, 'bad');
      }
    },
  }, opener);
}

async function testProxyRow(id, button) {
  const row = (proxyData?.proxies || []).find((item) => item.id === id);
  if (!row) return;
  if (button) { button.disabled = true; button.textContent = 'Testing…'; }
  proxyHoldNote($('proxyPoolNote'), `Probing ${row.maskedUrl}…`, '');
  try {
    const { res, body } = await proxyApi(`/api/proxies/${encodeURIComponent(id)}/test`, { method: 'POST' });
    if (!res.ok) throw new Error(proxyError(body, 'Could not test the proxy.'));
    await loadProxy({ quiet: true });
    proxyHoldNote(
      $('proxyPoolNote'),
      body.ok
        ? `${row.maskedUrl} reachable in ${fmtFull(body.latencyMs || 0)} ms.`
        : `${row.maskedUrl} failed${body.error ? `: ${body.error}` : '.'}`,
      body.ok ? 'ok' : 'bad',
    );
  } catch (err) {
    proxyHoldNote($('proxyPoolNote'), err.message, 'bad');
  } finally {
    if (button?.isConnected) {
      button.disabled = Boolean(proxyData?.testing?.running);
      button.textContent = 'Test';
    }
  }
}

function adoptProxyTesting(testing) {
  if (!proxyData || !testing) return;
  proxyData.testing = testing;
  paintProxyPool();
}

function adoptProxyScrape(scrape) {
  if (!proxyData || !scrape) return;
  proxyData.scrape = scrape;
  paintProxyScrape(proxySettings(), scrape);
}

async function runPoolTest() {
  if (!proxyData) return;
  if (proxyData.testing?.running) return;
  const button = $('testAllProxies');
  if (button) { button.disabled = true; button.textContent = 'Testing…'; }
  try {
    const { res, body } = await proxyApi('/api/proxies/test', proxyJson('POST', {}));
    if (res.status === 409 && body.testing) {
      adoptProxyTesting(body.testing);
      return;
    }
    if (!res.ok) throw new Error(proxyError(body, 'Could not start the pool test.'));
    adoptProxyTesting(body.testing);
  } catch (err) {
    proxyHoldNote($('proxyPoolNote'), err.message, 'bad');
    if (button) button.disabled = false;
  } finally {
    if (button) button.textContent = 'Test all';
  }
}

async function runProxyScrape() {
  if (!proxyData || proxyData.scrape?.running) return;
  const sources = [...document.querySelectorAll('[data-scrape-source]')]
    .filter((input) => input.checked)
    .map((input) => input.value);
  if (!sources.length) {
    proxyHoldNote($('scrapeNote'), 'Pick at least one source.', 'bad');
    return;
  }
  const limitInput = $('scrapeLimit');
  const hasLimit = String(limitInput?.value ?? '').trim() !== '';
  const limit = hasLimit ? proxyInteger(limitInput, 10, 1000) : null;
  if (hasLimit && limit == null) {
    proxyHoldNote($('scrapeNote'), 'Probe limit must be a whole number from 10 to 1000.', 'bad');
    return;
  }

  const button = $('scrapeNow');
  if (button) { button.disabled = true; button.textContent = 'Scraping…'; }
  try {
    const payload = { sources };
    if (limit != null) payload.limit = limit;
    const { res, body } = await proxyApi('/api/proxy/scrape', proxyJson('POST', payload));
    if (res.status === 409 && body.scrape) {
      adoptProxyScrape(body.scrape);
      return;
    }
    if (!res.ok) throw new Error(proxyError(body, 'Could not start the scrape.'));
    adoptProxyScrape(body.scrape);
  } catch (err) {
    proxyHoldNote($('scrapeNote'), err.message, 'bad');
    if (button) button.disabled = false;
  } finally {
    if (button) button.textContent = 'Scrape now';
  }
}

/* ---------------- wiring ---------------- */

$('proxyEnabled')?.addEventListener('change', (event) => {
  saveProxySettings(
    { enabled: event.target.checked },
    event.target.checked ? 'Proxy egress enabled.' : 'Proxy egress disabled: traffic goes direct.',
  );
});

$('proxyStrict')?.addEventListener('change', (event) => {
  saveProxySettings(
    { strict: event.target.checked },
    event.target.checked ? 'Strict mode enabled.' : 'Strict mode disabled.',
  );
});

document.querySelectorAll('[data-proxy-strategy]').forEach((tab) => {
  tab.addEventListener('click', () => {
    const strategy = tab.dataset.proxyStrategy;
    if (strategy === proxySettings().strategy) return;
    saveProxySettings({ strategy }, `Strategy set to ${strategy === 'random' ? 'random' : 'round robin'}.`);
  });
});

$('saveProxyAutoDisable')?.addEventListener('click', () => {
  const value = proxyInteger($('proxyAutoDisable'), 0, 100);
  if (value == null) {
    proxyHoldNote($('proxyEgressNote'), 'Bench threshold must be a whole number from 0 to 100.', 'bad');
    return;
  }
  saveProxySettings(
    { autoDisableAfter: value },
    value === 0 ? 'Automatic benching is off.' : `Proxies bench after ${value} failures.`,
  );
});

$('scrapeAuto')?.addEventListener('change', (event) => {
  saveProxySettings(
    { scrape: { auto: event.target.checked } },
    event.target.checked ? 'Scheduled scraping enabled.' : 'Scheduled scraping disabled.',
    $('scrapeNote'),
  );
});

$('saveScrapeInterval')?.addEventListener('click', () => {
  const value = proxyInteger($('scrapeInterval'), 30, 10080);
  if (value == null) {
    proxyHoldNote($('scrapeNote'), 'Interval must be a whole number from 30 to 10080 minutes.', 'bad');
    return;
  }
  saveProxySettings(
    { scrape: { intervalMinutes: value } },
    `Scheduled scrape interval set to ${value} minutes.`,
    $('scrapeNote'),
  );
});

$('saveScrapeLimit')?.addEventListener('click', () => {
  const value = proxyInteger($('scrapeLimit'), 10, 1000);
  if (value == null) {
    proxyHoldNote($('scrapeNote'), 'Probe limit must be a whole number from 10 to 1000.', 'bad');
    return;
  }
  saveProxySettings({ scrape: { limit: value } }, `Probe limit set to ${value}.`, $('scrapeNote'));
});

$('scrapeNow')?.addEventListener('click', runProxyScrape);
$('testAllProxies')?.addEventListener('click', runPoolTest);
$('openAddProxy')?.addEventListener('click', openProxyAdd);
$('openImportProxy')?.addEventListener('click', openProxyImport);

$('proxyForm')?.addEventListener('submit', submitProxy);
$('proxyImportForm')?.addEventListener('submit', submitProxyImport);
$('proxyEditForm')?.addEventListener('submit', submitProxyEdit);
$('proxyAssignSave')?.addEventListener('click', saveProxyAssignment);
$('proxyAssignTarget')?.addEventListener('change', paintProxyAssignModes);

document.querySelectorAll('[data-assign-mode]').forEach((tab) => {
  tab.addEventListener('click', () => {
    proxyAssignMode = tab.dataset.assignMode;
    proxyNote($('proxyAssignModalNote'), '', '');
    paintProxyAssignModes();
  });
});

document.querySelectorAll('[data-proxy-close]').forEach((el) => {
  el.addEventListener('click', () => closeProxyModal('proxyModal'));
});
document.querySelectorAll('[data-proxy-import-close]').forEach((el) => {
  el.addEventListener('click', () => closeProxyModal('proxyImportModal'));
});
document.querySelectorAll('[data-proxy-edit-close]').forEach((el) => {
  el.addEventListener('click', () => closeProxyModal('proxyEditModal'));
});
document.querySelectorAll('[data-proxy-assign-close]').forEach((el) => {
  el.addEventListener('click', () => closeProxyModal('proxyAssignModal'));
});

$('proxyList')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-proxy-retry]')) { loadProxy(); return; }
  if (event.target.closest('[data-proxy-empty-add]')) { openProxyAdd(); return; }
  const test = event.target.closest('[data-proxy-test]');
  if (test) { testProxyRow(test.dataset.proxyTest, test); return; }
  const edit = event.target.closest('[data-proxy-edit]');
  if (edit) { openProxyEdit(edit.dataset.proxyEdit); return; }
  const remove = event.target.closest('[data-proxy-delete]');
  if (remove) { deleteProxyRow(remove.dataset.proxyDelete); }
});

$('proxyList')?.addEventListener('change', (event) => {
  const toggle = event.target.closest('[data-proxy-toggle]');
  if (!toggle) return;
  const row = (proxyData?.proxies || []).find((item) => item.id === toggle.dataset.proxyToggle);
  if (!row) return;
  updateProxyRow(toggle.dataset.proxyToggle, { enabled: toggle.checked }, { enabled: row.enabled });
});

$('proxyProviderList')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-proxy-assign]');
  if (button) openProxyAssign(button.dataset.proxyAssign);
});

// Capture phase so an open custom-select popup swallows the first Escape; the
// second closes only the topmost proxy dialog. The confirmation modal owns its
// own Escape handling.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || currentPath !== '/proxy') return;
  if (document.querySelector('.cselect.is-open')) return;
  const confirm = $('confirmModal');
  if (confirm && !confirm.hidden) return;
  const open = ['proxyModal', 'proxyImportModal', 'proxyEditModal', 'proxyAssignModal']
    .map((id) => $(id)).filter((modal) => modal && !modal.hidden);
  if (!open.length) return;
  closeProxyModal(open.at(-1).id);
  event.preventDefault();
  event.stopPropagation();
}, true);
