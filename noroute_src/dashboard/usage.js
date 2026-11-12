/* ---------------- usage page ---------------- */

const USAGE_RANGE_LABELS = {
  day: { title: 'today', bucket: 'hourly', note: 'today, local time' },
  week: { title: 'this week', bucket: 'daily', note: 'this week, local time' },
  month: { title: 'this month', bucket: 'daily', note: 'this month, local time' },
  all: { title: 'all time', bucket: 'monthly', note: 'all saved history' },
};

// Bucket keys come from the server in local time: YYYY-MM-DDTHH, YYYY-MM-DD, or
// YYYY-MM. Parse them as text so the browser cannot shift them into another day.
function usageBucketLabel(bucket, key) {
  if (bucket === 'hour') return `${key.slice(11, 13)}:00`;
  if (bucket === 'month') {
    const [year, month] = key.split('-');
    return new Date(Number(year), Number(month) - 1, 1)
      .toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
  const [, month, day] = key.split('-');
  return new Date(Number(key.slice(0, 4)), Number(month) - 1, Number(day))
    .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function usageBucketTitle(bucket, item) {
  return `${usageBucketLabel(bucket, item.bucket)} · ${fmtFull(item.tokensIn + item.tokensOut)} tok · ${fmtFull(item.requests)} req`;
}

function usageSparkCells(series, bucket) {
  const weights = series.map((item) => Math.max(item.tokensIn + item.tokensOut, item.requests, 1));
  const max = Math.max(...weights, 1);
  return series.map((item, i) => {
    const failed = item.errors > 0 && item.requests === 0;
    const empty = item.requests === 0 && item.tokensIn === 0 && item.tokensOut === 0;
    const label = usageBucketTitle(bucket, item) + (item.errors ? ` · ${fmtFull(item.errors)} err` : '');
    return {
      className: failed ? 'is-err' : empty ? 'is-empty' : '',
      opacity: `${Math.round(Math.max(.2, weights[i] / max) * 100)}%`,
      ratio: weights[i] / max,
      empty,
      failed,
      label,
    };
  });
}

function paintUsageChartTabs() {
  document.querySelectorAll('[data-usage-chart]').forEach((btn) => {
    const active = btn.dataset.usageChart === usageChartType;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  });
  moveTabIndicator($('uChartTypes'), '[data-usage-chart].is-active');
  const legend = $('uSparkLegend');
  if (legend) {
    legend.textContent = usageChartType === 'heatmap'
      ? 'color intensity = tokens, red = failed'
      : usageChartType === 'bars'
        ? 'bar height = tokens, red = failed'
        : 'line height = tokens, red = failed';
  }
}

function usageChartMarkup(series, bucket, box = {}) {
  if (!series.length) return '<div class="spark-empty">No saved usage for this range yet.</div>';
  const cells = usageSparkCells(series, bucket);
  if (usageChartType === 'heatmap') {
    return `<div class="uchart-heat">${cells
      .map((cell) => `<span class="${cell.className}" style="--cell-opacity:${cell.opacity}" title="${escapeHtml(cell.label)}"></span>`)
      .join('')}</div>`;
  }
  if (usageChartType === 'bars') {
    return `<div class="uchart-bars">${cells
      .map((cell) => `<span class="uchart-bar${cell.failed ? ' is-err' : cell.empty ? ' is-empty' : ''}" style="--bar-height:${Math.max(4, Math.round(cell.ratio * 100))}%" title="${escapeHtml(cell.label)}"></span>`)
      .join('')}</div>`;
  }

  // Line and area share one polyline; the area variant only adds the fill.
  // The viewBox matches the measured pixel box so dots stay round instead of
  // being stretched by preserveAspectRatio="none".
  const width = Math.max(120, Math.round(box.width || 600));
  const height = Math.max(80, Math.round(box.height || 200));
  const padY = 6;
  const usable = height - padY * 2;
  const step = cells.length > 1 ? width / (cells.length - 1) : 0;
  const points = cells.map((cell, index) => {
    const x = cells.length > 1 ? index * step : width / 2;
    const y = padY + usable - Math.max(0.02, cell.ratio) * usable;
    return { x, y, cell };
  });
  const path = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const radius = cells.length > 60 ? 1.6 : cells.length > 24 ? 2.2 : 3;
  const dots = points
    .map((p) => `<circle class="uchart-dot${p.cell.failed ? ' is-err' : ''}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${radius}"><title>${escapeHtml(p.cell.label)}</title></circle>`)
    .join('');
  const area = usageChartType === 'area'
    ? `<polygon class="uchart-area-fill" points="0,${height} ${path} ${width},${height}" />`
    : '';
  return `<div class="uchart-line"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    ${area}
    <polyline class="uchart-line-path" points="${path}" vector-effect="non-scaling-stroke" />
    ${dots}
  </svg></div>`;
}

function usageSparkMarkup(series, bucket, box) {
  return usageChartMarkup(series, bucket, box);
}

function updateUsageSpark(series, bucket) {
  const host = $('uSpark');
  if (!host) return;
  paintUsageChartTabs();
  host.classList.toggle('is-heat', usageChartType === 'heatmap');
  host.dataset.chartType = usageChartType;
  if (!series.length) {
    if (!host.querySelector('.spark-empty')) host.innerHTML = usageSparkMarkup(series, bucket);
    return;
  }

  // The heatmap keeps its spans across polls so colour transitions stay smooth.
  // Bars/line/area are rebuilt on data changes, which is rare (2s polls only
  // redraw when the report signature actually changed).
  if (usageChartType !== 'heatmap') {
    const rect = host.getBoundingClientRect();
    host.innerHTML = usageSparkMarkup(series, bucket, { width: rect.width, height: rect.height });
    return;
  }

  const cells = usageSparkCells(series, bucket);
  const wrapper = host.querySelector('.uchart-heat');
  const spans = wrapper ? [...wrapper.children] : [];
  if (!wrapper || spans.length !== cells.length || spans.some((span) => span.tagName !== 'SPAN')) {
    host.innerHTML = usageSparkMarkup(series, bucket);
    return;
  }

  cells.forEach((cell, index) => {
    const span = spans[index];
    if (span.className !== cell.className) span.className = cell.className;
    if (span.style.getPropertyValue('--cell-opacity') !== cell.opacity) {
      span.style.setProperty('--cell-opacity', cell.opacity);
    }
    if (span.title !== cell.label) span.title = cell.label;
  });
}

function paintUsageRangeTabs() {
  const tabs = $('usageRangeTabs');
  document.querySelectorAll('[data-usage-range]').forEach((btn) => {
    const active = btn.dataset.usageRange === usageRange;
    btn.classList.toggle('is-active', active);
    // These are real tabs, so they expose aria-selected + roving tabindex
    // rather than aria-pressed.
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  });
  moveTabIndicator(tabs, '[data-usage-range].is-active');
}

// Polling every two seconds must not look like the page is reloading.
// The chip only reports the connection state. An earlier version printed
// "live · 3s ago", which changed its text every second and read as flicker;
// the label is now stable until the state itself changes.
function paintUsageLive() {
  const chip = $('usageLive');
  if (!chip) return;
  const state = usageState === 'error' ? 'error' : usageLastUpdated ? 'live' : 'connecting';
  if (chip.dataset.state === state) return;
  chip.dataset.state = state;
  if (state === 'error') {
    chip.className = 'chip chip-bad';
    chip.textContent = 'offline — retrying';
  } else if (state === 'live') {
    chip.className = 'chip chip-ok is-live';
    chip.innerHTML = '<span class="usage-live-dot" aria-hidden="true"></span>live';
  } else {
    chip.className = 'chip chip-quiet';
    chip.textContent = 'connecting';
  }
}

// Cheap identity for the rendered report. Re-writing identical markup every two
// seconds restarts the bar transitions and makes the chart flicker.
function usageReportSignature(data) {
  return JSON.stringify([data.range, data.bucket, data.totals, data.series, data.models, data.activity]);
}

function usageChartReportSignature(data) {
  return JSON.stringify([data.range, data.bucket, data.series]);
}

// KPI numbers move to their new value instead of being swapped in. The text is
// only touched when the value really changed, so an unchanged poll is a no-op;
// when it does change the old number rolls to the new one and the direction is
// shown with a short tint.
const usageNumberFrames = new WeakMap();

function activityTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Usage tables cap at ten rows per page so the page stays scannable while the
// full report remains reachable through the pager. Pagination is client-side:
// /api/usage keeps returning the complete range report.
const USAGE_PAGE_SIZE = 10;

function usagePageSlice(items, page) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / USAGE_PAGE_SIZE));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (current - 1) * USAGE_PAGE_SIZE;
  return { items: items.slice(start, start + USAGE_PAGE_SIZE), current, pages, total, start };
}

// Render "1 2 3" buttons plus prev/next. Long ranges collapse the middle so the
// control never wraps into a wall of numbers.
function paintUsagePager({ pager, info, btns, items, page, onSelect, noun }) {
  if (!pager || !info || !btns) return 1;
  const slice = usagePageSlice(items, page);
  info.textContent = slice.total === 0
    ? `0 ${noun}`
    : `${fmtFull(slice.start + 1)}–${fmtFull(slice.start + slice.items.length)} of ${fmtFull(slice.total)}`;
  pager.hidden = slice.total <= USAGE_PAGE_SIZE && slice.pages === 1;

  const make = (label, target, { disabled = false, current = false, aria } = {}) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `usage-page-btn${current ? ' is-current' : ''}`;
    button.textContent = label;
    if (aria) button.setAttribute('aria-label', aria);
    if (current) button.setAttribute('aria-current', 'page');
    button.disabled = disabled;
    if (!disabled && !current) {
      button.addEventListener('click', () => onSelect(target));
    }
    return button;
  };

  const nodes = [];
  nodes.push(make('←', slice.current - 1, { disabled: slice.current <= 1, aria: 'Previous page' }));
  for (let number = 1; number <= slice.pages; number += 1) {
    if (slice.pages > 7 && number !== 1 && number !== slice.pages
      && Math.abs(number - slice.current) > 1) {
      if (nodes.at(-1)?.dataset.gap !== 'true') {
        const gap = document.createElement('span');
        gap.className = 'usage-page-gap';
        gap.dataset.gap = 'true';
        gap.textContent = '…';
        nodes.push(gap);
      }
      continue;
    }
    nodes.push(make(String(number), number, { current: number === slice.current }));
  }
  nodes.push(make('→', slice.current + 1, { disabled: slice.current >= slice.pages, aria: 'Next page' }));
  btns.replaceChildren(...nodes);
  return slice.current;
}

function renderUsageActivity(rows) {
  const table = $('uActivityTable');
  if (!table) return;
  const activity = Array.isArray(rows) ? rows : [];
  const active = Array.isArray(usageData?.active) ? usageData.active : [];
  // In-flight requests sit at the top of the feed as live rows, ahead of the
  // persisted history, so "Streaming" is visible before the response closes.
  const live = active.map((row) => ({
    at: new Date(row.at).toISOString(),
    model: row.model || '',
    provider: row.provider || '',
    account: row.account || '',
    tokensIn: row.tokensIn || 0,
    tokensOut: row.tokensOut || 0,
    ms: row.ms ?? null,
    ok: true,
    streaming: true,
  }));
  const merged = [...live, ...activity];
  $('uActivityCount').textContent = `${activity.length}`;
  const slice = usagePageSlice(merged, usageActivityPage);
  usageActivityPage = paintUsagePager({
    pager: $('uActivityPager'),
    info: $('uActivityPageInfo'),
    btns: $('uActivityPageBtns'),
    items: merged,
    page: usageActivityPage,
    noun: 'entries',
    onSelect: (page) => {
      usageActivityPage = page;
      renderUsageActivity(activity);
    },
  });
  const signature = slice.items.map((row) => [
    row.at, row.model, row.provider, row.account, row.tokensIn, row.tokensOut, row.ms, row.status, row.ok, row.error, row.streaming,
  ]);
  if (!dashboardSignature('dashboard.usage.activity', [usageActivityPage, signature])) return;
  table.innerHTML = slice.items.length
    ? slice.items.map((row) => {
      const tokenTotal = Number(row.tokensIn || 0) + Number(row.tokensOut || 0);
      const status = row.streaming
        ? 'streaming'
        : row.ok ? (row.status || 200) : (row.status || 'error');
      const detail = row.error ? ` title="${escapeHtml(row.error)}"` : '';
      const latency = row.ms == null ? '—' : row.streaming ? `${fmtFull(row.ms)} ms` : `${fmtFull(row.ms)} ms`;
      return `<tr${row.streaming ? ' class="is-streaming"' : ''}>
        <td class="activity-time">${row.streaming ? 'now' : escapeHtml(activityTime(row.at))}</td>
        <td class="model">${escapeHtml(row.model || '—')}</td>
        <td class="model-sub">${escapeHtml(row.provider || '—')}</td>
        <td>${escapeHtml(row.account || '—')}</td>
        <td class="r" title="${fmtFull(tokenTotal)} total · ${fmtFull(row.tokensIn)} in · ${fmtFull(row.tokensOut)} out">${fmtFull(tokenTotal)}</td>
        <td class="r">${latency}</td>
        <td${detail}><span class="pill ${row.streaming ? 'stream' : row.ok ? 'ok' : 'bad'}">${row.streaming ? 'Streaming' : escapeHtml(String(status))}</span></td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="7" class="empty" style="border-bottom:0">No activity recorded in this range yet.</td></tr>';
}

function setUsageStat(el, value, format) {
  if (!el) return;
  const next = Number(value || 0);
  const previous = el.dataset.value === undefined ? next : Number(el.dataset.value);
  if (el.dataset.value !== undefined && previous === next) return;
  el.dataset.value = String(next);

  const cancel = usageNumberFrames.get(el);
  if (cancel) cancel();
  if (motionReduced() || el.dataset.value === undefined || previous === next) {
    el.textContent = format(next);
    return;
  }

  const from = previous;
  const started = performance.now();
  const duration = 420;
  // The tween works on whole units: a compact label like "4.2M" must never
  // render intermediate noise such as "836.662".
  const step = Math.max(1, Math.abs(next - from)) > 1;
  let frame = 0;
  const stepFn = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    const eased = 1 - (1 - progress) ** 3;
    const current = from + (next - from) * eased;
    el.textContent = format(step ? Math.round(current) : current);
    if (progress < 1) {
      frame = requestAnimationFrame(stepFn);
    } else {
      el.textContent = format(next);
      usageNumberFrames.delete(el);
    }
  };
  usageNumberFrames.set(el, () => cancelAnimationFrame(frame));
  el.classList.remove('is-up', 'is-down');
  void el.offsetWidth;
  el.classList.add(next >= from ? 'is-up' : 'is-down');
  frame = requestAnimationFrame(stepFn);
}


// Switching range used to clear usageData first, which replaced the chart and
// table with a placeholder for as long as the request took — a visible flash.
// Keep the previous report on screen, dim it, and swap it once the new one
// arrives; the incoming panel fades in over the old values.
function setUsagePending(pending) {
  const section = document.querySelector('[data-page="/usage"]');
  if (!section) return;
  section.classList.toggle('is-refreshing', pending);
  $('usageRangeTabs')?.setAttribute('aria-busy', String(pending));
}

function flashUsagePanel() {
  const section = document.querySelector('[data-page="/usage"]');
  if (!section || motionReduced()) return;
  section.classList.remove('usage-swap');
  void section.offsetWidth;
  section.classList.add('usage-swap');
  window.setTimeout(() => section.classList.remove('usage-swap'), 320);
}

function renderUsage() {
  if (!$('uRequests')) return;
  paintUsageRangeTabs();
  paintUsageLive();

  const meta = USAGE_RANGE_LABELS[usageRange] || USAGE_RANGE_LABELS.day;
  const zone = usageData?.timeZone || 'local time';
  // Same reasoning as the live chip: only touch the node when the text differs,
  // otherwise the poll rewrites an identical label twice a second.
  const noteText = `${meta.note} · ${zone}`;
  if ($('usageRangeNote').textContent !== noteText) $('usageRangeNote').textContent = noteText;

  if (!usageData) {
    const failed = usageState === 'error';
    $('uRequests').textContent = failed ? '—' : '…';
    $('uRange').textContent = failed ? usageError : 'loading saved usage';
    $('uTokIn').textContent = '—';
    $('uTokOut').textContent = '—';
    $('uTokInNote').textContent = '—';
    $('uTokOutNote').textContent = '—';
    $('uSuccess').textContent = '—';
    $('uErrors').textContent = 'no errors';
    $('uBucket').textContent = meta.bucket;
    $('uSpark').innerHTML = failed
      ? `<div class="spark-empty">${escapeHtml(usageError)}</div>`
      : '<div class="spark-empty">Loading saved usage…</div>';
    $('uSparkStart').textContent = 'oldest';
    $('uSparkEnd').textContent = 'newest';
    $('uModelCount').textContent = '0';
    if ($('uModelPager')) $('uModelPager').hidden = true;
    if ($('uActivityPager')) $('uActivityPager').hidden = true;
    if ($('uModelPageInfo')) $('uModelPageInfo').textContent = '0 models';
    if ($('uActivityPageInfo')) $('uActivityPageInfo').textContent = '0 entries';
    $('uTable').innerHTML = failed
      ? `<tr><td colspan="7" class="empty" style="border-bottom:0">${escapeHtml(usageError)}</td></tr>`
      : '<tr><td colspan="7" class="empty" style="border-bottom:0">Loading usage…</td></tr>';
    return;
  }

  const signature = usageReportSignature(usageData);
  const chartSignature = usageChartReportSignature(usageData);
  const pagerKey = `${usageModelPage}:${usageActivityPage}`;
  if (signature === usageSignature && chartSignature === usageChartSignature && pagerKey === usageRenderPagerKey) return;
  const chartChanged = chartSignature !== usageChartSignature;
  usageSignature = signature;
  usageChartSignature = chartSignature;
  usageRenderPagerKey = pagerKey;

  const totals = usageData.totals;
  // Numbers roll to their new value (or stay untouched when unchanged) instead
  // of being swapped in, which read as flashing on every poll.
  setUsageStat($('uRequests'), totals.requests, compact);
  $('uRequests').title = `${fmtFull(totals.requests)} requests`;
  $('uRange').textContent = totals.requests === 0
    ? `no requests ${meta.title}`
    : `${meta.title} · ${fmtFull(totals.errors)} error${totals.errors === 1 ? '' : 's'}`;

  setUsageStat($('uTokIn'), totals.tokensIn, compact);
  $('uTokIn').title = `${fmtFull(totals.tokensIn)} tokens`;
  setUsageStat($('uTokOut'), totals.tokensOut, compact);
  $('uTokOut').title = `${fmtFull(totals.tokensOut)} tokens`;

  const avgIn = totals.requests ? Math.round(totals.tokensIn / totals.requests) : 0;
  const avgOut = totals.requests ? Math.round(totals.tokensOut / totals.requests) : 0;
  $('uTokInNote').textContent = totals.requests ? `${fmtFull(avgIn)} avg / request` : 'no requests yet';
  $('uTokOutNote').textContent = totals.requests ? `${fmtFull(avgOut)} avg / request` : 'no requests yet';

  setUsageStat($('uSuccess'), totals.successRate == null ? 0 : totals.successRate, (n) => `${Math.round(n)}%`);
  if (totals.successRate == null) $('uSuccess').textContent = '—';
  $('uErrors').textContent = totals.errors === 0
    ? 'no errors'
    : `${totals.errors} error${totals.errors === 1 ? '' : 's'}`;

  $('uBucket').textContent = meta.bucket;
  if (chartChanged) updateUsageSpark(usageData.series, usageData.bucket);

  setUsageStat($('uCost'), totals.cost == null ? 0 : totals.cost, (n) => fmtCost(n));
  if (totals.cost == null) $('uCost').textContent = '—';
  $('uCostNote').textContent = totals.cost == null ? 'no list prices' : 'list-price estimate';
  const first = usageData.series[0];
  const last = usageData.series.at(-1);
  $('uSparkStart').textContent = first ? usageBucketLabel(usageData.bucket, first.bucket) : 'oldest';
  $('uSparkEnd').textContent = last ? usageBucketLabel(usageData.bucket, last.bucket) : 'newest';
  $('uSpark').setAttribute('aria-label', usageData.series.length
    ? `${meta.title}: ${seriesSummary(usageData.series)}`
    : `No saved usage for ${meta.title}`);

  $('uModelCount').textContent = `${usageData.models.length} model${usageData.models.length === 1 ? '' : 's'}`;
  const modelSlice = usagePageSlice(usageData.models, usageModelPage);
  usageModelPage = paintUsagePager({
    pager: $('uModelPager'),
    info: $('uModelPageInfo'),
    btns: $('uModelPageBtns'),
    items: usageData.models,
    page: usageModelPage,
    noun: 'models',
    onSelect: (page) => {
      usageModelPage = page;
      renderUsage();
    },
  });
  renderUsageActivity(usageData.activity);

  $('uTable').innerHTML = modelSlice.items.length
    ? modelSlice.items.map((m) => `<tr>
        <td class="model">${escapeHtml(m.model)}</td>
        <td class="model-sub">${escapeHtml(m.provider || '—')}</td>
        <td class="r">${fmtFull(m.requests)}</td>
        <td class="r">${fmtFull(m.tokensIn)}</td>
        <td class="r">${fmtFull(m.tokensOut)}</td>
        <td class="r">${m.cost == null ? '—' : fmtCost(m.cost)}</td>
        <td class="r">${m.avgMs == null ? '—' : m.avgMs + ' ms'}</td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="empty" style="border-bottom:0">No traffic recorded in this range yet.</td></tr>';
}

function seriesSummary(series) {
  const requests = series.reduce((sum, item) => sum + item.requests, 0);
  const tokens = series.reduce((sum, item) => sum + item.tokensIn + item.tokensOut, 0);
  return `${fmtFull(requests)} requests, ${fmtFull(tokens)} tokens across ${series.length} buckets`;
}

async function loadUsage({ fromPoll = false } = {}) {
  if (!document.querySelector('[data-page="/usage"]')) return;
  const requestId = ++usageRequestId;
  const requestedRange = usageRange;
  const previousChartSignature = usageData ? usageChartReportSignature(usageData) : '';
  let chartChanged = !usageData;
  // Keep the last report visible while the new one loads; only a first visit
  // (no data at all) shows the skeleton.
  if (!usageData) {
    usageState = 'loading';
    renderUsage();
  }
  // The 2s background poll must not dim the panel: only an explicit range
  // switch shows the pending state, otherwise the page breathes every tick.
  if (!fromPoll) setUsagePending(true);
  try {
    const res = await fetch(`/api/usage?range=${encodeURIComponent(usageRange)}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A 404 here means the HTML/JS on disk is newer than the running process:
      // static assets are read per request, but routes are fixed at startup.
      throw new Error(res.status === 404
        ? 'This server was started before the usage API existed. Restart norouter, then reload this page.'
        : body.error?.message || `usage ${res.status}`);
    }
    if (requestId !== usageRequestId || requestedRange !== usageRange || body.range !== usageRange) return;
    usageData = body;
    chartChanged = usageChartReportSignature(body) !== previousChartSignature;
    usageState = 'ready';
    usageError = '';
    usageLastUpdated = Date.now();
  } catch (err) {
    if (requestId !== usageRequestId || requestedRange !== usageRange) return;
    usageState = 'error';
    usageError = err.message || 'Could not load usage history.';
  } finally {
    if (requestId === usageRequestId && !fromPoll) setUsagePending(false);
  }
  if (requestId !== usageRequestId || requestedRange !== usageRange) return;
  renderUsage();
  if (!fromPoll && chartChanged) flashUsagePanel();
}

$('usageRangeTabs')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-usage-range]');
  if (!button) return;
  const next = button.dataset.usageRange;
  if (!next || next === usageRange) return;
  selectUsageRange(next);
});

// Arrow-key navigation between the range tabs, matching the ARIA tabs pattern
// already used on the provider detail page.
$('usageRangeTabs')?.addEventListener('keydown', (event) => {
  const buttons = [...document.querySelectorAll('[data-usage-range]')];
  const current = buttons.indexOf(document.activeElement);
  if (current === -1) return;
  let next = null;
  if (event.key === 'ArrowRight') next = (current + 1) % buttons.length;
  else if (event.key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  if (next === null) return;
  event.preventDefault();
  buttons[next].focus();
  selectUsageRange(buttons[next].dataset.usageRange);
});

function selectUsageRange(next) {
  if (!next || next === usageRange) return;
  usageRange = next;
  usageSignature = '';
  usageChartSignature = '';
  usageModelPage = 1;
  usageActivityPage = 1;
  paintUsageRangeTabs();
  loadUsage();
}

function selectUsageChartType(next) {
  if (!USAGE_CHART_TYPES.includes(next) || next === usageChartType) return;
  usageChartType = next;
  try {
    localStorage.setItem(USAGE_CHART_KEY, next);
  } catch {
    // Storage blocked: the choice still applies for this session.
  }
  paintUsageChartTabs();
  if (usageData) updateUsageSpark(usageData.series, usageData.bucket);
}

$('uChartTypes')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-usage-chart]');
  if (button) selectUsageChartType(button.dataset.usageChart);
});

$('uChartTypes')?.addEventListener('keydown', (event) => {
  const buttons = [...document.querySelectorAll('[data-usage-chart]')];
  const current = buttons.indexOf(document.activeElement);
  if (current === -1) return;
  let next = null;
  if (event.key === 'ArrowRight') next = (current + 1) % buttons.length;
  else if (event.key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  if (next === null) return;
  event.preventDefault();
  buttons[next].focus();
  selectUsageChartType(buttons[next].dataset.usageChart);
});

// Line/area are drawn in measured pixel coordinates, so a width change needs a
// fresh paint. Only this chart is redrawn; the 2s poll behaviour is untouched.
let usageChartResizeFrame = 0;
window.addEventListener('resize', () => {
  if (!usageData || usageChartType === 'heatmap') return;
  cancelAnimationFrame(usageChartResizeFrame);
  usageChartResizeFrame = requestAnimationFrame(() => {
    if (usageData) updateUsageSpark(usageData.series, usageData.bucket);
  });
});


