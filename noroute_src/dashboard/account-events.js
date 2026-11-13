/* ---------------- account pool events ---------------- */

document.querySelectorAll('.dtab[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => setDetailTab(btn.dataset.tab));
});

document.querySelectorAll('[data-dusage-range]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (dUsageRange === btn.dataset.dusageRange) return;
    dUsageRange = btn.dataset.dusageRange;
    loadProviderUsage();
  });
});

// Roving tabindex: only the selected tab is in the tab order, and the arrow
// keys move between tabs and activate them, per the ARIA tabs pattern.
$('dTabs')?.addEventListener('keydown', (event) => {
  const tabs = [...document.querySelectorAll('#dTabs .dtab')];
  const current = tabs.indexOf(document.activeElement);
  if (current === -1) return;
  let next = null;
  if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  if (next === null) return;
  event.preventDefault();
  tabs[next].focus();
  setDetailTab(tabs[next].dataset.tab);
});

$('openAddAccount')?.addEventListener('click', () => setAccountModal(true));
$('openBulk')?.addEventListener('click', () => setAccountModal(true, 'bulk'));
$('chooseProviderToken')?.addEventListener('click', () => setAccountModal(true, 'form'));
$('cancelProviderOAuth')?.addEventListener('click', async () => {
  const note = $('providerOAuthNote');
  const providerId = detail?.provider?.id;
  if (providerId && note?.dataset.state) await fetch(`/api/providers/${encodeURIComponent(providerId)}/oauth/cancel/${encodeURIComponent(note.dataset.state)}`, { method: 'POST' }).catch(() => {});
  finishProviderOAuth(note, 'OAuth cancelled.');
});
$('startProviderOAuth')?.addEventListener('click', async () => {
  const note = $('providerOAuthNote');
  const providerId = detail?.provider?.id;
  const link = $('providerOAuthLink');
  if (!providerId) return;
  // Replacing a pending login: stop polling and retire the old state first.
  if (note?.dataset.state) {
    await fetch(`/api/providers/${encodeURIComponent(providerId)}/oauth/cancel/${encodeURIComponent(note.dataset.state)}`, { method: 'POST' }).catch(() => {});
    delete note.dataset.state;
  }
  clearInterval(oauthTimer);
  oauthTimer = null;
  closeOAuthWaitWindow();
  clearOAuthWaitInfo(providerId);
  detailNote(note, 'Starting secure local OAuth…');
  const attempt = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Open both windows while the click is still active; browsers treat a
  // window opened after the fetch below as a popup and block it. The small
  // window starts at its real page so it still works when the browser does not
  // return its handle; it picks up the login from localStorage once the start
  // request below succeeds. The tab is the provider's login page.
  const waitWin = window.open(`/oauth/wait?provider=${encodeURIComponent(providerId)}`, 'norouter-oauth-wait', 'popup=yes,width=460,height=660');
  if (waitWin) {
    waitWin.opener = null;
    oauthWaitWindow = waitWin;
  }
  const tab = window.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  try {
    const response = await fetch(`/api/providers/${encodeURIComponent(providerId)}/oauth/start`, { method: 'POST' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || 'Could not start OAuth.');
    if (tab) tab.location.href = body.authorizeUrl;
    else window.open(body.authorizeUrl, '_blank', 'noopener');
    storeOAuthPending(providerId, { attempt, state: body.state, authorizeUrl: body.authorizeUrl, callbackUrl: body.callbackUrl });
    if (link) link.placeholder = `${body.callbackUrl || 'http://127.0.0.1'}?code=…&state=…`;
    if (note) {
      note.dataset.provider = providerId;
      note.dataset.state = body.state;
      note.dataset.attempt = attempt;
      detailNote(note, 'Complete the login in the waiting window. It updates on its own.');
    }
    let inlineFallback = false;
    let checks = 0;
    const showInlineFallback = () => {
      inlineFallback = true;
      setProviderOAuthWaiting(true);
      if (note) detailNote(note, 'Complete login in the new tab. Paste the callback link below if it does not come back.');
    };
    setProviderOAuthWaiting(true, false);
    clearInterval(oauthTimer);
    oauthTimer = setInterval(async () => {
      const statusResponse = await fetch(`/api/providers/${encodeURIComponent(providerId)}/oauth/status/${encodeURIComponent(body.state)}`).catch(() => null);
      const status = await statusResponse?.json().catch(() => ({}));
      if (status?.status === 'complete') {
        finishProviderOAuth(note, oauthCopyFor(detail?.provider).done);
        await loadDetail();
        setAccountModal(false);
        return;
      }
      if (status?.status === 'unknown') {
        finishProviderOAuth(note, 'OAuth expired or was cancelled. Start again if needed.');
        return;
      }
      checks += 1;
      // Some embedded browsers hide the window handle even though the page
      // opened. Its heartbeat in localStorage still proves it is alive, and a
      // missing heartbeat brings back the dialog's own paste field.
      const waitAlive = (oauthWaitWindow && !oauthWaitWindow.closed) || oauthWaitAlive(providerId, attempt);
      if (!waitAlive) {
        oauthWaitWindow = null;
        if (!inlineFallback && checks >= 1) showInlineFallback();
      } else if (inlineFallback) {
        inlineFallback = false;
        setProviderOAuthWaiting(true, false);
      }
    }, 1500);
  } catch (err) {
    if (tab) tab.close();
    closeOAuthWaitWindow();
    clearOAuthWaitInfo(providerId);
    setProviderOAuthWaiting(false);
    detailNote(note, err.message, 'bad');
  }
});
$('providerOAuthLinkForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const note = $('providerOAuthNote');
  const providerId = detail?.provider?.id;
  const input = $('providerOAuthLink');
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  const redirectUrl = input?.value.trim() || '';
  if (!providerId) return;
  if (!redirectUrl) {
    detailNote(note, 'Paste the final login link first.', 'bad');
    input?.focus();
    return;
  }
  if (submit) submit.disabled = true;
  detailNote(note, 'Completing login…');
  try {
    const response = await fetch(`/api/providers/${encodeURIComponent(providerId)}/oauth/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirectUrl }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `Could not complete login (${response.status}).`);
    finishProviderOAuth(note, oauthCopyFor(detail?.provider).done);
    await loadDetail();
    setAccountModal(false);
  } catch (err) {
    detailNote(note, err.message, 'bad');
  } finally {
    if (submit) submit.disabled = false;
  }
});
$('closeAccountModal')?.addEventListener('click', closeAccountModal);
$('cancelAddAccount')?.addEventListener('click', closeAccountModal);
$('cancelBulk')?.addEventListener('click', closeAccountModal);
$('accountModal')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-modal-close]')) closeAccountModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && accountModalMode) closeAccountModal();
});

function previewStatusLabel(status) {
  return {
    new: ['new', 'New'],
    duplicate: ['duplicate', 'Already exists'],
    duplicate_input: ['duplicate', 'Duplicate in paste'],
    invalid: ['invalid', 'Invalid'],
  }[status] || ['invalid', status];
}

function renderAccountPreview(preview) {
  const summary = $('accountPreviewSummary');
  const list = $('accountPreviewList');
  if (!summary || !list) return;
  summary.innerHTML = `<strong>${fmtFull(preview.total)} checked</strong><span>${fmtFull(preview.fresh)} new</span><span>${fmtFull(preview.duplicates)} duplicates</span><span>${fmtFull(preview.invalid)} invalid</span>`;
  list.innerHTML = (preview.items || []).map((item) => {
    const [tone, label] = previewStatusLabel(item.status);
    return `<div class="account-preview-row">
      <span class="account-preview-index">${item.index + 1}</span>
      <span class="account-preview-main"><strong>${escapeHtml(item.label || item.uid || `Account ${item.index + 1}`)}</strong><small>${escapeHtml(item.masked)} · ${escapeHtml(item.kind.replace(/_/g, ' '))}</small></span>
      <span class="preview-pill ${tone}">${escapeHtml(label)}</span>
      ${item.error ? `<span class="account-preview-error">${escapeHtml(item.error)}</span>` : ''}
    </div>`;
  }).join('');
  detailNote($('accountPreviewNote'), preview.truncated ? `${fmtFull(preview.truncated)} more rows omitted from preview.` : 'Review the masked rows, then confirm.', '');
}

async function previewAccountEntries(entries, note) {
  const res = await detailApi('/accounts/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accounts: entries }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
  accountPreviewEntries = entries;
  accountPreviewPayload = body;
  renderAccountPreview(body);
  $('addAccountPanel')?.setAttribute('hidden', '');
  $('bulkEditView')?.setAttribute('hidden', '');
  $('accountPreview')?.removeAttribute('hidden');
  detailNote(note, 'Preview ready.', 'ok');
}

async function confirmAccountImport() {
  if (!accountPreviewEntries?.length || !currentDetailId) return;
  const button = $('confirmAccountImport');
  const note = $('accountPreviewNote');
  button.disabled = true;
  detailNote(note, 'Adding checked rows…');
  try {
    const res = await detailApi('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accounts: accountPreviewEntries }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    accounts.data = body;
    accounts.page = 1;
    renderAccounts();
    closeAccountModal();
    detailNote($('accountNote'), `${fmtFull(body.added)} added${body.duplicates ? ` · ${fmtFull(body.duplicates)} duplicates skipped` : ''}.`, 'ok');
  } catch (err) {
    detailNote(note, err.message, 'bad');
  } finally {
    button.disabled = false;
  }
}

$('confirmAccountImport')?.addEventListener('click', confirmAccountImport);
$('backAccountEdit')?.addEventListener('click', () => {
  $('accountPreview')?.setAttribute('hidden', '');
  if (accountModalMode === 'bulk') $('bulkEditView')?.removeAttribute('hidden');
  else $('addAccountPanel')?.removeAttribute('hidden');
});

$('addAccountForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentDetailId) return;
  const form = event.currentTarget;
  const note = $('addAccountNote');
  const button = form.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(form).entries());
  button.disabled = true;
  detailNote(note, 'Checking for duplicates…');
  try {
    await previewAccountEntries([data], note);
  } catch (err) {
    detailNote(note, err.message, 'bad');
  } finally {
    button.disabled = false;
  }
});

function invalidateAccountPreview() {
  if (!$('accountPreview') || $('accountPreview').hidden) return;
  accountPreviewPayload = null;
  accountPreviewEntries = null;
  $('accountPreview').setAttribute('hidden', '');
  if (accountModalMode === 'bulk') $('bulkEditView')?.removeAttribute('hidden');
  else $('addAccountPanel')?.removeAttribute('hidden');
  detailNote($(accountModalMode === 'bulk' ? 'bulkNote' : 'addAccountNote'), 'Input changed. Preview again before importing.');
}

$('bulkFile')?.addEventListener('change', async (event) => {
  invalidateAccountPreview();
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    $('bulkInput').value = await file.text();
    detailNote($('bulkNote'), `${file.name} loaded. Press Check duplicates.`, 'ok');
  } catch (err) {
    detailNote($('bulkNote'), `Could not read the file: ${err.message}`, 'bad');
  }
});

$('bulkInput')?.addEventListener('input', invalidateAccountPreview);
$('addAccountForm')?.addEventListener('input', invalidateAccountPreview);

$('importBulk')?.addEventListener('click', async () => {
  if (!currentDetailId) return;
  const note = $('bulkNote');
  const button = $('importBulk');
  let entries;
  try {
    entries = parseBulk($('bulkInput').value);
  } catch (err) {
    detailNote(note, `That is not valid JSON: ${err.message}`, 'bad');
    return;
  }
  if (!entries.length) {
    detailNote(note, 'Paste a JSON array, or one token per line.', 'bad');
    return;
  }

  button.disabled = true;
  detailNote(note, `Checking ${fmtFull(entries.length)} accounts for duplicates…`);
  try {
    await previewAccountEntries(entries, note);
  } catch (err) {
    detailNote(note, err.message, 'bad');
  } finally {
    button.disabled = false;
  }
});

$('accountFilters')?.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-status]');
  if (!chip) return;
  accounts.status = chip.dataset.status;
  accounts.page = 1;
  accounts.selected.clear();
  paintFilterChips();
  loadAccounts();
});

$('accountSearch')?.addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value.trim();
  searchTimer = setTimeout(() => {
    accounts.q = value;
    accounts.page = 1;
    accounts.selected.clear();
    loadAccounts();
  }, 250);
});

$('accountPageSize')?.addEventListener('change', (event) => {
  accounts.pageSize = Number(event.target.value) || 20;
  accounts.page = 1;
  accounts.selected.clear();
  loadAccounts();
});

$('accountPrev')?.addEventListener('click', () => {
  if (accounts.page <= 1) return;
  accounts.page -= 1;
  accounts.selected.clear();
  loadAccounts();
});

$('accountNext')?.addEventListener('click', () => {
  if (accounts.data && accounts.page >= accounts.data.pages) return;
  accounts.page += 1;
  accounts.selected.clear();
  loadAccounts();
});

$('selectAllAccounts')?.addEventListener('change', (event) => {
  const ids = accounts.data?.items.map((item) => item.id) || [];
  if (event.target.checked) ids.forEach((id) => accounts.selected.add(id));
  else ids.forEach((id) => accounts.selected.delete(id));
  renderAccounts();
});

$('dAccounts')?.addEventListener('change', (event) => {
  const box = event.target.closest('[data-select]');
  if (!box) return;
  if (box.checked) accounts.selected.add(box.dataset.select);
  else accounts.selected.delete(box.dataset.select);
  box.closest('tr')?.classList.toggle('is-selected', box.checked);
  updateBulkBar();

  const selectAll = $('selectAllAccounts');
  const ids = accounts.data?.items.map((item) => item.id) || [];
  const picked = ids.filter((id) => accounts.selected.has(id)).length;
  if (selectAll) {
    selectAll.checked = ids.length > 0 && picked === ids.length;
    selectAll.indeterminate = picked > 0 && picked < ids.length;
  }
});

let accountActionsId = null;
let accountActionsOpener = null;

function closeAccountActions() {
  const modal = $('accountActionsModal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  accountActionsId = null;
  requestAnimationFrame(() => accountActionsOpener?.focus?.());
  accountActionsOpener = null;
}

function openAccountActions(id, opener) {
  const account = accounts.data?.items.find((item) => item.id === id);
  if (!account) return;
  accountActionsId = id;
  accountActionsOpener = opener;
  $('accountActionsTitle').textContent = accountDisplayLabel(account);
  $('accountActionsMessage').textContent = `${account.kind.replace(/_/g, ' ')} · ${account.status}`;
  $('accountActionsList').innerHTML = [
    '<button class="account-action-button" type="button" data-account-action="edit">Edit name</button>',
    account.kind === 'api_key'
      ? '<p class="account-action-note">Check-in needs an OAuth token.</p>'
      : '<button class="account-action-button" type="button" data-account-action="checkin">Check in</button>',
    `<button class="account-action-button" type="button" data-account-action="toggle">${account.enabled ? 'Pause account' : 'Resume account'}</button>`,
    '<button class="account-action-button danger" type="button" data-account-action="delete">Remove account</button>',
  ].join('');
  $('accountActionsModal').hidden = false;
  $('accountActionsList').querySelector('button')?.focus();
}

let accountSummaryId = null;
let accountSummaryOpener = null;
let accountSummaryRequestId = 0;

function closeAccountSummary() {
  const modal = $('accountSummaryModal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  accountSummaryId = null;
  accountSummaryRequestId += 1;
  requestAnimationFrame(() => accountSummaryOpener?.focus?.());
  accountSummaryOpener = null;
}

function accountSummaryWindow(label, item) {
  const tokens = item.tokensIn + item.tokensOut;
  return `<div class="asum-window">
    <span class="asum-window-label">${escapeHtml(label)}</span>
    <span class="asum-window-value">${compact(item.requests)}<em>req</em></span>
    <span class="asum-window-note">${compact(tokens)} tok</span>
  </div>`;
}

function renderAccountSummary(summary) {
  const body = $('accountSummaryBody');
  if (!body) return;
  const windows = summary.windows || {};
  const zero = { requests: 0, tokensIn: 0, tokensOut: 0 };
  const series = summary.series || [];
  const peak = Math.max(1, ...series.map((day) => day.tokensIn + day.tokensOut));
  const bars = series.map((day) => {
    const tokens = day.tokensIn + day.tokensOut;
    const height = tokens ? Math.max(5, Math.round((tokens / peak) * 100)) : 0;
    const label = `${day.day} · ${fmtFull(day.requests)} req · ${fmtFull(tokens)} tok`;
    return `<span class="asum-day${tokens ? '' : ' is-empty'}" style="--day-height:${height}%" title="${escapeHtml(label)}"></span>`;
  }).join('');
  const lifetime = windows.all || zero;

  body.innerHTML = `
    <div class="asum-windows">
      ${accountSummaryWindow('Today', windows.day || zero)}
      ${accountSummaryWindow('Last 7 days', windows.week || zero)}
      ${accountSummaryWindow('Last 30 days', windows.month || zero)}
      ${accountSummaryWindow('Lifetime', lifetime)}
    </div>
    <div class="asum-chart-head">
      <span class="tile-label">Last 30 days</span>
      <span class="chip chip-quiet">${escapeHtml(summary.timeZone || 'UTC')} days</span>
    </div>
    <div class="asum-days" role="img" aria-label="Daily token usage for the last 30 days">${bars}</div>
    <div class="asum-foot">
      <span><strong>${fmtFull(lifetime.requests)}</strong> lifetime requests</span>
      <span><strong>${fmtFull(summary.errors || 0)}</strong> lifetime errors</span>
    </div>
    <p class="toolnote">Daily windows count successful requests on ${escapeHtml(summary.timeZone || 'UTC')} days; lifetime totals include failures.</p>
  `;
}

async function openAccountSummary(id, opener) {
  const modal = $('accountSummaryModal');
  if (!modal || !currentDetailId) return;
  const account = accounts.data?.items.find((item) => item.id === id);
  accountSummaryId = id;
  accountSummaryOpener = opener;
  if ($('accountSummaryTitle')) $('accountSummaryTitle').textContent = account ? accountDisplayLabel(account) : 'Account summary';
  if ($('accountSummaryMeta')) {
    $('accountSummaryMeta').textContent = account
      ? [account.kind.replace(/_/g, ' '), accountPlanLabel(account.plan), account.masked].filter(Boolean).join(' · ')
      : '';
  }
  if ($('accountSummaryBody')) $('accountSummaryBody').innerHTML = '<p class="toolnote">Loading summary…</p>';
  modal.hidden = false;
  modal.querySelector('.iconbtn')?.focus();

  const requestId = ++accountSummaryRequestId;
  try {
    const res = await detailApi(`/accounts/${encodeURIComponent(id)}/summary`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (requestId !== accountSummaryRequestId || accountSummaryId !== id) return;
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    renderAccountSummary(body);
  } catch (err) {
    if (requestId !== accountSummaryRequestId || accountSummaryId !== id) return;
    if ($('accountSummaryBody')) {
      $('accountSummaryBody').innerHTML = `<p class="toolnote bad">${escapeHtml(err.message || 'Could not load the summary.')}</p>`;
    }
  }
}

$('dAccounts')?.addEventListener('click', (event) => {
  const summaryBtn = event.target.closest('[data-account-summary]');
  if (summaryBtn) return openAccountSummary(summaryBtn.dataset.accountSummary, summaryBtn);
  const btn = event.target.closest('[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'more') return openAccountActions(id, btn);
  if (act === 'test') testOne(id);
  if (act === 'checkin') checkinOne(id);
  if (act === 'toggle') toggleOne(id);
  if (act === 'delete') deleteOne(id).then(() => loadAccounts());
});

document.querySelectorAll('[data-account-actions-close]').forEach((el) => el.addEventListener('click', closeAccountActions));
document.querySelectorAll('[data-account-summary-close]').forEach((el) => el.addEventListener('click', closeAccountSummary));
$('accountActionsList')?.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-account-name-form]');
  if (!form || !accountActionsId) return;
  event.preventDefault();
  const id = accountActionsId;
  const label = String(new FormData(form).get('label') || '').trim();
  try {
    const res = await detailApi(`/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    closeAccountActions();
    detailNote($('accountNote'), 'Account name updated.', 'ok');
    await loadAccounts();
  } catch (err) {
    detailNote($('accountNote'), err.message, 'bad');
  }
});
$('accountActionsList')?.addEventListener('click', (event) => {
  const action = event.target.closest('[data-account-action]')?.dataset.accountAction;
  const id = accountActionsId;
  if (event.target.closest('[data-account-name-cancel]')) {
    closeAccountActions();
    return;
  }
  if (!action || !id) return;
  if (action === 'edit') {
    const account = accounts.data?.items.find((item) => item.id === id);
    if (!account) return;
    $('accountActionsList').innerHTML = `<form class="account-name-form" data-account-name-form><label class="apfield"><span>Account name</span><input name="label" maxlength="80" required value="${escapeHtml(accountDisplayLabel(account))}"></label><div class="key-form-footer"><button class="btn btn-ghost" type="button" data-account-name-cancel>Cancel</button><button class="btn btn-primary" type="submit">Save</button></div></form>`;
    $('accountActionsList').querySelector('input')?.focus();
    return;
  }
  closeAccountActions();
  if (action === 'checkin') checkinOne(id);
  if (action === 'toggle') toggleOne(id);
  if (action === 'delete') deleteOne(id).then(() => loadAccounts());
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('accountActionsModal').hidden) closeAccountActions();
  else if (!$('accountSummaryModal').hidden) closeAccountSummary();
});

$('bulkActions')?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-bulk]');
  if (!btn) return;
  bulkAction(btn.dataset.bulk);
});

document.querySelectorAll('[data-quota-columns]').forEach((button) => {
  button.addEventListener('click', () => {
    quotaColumns = Number(button.dataset.quotaColumns);
    localStorage.setItem('norouter.quotaColumns', String(quotaColumns));
    paintQuotaColumns();
  });
});
$('refreshUpstreamQuota')?.addEventListener('click', () => loadUpstreamQuota());
$('refreshQuotaOrder')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (!currentDetailId || button.disabled) return;
  button.disabled = true;
  detailNote($('upstreamQuotaNote'), 'Refreshing quota order for every account…');
  try {
    const res = await detailApi('/accounts/quota-order/refresh', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    detailNote($('upstreamQuotaNote'), `${fmtFull(body.withQuota)} with quota · ${fmtFull(body.empty)} empty · ${fmtFull(body.unavailable)} unavailable.`, 'ok');
    await loadUpstreamQuota({ reset: true });
  } catch (err) {
    detailNote($('upstreamQuotaNote'), err.message, 'bad');
  } finally {
    button.disabled = false;
  }
});
$('dUpstreamQuota')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-package-page]');
  if (!button || button.disabled) return;
  const id = button.dataset.accountId;
  const current = quotaPage.packagePages.get(id) || 1;
  quotaPage.packagePages.set(id, Math.max(1, current + (button.dataset.packagePage === 'next' ? 1 : -1)));
  renderUpstreamQuota();
});
$('quotaPrev')?.addEventListener('click', () => {
  if (quotaPage.page <= 1 || quotaPage.loading) return;
  quotaPage.page -= 1;
  loadUpstreamQuota();
});
$('quotaNext')?.addEventListener('click', () => {
  if (!quotaPage.data || quotaPage.page >= quotaPage.data.pages || quotaPage.loading) return;
  quotaPage.page += 1;
  loadUpstreamQuota();
});

