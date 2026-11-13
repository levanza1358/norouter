/* ---------------- router ---------------- */

const DETAIL_PREFIX = '/providers/';

let currentPath = '/';
let currentDetailId = null;
let latest = null;
let detail = null;
let detailState = 'idle';
let detailError = '';
let routeTransitionId = 0;
let dashboardUsageRange = 'day';
let dashboardUsageData = null;
let dashboardUsageRequestId = 0;
let dashboardApiKeySecret = '';
let settingsTab = 'general';
let dashboardAuth = { enabled: false, hasPassword: false, configuredAt: null };
let tokenSaver = { ponytail: { enabled: false }, rtk: { enabled: false }, caveman: { enabled: false } };
let tokenSaverLoading = false;
let replyFilters = { language: 'auto', verbosity: 'balanced', coding: false, focus: '', addressAs: '' };
let replyFiltersLoading = false;
let replyLanguageTrigger = null;
let booting = true;
let apiKeys = [];
let apiKeySecret = '';
let editingApiKeyId = '';
let usageRange = 'day';
let usageData = null;
let usageState = 'idle';
let usageError = '';
let usageLastUpdated = 0;
let usageSignature = '';
let usageChartSignature = '';
let usageRequestId = 0;
let usageModelPage = 1;
let usageActivityPage = 1;
let usageRenderPagerKey = '';
const USAGE_CHART_KEY = 'norouter.usageChart';
const USAGE_CHART_TYPES = ['heatmap', 'bars', 'line', 'area'];
function readUsageChartType() {
  try {
    const stored = localStorage.getItem(USAGE_CHART_KEY);
    return USAGE_CHART_TYPES.includes(stored) ? stored : 'heatmap';
  } catch {
    return 'heatmap';
  }
}
let usageChartType = readUsageChartType();
const dashboardRenderSignatures = new Map();
const PROVIDER_QUOTA_REFRESH_MS = 30_000;
let providerQuotaRefreshing = false;
let providerQuotaLastRefresh = 0;

function dashboardSignature(key, value) {
  const signature = JSON.stringify(value);
  if (dashboardRenderSignatures.get(key) === signature) return false;
  dashboardRenderSignatures.set(key, signature);
  return true;
}

function isDetailPath(path) {
  return path.startsWith(DETAIL_PREFIX) && path.length > DETAIL_PREFIX.length;
}

function detailIdFrom(path) {
  return decodeURIComponent(path.slice(DETAIL_PREFIX.length).split('?')[0]);
}

function normalize(path) {
  if (!path || path === '/dashboard') return '/';
  const trimmed = path.replace(/\/+$/, '') || '/';
  return ROUTES[trimmed] ? trimmed : '/';
}

function motionReduced() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || false;
}

function showPage(targetSection) {
  document.querySelectorAll('.page').forEach((section) => {
    section.classList.remove('route-enter', 'route-leave');
    section.hidden = section !== targetSection;
  });
}

function settlePageTransition(targetSection) {
  showPage(targetSection);
  document.querySelectorAll('.page').forEach((section) => {
    section.style.viewTransitionName = '';
  });
}

function transitionPages(pageKey, update, { animate = !booting } = {}) {
  const sections = [...document.querySelectorAll('.page')];
  const targetSection = sections.find((section) => section.dataset.page === pageKey);
  if (!targetSection) return;

  const apply = () => {
    update?.();
    settlePageTransition(targetSection);
  };
  if (!animate || motionReduced() || typeof document.startViewTransition !== 'function') {
    apply();
    return;
  }

  const currentSection = sections.find((section) => !section.hidden && section !== targetSection);
  if (!currentSection) {
    apply();
    return;
  }
  currentSection.style.viewTransitionName = 'route-page';
  targetSection.style.viewTransitionName = 'route-page';
  const transitionId = ++routeTransitionId;
  const transition = document.startViewTransition(() => {
    if (transitionId === routeTransitionId) {
      showPage(targetSection);
      update?.();
    }
  });
  transition.finished.catch(() => {}).finally(() => {
    if (transitionId === routeTransitionId) settlePageTransition(targetSection);
  });
}

function navigate(path, { push = true, initial = false } = {}) {
  if (!isDetailPath(String(path || '/'))) closeAccountModal();
  const raw = String(path || '/');
  const onDetail = isDetailPath(raw);
  const target = onDetail ? raw.replace(/\/+$/, '') : normalize(raw);

  currentPath = target;
  currentDetailId = onDetail ? detailIdFrom(target) : null;
  if (!onDetail || detail?.provider?.id !== currentDetailId) {
    detail = null;
    detailState = 'idle';
  }
  if (push && location.pathname !== target) history.pushState({}, '', target);

  const route = ROUTES[target] || ROUTES['/'];
  $('pageTitle').textContent = onDetail ? (detail?.provider?.name || 'Provider') : route.title;
  $('tagline').textContent = onDetail
    ? 'Accounts, quota and models for this upstream.'
    : route.sub;
  $('topbarConnect').hidden = onDetail ? true : !route.copy;

  const pageKey = onDetail ? 'detail' : target;
  const updateRoute = () => {
    transitionPages(pageKey, () => {
      document.querySelectorAll('.rail-nav a').forEach((link) => {
        link.classList.toggle('is-active', normalize(link.dataset.route) === (onDetail ? '/providers' : target));
      });
      renderCurrent();
    }, { animate: !initial && !booting });
  };

  // Keep the app shell outside the transition. A document-level View Transition
  // snapshots the rail and topbar too, which makes them flash on every route.
  // transitionPages animates only the main `.page` sections.
  updateRoute();
  if (onDetail) loadDetail();
  if (target === '/api-keys') loadApiKeys();
  if (target === '/settings') {
    loadDashboardAuth();
    loadAutostart();
    loadTokenSaver();
    loadWebhook();
    loadBudgets();
    loadMaintenance();
  }
  if (target === '/usage') loadUsage();
  if (target === '/chat') loadChat();
  if (target === '/combos') {
    loadCombos();
    loadVisionRouting();
    loadRoutingRules();
  }
  if (target === '/') loadDashboardApiKey();
}

// Every internal link goes through the router, including the provider cards.
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="/"]');
  if (!link) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  if (link.target === '_blank' || link.hasAttribute('download')) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
});

window.addEventListener('popstate', () => navigate(location.pathname, { push: false }));

