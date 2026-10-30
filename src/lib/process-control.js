import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { ROOT } from '../config.js';

const MARKER = resolve(tmpdir(), `norouter-${createHash('sha256').update(resolve(ROOT)).digest('hex').slice(0, 16)}.pid`);

export function processMarkerPath() {
  return MARKER;
}

export function readManagedPid() {
  try {
    const pid = Number.parseInt(readFileSync(MARKER, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writeManagedPid(pid = process.pid) {
  writeFileSync(MARKER, `${pid}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function clearManagedPid(pid = process.pid) {
  if (readManagedPid() !== pid) return false;
  try {
    unlinkSync(MARKER);
    return true;
  } catch {
    return false;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
