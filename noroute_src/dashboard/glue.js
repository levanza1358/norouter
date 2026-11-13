/* ---------------- data + routing glue ---------------- */

let recentPage = 1;

function renderRecent(data, report = dashboardUsageData) {
  const table = $('recentTable');
  if (!table) return;

  const rows = report?.activity || [];
  $('recentCount').textContent = `${rows.length}`;
  const pager = $('recentPager');
  if (!rows.length) {
    if (pager) pager.hidden = true;
    recentPage = 1;
    if (dashboardSignature('dashboard.recent', [])) table.innerHTML = `<tr><td colspan="4" class="empty-cell">
      <div class="list-empty"><strong>No requests yet</strong><span>Recent calls appear here with model, tokens, latency and status.</span></div>
    </td></tr>`;
    return;
  }

  const recentSignature = rows.map((r) => [r.at, r.model, r.tokensIn, r.tokensOut, r.ms, r.ok, r.status]);
  // Paging and the mobile/desktop switch both re-run this with identical data,
  // so the signature has to carry them or the redraw is skipped.
  if (!dashboardSignature('dashboard.recent', [dashPaged(), recentPage, recentSignature])) return;

  // Phones get five rows per page; wider screens keep filling the card.
  let visible = rows;
  if (dashPaged()) {
    recentPage = paintUsagePager({
      pager,
      info: $('recentPageInfo'),
      btns: $('recentPageBtns'),
      items: rows,
      page: recentPage,
      pageSize: DASH_MOBILE_PAGE_SIZE,
      noun: 'requests',
      onSelect: (page) => { recentPage = page; renderRecent(data, report); },
    });
    visible = usagePageSlice(rows, recentPage, DASH_MOBILE_PAGE_SIZE).items;
  } else if (pager) {
    pager.hidden = true;
    recentPage = 1;
  }

  table.innerHTML = visible.map((r) => {
    const tokens = r.tokensIn + r.tokensOut;
    return `<tr>
      <td class="model">${escapeHtml(r.model || 'unknown')}</td>
      <td class="r">${r.ok ? fmtFull(tokens) : '—'}</td>
      <td class="r">${r.ms == null ? '—' : r.ms + ' ms'}</td>
      <td class="r"><span class="pill ${r.ok ? 'ok' : 'bad'}">${r.ok ? (r.status || 'ok') : 'error'}</span></td>
    </tr>`;
  }).join('');

  if (dashPaged()) return;
  trimRecentToCard();
  requestAnimationFrame(trimRecentToCard);
}

// Rows are dropped from the bottom until the table fits its card, so a tall
// screen shows more history and a short one shows less, never a half row.
function trimRecentToCard() {
  if (dashPaged()) return;
  const body = $('recentTable');
  const wrap = body?.closest('.table-wrap');
  const table = wrap?.querySelector('table');
  if (!wrap || !table) return;

  const rows = [...body.children].filter((row) => !row.classList.contains('rghost'));
  let guard = rows.length + 4;
  while (rows.length > 1 && guard-- > 0) {
    const available = wrap.clientHeight;
    if (!available || available < 60) return;
    // Measure the whole table: the header row is part of what has to fit.
    if (table.getBoundingClientRect().height <= available + 1) return;
    rows.pop().remove();
  }
}

// A short history leaves the bottom of the card blank on purpose: an empty
// slot is honest, placeholder rows would look like data that never arrived.
function paintDashboardRangeTabs() {
  const tabs = [...document.querySelectorAll('[data-dashboard-range]')];
  const active = tabs.find((tab) => tab.dataset.dashboardRange === dashboardUsageRange) || tabs[0];
  if (!active) return;
  dashboardUsageRange = active.dataset.dashboardRange;
  tabs.forEach((tab) => {
    const selected = tab === active;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  $('dashboardHistoryPanel')?.setAttribute('aria-labelledby', active.id);
  moveTabIndicator($('dashboardRangeTabs'), '[data-dashboard-range].is-active');
}

async function loadDashboardUsage() {
  if (currentPath !== '/') return;
  const requestId = ++dashboardUsageRequestId;
  const requestedRange = dashboardUsageRange;
  const statsNote = $('dashboardHistoryStatsNote');
  const requestsNote = $('dashboardHistoryRequestsNote');
  if (statsNote) statsNote.textContent = 'Loading historical usage…';
  if (requestsNote) requestsNote.textContent = 'Loading historical usage…';
  try {
    // Reuse the Usage report contract; dashboard reads only its persisted totals.
    const res = await fetch(`/api/usage?range=${encodeURIComponent(requestedRange)}`, { cache: 'no-store' });
    const report = await res.json();
    if (!res.ok) throw new Error(report.error?.message || 'Could not load historical usage.');
    if (requestId !== dashboardUsageRequestId || requestedRange !== dashboardUsageRange || currentPath !== '/') return;
    dashboardUsageData = report;
    renderStatistics(latest || {}, report);
    renderRequests(latest || {}, report);
    renderModels(latest || {}, report);
    renderRecent(latest || {}, report);
    renderEvents(latest || {}, report);
    renderDashboardHistorical(report);
  } catch (err) {
    if (requestId !== dashboardUsageRequestId || requestedRange !== dashboardUsageRange) return;
    dashboardUsageData = null;
    if (statsNote) statsNote.textContent = err.message;
    if (requestsNote) requestsNote.textContent = err.message;
  }
}

$('dashboardRangeTabs')?.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-dashboard-range]');
  if (!tab || tab.dataset.dashboardRange === dashboardUsageRange) return;
  dashboardUsageRange = tab.dataset.dashboardRange;
  paintDashboardRangeTabs();
  loadDashboardUsage();
});
$('dashboardRangeTabs')?.addEventListener('keydown', (event) => {
  const tabs = [...document.querySelectorAll('[data-dashboard-range]')];
  const current = tabs.indexOf(document.activeElement);
  if (current < 0) return;
  let next = null;
  if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  if (next === null) return;
  event.preventDefault();
  tabs[next].focus();
  dashboardUsageRange = tabs[next].dataset.dashboardRange;
  paintDashboardRangeTabs();
  loadDashboardUsage();
});

function renderCurrent() {
  if (isDetailPath(currentPath)) {
    renderDetailPage();
    return;
  }
  if (!latest) return;
  if (currentPath === '/') {
    renderDashboardMap(latest);
    renderStatistics(latest, dashboardUsageData);
    renderRequests(latest, dashboardUsageData);
    renderModels(latest, dashboardUsageData);
    renderRecent(latest, dashboardUsageData);
    // Last: it measures the finished middle column to size itself.
    renderEvents(latest, dashboardUsageData);
    paintDashboardRangeTabs();
    if (!dashboardUsageData || dashboardUsageData.range !== dashboardUsageRange) loadDashboardUsage();
    else renderDashboardHistorical(dashboardUsageData);
  } else if (currentPath === '/providers') {
    renderProviderCards(latest);
  } else if (currentPath === '/usage') {
    renderUsage();
  } else if (currentPath === '/combos') {
    renderCombos();
  } else if (currentPath === '/settings') {
    renderSettings(latest);
  } else if (currentPath === '/api-keys') {
    renderApiKeys();
  } else if (currentPath === '/map') {
    renderServiceMapPage(latest);
  }
}

async function refresh() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    latest = await res.json();

    if (isDetailPath(currentPath)) {
      await loadDetail({ quiet: true });
      return;
    }

    renderCurrent();
    if (currentPath === '/providers') refreshProviderQuota();

    if (currentPath === '/usage') loadUsage({ fromPoll: true });

    if (currentPath === '/') {
      loadDashboardUsage();
      const total = latest.providers.length;
      const ready = latest.providers.filter((p) => isReady(p.credential)).length;
      $('tagline').textContent = ready === total
        ? `${ready} of ${total} providers ready · ${latest.requests} requests served`
        : `${ready} of ${total} providers ready · waiting for credentials`;
    }
  } catch {
    if (currentPath === '/') $('tagline').textContent = 'Dashboard disconnected — is the server still running?';
  }
}

