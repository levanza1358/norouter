/* ---------------- formatting ---------------- */

const fmtFull = (n) => Number(n || 0).toLocaleString('en-US');

// USD cost, compact: $0.0042 -> "$0.0042", $1.25 -> "$1.25", $1200 -> "$1,200".
function fmtCost(n) {
  const value = Number(n || 0);
  if (value >= 1) return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return '$' + value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function compact(n) {
  const value = Number(n || 0);
  if (value < 1000) return fmtFull(value);
  if (value < 1_000_000) return (value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function uptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function relTime(iso) {
  const diff = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// A provider is usable when env credentials exist, when the pool holds at
// least one account, or when the endpoint needs no credential at all.
function isReady(credential) {
  return credential === 'configured' || credential === 'pool' || credential === 'open';
}

function initialOf(name) {
  return name.replace(/[^A-Za-z ]/g, '').split(/\s+/).filter(Boolean)
    .slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'P';
}

// Model rows per column. Width alone is not enough: 1280x720 and 1280x1080 have
// very different vertical room, so the row budget is the smaller of the two
// axes. A 24px deadband around each threshold keeps a window sitting exactly on
// a boundary from flipping the bucket (and re-rendering the list) repeatedly.
const DENSITY_WIDTH_STEPS = [1200, 1500];
const DENSITY_HEIGHT_STEPS = [820, 1000];
const densityState = { width: null, height: null };

function densityStep(value, thresholds, previous) {
  let index = 0;
  for (const threshold of thresholds) if (value >= threshold) index += 1;
  if (previous === null) return index;
  const margin = 24;
  // Only move up once the value clearly clears the threshold above it, and
  // only move down once it clearly drops below the one it is leaving.
  if (index > previous && value >= thresholds[previous] + margin) return index;
  if (index < previous && value < thresholds[previous - 1] - margin) return index;
  return previous;
}

function density() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const widthStep = densityStep(w, DENSITY_WIDTH_STEPS, densityState.width);
  const heightStep = densityStep(h, DENSITY_HEIGHT_STEPS, densityState.height);
  densityState.width = widthStep;
  densityState.height = heightStep;
  // Whichever axis is tighter decides; a tall narrow window still gets 6 rows.
  const step = Math.min(widthStep, heightStep);
  return { models: step === 2 ? 11 : step === 1 ? 9 : 6 };
}

// The log card has a fixed height on wide screens, so rows are trimmed to the
// space it actually has. Trimming re-reads layout on the next frame because the
// card's final height is only known once the rest of the board has settled.
let eventSource = [];

function trimEventsToColumn() {
  const list = $('eventList');
  if (!list) return;

  // Re-read the budget on every iteration: the card can still be settling, and
  // a stale budget leaves rows hanging past the card edge.
  const rows = [...list.children].filter((row) => !row.classList.contains('ghost'));
  const overflow = () => {
    const last = list.lastElementChild;
    if (!last) return 0;
    return last.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom;
  };

  let guard = rows.length + 4;
  while (rows.length > 1 && guard-- > 0) {
    if (!list.clientHeight || list.clientHeight < 60) return;
    if (overflow() <= 1) return;
    rows.pop().remove();
  }
}

function paintEvents() {
  const list = $('eventList');
  if (!list) return;

  list.innerHTML = eventSource.map(rowHtml).join('');

  // Synchronous pass (the loop forces layout), then two more on later frames
  // for the case where the card shrinks once its sibling columns settle.
  trimEventsToColumn();
  padEventsToColumn();
  requestAnimationFrame(() => {
    trimEventsToColumn();
    padEventsToColumn();
    requestAnimationFrame(() => {
      trimEventsToColumn();
      padEventsToColumn();
    });
  });
}

// A quiet router leaves the bottom of the log card blank; placeholder rows keep
// it filled with structure instead of a hollow block.
function padEventsToColumn() {
  const list = $('eventList');
  if (!list) return;

  for (const ghost of [...list.querySelectorAll('.evrow.ghost')]) ghost.remove();

  // The idle-state hints are already placeholders.
  if (list.querySelector('.evbar')) return;

  const available = list.clientHeight;
  if (!available) return;

  // The list is a flex column, so scrollHeight equals clientHeight even when
  // the rows stop short: measure where the last row actually ends.
  const used = () => {
    const last = list.lastElementChild;
    if (!last) return 0;
    return last.getBoundingClientRect().bottom - list.getBoundingClientRect().top;
  };

  const widths = [78, 62, 71, 55, 68];
  const ghosts = [];
  while (ghosts.length < 40 && used() + 24 <= available) {
    const i = ghosts.length;
    const row = document.createElement('div');
    row.className = 'evrow ghost';
    row.innerHTML = `<span class="evdot"></span>
      <div class="evbody">
        <div class="evbar" style="width:${widths[i % widths.length]}%"></div>
        <div class="evtime" style="margin-top:7px">&nbsp;</div>
      </div>`;
    list.appendChild(row);
    ghosts.push(row);
  }

  while (ghosts.length && used() > available + 1) ghosts.pop().remove();
}

function rowHtml(ev) {
  const isErr = ev.type === 'error';
  const msg = ev.message.length > 90 ? ev.message.slice(0, 90) + '…' : ev.message;
  return `<div class="evrow">
      <span class="evdot ${isErr ? 'err' : ''}"></span>
      <div class="evbody">
        <div class="evmsg">${escapeHtml(msg)}</div>
        <div class="evtime">${relTime(ev.at)}</div>
      </div>
    </div>`;
}

