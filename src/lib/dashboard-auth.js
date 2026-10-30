import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { getDb } from './db.js';

const ENABLED_KEY = 'dashboard_auth.enabled';
const HASH_KEY = 'dashboard_auth.password_hash';
const SALT_KEY = 'dashboard_auth.password_salt';
const CONFIGURED_KEY = 'dashboard_auth.configured_at';
const DEFAULT_PASSWORD = '123456';
const DEFAULT_SALT = Buffer.from('norouter-dashboard-default-salt-v1');
const PASSWORD_MAX = 256;

function readMeta(key) {
  return getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

function writeMeta(key, value) {
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64);
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 4 && password.length <= PASSWORD_MAX;
}

export function getDashboardAuthSettings() {
  const configuredAt = readMeta(CONFIGURED_KEY);
  return {
    enabled: readMeta(ENABLED_KEY) === 'true',
    hasPassword: Boolean(readMeta(HASH_KEY) && readMeta(SALT_KEY)),
    configuredAt: configuredAt ? Number(configuredAt) || null : null,
  };
}

export function isDashboardPasswordEnabled() {
  return readMeta(ENABLED_KEY) === 'true';
}

export function setDashboardAuthEnabled(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
  writeMeta(ENABLED_KEY, enabled ? 'true' : 'false');
  return enabled;
}

export function setDashboardAuthPassword(password) {
  if (!validPassword(password)) throw new Error(`Password must be between 4 and ${PASSWORD_MAX} characters.`);
  const salt = randomBytes(16);
  const hash = hashPassword(password, salt);
  writeMeta(HASH_KEY, hash.toString('hex'));
  writeMeta(SALT_KEY, salt.toString('hex'));
  writeMeta(CONFIGURED_KEY, String(Date.now()));
  return { hasPassword: true, configuredAt: Date.now() };
}

export function verifyDashboardPassword(password) {
  if (!isDashboardPasswordEnabled() || typeof password !== 'string' || password.length > PASSWORD_MAX) return false;
  const storedHash = readMeta(HASH_KEY);
  const storedSalt = readMeta(SALT_KEY);
  const expected = storedHash && storedSalt
    ? Buffer.from(storedHash, 'hex')
    : hashPassword(DEFAULT_PASSWORD, DEFAULT_SALT);
  const salt = storedHash && storedSalt ? Buffer.from(storedSalt, 'hex') : DEFAULT_SALT;
  const actual = hashPassword(password, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export { DEFAULT_PASSWORD };
