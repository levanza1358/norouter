/* ---------------- dashboard ---------------- */

const DASHBOARD_RANGE_LABELS = { day: 'today', week: 'this week', month: 'this month', all: 'all time' };

function renderDashboardHistorical(report) {
  const totals = report?.totals || {};
  const label = DASHBOARD_RANGE_LABELS[dashboardUsageRange] || dashboardUsageRange;
  const total = Number(totals.requests || 0) + Number(totals.errors || 0);
  const empty = total === 0 && Number(totals.tokensIn || 0) === 0 && Number(totals.tokensOut || 0) === 0;
  const source = $('dashboardHistoryRange');
  if (source) source.textContent = label;
  for (const id of ['dashboardHistoryIn', 'dashboardHistoryOut', 'dashboardHistoryErrors', 'dashboardHistoryRequests']) {
    const value = id.endsWith('In') ? totals.tokensIn : id.endsWith('Out') ? totals.tokensOut : id.endsWith('Errors') ? totals.errors : totals.requests;
    if ($(id)) $(id).textContent = empty ? '—' : compact(value);
  }
  if ($('dashboardHistorySuccess')) $('dashboardHistorySuccess').textContent = empty || totals.successRate == null ? '—' : `${totals.successRate}%`;
  const note = empty ? `No usage yet for ${label}.` : label;
  if ($('dashboardHistoryStatsNote')) $('dashboardHistoryStatsNote').textContent = note;
  if ($('dashboardHistoryRequestsNote')) $('dashboardHistoryRequestsNote').textContent = note;
}

function renderStatistics(data, report = dashboardUsageData) {
  const totals = report?.totals || {};
  const label = DASHBOARD_RANGE_LABELS[dashboardUsageRange] || dashboardUsageRange;
  $('statRangeChip').textContent = label;
  $('statIn').textContent = compact(totals.tokensIn);
  $('statIn').title = `${fmtFull(totals.tokensIn)} tokens ${label}`;
  $('statOut').textContent = compact(totals.tokensOut);
  $('statOut').title = `${fmtFull(totals.tokensOut)} tokens ${label}`;
  $('statLatency').textContent = totals.avgMs == null ? '—' : `${totals.avgMs} ms`;
  $('statErrors').textContent = fmtFull(totals.errors);
}

// Sparkline: bars are decorative, so the chart carries a text summary that is
// readable without hover or a pointer. Bars keep their title for mouse users,
// and aria-hidden stops screen readers announcing 40 meaningless spans.
function sparkSummary(history) {
  if (!history.length) return 'No requests recorded yet.';
  const ok = history.filter((h) => h.ok);
  const failed = history.length - ok.length;
  const waited = ok.filter((h) => typeof h.ms === 'number' && h.ms > 0).map((h) => h.ms);
  const avg = waited.length ? Math.round(waited.reduce((sum, ms) => sum + ms, 0) / waited.length) : null;
  const parts = [
    `${history.length} recent request${history.length === 1 ? '' : 's'}`,
    failed ? `${failed} failed` : 'no failures',
  ];
  if (avg != null) parts.push(`${avg} ms average`);
  return `${parts.join(' · ')}.`;
}

function sparkMarkup(history) {
  if (!history.length) {
    return '<div class="spark-empty">No requests yet — send one to /v1 to see the chart.</div>';
  }
  const weights = history.map((h) => Math.max(h.tokens, h.ms / 10, 1));
  const max = Math.max(...weights);
  const bars = history.map((h, i) => {
    const pct = Math.max(6, Math.round((weights[i] / max) * 100));
    const cls = h.ok ? '' : ' is-err';
    const label = h.ok ? `${h.ms} ms · ${h.tokens} tok` : 'failed';
    return `<span class="${cls}" style="height:${pct}%" title="${label}"></span>`;
  }).join('');
  // The container keeps role="img", which already hides the bars from the
  // accessibility tree; the text summary below the chart is the readable path.
  return bars;
}

function renderRequests(data, report = dashboardUsageData) {
  const totals = report?.totals || {};
  const rangeLabel = DASHBOARD_RANGE_LABELS[dashboardUsageRange] || dashboardUsageRange;
  $('reqRangeChip').textContent = rangeLabel;
  $('statRequests').textContent = compact(totals.requests);
  $('statRequests').title = `${fmtFull(totals.requests)} persisted requests`;
  $('uptimeChip').textContent = `up ${uptime(data.uptimeSeconds)}`;

  $('successChip').textContent = totals.successRate == null ? 'no traffic' : `${totals.successRate}% success`;
  $('successChip').className = totals.successRate == null
    ? 'chip chip-quiet'
    : totals.successRate >= 95 ? 'chip chip-ok' : 'chip chip-bad';

  $('inOutChip').textContent = totals.requests === 0
    ? 'waiting for first call'
    : `${compact(totals.tokensIn)} in / ${compact(totals.tokensOut)} out`;

  const history = (report?.series || []).map((bucket) => ({
    ms: bucket.requests ? 0 : 0,
    tokens: Number(bucket.tokensIn || 0) + Number(bucket.tokensOut || 0),
    ok: Number(bucket.errors || 0) === 0,
  }));
  if (dashboardSignature('dashboard.spark', report?.series || [])) $('spark').innerHTML = sparkMarkup(history);
  const summary = totals.requests ? `${fmtFull(totals.requests)} persisted requests · ${totals.successRate ?? 0}% success.` : 'No requests recorded yet.';
  $('sparkSummary').textContent = summary;
  $('spark').setAttribute('aria-label', summary);
  $('sparkWindow').textContent = report?.series?.length ? `${report.series.length} buckets` : 'no history';
}

function renderModels(data, report = dashboardUsageData) {
  const models = report?.models || [];
  $('modelCount').textContent = `${models.length} used`;
  const list = $('modelList');
  const limit = density().models;

  if (!models.length) {
    if (dashboardSignature('dashboard.models', { limit, models: [] })) list.innerHTML = `<div class="list-empty">
      <strong>No model traffic yet</strong>
      <span>Send a request to /v1; per-model token bars appear here.</span>
    </div>`;
    trimModelsToCard();
    return;
  }

  const modelSignature = { limit, models: models.map((m) => [m.model, m.requests, m.tokensIn, m.tokensOut]) };
  if (!dashboardSignature('dashboard.models', modelSignature)) return trimModelsToCard();
  const peak = Math.max(...models.map((m) => m.tokensIn + m.tokensOut), 1);
  list.innerHTML = models.slice(0, limit).map((m) => {
    const total = m.tokensIn + m.tokensOut;
    const width = Math.max(4, Math.round((total / peak) * 100));
    return `<div class="mrow">
      <div class="mrow-top">
        <span class="mname" title="${escapeHtml(m.model)}">${escapeHtml(m.model)}</span>
        <span class="mval">${m.requests} req · ${compact(total)} tok</span>
      </div>
      <div class="mtrack"><div class="mfill" style="width:${width}%"></div></div>
    </div>`;
  }).join('');
  staggerChildren(list, '.mrow', `models:${models.map((model) => model.model).join('|')}`);

  trimModelsToCard();
}

// The card has a fixed height on wide screens, so rows that do not fit are
// dropped instead of being clipped mid-bar.
function trimModelsToCard() {
  const list = $('modelList');
  if (!list) return;
  const rows = [...list.querySelectorAll('.mrow')];
  let guard = rows.length + 4;
  while (rows.length > 1 && guard-- > 0) {
    const available = list.clientHeight;
    if (!available || available < 60) return;
    if (list.scrollHeight <= available + 1) return;
    rows.pop().remove();
  }
}

function renderEvents(data, report = dashboardUsageData) {
  const persisted = (report?.activity || []).map((item) => ({
    at: item.at,
    type: item.ok ? 'request' : 'error',
    message: item.ok
      ? `${item.model || 'unknown'} · ${item.tokensIn + item.tokensOut} tok · ${item.ms ?? '?'} ms`
      : `${item.model || 'unknown'} · request failed${item.error ? ` · ${item.error}` : ''}`,
  }));
  const active = (data.active || []).map((item) => ({
    at: item.at,
    type: 'request',
    message: `${item.model || 'unknown'} · ${item.tokensIn + item.tokensOut} tok · ${item.ms ?? '?'} ms · streaming`,
  }));
  const rows = [...active, ...persisted];
  $('eventCount').textContent = `${rows.length}`;

  if (!rows.length) {
    eventSource = [];
    if (!dashboardSignature('dashboard.events', [])) return;
    $('eventList').innerHTML = `<div class="list-empty">
      <strong>No activity yet</strong>
      <span>Every request and error is logged here. Point a client at /v1 to begin.</span>
    </div>`;
    return;
  }

  const eventSignature = rows.map((event) => [event.at, event.type, event.message]);
  if (!dashboardSignature('dashboard.events', eventSignature)) return;
  eventSource = rows;
  paintEvents();
}

