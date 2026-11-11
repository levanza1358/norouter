import { randomBytes } from 'node:crypto';

export const SESSION_TTL_MS = 60 * 60 * 1000;
const sessions = new Map();

function prune(now = Date.now()) {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

export function createDashboardSession() {
  prune();
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function setDashboardSession(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  return true;
}

export function isValidDashboardSession(token) {
  if (typeof token !== 'string') return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function revokeDashboardSession(token) {
  if (typeof token !== 'string') return false;
  return sessions.delete(token);
}

export const DASHBOARD_SESSION_COOKIE = 'norouter_dashboard_session';
