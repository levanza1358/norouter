#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearManagedPid, isProcessAlive, readManagedPid } from '../src/lib/process-control.js';
import { installAutostart, uninstallAutostart, autostartStatus as getAutostartStatus } from '../src/lib/autostart.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server.js');
const SMOKE = join(ROOT, 'test', 'smoke.js');

const COMMANDS = {
  start: { script: SERVER, label: 'Start the HTTP server and dashboard' },
  restart: { label: 'Restart the managed HTTP server' },
  stop: { label: 'Stop the managed HTTP server' },
  update: { label: 'Fast-forward from the configured Git remote' },
  dev: { script: SERVER, nodeArgs: ['--watch'], label: 'Start the server with file watching' },
  test: { script: SMOKE, label: 'Run the smoke test suite' },
  install: { label: 'Create local configuration and start the server' },
  'autostart-on': { label: 'Enable operating-system autostart' },
  'autostart-off': { label: 'Disable operating-system autostart' },
  'autostart-status': { label: 'Show operating-system autostart status' },
  uninstall: { label: 'Confirm and remove this norouter checkout' },
};

function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function usage() {
  console.log([
    'Usage: norouter <command>',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([name, meta]) => `  ${name.padEnd(18)}${meta.label}`),
    '  help    Show this help',
    '  version Show the package version',
  ].join('\n'));
}

function waitForExit(pid, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (!isProcessAlive(pid) || Date.now() - started >= timeoutMs) return resolve(!isProcessAlive(pid));
      setTimeout(check, 50);
    };
    check();
  });
}

async function stopManagedServer({ quiet = false } = {}) {
  const pid = readManagedPid();
  if (!pid || !isProcessAlive(pid)) {
    if (pid) clearManagedPid(pid);
    if (!quiet) console.log('norouter: no managed server is running.');
    return false;
  }
  if (pid === process.pid) throw new Error('Refusing to stop the CLI process.');
  try { process.kill(pid, 'SIGTERM'); } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
  if (!(await waitForExit(pid))) throw new Error(`server process ${pid} did not stop in time.`);
  clearManagedPid(pid);
  if (!quiet) console.log(`norouter: stopped server process ${pid}.`);
  return true;
}

async function restart() {
  await stopManagedServer({ quiet: true });
  run(SERVER);
}

function ensureLocalSetup() {
  const envFile = join(ROOT, '.env');
  const example = join(ROOT, '.env.example');
  if (!existsSync(envFile)) writeFileSync(envFile, readFileSync(example), { mode: 0o600 });
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  console.log(`norouter: ready at ${envFile}`);
}

async function install() {
  ensureLocalSetup();
  run(SERVER);
}

function autostartOn() {
  console.log(JSON.stringify(installAutostart(), null, 2));
}

function autostartOff() {
  console.log(JSON.stringify(uninstallAutostart(), null, 2));
}

function autostartStatus() {
  console.log(JSON.stringify(getAutostartStatus(), null, 2));
}

function askConfirmation(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(false);
  const input = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => input.question(question, (answer) => { input.close(); resolve(/^(y|yes)$/i.test(answer.trim())); }));
}

function scheduleRemoval() {
  const target = ROOT;
  if (process.platform === 'win32') {
    const command = `ping 127.0.0.1 -n 3 >nul & rmdir /s /q "${target}"`;
    spawn('cmd.exe', ['/d', '/c', command], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn('sh', ['-c', `sleep 1; rm -rf -- ${JSON.stringify(target)}`], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function uninstall() {
  console.log(`This removes the norouter checkout, .env, config.local.json, and data/ SQLite files:\n  ${ROOT}`);
  if (!(await askConfirmation('Type y or yes to continue: '))) throw new Error('Uninstall cancelled.');
  await stopManagedServer({ quiet: true });
  try { uninstallAutostart(); } catch (err) { console.error(`norouter: autostart removal: ${err.message}`); }
  scheduleRemoval();
  console.log('norouter: uninstall scheduled.');
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function update() {
  if (!existsSync(join(ROOT, '.git'))) throw new Error('This installation is not a Git checkout.');
  if (git(['status', '--porcelain'])) throw new Error('Working tree is not clean; commit or stash local changes before update.');
  const branch = git(['branch', '--show-current']);
  if (!branch) throw new Error('Detached HEAD cannot be updated automatically.');
  const wasRunning = Boolean(readManagedPid() && isProcessAlive(readManagedPid()));
  git(['fetch', '--prune', 'origin']);
  const before = git(['rev-parse', 'HEAD']);
  git(['merge', '--ff-only', `origin/${branch}`]);
  const after = git(['rev-parse', 'HEAD']);
  if (before === after) {
    console.log(`norouter: already up to date (${branch}).`);
    return;
  }
  console.log(`norouter: updated ${before.slice(0, 8)} → ${after.slice(0, 8)}.`);
  if (wasRunning) {
    await stopManagedServer({ quiet: true });
    run(SERVER);
  }
}

function run(script, nodeArgs = [], scriptArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, script, ...scriptArgs], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  child.on('error', (err) => {
    console.error(`norouter: ${err.message}`);
    process.exit(1);
  });
  const forward = (signal) => () => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  child.on('exit', (code) => process.exit(code ?? 0));
}

const [command = 'help', ...rest] = process.argv.slice(2);

if (command === 'help' || command === '--help' || command === '-h') {
  usage();
} else if (command === 'version' || command === '--version' || command === '-v') {
  console.log(packageVersion());
} else if (command === 'restart') {
  restart().catch((err) => {
    console.error(`norouter: ${err.message}`);
    process.exit(1);
  });
} else if (command === 'stop') {
  stopManagedServer().catch((err) => {
    console.error(`norouter: ${err.message}`);
    process.exit(1);
  });
} else if (command === 'update') {
  update().catch((err) => {
    console.error(`norouter: ${err.message}`);
    process.exit(1);
  });
} else if (command === 'install') {
  install();
} else if (command === 'autostart-on') {
  try { autostartOn(); } catch (err) { console.error(`norouter: ${err.message}`); process.exit(1); }
} else if (command === 'autostart-off') {
  try { autostartOff(); } catch (err) { console.error(`norouter: ${err.message}`); process.exit(1); }
} else if (command === 'autostart-status') {
  autostartStatus();
} else if (command === 'uninstall') {
  uninstall().catch((err) => { console.error(`norouter: ${err.message}`); process.exit(1); });
} else if (COMMANDS[command]?.script) {
  const { script, nodeArgs = [] } = COMMANDS[command];
  run(script, nodeArgs, rest);
} else {
  console.error(`Unknown command "${command}".`);
  usage();
  process.exit(1);
}
