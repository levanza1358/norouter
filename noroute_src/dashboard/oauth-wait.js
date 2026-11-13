/* ---------------- OAuth wait window ---------------- */

const OAUTH_WAIT_PROVIDERS = {
  codex: {
    title: 'Finish the ChatGPT login',
    lede: 'Complete the sign-in in the other window. This window updates on its own.',
    callback: 'http://127.0.0.1:1455/auth/callback',
  },
  antigravity: {
    title: 'Finish the Google login',
    lede: 'Complete the sign-in in the other window. This window updates on its own.',
    callback: 'http://localhost:1456/callback',
  },
};
const OAUTH_PENDING_PREFIX = 'norouter.oauth.pending.';
const OAUTH_ALIVE_PREFIX = 'norouter.oauth.alive.';
const OAUTH_PENDING_TTL = 5 * 60 * 1000;
const OAUTH_PENDING_WAIT_MS = 20000;
const OAUTH_PENDING_POLL_MS = 400;
const OAUTH_WAIT_POLL_MS = 1500;
const OAUTH_LINK_ERRORS = /^(Paste the login link|That link|The login link has no code)/;

const waitEl = (id) => document.getElementById(id);
const waitParams = new URLSearchParams(location.search);
const waitProvider = waitParams.get('provider') || '';
const waitCopy = OAUTH_WAIT_PROVIDERS[waitProvider] || null;
const waitTitle = waitEl('waitTitle');
const waitLede = waitEl('waitLede');
const waitCallback = waitEl('waitCallback');
const waitProgress = waitEl('waitProgress');
const waitStatus = waitEl('waitStatus');
const waitDot = waitEl('waitDot');
const waitLinkForm = waitEl('waitLinkForm');
const waitLink = waitEl('waitLink');
const waitSubmit = waitEl('waitSubmit');
const waitCancel = waitEl('waitCancel');
const waitClose = waitEl('waitClose');
const waitOpenSignIn = waitEl('waitOpenSignIn');

let waitState = waitParams.get('state') || '';
let waitAttempt = '';
let waitAdopted = false;
let waitTimer = null;
let waitPendingTimer = null;
let waitPendingDeadline = 0;
let waitFinished = false;
let waitBusy = false;

function oauthPendingKey(providerId) {
  return `${OAUTH_PENDING_PREFIX}${providerId}`;
}

function oauthAliveKey(providerId) {
  return `${OAUTH_ALIVE_PREFIX}${providerId}`;
}

// The dashboard parks the login here after /oauth/start; the window opens
// before that request finishes, so it waits for this entry instead of a state
// in its URL.
function readOAuthPending(providerId) {
  if (!providerId) return null;
  try {
    const info = JSON.parse(localStorage.getItem(oauthPendingKey(providerId)) || 'null');
    if (!info || Date.now() - Number(info.at) > OAUTH_PENDING_TTL) return null;
    return info;
  } catch {
    return null;
  }
}

function clearOAuthPending(providerId, state) {
  if (!providerId) return;
  try {
    const alive = JSON.parse(localStorage.getItem(oauthAliveKey(providerId)) || 'null');
    if (!alive || !waitAttempt || alive.attempt === waitAttempt) localStorage.removeItem(oauthAliveKey(providerId));
    const pending = readOAuthPending(providerId);
    if (!pending || !state || pending.state === state) localStorage.removeItem(oauthPendingKey(providerId));
  } catch {}
}

function writeOAuthAlive() {
  if (!waitProvider || waitFinished) return;
  try {
    localStorage.setItem(oauthAliveKey(waitProvider), JSON.stringify({ attempt: waitAttempt, at: Date.now() }));
  } catch {}
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

function setWaitStatus(message, tone = '') {
  if (waitStatus) waitStatus.textContent = message;
  if (waitProgress) {
    waitProgress.classList.toggle('is-bad', tone === 'bad');
    waitProgress.classList.toggle('is-ok', tone === 'ok');
  }
  if (waitDot) waitDot.classList.toggle('is-idle', tone === 'ok' || tone === 'bad');
}

function setWaitFormEnabled(enabled) {
  if (waitLink) waitLink.disabled = !enabled;
  if (waitSubmit) waitSubmit.disabled = !enabled;
  if (waitCancel) waitCancel.disabled = !enabled;
}

function stopWaitPolling() {
  clearInterval(waitTimer);
  waitTimer = null;
}

function stopPendingWait() {
  clearInterval(waitPendingTimer);
  waitPendingTimer = null;
}

function finishWait(kind, message) {
  if (waitFinished) return;
  waitFinished = true;
  stopWaitPolling();
  stopPendingWait();
  clearOAuthPending(waitProvider, waitState);
  setWaitFormEnabled(false);
  setWaitStatus(message, kind === 'complete' ? 'ok' : kind === 'error' ? 'bad' : '');
  if (waitLinkForm) waitLinkForm.hidden = true;
  if (waitCancel) waitCancel.hidden = true;
  if (waitClose) {
    waitClose.hidden = false;
    waitClose.focus();
  }
  if (kind === 'complete' || kind === 'cancelled') {
    window.setTimeout(() => {
      window.close();
      // Some browsers keep tabs opened this way alive. If that happens, say so
      // instead of leaving a "closing" message on a window that stays open.
      window.setTimeout(() => {
        if (waitFinished && !document.hidden) {
          setWaitStatus(kind === 'complete' ? 'Login complete. You can close this window.' : 'Login cancelled. You can close this window.', kind === 'complete' ? 'ok' : '');
        }
      }, 500);
    }, 900);
  }
}

function waitUnavailable(message) {
  waitFinished = true;
  stopWaitPolling();
  stopPendingWait();
  clearOAuthPending(waitProvider, waitState);
  if (waitTitle) waitTitle.textContent = 'Login unavailable';
  if (waitLede) waitLede.textContent = 'Start the login again from the provider page in the dashboard.';
  setWaitFormEnabled(false);
  setWaitStatus(message, 'bad');
  if (waitLinkForm) waitLinkForm.hidden = true;
  if (waitCancel) waitCancel.hidden = true;
  if (waitOpenSignIn) waitOpenSignIn.hidden = true;
  if (waitClose) {
    waitClose.hidden = false;
    waitClose.focus();
  }
}

async function pollWaitStatus() {
  if (waitFinished || !waitProvider || !waitState) return;
  writeOAuthAlive();
  const response = await fetch(`/api/providers/${encodeURIComponent(waitProvider)}/oauth/status/${encodeURIComponent(waitState)}`, { cache: 'no-store' }).catch(() => null);
  if (!response) return;
  if (response.status === 404) {
    waitUnavailable('Login status is not available. Restart the dashboard and try again.');
    return;
  }
  if (response.status === 401) {
    waitUnavailable('The dashboard session expired. Sign in again, then start the login.');
    return;
  }
  if (!response.ok) return;
  const body = await response.json().catch(() => ({}));
  if (body?.status === 'complete') {
    finishWait('complete', 'Login complete. Closing this window…');
  } else if (body?.status === 'unknown') {
    waitUnavailable('This login expired or was cancelled. Start it again from the dashboard.');
  }
}

function startWaitPolling() {
  stopWaitPolling();
  waitTimer = setInterval(pollWaitStatus, OAUTH_WAIT_POLL_MS);
  pollWaitStatus();
}

// Adopt the state from the URL when given, otherwise from the dashboard's
// pending entry. Re-adopting is allowed so a URL-only window can pick up the
// authorize link once the start request lands.
function adoptLogin(info, sourceState = '') {
  const state = String(info?.state || sourceState || '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(state)) return false;
  const attempt = String(info?.attempt || '');
  const unchanged = waitAdopted && waitState === state && waitAttempt === attempt;
  waitState = state;
  waitAttempt = attempt;
  const authorizeUrl = safeHttpUrl(info?.authorizeUrl);
  if (authorizeUrl && waitOpenSignIn) {
    waitOpenSignIn.href = authorizeUrl;
    waitOpenSignIn.hidden = false;
  }
  if (info?.callbackUrl && waitLink) {
    waitLink.placeholder = `${info.callbackUrl}?code=…&state=…`;
  }
  setWaitFormEnabled(true);
  if (unchanged) return true;
  waitAdopted = true;
  setWaitStatus('Waiting for you to finish the login…');
  writeOAuthAlive();
  startWaitPolling();
  return true;
}

function waitForPendingLogin() {
  stopPendingWait();
  setWaitFormEnabled(false);
  setWaitStatus('Waiting for the dashboard to start the login…');
  waitPendingDeadline = Date.now() + OAUTH_PENDING_WAIT_MS;
  const tryAdopt = () => {
    if (waitFinished) return;
    if (adoptLogin(readOAuthPending(waitProvider))) return;
    if (Date.now() > waitPendingDeadline) {
      stopPendingWait();
      waitUnavailable('This window has no pending login. Start it again from the dashboard.');
    }
  };
  waitPendingTimer = setInterval(tryAdopt, OAUTH_PENDING_POLL_MS);
  window.addEventListener('storage', (event) => {
    if (event.key === oauthPendingKey(waitProvider)) tryAdopt();
  });
  tryAdopt();
}

async function submitWaitLink(event) {
  event.preventDefault();
  if (waitFinished || waitBusy || !waitState) return;
  const redirectUrl = waitLink?.value.trim() || '';
  if (!redirectUrl) {
    setWaitStatus('Paste the final login link first.', 'bad');
    waitLink?.focus();
    return;
  }
  waitBusy = true;
  setWaitFormEnabled(false);
  setWaitStatus('Completing login…');
  try {
    const response = await fetch(`/api/providers/${encodeURIComponent(waitProvider)}/oauth/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirectUrl }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body.error?.message || `Could not complete login (${response.status}).`;
      if (response.status === 400 && OAUTH_LINK_ERRORS.test(message)) {
        setWaitStatus(message, 'bad');
        waitBusy = false;
        setWaitFormEnabled(true);
        waitLink?.focus();
        return;
      }
      finishWait('error', message);
      return;
    }
    finishWait('complete', 'Login complete. Closing this window…');
  } catch {
    setWaitStatus('Could not reach the local server. Check that norouter is running.', 'bad');
    waitBusy = false;
    setWaitFormEnabled(true);
  }
}

async function cancelWaitLogin() {
  if (waitFinished || waitBusy || !waitState) return;
  waitBusy = true;
  setWaitFormEnabled(false);
  setWaitStatus('Cancelling login…');
  await fetch(`/api/providers/${encodeURIComponent(waitProvider)}/oauth/cancel/${encodeURIComponent(waitState)}`, { method: 'POST' }).catch(() => {});
  finishWait('cancelled', 'Login cancelled. Closing this window…');
}

if (!waitCopy) {
  waitUnavailable('This window has no pending login. Start it again from the dashboard.');
} else {
  if (waitTitle) waitTitle.textContent = waitCopy.title;
  if (waitLede) waitLede.textContent = waitCopy.lede;
  // The callback port is fixed per provider; naming it here tells the operator
  // which loopback address the browser should come back to.
  if (waitCallback && waitCopy.callback) {
    waitCallback.textContent = `Callback ${waitCopy.callback}`;
    waitCallback.hidden = false;
  }
  waitLinkForm?.addEventListener('submit', submitWaitLink);
  waitCancel?.addEventListener('click', cancelWaitLogin);
  waitClose?.addEventListener('click', () => window.close());
  window.addEventListener('focus', pollWaitStatus);
  // Tell the dashboard when this window goes away so it can show the paste
  // field instead of waiting for a heartbeat that will never come.
  window.addEventListener('pagehide', () => {
    try {
      const alive = JSON.parse(localStorage.getItem(oauthAliveKey(waitProvider)) || 'null');
      if (alive && (!waitAttempt || alive.attempt === waitAttempt)) localStorage.removeItem(oauthAliveKey(waitProvider));
    } catch {}
  });
  if (waitState) {
    adoptLogin(readOAuthPending(waitProvider), waitState);
  } else {
    waitForPendingLogin();
  }
}
