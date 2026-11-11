import { readJson, sendError, sendJson } from '../lib/http.js';
import {
  getDashboardAuthSettings,
  isDashboardPasswordEnabled,
  setDashboardAuthEnabled,
  setDashboardAuthPassword,
  verifyDashboardPassword,
} from '../lib/dashboard-auth.js';
import {
  DASHBOARD_SESSION_COOKIE,
  SESSION_TTL_MS,
  createDashboardSession,
  isValidDashboardSession,
  revokeDashboardSession,
} from '../lib/dashboard-session.js';

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000;
const attempts = new Map();

function cookieHeader(token, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
  return `${DASHBOARD_SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax`;
}

function readSession(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${DASHBOARD_SESSION_COOKIE}=`));
  return match ? match.slice(DASHBOARD_SESSION_COOKIE.length + 1) : '';
}

export function hasDashboardSession(req) {
  return isValidDashboardSession(readSession(req));
}

export function handleDashboardAuthStatus(req, res) {
  const settings = getDashboardAuthSettings();
  return sendJson(res, 200, { enabled: settings.enabled, authenticated: settings.enabled && hasDashboardSession(req) });
}

export async function handleDashboardAuthLogin(req, res) {
  let body;
  try { body = await readJson(req, 16 * 1024); } catch (err) { return sendError(res, err.status || 400, err.message); }
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = attempts.get(ip);
  if (recent && recent.resetAt > now && recent.failures >= MAX_ATTEMPTS) {
    return sendError(res, 429, 'Too many failed login attempts. Try again later.');
  }
  if (!isDashboardPasswordEnabled()) return sendError(res, 400, 'Dashboard password is disabled.');
  const ok = verifyDashboardPassword(body?.password);
  if (!ok) {
    const failures = recent && recent.resetAt > now ? recent.failures + 1 : 1;
    attempts.set(ip, { failures, resetAt: now + WINDOW_MS });
    return sendError(res, failures >= MAX_ATTEMPTS ? 429 : 401, failures >= MAX_ATTEMPTS ? 'Too many failed login attempts. Try again later.' : 'Invalid dashboard password.');
  }
  attempts.delete(ip);
  const token = createDashboardSession();
  res.setHeader('Set-Cookie', cookieHeader(token));
  return sendJson(res, 200, { ok: true });
}

export function handleDashboardAuthLogout(req, res) {
  const token = readSession(req);
  revokeDashboardSession(token);
  res.setHeader('Set-Cookie', cookieHeader('', 0));
  return sendJson(res, 200, { ok: true });
}

export function handleDashboardAuthGetSettings(req, res) {
  const { enabled, hasPassword, configuredAt } = getDashboardAuthSettings();
  return sendJson(res, 200, { enabled, hasPassword, configuredAt });
}

export async function handleDashboardAuthUpdateSettings(req, res) {
  let body;
  try { body = await readJson(req, 16 * 1024); } catch (err) { return sendError(res, err.status || 400, err.message); }
  if (typeof body?.enabled !== 'boolean') return sendError(res, 400, 'enabled must be boolean.');
  const enabled = setDashboardAuthEnabled(body.enabled);
  if (enabled && !hasDashboardSession(req)) {
    res.setHeader('Set-Cookie', cookieHeader(createDashboardSession()));
  }
  return sendJson(res, 200, { enabled });
}

export async function handleDashboardAuthUpdatePassword(req, res) {
  let body;
  try { body = await readJson(req, 16 * 1024); } catch (err) { return sendError(res, err.status || 400, err.message); }
  try {
    const result = setDashboardAuthPassword(body?.password);
    return sendJson(res, 200, result);
  } catch (err) {
    return sendError(res, 400, err.message);
  }
}
