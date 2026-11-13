// GET /api/live: server-sent events for the dashboard service map. The status
// endpoint keeps polling topology and totals; this stream only carries request
// lifecycle deltas, so a quiet gateway sends nothing but a heartbeat.

import { CORS_HEADERS } from '../lib/http.js';
import { addLiveSubscriber, liveHello } from '../lib/live.js';

const HEARTBEAT_MS = 25_000;

export function handleLive(req, res) {
  res.writeHead(200, {
    ...CORS_HEADERS,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const remove = addLiveSubscriber(res);

  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify(liveHello())}\n\n`);

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(': ping\n\n');
    } catch {
      // The close handler owns removal.
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    remove();
  };
  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);
}
