import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../config.js';

const DIR = join(ROOT, 'src', 'dashboard');
const FLAGS_DIR = join(DIR, 'flags');

// Files are small and read per request so editing the design needs no restart.
const ASSETS = {
  '/assets/styles.css': 'text/css; charset=utf-8',
  '/assets/app.js': 'text/javascript; charset=utf-8',
  '/assets/icon.svg': 'image/svg+xml',
};

export function handleDashboard(req, res, status = 200) {
  let html = readFileSync(join(DIR, 'page.html'), 'utf8');
  if (status === 401) {
    html = html.replace('<body>', '<body class="dashboard-locked" data-dashboard-locked="true">');
  }
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}

export function handleAsset(pathname, req, res) {
  const type = ASSETS[pathname];
  if (type) {
    const file = pathname.slice('/assets/'.length);
    const body = readFileSync(join(DIR, file));
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(body);
    return true;
  }

  const flagMatch = /^\/assets\/flags\/([a-z0-9-]+)\.png$/.exec(pathname);
  if (flagMatch) {
    let body;
    try {
      body = readFileSync(join(FLAGS_DIR, `${flagMatch[1]}.png`));
    } catch {
      return false;
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(body);
    return true;
  }

  return false;
}
