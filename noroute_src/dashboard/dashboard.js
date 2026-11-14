/* ---------------- dashboard ---------------- */

const DASHBOARD_RANGE_LABELS = { day: 'today', week: 'this week', month: 'this month', all: 'all time' };
const DASHBOARD_BUCKET_LABELS = { hour: 'hourly', day: 'daily', month: 'monthly' };

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

// Bucket keys are already in the server's timezone ("2026-11-13T03"). Building
// the current key in that same zone keeps "upcoming" honest when the browser
// sits somewhere else.
function dashboardBucketNow(bucket, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
  } catch {
    return null;
  }
  const part = (type) => parts.find((entry) => entry.type === type)?.value || '';
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  if (bucket === 'hour') return `${day}T${part('hour')}`;
  return bucket === 'month' ? day.slice(0, 7) : day;
}

function dashboardBucketLabel(bucket, key) {
  if (bucket === 'hour') return `${key.slice(11, 13)}:00`;
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day || 1);
  if (bucket === 'month') {
    return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Request-volume bars: one slot per bucket, so the window keeps its time axis
// even where traffic is zero. Heights compare total requests (successes plus
// failures); failures cap the bar instead of recolouring the whole column.
// The container keeps role="img", so the text summary below is the readable
// path for screen readers and for anyone who does not hover.
function sparkMarkup(history) {
  if (!history.length) {
    return '<div class="spark-empty">No history yet.</div>';
  }
  if (!history.some((h) => h.requests + h.errors)) {
    return '<div class="spark-empty">No requests in this range.</div>';
  }
  const volumes = history.map((h) => h.requests + h.errors);
  const max = Math.max(...volumes, 1);
  // The part of the window that has not happened yet is shaded as a whole, so
  // a mostly-empty morning chart reads as "rest of the day" rather than dead
  // space. Slots stay in place either way, which keeps the time axis honest.
  const firstFuture = history.findIndex((h) => h.future);
  const ahead = firstFuture < 0 ? '' : `<div class="spark-ahead" style="width:${Math.round(((history.length - firstFuture) / history.length) * 100)}%"></div>`;
  const bars = history.map((h, i) => {
    // An empty slot stays as a baseline tick: an hour or day with no traffic is
    // still part of the window, and hiding it would compress the time axis.
    if (!volumes[i]) {
      return `<span class="${h.future ? 'is-future' : 'is-empty'}" style="height:2px" title="${h.future ? 'upcoming' : 'no requests'}"></span>`;
    }
    const pct = Math.max(6, Math.round((volumes[i] / max) * 100));
    const failed = h.errors ? Math.max(2, Math.round((h.errors / volumes[i]) * 100)) : 0;
    const label = `${fmtFull(h.requests)} ok${h.errors ? ` · ${fmtFull(h.errors)} failed` : ''} · ${fmtFull(h.tokens)} tok`;
    const cap = failed ? `<span class="is-err" style="height:max(2px, ${failed}%)"></span>` : '';
    return `<span class="bar" style="height:${pct}%" title="${label}"><span class="bar-fill">${cap}<span class="is-ok"></span></span></span>`;
  }).join('');
  return ahead + bars;
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

  const series = report?.series || [];
  const bucket = report?.bucket || 'hour';
  const nowKey = series.length ? dashboardBucketNow(bucket, report?.timeZone) : null;
  const history = series.map((entry) => {
    const requests = Number(entry.requests || 0);
    const errors = Number(entry.errors || 0);
    return {
      key: entry.bucket,
      requests,
      errors,
      tokens: Number(entry.tokensIn || 0) + Number(entry.tokensOut || 0),
      future: Boolean(nowKey && entry.bucket > nowKey),
    };
  });
  const sparkSignature = {
    nowKey,
    series: series.map((entry) => [entry.bucket, entry.requests, entry.errors, entry.tokensIn, entry.tokensOut]),
  };
  if (dashboardSignature('dashboard.spark', sparkSignature)) $('spark').innerHTML = sparkMarkup(history);

  const totalRequests = Number(totals.requests || 0);
  const totalErrors = Number(totals.errors || 0);
  const peak = history.reduce((best, entry) => {
    const volume = entry.requests + entry.errors;
    return volume > (best?.volume || 0) ? { ...entry, volume } : best;
  }, null);
  const parts = [];
  if (!totalRequests && !totalErrors) {
    parts.push('No requests recorded yet');
  } else {
    if (totalRequests && totalErrors) parts.push(`${fmtFull(totalRequests)} ok`, `${fmtFull(totalErrors)} failed`);
    else if (totalErrors) parts.push(`${fmtFull(totalErrors)} failed`);
    else parts.push(`${fmtFull(totalRequests)} requests`);
    if (peak) parts.push(`peak ${fmtFull(peak.volume)} at ${dashboardBucketLabel(bucket, peak.key)}`);
  }
  const summary = `${parts.join(' · ')}.`;
  $('sparkSummary').textContent = summary;
  $('spark').setAttribute('aria-label', summary);
  $('sparkWindow').textContent = series.length ? (DASHBOARD_BUCKET_LABELS[bucket] || bucket) : 'no history';

  // Three ticks are enough for an axis; repeating the same bucket for very short
  // windows (a single month, two days) would just print the label twice.
  const first = history[0];
  const middle = history.length > 2 ? history[Math.floor(history.length / 2)] : null;
  const last = history.length > 1 ? history[history.length - 1] : null;
  $('sparkFrom').textContent = first ? dashboardBucketLabel(bucket, first.key) : '';
  $('sparkMid').textContent = middle ? dashboardBucketLabel(bucket, middle.key) : '';
  $('sparkTo').textContent = last ? dashboardBucketLabel(bucket, last.key) : '';
  // One bucket has one centred bar, so its label sits centred under it instead
  // of stranded at the left edge of the axis.
  $('sparkFoot').classList.toggle('is-single', history.length === 1);
}

function renderModels(data, report = dashboardUsageData) {
  const models = report?.models || [];
  $('modelCount').textContent = `${models.length} used`;
  const list = $('modelList');

  if (!models.length) {
    if (dashboardSignature('dashboard.models', { models: [] })) list.innerHTML = `<div class="list-empty">
      <strong>No model traffic yet</strong>
      <span>Send a request to /v1; per-model token bars appear here.</span>
    </div>`;
    return;
  }

  const modelSignature = { models: models.map((m) => [m.model, m.requests, m.tokensIn, m.tokensOut]) };
  if (!dashboardSignature('dashboard.models', modelSignature)) return;
  const peak = Math.max(...models.map((m) => m.tokensIn + m.tokensOut), 1);
  list.innerHTML = models.map((m) => {
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
}


