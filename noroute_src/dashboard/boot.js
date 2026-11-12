/* ---------------- boot ---------------- */

function paintDate() {
  const now = new Date();
  $('todayLabel').textContent = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  $('todayAlt').textContent = now.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric' });
}

const bootStartedAt = performance.now();
let splashDismissScheduled = false;

function dismissSplash() {
  const splash = $('appSplash');
  if (!splash || splashDismissScheduled) return;
  splashDismissScheduled = true;
  const remove = () => {
    splash.remove();
    booting = false;
    document.documentElement.classList.remove('dashboard-booting');
  };
  if (motionReduced()) {
    remove();
    return;
  }
  const finish = () => {
    splash.classList.add('is-done');
    window.setTimeout(remove, 300);
  };
  const remaining = Math.max(0, 260 - (performance.now() - bootStartedAt));
  window.setTimeout(() => requestAnimationFrame(finish), remaining);
}

paintDate();
paintAppearanceControls();
$('baseUrl').textContent = `${location.origin}/v1`;
navigate(location.pathname, { push: false, initial: true });
refresh();
requestAnimationFrame(() => requestAnimationFrame(dismissSplash));

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderCurrent, 180);
});

// The log card's height depends on the tallest sibling column, so it can settle
// after render. Re-trim whenever its own box changes.
const eventCard = $('eventList')?.closest('.card');
const recentCard = $('recentTable')?.closest('.card');
if ('ResizeObserver' in window) {
  const observer = new ResizeObserver(() => {
    if (currentPath !== '/') return;
    requestAnimationFrame(() => {
      trimEventsToColumn();
      trimModelsToCard();
      trimRecentToCard();
      padRecentToCard();
    });
  });
  if (eventCard) observer.observe(eventCard);
  if (recentCard) observer.observe(recentCard);
}

setInterval(() => {
  if (document.visibilityState === 'visible') refresh();
}, REFRESH_MS);
