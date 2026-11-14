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

// The pool stores one canonical tier per account (`free`, `plus`, `pro`,
// `ultra`, …). The badge and the summary line show the display form; an
// unknown tier is shown as nothing rather than as a badge.
const PLAN_LABELS = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  ultra: 'Ultra',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
};

function accountPlanLabel(value) {
  return PLAN_LABELS[String(value || '').toLowerCase()] || '';
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

// The dashboard's request table is always one page of five rows. It used to
// fill whatever height the card had, so shrinking the window showed a different
// amount of history; a fixed page keeps every screen on the same five rows.
const DASH_RECENT_PAGE_SIZE = 5;



// A switch already shows its state; the word beside it has to agree, or a card
// reads "Enabled" with the control off. Labels naming the setting itself
// ("Coding focus") carry no state word and are left alone.
function syncToggleLabels() {
  document.querySelectorAll('.key-toggle input[type="checkbox"]').forEach((input) => {
    const word = input.closest('.key-toggle')?.querySelector('b');
    if (word && /^(enabled|disabled)$/i.test(word.textContent.trim())) {
      word.textContent = input.checked ? 'Enabled' : 'Disabled';
    }
  });
}

document.addEventListener('change', (event) => {
  if (event.target.matches?.('.key-toggle input')) syncToggleLabels();
});
