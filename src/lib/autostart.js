import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ROOT } from '../config-root.js';
import { readLocalConfig, writeLocalConfig } from './local-config.js';

const ID = `norouter-${Buffer.from(ROOT).toString('hex').slice(-16)}`;
const TASK_NAME = ID;
const SERVICE_NAME = `${ID}.service`;
const SERVICE_DIR = join(homedir(), '.config', 'systemd', 'user');
const SERVICE_FILE = join(SERVICE_DIR, SERVICE_NAME);

function commandExists(command) {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function windowsArgs() {
  return ['node', join(ROOT, 'src', 'server.js')];
}

function windowsTaskCommand() {
  return `\"${process.execPath}\" \"${join(ROOT, 'src', 'server.js')}\"`;
}

function linuxUnit() {
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  return [
    '[Unit]',
    'Description=Norouter AI gateway',
    'After=network-online.target',
    '',
    '[Service]',
    `WorkingDirectory=${quote(ROOT)}`,
    `ExecStart=${quote(process.execPath)} ${quote(join(ROOT, 'src', 'server.js'))}`,
    'Restart=on-failure',
    'RestartSec=3',
    'Environment=NODE_ENV=production',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function windowsInstalled() {
  if (process.platform !== 'win32' || !commandExists('schtasks')) return false;
  try {
    execFileSync('schtasks.exe', ['/Query', '/TN', TASK_NAME], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function linuxInstalled() {
  if (process.platform !== 'linux' || !commandExists('systemctl')) return false;
  try {
    execFileSync('systemctl', ['--user', 'is-enabled', SERVICE_NAME], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function autostartPlatform() {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'linux') return 'linux';
  return process.platform;
}

export function autostartSupported() {
  return process.platform === 'win32' ? commandExists('schtasks') : process.platform === 'linux' && commandExists('systemctl');
}

export function autostartStatus() {
  const enabled = process.platform === 'win32' ? windowsInstalled() : process.platform === 'linux' ? linuxInstalled() : false;
  return { enabled, supported: autostartSupported(), platform: autostartPlatform() };
}

export function installAutostart() {
  if (!autostartSupported()) throw new Error(`Autostart is not supported on ${autostartPlatform()} on this system.`);
  if (process.platform === 'win32') {
    execFileSync('schtasks.exe', ['/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/TR', windowsTaskCommand(), '/F'], { cwd: ROOT, stdio: 'ignore' });
  } else {
    mkdirSync(SERVICE_DIR, { recursive: true });
    writeFileSync(SERVICE_FILE, linuxUnit(), { encoding: 'utf8', mode: 0o600 });
    execFileSync('systemctl', ['--user', 'daemon-reload'], { cwd: ROOT });
    execFileSync('systemctl', ['--user', 'enable', SERVICE_NAME], { cwd: ROOT });
  }
  writeLocalConfig({ autostart: true });
  return autostartStatus();
}

export function uninstallAutostart() {
  if (process.platform === 'win32') {
    if (windowsInstalled()) execFileSync('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'], { stdio: 'ignore' });
  } else if (process.platform === 'linux') {
    if (linuxInstalled() && commandExists('systemctl')) execFileSync('systemctl', ['--user', 'disable', '--now', SERVICE_NAME], { cwd: ROOT, stdio: 'ignore' });
    if (existsSync(SERVICE_FILE)) unlinkSync(SERVICE_FILE);
    if (commandExists('systemctl')) execFileSync('systemctl', ['--user', 'daemon-reload'], { cwd: ROOT, stdio: 'ignore' });
  }
  writeLocalConfig({ autostart: false });
  return autostartStatus();
}

export function autostartPlan() {
  return {
    platform: autostartPlatform(),
    supported: autostartSupported(),
    taskName: process.platform === 'win32' ? TASK_NAME : null,
    serviceFile: process.platform === 'linux' ? SERVICE_FILE : null,
    command: process.platform === 'win32' ? windowsArgs() : [process.execPath, join(ROOT, 'src', 'server.js')],
    configured: Boolean(readLocalConfig().autostart),
  };
}

export { ID, SERVICE_FILE, SERVICE_NAME, TASK_NAME };
