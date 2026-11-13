// Live request events for the dashboard service map. The bus is deliberately
// tiny: subscribers are response objects, publishing is a best-effort write,
// and nothing here ever throws into request handling. No event carries account
// labels, message text, headers, or upstream error bodies.

import { activeRequestSnapshot } from './stats.js';

const subscribers = new Set();
let sequence = 0;

export function nextLiveId() {
  sequence += 1;
  return `r-${sequence}`;
}

// The hello frame seeds in-flight work. activeRequestSnapshot() includes the
// account label, so map it through an explicit allowlist instead of spreading.
export function liveHello() {
  return {
    phase: 'hello',
    now: Date.now(),
    active: activeRequestSnapshot().map(({ provider, model, ms }) => ({ provider, model, ms })),
  };
}

export function publishLive(event) {
  if (subscribers.size === 0) return;
  let frame;
  try {
    frame = `data: ${JSON.stringify(event)}\n\n`;
  } catch {
    return;
  }
  for (const res of subscribers) {
    // A client that stopped reading must not grow the server buffer without
    // bound; the heartbeat notices the dead socket and cleanup removes it.
    if (res.writableEnded || res.destroyed || res.writableLength > 1_000_000) continue;
    try {
      res.write(frame);
    } catch {
      // The close handler owns removal.
    }
  }
}

export function addLiveSubscriber(res) {
  subscribers.add(res);
  return () => subscribers.delete(res);
}

// An open event stream keeps http.Server#close() waiting for its connections,
// so the port-change and shutdown paths release streams before closing.
export function closeLiveStreams() {
  for (const res of subscribers) {
    try {
      res.end();
    } catch {
      // Already gone.
    }
  }
  subscribers.clear();
}
