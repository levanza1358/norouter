/* ---------------- data + routing glue ---------------- */

function renderRecent(data, report = dashboardUsageData) {
  const table = $('recentTable');
  if (!table) return;

  const rows = report?.activity || [];
  $('recentCount').textContent = `${rows.length}`;
  if (!rows.length) {
    if (dashboardSignature('dashboard.recent', [])) table.innerHTML = `<tr><td colspan="4" class="empty-cell">
      <div class="list-empty"><strong>No requests yet</strong><span>Recent calls appear here with model, tokens, latency and status.</span></div>
    </td></tr>`;
    return;
  }

  const recentSignature = rows.map((r) => [r.at, r.model, r.tokensIn, r.tokensOut, r.ms, r.ok, r.status]);
  if (!dashboardSignature('dashboard.recent', recentSignature)) return;
  table.innerHTML = rows.map((r) => {
    const tokens = r.tokensIn + r.tokensOut;
    return `<tr>
      <td class="model">${escapeHtml(r.model || 'unknown')}</td>
      <td class="r">${r.ok ? fmtFull(tokens) : '—'}</td>
      <td class="r">${r.ms == null ? '—' : r.ms + ' ms'}</td>
      <td class="r"><span class="pill ${r.ok ? 'ok' : 'bad'}">${r.ok ? (r.status || 'ok') : 'error'}</span></td>
    </tr>`;
  }).join('');

  trimRecentToCard();
  padRecentToCard();
  requestAnimationFrame(() => {
    trimRecentToCard();
    padRecentToCard();
  });
}

// Rows are dropped from the bottom until the table fits its card, so a tall
// screen shows more history and a short one shows less, never a half row.
function trimRecentToCard() {
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

// A short history leaves the bottom of the card blank; placeholder rows keep it
// filled without pretending to be data. They are added in one batch and the
// overshoot is trimmed off the end, because the card's final height is only
// known once the browser has laid out the rest of the board.
function padRecentToCard() {
  const body = $('recentTable');
  const wrap = body?.closest('.table-wrap');
  const table = wrap?.querySelector('table');
  if (!wrap || !table) return;

  for (const ghost of [...body.querySelectorAll('.rghost')]) ghost.remove();

  const first = body.firstElementChild;
  if (!first || first.querySelector('.empty')) return;

  const available = wrap.clientHeight;
  if (!available) return;

  const widths = [74, 56, 66, 48, 61];
  const ghosts = [];
  // Append optimistically, then drop whatever overshoots: the exact height of a
  // placeholder row depends on the theme's font scale, so guessing it up front
  // would either stop early or clip.
  while (ghosts.length < 40 && table.getBoundingClientRect().height + 24 <= available) {
    const i = ghosts.length;
    const tr = document.createElement('tr');
    tr.className = 'rghost';
    tr.innerHTML = `<td colspan="4"><span class="ghostbar" style="width:${widths[i % widths.length]}%"></span></td>`;
    body.appendChild(tr);
    ghosts.push(tr);
  }

  while (ghosts.length && table.getBoundingClientRect().height > available + 1) {
    ghosts.pop().remove();
  }
}

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

