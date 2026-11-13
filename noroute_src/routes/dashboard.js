import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { ROOT } from '../config.js';

const DIR = join(ROOT, 'noroute_src', 'dashboard');
const FLAGS_DIR = join(DIR, 'flags');
const FONTS_DIR = join(DIR, 'fonts');

// Files are small and read per request so editing the design needs no restart.
const ASSETS = {
  '/assets/styles.css': 'text/css; charset=utf-8',
  '/assets/icon.svg': 'image/svg+xml',
};

const SCRIPT_TYPE = 'text/javascript; charset=utf-8';

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

  const scriptMatch = /^\/assets\/([a-z0-9-]+\.js)$/.exec(pathname);
  if (scriptMatch) {
    let body;
    try {
      body = readFileSync(join(DIR, basename(scriptMatch[1])));
    } catch {
      return false;
    }
    res.writeHead(200, {
      'content-type': SCRIPT_TYPE,
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(body);
    return true;
  }

  const fontMatch = /^\/assets\/fonts\/([a-z0-9-]+\.woff2)$/.exec(pathname);
  if (fontMatch) {
    let body;
    try {
      body = readFileSync(join(FONTS_DIR, basename(fontMatch[1])));
    } catch {
      return false;
    }
    res.writeHead(200, {
      'content-type': 'font/woff2',
      // The bundle ships with the app, and the file name does not change when
      // the font is updated, so revalidate rather than cache for a year.
      'cache-control': 'no-cache',
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
