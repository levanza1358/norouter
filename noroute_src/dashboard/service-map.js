/* ---------------- live service map ---------------- */

// One renderer serves the compact dashboard strip and the full /map board. The
// topology comes from the normal /api/status poll; only request lifecycle
// deltas arrive over /api/live. Every wire draws as soon as its topology is
// known and stays static; motion belongs to wires that are actually carrying a
// request, so an idle gateway reads as a real path instead of a blank board.

const serviceMapSession = {
  requests: 0,
  errors: 0,
  tokens: 0,
  lastMs: null,
  inflight: 0,
  stamps: [],
  pending: new Map(),
  feed: [],
};

const serviceMapHosts = [];
let serviceMapSource = null;
let serviceMapLink = 'paused';
let serviceMapPalette = null;
let serviceMapRaf = 0;
let serviceMapRetry = 0;

// How long a dot, lane, wire, or the rail stays lit after an event. A request
// can finish in under a second, so a short flash would vanish before the eye
// catches it and the map would look dead between requests.
const serviceMapLinger = 2_000;

function serviceMapClock(ts) {
  const date = new Date(Number(ts) || Date.now());
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

function serviceMapReadColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    accent: style.getPropertyValue('--accent').trim() || '#2450c8',
    accent2: style.getPropertyValue('--accent-2').trim() || '#4d72dd',
    bad: style.getPropertyValue('--bad').trim() || '#a83a2c',
  };
}

function serviceMapPaletteNow() {
  if (!serviceMapPalette) serviceMapPalette = serviceMapReadColors();
  return serviceMapPalette;
}

function serviceMapVisible(inst) {
  return inst.el.host.offsetParent !== null && inst.el.stage.clientWidth > 0;
}

function serviceMapSetLink(state) {
  serviceMapLink = state;
  const label = state === 'polling' ? 'polling only' : state;
  for (const inst of serviceMapHosts) {
    if (!inst.el.live) continue;
    inst.el.live.dataset.state = state;
    inst.el.live.querySelector('b').textContent = label;
    inst.el.live.title = state === 'live'
      ? 'Receiving request events over /api/live'
      : state === 'polling'
        ? 'This browser cannot open the live stream; topology still polls'
        : state === 'paused'
          ? 'Live stream paused while the map is out of view'
          : 'Live stream is reconnecting';
  }
}

function serviceMapConnect() {
  if (serviceMapSource || typeof EventSource !== 'function') return;
  if (document.visibilityState === 'hidden') return;
  serviceMapSetLink('connecting');
  const source = new EventSource('/api/live');
  serviceMapSource = source;

  source.onopen = () => {
    if (serviceMapSource === source) serviceMapSetLink('live');
  };
  source.onerror = () => {
    if (serviceMapSource !== source) return;
    if (source.readyState === EventSource.CLOSED) {
      serviceMapClose(false);
      serviceMapSetLink('offline');
      clearTimeout(serviceMapRetry);
      serviceMapRetry = setTimeout(serviceMapSync, 10_000);
      return;
    }
    serviceMapSetLink('reconnecting');
  };
  source.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    serviceMapEvent(payload);
  };
}

function serviceMapClose(paused = true) {
  if (serviceMapSource) {
    serviceMapSource.close();
    serviceMapSource = null;
  }
  clearTimeout(serviceMapRetry);
  serviceMapRetry = 0;
  if (paused) serviceMapSetLink('paused');
}

function serviceMapSync() {
  const watching = serviceMapHosts.some(serviceMapVisible);
  if (!watching || document.visibilityState === 'hidden') {
    if (serviceMapSource) serviceMapClose(true);
    return;
  }
  if (typeof EventSource !== 'function') {
    serviceMapSetLink('polling');
    return;
  }
  if (!serviceMapSource) {
    serviceMapConnect();
    return;
  }
  if (serviceMapLink === 'paused') serviceMapSetLink('connecting');
}

/* ---------------- skeleton ---------------- */

function serviceMapLaneMeta(provider) {
  const percent = provider.quota?.percent;
  if (percent != null) return `${percent}% used`;
  const count = provider.models || 0;
  return `${count} model${count === 1 ? '' : 's'}`;
}

function serviceMapLaneMarkup(provider, mode) {
  const percent = provider.quota?.percent;
  const depleted = percent != null && percent >= 100;
  const id = escapeHtml(provider.id);
  if (mode === 'compact') {
    return `<span class="smap-lane smap-stop" data-provider="${id}" title="${escapeHtml(`${provider.id} · ${serviceMapLaneMeta(provider)}`)}">
      <i class="smap-stop-dot${depleted ? ' is-warn' : ''}"></i>
      <b>${id}</b>
    </span>`;
  }
  return `<span class="smap-lane" data-provider="${id}">
    <i class="smap-dot${depleted ? ' is-warn' : ''}"></i>
    <span class="smap-lane-name">${id}</span>
    <em>${escapeHtml(serviceMapLaneMeta(provider))}</em>
  </span>`;
}

function serviceMapBuild(host) {
  const mode = host.dataset.serviceMap === 'full' ? 'full' : 'compact';
  const full = mode === 'full';
  const kpis = full
    ? [['req', 'requests'], ['err', 'errors'], ['tok', 'tokens'], ['rate', 'req/min'], ['last', 'last']]
    : [['req', 'req'], ['err', 'err'], ['tok', 'tok']];

  host.classList.add('smap');
  host.dataset.mode = mode;
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', 'Live request path from the client through the local gate to an upstream model');
  const head = `
    <div class="smap-head">
      <div class="smap-head-copy">
        <h2 class="card-title">${full ? 'Request path' : 'Service map'}</h2>
        ${full ? '<p class="smap-sub">Requests move from the client through the local gate into one upstream lane.</p>' : ''}
      </div>
      <div class="smap-head-side">
        ${kpis.map(([key, label]) => `<span class="smap-kpi" title="Counted since this page opened"><b data-kpi="${key}">—</b>${label}</span>`).join('')}
        <span class="smap-live" data-state="paused"><i></i><b>paused</b></span>
      </div>
    </div>`;
  const stage = full
    ? `
    <div class="smap-stage">
      <div class="smap-flow">
        <div class="smap-node smap-client" data-map-node="client">
          <span class="smap-node-kicker">client</span>
          <strong>OpenAI SDK</strong>
          <span class="smap-meta" data-map="clientMeta">idle</span>
        </div>
        <div class="smap-node smap-gate" data-map-node="gate">
          <span class="smap-node-kicker">local gate</span>
          <div class="smap-pills">
            <span class="smap-pill" data-gate="auth">auth</span>
            <span class="smap-pill" data-gate="route">route</span>
            <span class="smap-pill" data-gate="relay">relay</span>
          </div>
        </div>
        <div class="smap-lanes" data-map-node="lanes">
          <span class="smap-empty">Waiting for status<span>Topology loads with the dashboard poll.</span></span>
        </div>
        <div class="smap-outcomes" data-map-node="outcomes">
          <span class="smap-outcome" data-outcome="chat"><i></i>Chat stream</span>
          <span class="smap-outcome" data-outcome="tool"><i></i>Tool call</span>
          <span class="smap-outcome" data-outcome="tokens"><i></i>Tokens</span>
        </div>
      </div>
      <svg class="smap-wires" aria-hidden="true"></svg>
      <canvas class="smap-particles" aria-hidden="true"></canvas>
    </div>
    <div class="smap-lower">
      <section class="smap-feed">
        <div class="smap-lower-head"><h3>Live events</h3><span class="smap-feed-count" data-map="feedCount">0</span></div>
        <ol class="smap-feed-list" data-map="feed" aria-label="Recent live request events"></ol>
      </section>
      <section class="smap-legend">
        <div class="smap-lower-head"><h3>Reading the map</h3></div>
        <p>Every configured path is drawn as a solid line. A wire turns into a moving dash only while a request is using it, then settles back. A red wire means the request failed before a reply.</p>
      </section>
    </div>`
    : `
    <div class="smap-stage smap-stage-rail">
      <span class="smap-rail-line" aria-hidden="true"></span>
      <div class="smap-rail">
        <div class="smap-stop smap-stop-client" data-stop="client">
          <i class="smap-stop-dot"></i>
          <b>client</b>
        </div>
        <div class="smap-stop smap-stop-gate" data-stop="gate">
          <i class="smap-stop-dot"></i>
          <b>local gate</b>
        </div>
        <div class="smap-lanes" data-map-node="lanes">
          <span class="smap-stop is-empty"><i class="smap-stop-dot"></i><b>waiting for status</b></span>
        </div>
      </div>
      <canvas class="smap-particles" aria-hidden="true"></canvas>
    </div>`;

  host.innerHTML = head + stage;

  const inst = {
    mode,
    limit: full ? 8 : 5,
    el: {
      host,
      stage: host.querySelector('.smap-stage'),
      client: host.querySelector('[data-stop="client"], .smap-client'),
      gate: host.querySelector('[data-stop="gate"], .smap-gate'),
      lanes: host.querySelector('.smap-lanes'),
      outcomes: host.querySelector('.smap-outcomes'),
      svg: host.querySelector('.smap-wires'),
      railLine: host.querySelector('.smap-rail-line'),
      canvas: host.querySelector('.smap-particles'),
      live: host.querySelector('.smap-live'),
      clientMeta: host.querySelector('[data-map="clientMeta"]'),
      feed: host.querySelector('[data-map="feed"]'),
      feedCount: host.querySelector('[data-map="feedCount"]'),
    },
    laneSig: '',
    laneWires: null,
    mainWire: null,
    liveMain: new Set(),
    liveLanes: new Map(),
    particles: [],
    ctx: null,
    size: null,
    lastFrame: 0,
  };
  serviceMapHosts.push(inst);
  serviceMapUpdateText();
  // Draw the client→gate wire now instead of waiting for the first status poll;
  // lanes join it as soon as their providers arrive.
  serviceMapSchedule(inst);
  return inst;
}

/* ---------------- topology ---------------- */

function serviceMapTopology(providers) {
  if (!Array.isArray(providers)) return;
  const ready = providers.filter((provider) => provider && isReady(provider.credential));
  for (const inst of serviceMapHosts) {
    const shown = ready.slice(0, inst.limit);
    const sig = `${shown.map((p) => [p.id, p.models, p.quota?.percent ?? ''].join(':')).join('|')}#${ready.length}`;
    if (sig === inst.laneSig) continue;
    inst.laneSig = sig;
    const more = ready.length - shown.length;
    inst.el.lanes.innerHTML = shown.length
      ? shown.map((provider) => serviceMapLaneMarkup(provider, inst.mode)).join('')
        + (more > 0
          ? inst.mode === 'full'
            ? `<span class="smap-more">+${more} more</span>`
            : `<a class="smap-more smap-stop" href="/map" title="Open the full map"><i class="smap-stop-dot is-more"></i><b>+${more} more</b></a>`
          : '')
      : inst.mode === 'full'
        ? '<a class="smap-empty" href="/providers">No provider ready<span>Add an account to open a lane.</span></a>'
        : '<a class="smap-stop is-empty" href="/providers" title="Add an account"><i class="smap-stop-dot"></i><b>no provider ready</b></a>';
    serviceMapSchedule(inst);
  }
}

function serviceMapEnsureLane(inst, providerId) {
  if (!providerId) return null;
  const lanes = [...inst.el.lanes.querySelectorAll('.smap-lane')];
  const found = lanes.find((lane) => lane.dataset.provider === providerId);
  if (found) return found;
  if (inst.mode === 'compact') {
    if (lanes.length >= inst.limit + 1) return null;
    inst.el.lanes.querySelector('.smap-stop.is-empty, .smap-empty')?.remove();
    const lane = document.createElement('span');
    lane.className = 'smap-lane smap-stop';
    lane.dataset.provider = providerId;
    lane.title = providerId;
    lane.innerHTML = `<i class="smap-stop-dot"></i><b>${escapeHtml(providerId)}</b>`;
    inst.el.lanes.appendChild(lane);
    serviceMapLayout(inst);
    return lane;
  }
  inst.el.lanes.querySelector('.smap-empty')?.remove();
  const lane = document.createElement('span');
  lane.className = 'smap-lane';
  lane.dataset.provider = providerId;
  lane.innerHTML = `<i class="smap-dot"></i><span class="smap-lane-name">${escapeHtml(providerId)}</span><em>relay</em>`;
  inst.el.lanes.appendChild(lane);
  serviceMapLayout(inst);
  return lane;
}

function serviceMapSchedule(inst) {
  requestAnimationFrame(() => {
    if (!serviceMapVisible(inst)) return;
    serviceMapLayout(inst);
    serviceMapResize(inst);
    serviceMapSync();
  });
}

/* ---------------- geometry ---------------- */

function serviceMapMakeWire(svg, from, to, cls) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const mid = from.x + (to.x - from.x) * 0.5;
  const wire = {
    x1: from.x,
    y1: from.y,
    cx1: mid,
    cy1: from.y,
    cx2: mid,
    cy2: to.y,
    x2: to.x,
    y2: to.y,
    path,
  };
  path.setAttribute('d', `M${from.x} ${from.y} C${wire.cx1} ${wire.cy1} ${wire.cx2} ${wire.cy2} ${to.x} ${to.y}`);
  path.setAttribute('class', cls);
  svg.appendChild(path);
  return wire;
}

/* Compact mode draws one straight rail: station dots sit on a hairline and
   particles run along it. There are no SVG paths to pulse, so wires are plain
   geometry shared with the particle evaluator. */
function serviceMapStopPoint(stage, el) {
  const base = stage.getBoundingClientRect();
  const dot = el.querySelector('.smap-stop-dot') || el;
  const rect = dot.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2 - base.left,
    y: rect.top + rect.height / 2 - base.top,
  };
}

function serviceMapRailWire(from, to) {
  const dx = to.x - from.x;
  return {
    x1: from.x,
    y1: from.y,
    cx1: from.x + dx / 3,
    cy1: from.y,
    cx2: from.x + (dx * 2) / 3,
    cy2: from.y,
    x2: to.x,
    y2: to.y,
  };
}

function serviceMapLayoutRail(inst) {
  const stage = inst.el.stage;
  const width = stage.clientWidth;
  if (!width) return;

  const client = serviceMapStopPoint(stage, inst.el.client);
  const gate = serviceMapStopPoint(stage, inst.el.gate);
  const padRight = parseFloat(getComputedStyle(stage).paddingRight) || 0;
  const end = { x: Math.max(client.x, width - padRight - 1), y: client.y };

  const line = inst.el.railLine;
  if (line) {
    const length = end.x - client.x;
    line.style.left = `${client.x}px`;
    line.style.top = `${client.y}px`;
    line.style.width = `${Math.max(0, length)}px`;
    line.classList.toggle('is-off', length < 8);
  }

  inst.mainWire = serviceMapRailWire(client, gate);
  const laneWires = new Map();
  for (const lane of inst.el.lanes.querySelectorAll('.smap-lane')) {
    const at = serviceMapStopPoint(stage, lane);
    const out = serviceMapRailWire(at, { x: end.x, y: at.y });
    laneWires.set(lane.dataset.provider, {
      toLane: serviceMapRailWire(gate, at),
      outs: { chat: out, tool: out, tokens: out },
    });
  }
  inst.laneWires = laneWires;
}

function serviceMapLayout(inst) {
  if (inst.mode === 'compact') {
    serviceMapLayoutRail(inst);
    return;
  }
  const stage = inst.el.stage;
  const svg = inst.el.svg;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (!width || !height) return;

  const base = stage.getBoundingClientRect();
  const anchor = (el, side) => {
    const rect = el.getBoundingClientRect();
    return {
      x: (side === 'right' ? rect.right : rect.left) - base.left,
      y: rect.top + rect.height / 2 - base.top,
    };
  };

  svg.innerHTML = '';
  inst.mainWire = serviceMapMakeWire(
    svg,
    anchor(inst.el.client, 'right'),
    anchor(inst.el.gate, 'left'),
    'smap-wire smap-wire-main',
  );

  const gateAnchor = anchor(inst.el.gate, 'right');
  const outcomes = {
    chat: inst.el.outcomes.querySelector('[data-outcome="chat"]'),
    tool: inst.el.outcomes.querySelector('[data-outcome="tool"]'),
    tokens: inst.el.outcomes.querySelector('[data-outcome="tokens"]'),
  };
  const laneWires = new Map();
  for (const lane of inst.el.lanes.querySelectorAll('.smap-lane')) {
    const left = anchor(lane, 'left');
    const right = anchor(lane, 'right');
    const entry = {
      toLane: serviceMapMakeWire(svg, gateAnchor, left, 'smap-wire smap-wire-lane'),
      outs: {},
    };
    for (const [key, outcome] of Object.entries(outcomes)) {
      if (outcome) entry.outs[key] = serviceMapMakeWire(svg, right, anchor(outcome, 'left'), 'smap-wire smap-wire-out');
    }
    laneWires.set(lane.dataset.provider, entry);
  }
  inst.laneWires = laneWires;
  // A layout rebuild replaces every path, so restore the live state that was
  // already tracked for in-flight requests.
  serviceMapPaintLive(inst);
  serviceMapResize(inst);
}

function serviceMapResize(inst) {
  const stage = inst.el.stage;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (!width || !height) return;
  if (inst.size && inst.size.w === width && inst.size.h === height) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = inst.el.canvas;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  inst.size = { w: width, h: height };
  inst.ctx = canvas.getContext('2d');
  inst.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/* ---------------- particles ---------------- */

function serviceMapPoint(p, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p.x1 + 3 * u * u * t * p.cx1 + 3 * u * t * t * p.cx2 + t * t * t * p.x2,
    y: u * u * u * p.y1 + 3 * u * u * t * p.cy1 + 3 * u * t * t * p.cy2 + t * t * t * p.y2,
  };
}

function serviceMapSpawn(inst, wire, tone = 'request', reverse = false) {
  if (!wire || motionReduced() || !serviceMapVisible(inst)) return;
  const palette = serviceMapPaletteNow();
  const color = tone === 'bad' ? palette.bad : tone === 'tool' ? palette.accent2 : palette.accent;
  const shape = reverse
    ? { x1: wire.x2, y1: wire.y2, cx1: wire.cx2, cy1: wire.cy2, cx2: wire.cx1, cy2: wire.cy1, x2: wire.x1, y2: wire.y1 }
    : wire;
  inst.particles.push({
    ...shape,
    t: 0,
    dur: tone === 'bad' ? 1_100 : 1_800,
    color,
    radius: tone === 'bad' ? 2.4 : 2,
  });
  if (inst.particles.length > 120) inst.particles.splice(0, inst.particles.length - 120);
  serviceMapEnsureLoop();
}

function serviceMapEnsureLoop() {
  if (!serviceMapRaf) serviceMapRaf = requestAnimationFrame(serviceMapFrame);
}

function serviceMapFrame(now) {
  serviceMapRaf = 0;
  let alive = false;

  for (const inst of serviceMapHosts) {
    if (!inst.particles.length) {
      inst.lastFrame = 0;
      continue;
    }
    if (!serviceMapVisible(inst)) {
      inst.particles.length = 0;
      inst.lastFrame = 0;
      continue;
    }
    const ctx = inst.ctx;
    if (!ctx || !inst.size) {
      inst.particles.length = 0;
      continue;
    }

    const delta = inst.lastFrame ? Math.min(64, now - inst.lastFrame) : 16;
    inst.lastFrame = now;
    ctx.clearRect(0, 0, inst.size.w, inst.size.h);

    for (let index = inst.particles.length - 1; index >= 0; index -= 1) {
      const particle = inst.particles[index];
      particle.t += delta / particle.dur;
      if (particle.t >= 1) {
        inst.particles.splice(index, 1);
        continue;
      }
      const point = serviceMapPoint(particle, particle.t);
      ctx.fillStyle = particle.color;
      ctx.globalAlpha = 0.16 + 0.16 * Math.sin(particle.t * Math.PI);
      ctx.beginPath();
      ctx.arc(point.x, point.y, particle.radius + 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(point.x, point.y, particle.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    if (inst.particles.length) {
      alive = true;
    } else {
      ctx.clearRect(0, 0, inst.size.w, inst.size.h);
      inst.lastFrame = 0;
    }
  }

  if (alive) serviceMapEnsureLoop();
}

/* ---------------- event reactions ---------------- */

function serviceMapHit(el, cls = 'is-hit', duration = 520) {
  if (!el || motionReduced()) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  clearTimeout(el._smapHit);
  el._smapHit = setTimeout(() => el.classList.remove(cls), duration);
}

function serviceMapHot(wire, duration = serviceMapLinger, bad = false) {
  if (!wire?.path) return;
  const el = wire.path;
  const cls = bad ? 'is-bad' : 'is-hot';
  el.classList.remove('is-hot', 'is-bad');
  el.classList.add(cls);
  clearTimeout(el._smapHot);
  el._smapHot = setTimeout(() => el.classList.remove(cls), duration);
}

/* A wire is live while at least one request is using it. Turning it off keeps
   the flow animation for the linger window so a fast request stays visible,
   then the wire returns to its static line. */
function serviceMapSetLive(wire, live, bad = false) {
  if (!wire?.path) return;
  const el = wire.path;
  if (live) {
    clearTimeout(el._smapOff);
    el.classList.remove('is-hot', 'is-bad');
    el.classList.add('is-live');
    return;
  }
  if (!el.classList.contains('is-live')) return;
  el.classList.remove('is-live');
  el.classList.add(bad ? 'is-bad' : 'is-hot');
  clearTimeout(el._smapOff);
  el._smapOff = setTimeout(() => el.classList.remove('is-hot', 'is-bad'), serviceMapLinger);
}

function serviceMapPaintLive(inst) {
  if (inst.mode !== 'full') return;
  serviceMapSetLive(inst.mainWire, inst.liveMain.size > 0);
  for (const [provider, entry] of inst.laneWires || []) {
    serviceMapSetLive(entry.toLane, (inst.liveLanes.get(provider)?.size || 0) > 0);
  }
}

function serviceMapTrack(inst, id, provider) {
  inst.liveMain.add(id);
  if (!provider) return;
  let ids = inst.liveLanes.get(provider);
  if (!ids) inst.liveLanes.set(provider, (ids = new Set()));
  ids.add(id);
}

function serviceMapUntrack(inst, id) {
  inst.liveMain.delete(id);
  for (const [key, ids] of inst.liveLanes) {
    ids.delete(id);
    if (!ids.size) inst.liveLanes.delete(key);
  }
}

/* The compact rail is one hairline, so it lights as a whole: a short sweep
   travels its length, then the line fades back. */
function serviceMapRailLive(inst, bad = false) {
  const el = inst.el.railLine;
  if (!el || motionReduced()) return;
  el.classList.remove('is-live');
  el.classList.toggle('is-bad', bad);
  void el.offsetWidth;
  el.classList.add('is-live');
  clearTimeout(el._smapRail);
  el._smapRail = setTimeout(() => el.classList.remove('is-live', 'is-bad'), serviceMapLinger);
}

function serviceMapLaneWire(inst, providerId) {
  return providerId ? inst.laneWires?.get(providerId) : null;
}

/* Both modes react to the same lifecycle phases; only the gate element differs. */
function serviceMapGateStage(inst, stage) {
  return inst.mode === 'full' ? inst.el.gate.querySelector(`[data-gate="${stage}"]`) : inst.el.gate;
}

function serviceMapEvent(event) {
  if (!event || typeof event !== 'object') return;
  const now = Date.now();
  const session = serviceMapSession;

  if (event.phase === 'hello') {
    session.inflight = Array.isArray(event.active) ? event.active.length : 0;
    if (serviceMapSource) serviceMapSetLink('live');
    serviceMapUpdateText();
    return;
  }

  if (event.phase === 'start') {
    session.requests += 1;
    session.stamps.push(Number(event.at) || now);
    session.pending.set(event.id, { kind: event.kind || 'chat', model: event.model || '' });
    session.inflight += 1;
    session.feed.unshift(event);
    session.feed = session.feed.slice(0, 12);
    for (const inst of serviceMapHosts) {
      if (!serviceMapVisible(inst)) continue;
      serviceMapHit(inst.el.client, 'is-hit', serviceMapLinger);
      serviceMapHit(serviceMapGateStage(inst, 'auth'), 'is-hit', serviceMapLinger);
      serviceMapTrack(inst, event.id, null);
      serviceMapPaintLive(inst);
      serviceMapRailLive(inst);
      serviceMapSpawn(inst, inst.mainWire);
    }
  } else if (event.phase === 'route') {
    const pending = session.pending.get(event.id);
    if (pending) pending.provider = event.provider;
    session.feed.unshift(event);
    session.feed = session.feed.slice(0, 12);
    for (const inst of serviceMapHosts) {
      if (!serviceMapVisible(inst)) continue;
      const lane = serviceMapEnsureLane(inst, event.provider);
      serviceMapUntrack(inst, event.id);
      serviceMapTrack(inst, event.id, event.provider);
      serviceMapPaintLive(inst);
      serviceMapHit(serviceMapGateStage(inst, 'route'), 'is-hit', serviceMapLinger);
      serviceMapHit(lane, 'is-active', serviceMapLinger);
      const entry = serviceMapLaneWire(inst, event.provider);
      serviceMapRailLive(inst);
      serviceMapSpawn(inst, entry?.toLane);
    }
  } else if (event.phase === 'first') {
    session.feed.unshift(event);
    session.feed = session.feed.slice(0, 12);
    for (const inst of serviceMapHosts) {
      if (!serviceMapVisible(inst)) continue;
      const lane = serviceMapEnsureLane(inst, event.provider);
      serviceMapTrack(inst, event.id, event.provider);
      serviceMapPaintLive(inst);
      serviceMapHit(serviceMapGateStage(inst, 'relay'), 'is-hit', serviceMapLinger);
      serviceMapHit(lane, 'is-active', serviceMapLinger);
      const entry = serviceMapLaneWire(inst, event.provider);
      serviceMapRailLive(inst);
    }
  } else if (event.phase === 'finish') {
    const pending = session.pending.get(event.id);
    session.pending.delete(event.id);
    session.inflight = Math.max(0, session.inflight - 1);
    session.tokens += (event.tokensIn || 0) + (event.tokensOut || 0);
    if (Number.isFinite(event.ms)) session.lastMs = event.ms;
    session.feed.unshift(event);
    session.feed = session.feed.slice(0, 12);
    const provider = event.provider || pending?.provider;
    const outcomeKey = event.tool ? 'tool' : 'chat';
    for (const inst of serviceMapHosts) {
      if (!serviceMapVisible(inst)) continue;
      const lane = serviceMapEnsureLane(inst, provider);
      serviceMapUntrack(inst, event.id);
      serviceMapPaintLive(inst);
      serviceMapHit(serviceMapGateStage(inst, 'relay'), 'is-hit', serviceMapLinger);
      serviceMapHit(lane, 'is-active', serviceMapLinger);
      const outcome = inst.el.outcomes?.querySelector(`[data-outcome="${outcomeKey}"]`);
      if (outcome) serviceMapHit(outcome, 'is-hit', serviceMapLinger);
      if ((event.tokensIn || 0) + (event.tokensOut || 0) > 0) {
        const tokenOutcome = inst.el.outcomes?.querySelector('[data-outcome="tokens"]');
        if (tokenOutcome) serviceMapHit(tokenOutcome, 'is-hit', serviceMapLinger);
      }
      const entry = serviceMapLaneWire(inst, provider);
      const wire = entry?.outs?.[outcomeKey];
      if (wire) serviceMapHot(wire, serviceMapLinger);
      serviceMapRailLive(inst);
      serviceMapSpawn(inst, wire, event.tool ? 'tool' : 'request');
    }
  } else if (event.phase === 'error') {
    const pending = session.pending.get(event.id);
    session.pending.delete(event.id);
    session.inflight = Math.max(0, session.inflight - 1);
    session.errors += 1;
    session.feed.unshift(event);
    session.feed = session.feed.slice(0, 12);
    const provider = event.provider || pending?.provider;
    for (const inst of serviceMapHosts) {
      if (!serviceMapVisible(inst)) continue;
      const lane = serviceMapEnsureLane(inst, provider);
      serviceMapUntrack(inst, event.id);
      serviceMapPaintLive(inst);
      serviceMapHit(lane, 'is-error', serviceMapLinger);
      serviceMapHit(inst.el.gate, 'is-error', serviceMapLinger);
      serviceMapRailLive(inst, true);
      const entry = serviceMapLaneWire(inst, provider);
      if (entry) {
        serviceMapHot(entry.toLane, serviceMapLinger, true);
        serviceMapSpawn(inst, entry.toLane, 'bad', true);
      } else {
        serviceMapSpawn(inst, inst.mainWire, 'bad', true);
      }
    }
  } else {
    return;
  }

  serviceMapUpdateText();
  serviceMapRenderFeed();
}

/* ---------------- text + feed ---------------- */

function serviceMapUpdateText() {
  const session = serviceMapSession;
  const cutoff = Date.now() - 60_000;
  while (session.stamps.length && session.stamps[0] < cutoff) session.stamps.shift();

  const values = {
    req: String(session.requests),
    err: String(session.errors),
    tok: compact(session.tokens),
    rate: String(session.stamps.length),
    last: session.lastMs == null ? '—' : `${session.lastMs} ms`,
  };
  const clientMeta = session.inflight > 0 ? `${session.inflight} in flight` : 'idle';

  for (const inst of serviceMapHosts) {
    for (const [key, value] of Object.entries(values)) {
      const node = inst.el.host.querySelector(`[data-kpi="${key}"]`);
      if (node && node.textContent !== value) node.textContent = value;
    }
    inst.el.host.querySelector('[data-kpi="err"]')?.classList.toggle('is-bad', session.errors > 0);
    if (inst.el.clientMeta && inst.el.clientMeta.textContent !== clientMeta) inst.el.clientMeta.textContent = clientMeta;
  }
}

function serviceMapFeedRow(event) {
  const phase = String(event.phase || '');
  const what = [event.provider, event.model].filter(Boolean).join(' · ') || 'local gate';
  let meta = '';
  if (phase === 'start') {
    meta = `${event.kind || 'chat'} · ${event.stream ? 'stream' : 'sync'}${event.tools ? ' · tools' : ''}`;
  } else if (phase === 'route') {
    meta = `attempt ${event.attempt || 1}`;
  } else if (phase === 'first') {
    meta = `status ${event.status || 200}`;
  } else if (phase === 'finish') {
    meta = `${event.ms ?? 0} ms · ${(event.tokensIn || 0) + (event.tokensOut || 0)} tok`;
  } else if (phase === 'error') {
    meta = `${event.status || '—'} · ${event.stage || 'error'}`;
  }
  return `<li class="smap-ev">
    <time>${serviceMapClock(event.at)}</time>
    <span class="smap-ev-phase" data-phase="${escapeHtml(phase)}">${escapeHtml(phase)}</span>
    <span class="smap-ev-what">${escapeHtml(what)}</span>
    <span class="smap-ev-meta">${escapeHtml(meta)}</span>
  </li>`;
}

function serviceMapRenderFeed() {
  const rows = serviceMapSession.feed.slice(0, 12);
  for (const inst of serviceMapHosts) {
    if (inst.mode !== 'full' || !inst.el.feed) continue;
    inst.el.feed.innerHTML = rows.length
      ? rows.map(serviceMapFeedRow).join('')
      : '<li class="smap-ev-empty">No live request yet. Send one through the gateway.</li>';
    if (inst.el.feedCount) inst.el.feedCount.textContent = String(rows.length);
  }
}

/* ---------------- wiring ---------------- */

function serviceMapUpdate(data) {
  if (data && Array.isArray(data.providers)) serviceMapTopology(data.providers);
  serviceMapSync();
}

function renderDashboardMap(data) {
  serviceMapUpdate(data);
}

function renderServiceMapPage(data) {
  serviceMapUpdate(data);
}

function serviceMapInit() {
  document.querySelectorAll('[data-service-map]').forEach((host) => serviceMapBuild(host));
  serviceMapRenderFeed();

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      for (const inst of serviceMapHosts) {
        if (!serviceMapVisible(inst)) continue;
        serviceMapLayout(inst);
        serviceMapResize(inst);
      }
      serviceMapSync();
    });
    for (const inst of serviceMapHosts) observer.observe(inst.el.stage);
  }

  new MutationObserver(() => {
    serviceMapPalette = null;
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] });

  document.addEventListener('visibilitychange', serviceMapSync);
  window.addEventListener('pagehide', () => serviceMapClose(false));
  document.fonts?.ready?.then(() => serviceMapHosts.forEach(serviceMapSchedule));
  serviceMapSync();
}

serviceMapInit();
