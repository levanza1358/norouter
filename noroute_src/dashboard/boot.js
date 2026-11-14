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
syncToggleLabels();
$('baseUrl').textContent = `${location.origin}/v1`;
navigate(location.pathname, { push: false, initial: true });
refresh();
requestAnimationFrame(() => requestAnimationFrame(dismissSplash));

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderCurrent, 180);
});

setInterval(() => {
  if (document.visibilityState === 'visible') refresh();
}, REFRESH_MS);
