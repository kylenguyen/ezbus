// Route page glue — /bus/:service, the "Approach Window". Elements, `fetch`,
// `localStorage`, `history` and event wiring only: every rule this file applies
// is decided in ./route-logic.js (pure, unit tested), the same split app.js
// keeps with origin.js. Keep new rules on that side of the line.
//
// One localStorage key of its own, plus two of the board's, read-only here
// except where noted:
//   bus-route.anchor.v1   remembered boarding stop per service (LRU ≤ 30) — the
//                         only key this page writes routinely
//   bus-board.origin.v1   which door the board is ranked from — read only
//   bus-board.loc.v1      the last GPS fix — read for the anchor ladder, and
//                         written on a successful fix from this page's location
//                         door, the same {lat, lon, at} shape app.js writes
//   bus-board.pins.v1     the board's pinned stops — read and written by the
//                         anchor panel's Pin button, the same rows app.js and
//                         stop.js write: pin here is pin on the board

import {
  formatMetres,
  isUsableCoord,
  originCoord,
  readOriginRecord,
} from './origin.js';
import {
  arrivalsParams,
  BUS_POSITION_LABEL,
  busMarkPlacement,
  departureSummary,
  directionFor,
  filterServiceEta,
  foldPlan,
  haversineM,
  installHintVisible,
  isPinnedCode,
  markTarget,
  parseServicePath,
  readAnchors,
  readPinList,
  rememberAnchor,
  resolveAnchor,
  searchStops,
  togglePinList,
  translateAnchor,
  UPSTREAM_WINDOW,
  windowFor,
} from './route-logic.js';
import { VEHICLE, vehicleIcon } from './vehicle-marks.js';

const ANCHOR_KEY = 'bus-route.anchor.v1';
const ORIGIN_KEY = 'bus-board.origin.v1';
const LOC_KEY = 'bus-board.loc.v1';
const PINS_KEY = 'bus-board.pins.v1';

const REFRESH_MS = 30_000; // arrivals refetch — one batch of ≤ 5 codes
const TICK_MS = 10_000; // local re-render so minutes count down between fetches

const el = {
  head: document.getElementById('rt-head'),
  notices: document.getElementById('rt-notices'),
  body: document.getElementById('rt-body'),
  status: document.getElementById('status'),
};

// --- state ----------------------------------------------------------------

/** The service in the URL, or null for a path the API would 400 anyway. */
const serviceNo = parseServicePath(location.pathname);

/**
 * Whether /bus/:service injected the real header (and with it the keyword
 * title and canonical). Read once at boot, before anything rewrites #rt-head.
 * When true the server's <title> is the one search engines index, and this
 * page must not overwrite it with a different string.
 */
const serverHead = el.head.hasAttribute('data-ssr');

/** The /api/route response body, once it lands. */
let route = null;
/** Index into route.directions — which direction the page is showing. */
let dirIndex = 0;
/** @type {'loading' | 'anchored' | 'picker' | 'guard' | 'missing' | 'failed'} */
let mode = 'loading';
/** Which hat the picker wears: bare, the guard's offer, or the Change morph. */
let hat = 'bare';
/** The committed anchor: its stop record, how it was chosen, its direction. */
let anchor = null;
/**
 * The direction toggle's auto-translated return stop — displayed, never
 * persisted. `anchor` keeps the stop the user actually chose, which is what
 * toggling back restores.
 */
let translated = null;
/** The guard's nearest-stop offer, held while the page asks instead of assuming. */
let guardSuggestion = null;
/** Stale-stop notices from the anchor ladder, cleared on the next real anchor. */
let notices = [];
/** One transient sentence for a direction toggle that found no return stop. */
let dirNotice = '';
/** Folds spliced open: startIndex → count. Cleared when the anchor or direction changes. */
let expanded = new Map();
/** The direction the Change morph must restore if the keep chip cancels it. */
let changeDirIndex = 0;

/** The last arrivals batch, code → response entry. */
let arrivalsByCode = new Map();
/** Whether any arrivals batch has landed for the current window. */
let arrivalsFresh = false;

/**
 * The picker's live line: the first stop of the direction on screen, its last
 * /api/arrivals entry (null on failure), and whether anything has landed for
 * that stop yet. Kept apart from the window's state above — the picker and the
 * anchored window never show at once, but they must not share a batch.
 */
let nextCode = null;
let nextEntry = null;
let nextFresh = false;

/**
 * What the picker list is showing, row for row. Written in the same synchronous
 * block as the list's markup — the same invariant app.js keeps for its result
 * rows — so a `data-pick` index read off the DOM always addresses the array
 * that produced that DOM.
 */
let pickRows = [];

/** The remembered anchors, service → stop code, LRU order. */
let anchors = readAnchors(readRaw(ANCHOR_KEY));

let locBusy = false;
let locDenied = false;

/**
 * The browser's deferred install prompt, and whether "Not now" was pressed in
 * this page view. Memory only — see installHintVisible for why nothing about
 * the choice is stored.
 */
let installPrompt = null;
let installDismissed = false;

// --- storage, guarded ------------------------------------------------------

/** Reading throws too with storage disabled outright, hence the try. */
function readRaw(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing with storage blocked: the page works, it just is not
    // remembered next time.
  }
}

function writeAnchors() {
  write(ANCHOR_KEY, Object.fromEntries(anchors));
}

/** The last fix, read exactly as app.js's readLoc reads it. */
function readFix() {
  try {
    const raw = JSON.parse(readRaw(LOC_KEY) ?? 'null');
    if (!raw || !Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) return null;
    return raw;
  } catch {
    return null;
  }
}

// --- helpers ----------------------------------------------------------------

// app.js's escape is unimportable (module-scope document), so this is its copy.
// EVERY interpolation of server data below goes through it.
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );

const LOAD_LABEL = { SEA: 'Seats', SDA: 'Standing', LSD: 'Crowded' };
const LOAD_TITLE = {
  SEA: 'Seats available',
  SDA: 'Standing room available',
  LSD: 'Limited standing — crowded',
};

/** Minutes until an ISO arrival, floored — the board's rule, same clock passed in. */
function minutesUntil(iso, now) {
  return Math.floor((new Date(iso).getTime() - now) / 60_000);
}

/** DataMall's HHMM ("0530") as a clock time ("05:30"); '' for anything else. */
function clockTime(hhmm) {
  return typeof hhmm === 'string' && /^\d{4}$/.test(hhmm)
    ? `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`
    : '';
}

function stamp(when) {
  el.status.textContent = `Updated ${new Date(when).toLocaleTimeString('en-SG', { hour12: false })}`;
}

/** The stop the window is drawn around: the translated return stop, or the anchor. */
function effectiveStop() {
  return translated ? translated.stop : anchor?.stop ?? null;
}

/** A stop's dense index in a direction's list. `seq` is 1-based and dense. */
function indexOfStop(stops, stop) {
  const bySeq = Number.isInteger(stop?.seq) ? stop.seq - 1 : -1;
  if (bySeq >= 0 && stops[bySeq]?.code === stop.code) return bySeq;
  return stops.findIndex((s) => s.code === stop?.code);
}

/**
 * Walking distance from the board's saved origin to a stop, or null with no
 * coordinate in hand. Display only — every ≤/> decision against the 2 km guard
 * is route-logic.js's, made inside resolveAnchor and translateAnchor.
 */
function userDistanceM(stop) {
  const coord = originCoord(readOriginRecord(readRaw(ORIGIN_KEY)), readFix());
  if (!coord || !isUsableCoord(coord.lat, coord.lon)) return null;
  if (!stop || !isUsableCoord(stop.lat, stop.lon)) return null;
  return Math.round(haversineM(coord.lat, coord.lon, stop.lat, stop.lon));
}

// --- boot -------------------------------------------------------------------

/**
 * The server-rendered static route (#rt-static in route.html, injected by
 * /bus/:service) — the facts, questions and every stop of every direction, for
 * crawlers and for JS-off readers. It stays once the live view takes over:
 * Google indexes the rendered DOM, and this section is what it has to index.
 * Only the per-direction stop lists are closed, because the live spine above
 * shows the same stops and both open would be the route twice. Left open on
 * fetch failure: renderFailed's guard sits above it, and a route list already
 * in hand is exactly what a reader on a dead connection still wants.
 */
function collapseStatic() {
  for (const list of document.querySelectorAll('#rt-static details.rt-dir[open]')) {
    list.removeAttribute('open');
  }
}

/**
 * Removed outright only for the "no such service" page: a route the API has
 * disowned (feed drift) under "There's no bus service X" would contradict it.
 */
function dropStatic() {
  document.getElementById('rt-static')?.remove();
}

async function loadRoute() {
  try {
    const res = await fetch(`/api/route/${encodeURIComponent(serviceNo)}`);
    if (res.status === 404 || res.status === 400) {
      renderMissing(serviceNo);
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (!Array.isArray(data.directions) || data.directions.length === 0) {
      renderMissing(serviceNo);
      return;
    }
    route = data;
    // A shell served unreplaced (route index cold when the HTML was built)
    // still carries the generic title; name the service now that it is known.
    if (!serverHead) document.title = `bus ${route.serviceNo} timing & route · ezbus`;
    applyLadder();
  } catch {
    renderFailed();
  }
}

/**
 * The anchor ladder, applied. resolveAnchor decides everything — this reads the
 * raw storage strings, hands them over, and assigns the outcome.
 */
function applyLadder() {
  collapseStatic();
  const resolved = resolveAnchor({
    serviceNo,
    queryStop: new URLSearchParams(location.search).get('stop'),
    anchorsRaw: readRaw(ANCHOR_KEY),
    originRaw: readRaw(ORIGIN_KEY),
    locRaw: readRaw(LOC_KEY),
    directions: route.directions,
  });

  notices = resolved.notices;
  if (resolved.dropRemembered) {
    // A remembered stop the route no longer serves would re-raise the same
    // notice on every visit; drop it now that the notice has been shown once.
    anchors = new Map(anchors);
    anchors.delete(serviceNo);
    writeAnchors();
  }

  if (resolved.state === 'anchored') {
    setAnchor(resolved.stop, resolved.source);
    return;
  }
  if (resolved.state === 'guard') {
    guardSuggestion = resolved.suggestion;
    mode = 'guard';
    hat = 'guard';
    renderAll();
    return;
  }
  mode = 'picker';
  hat = 'bare';
  renderAll();
}

// --- anchoring ----------------------------------------------------------------

/**
 * The one place an anchor is committed: URL via replaceState, localStorage via
 * rememberAnchor, window redrawn, arrivals asked for. The translated return
 * stop never comes through here — it is displayed, not committed.
 */
function setAnchor(stop, source) {
  const dir = directionFor(route.directions, stop.code);
  dirIndex = Math.max(0, route.directions.indexOf(dir));
  anchor = { stop, source, dirNumber: dir?.direction ?? null };
  translated = null;
  guardSuggestion = null;
  dirNotice = '';
  mode = 'anchored';
  hat = 'bare';
  expanded = new Map();
  arrivalsByCode = new Map();
  arrivalsFresh = false;

  const url = new URL(location.href);
  url.searchParams.set('stop', stop.code);
  history.replaceState(null, '', url);

  anchors = rememberAnchor(anchors, serviceNo, stop.code);
  writeAnchors();

  renderAll();
  void refreshArrivals();
}

/** A stop chosen by hand — picker row, search result — clears old notices too. */
function anchorPicked(stop) {
  notices = [];
  setAnchor(stop, 'picked');
}

// --- arrivals ---------------------------------------------------------------

/** The window around the effective anchor, or null when nothing is anchored. */
function currentWindow() {
  const stop = effectiveStop();
  if (!stop || !route) return null;
  const stops = route.directions[dirIndex]?.stops ?? [];
  const anchorIdx = indexOfStop(stops, stop);
  if (anchorIdx < 0) return null;
  return { stops, anchorIdx, win: windowFor(stops, anchorIdx) };
}

/**
 * One /api/arrivals batch — the anchor plus its ≤ 4 upstream stops, so a route
 * page costs one ≤ 5-code call per 30 s. The picker states spend one 1-code
 * call per 30 s instead, on the live line (refreshNext), and route here to it.
 */
async function refreshArrivals() {
  if ((mode === 'picker' || mode === 'guard') && hat !== 'change') {
    void refreshNext();
    return;
  }
  if (mode !== 'anchored' || document.visibilityState !== 'visible') return;
  const current = currentWindow();
  if (!current?.win) return;

  const params = arrivalsParams([...current.win.upstreamCodes, current.win.anchorCode]);
  if (!params) return;

  try {
    const res = await fetch(`/api/arrivals?${params}`);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    arrivalsByCode = new Map((data.arrivals ?? []).map((entry) => [entry.code, entry]));
    arrivalsFresh = true;
    stamp(data.fetchedAt);
    if (mode === 'anchored') renderBody();
  } catch {
    // Leave the last good timings on screen; the next tick tries again.
  }
}

/** The first stop of the direction on screen — the picker's live line's stop. */
function nextStopCode() {
  return route?.directions[dirIndex]?.stops[0]?.code ?? null;
}

/**
 * The picker's live line: one /api/arrivals call for one code, the route's
 * first stop. The only upstream cost the picker states have — the window's
 * ≤ 5-code batch is not spent until a stop is chosen — and a terminus is
 * shared by every visitor to the route, so the server's arrivals cache absorbs
 * most of it. A response for a stop the picker has since left (direction
 * toggled mid-flight) is dropped.
 */
async function refreshNext() {
  if (document.visibilityState !== 'visible') return;
  const code = nextStopCode();
  if (!code) return;
  if (code !== nextCode) {
    nextCode = code;
    nextEntry = null;
    nextFresh = false;
    renderNext();
  }
  const params = arrivalsParams([code]);
  if (!params) return;
  try {
    const res = await fetch(`/api/arrivals?${params}`);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (code !== nextCode) return;
    nextEntry = (data.arrivals ?? []).find((entry) => entry.code === code) ?? null;
    nextFresh = true;
    stamp(data.fetchedAt);
  } catch {
    if (code !== nextCode) return;
    // Keep a good answer through one bad refresh; with none, say so.
    if (!nextFresh) {
      nextEntry = null;
      nextFresh = true;
    }
  }
  renderNext();
}

// --- rendering ----------------------------------------------------------------

function renderAll() {
  renderHead();
  renderNotices();
  renderBody();
}

function renderHead() {
  if (!route) {
    el.head.innerHTML = '';
    return;
  }

  const dir = route.directions[dirIndex];
  const ends = route.loop
    ? `${escape(dir.origin.description)} — loop service`
    : `${escape(dir.origin.description)} → ${escape(dir.destination.description)}`;

  const first = clockTime(dir.firstBus?.wd);
  const last = clockTime(dir.lastBus?.wd);
  const meta = [`${dir.stops.length} stops`, first && last ? `runs ${first}–${last}` : '']
    .filter(Boolean)
    .join(' · ');

  const toggle = route.loop
    ? `<p class="loop-badge">⟲ Loop at ${escape(route.loopDesc ?? dir.destination.description)}</p>`
    : route.directions.length > 1
      ? `<div class="dir-toggle" role="group" aria-label="Direction of travel">${route.directions
          .map(
            (d, i) =>
              `<button type="button" data-act="dir" data-dir="${escape(d.direction)}"
                 class="${i === dirIndex ? 'on' : ''}" aria-pressed="${i === dirIndex}">
                 to ${escape(d.destination.description)}</button>`,
          )
          .join('')}</div>`
      : '';

  // The same markup buildRouteHead in src/route-page.ts renders on the server
  // — edit the two together. The h1 restates the aria-hidden stencil number in
  // a visually-hidden prefix, so the heading reads "Bus 74: A → B".
  el.head.innerHTML = `
    <div class="rt-head">
      <span class="rt-no" aria-hidden="true">${escape(route.serviceNo)}</span>
      <div class="rt-title">
        <h1 class="rt-ends"><span class="visually-hidden">Bus ${escape(route.serviceNo)}: </span>${ends}</h1>
        <span class="rt-meta">${escape(meta)}</span>
      </div>
    </div>
    ${toggle}`;
}

function renderNotices() {
  const chips = [];

  for (const notice of notices) {
    chips.push(`<div class="note-chip">${escape(notice.message)}</div>`);
  }
  if (dirNotice) chips.push(`<div class="note-chip">${escape(dirNotice)}</div>`);

  if (mode === 'anchored') {
    const change = '<button type="button" class="chip-act" data-act="change">Change ›</button>';
    if (translated) {
      chips.push(
        `<div class="note-chip">↩ Return stop · ${escape(formatMetres(translated.distanceM))}
           from ${escape(anchor.stop.description)} ${change}</div>`,
      );
    } else if (anchor.source === 'remembered') {
      chips.push(`<div class="note-chip">Your usual stop on this route ${change}</div>`);
    } else if (anchor.source === 'nearest') {
      chips.push(`<div class="note-chip">📍 Nearest stop on this route to you ${change}</div>`);
    }
  }

  if (mode === 'picker' && hat === 'change') {
    const name = effectiveStop()?.description ?? '';
    chips.push(
      `<button type="button" class="keep-chip" data-act="keep">← Keep ${escape(name)}</button>`,
    );
  }

  el.notices.innerHTML = chips.join('');
}

function renderBody() {
  if (mode === 'anchored') renderWindow();
  else if (mode === 'picker' || mode === 'guard') renderPicker();
  // 'missing' and 'failed' write el.body themselves; 'loading' keeps the
  // skeleton spine the HTML shipped with.
}

// --- the approach window --------------------------------------------------------

/**
 * One upstream stop's inline ETA: pulsing until the batch lands, then minutes.
 *
 * An expired timing reads "due", not "arr" — deliberately diverging from the
 * board and the anchor panel, which keep "Arr". Those answer the boarding
 * question ("go to the platform now") with nothing beside them to argue with.
 * A spine row sits next to the position mark, which can honestly place the bus
 * *upstream* of a stop whose prediction has run out; "arr" there claims an
 * arrival the mark contradicts, while "due" claims only that the timing has
 * passed — true whether the bus is at the stop or still a bend away.
 */
function etaInline(lead, now) {
  if (!arrivalsFresh) {
    return '<span class="eta-inline"><span class="sk sk-eta-in skeleton"></span></span>';
  }
  if (!lead || !lead.estimatedArrival) return '';
  const mins = minutesUntil(lead.estimatedArrival, now);
  if (mins <= 0) {
    return '<span class="eta-inline" title="Timing has passed — bus may still be approaching">due</span>';
  }
  return `<span class="eta-inline">${mins}<span class="eta-unit">min</span></span>`;
}

/** One arrival cell in the anchor panel — renderEta's markup, minus the vehicle tags. */
function etaCell(bus, index, now) {
  const lead = index === 0;
  const classes = ['eta'];
  if (lead) classes.push('eta-lead');

  if (!bus || !bus.estimatedArrival) {
    return `<div class="${classes.join(' ')} eta-empty">
      <span class="eta-value">–</span>${lead ? '<span class="eta-load"></span>' : ''}
    </div>`;
  }

  const mins = minutesUntil(bus.estimatedArrival, now);
  if (mins <= 1) classes.push('arriving');
  if (!bus.monitored) classes.push('scheduled');

  const value =
    mins <= 0
      ? '<span class="eta-value">Arr</span>'
      : `<span class="eta-value">${mins}${lead ? '<span class="eta-unit">min</span>' : ''}</span>`;

  const label = lead && bus.load && LOAD_LABEL[bus.load] ? LOAD_LABEL[bus.load] : '';
  const load = label
    ? `<span class="eta-load load-${escape(bus.load.toLowerCase())}" title="${escape(
        LOAD_TITLE[bus.load],
      )}">${escape(label)}</span>`
    : lead
      ? '<span class="eta-load"></span>'
      : '';

  const title = bus.monitored ? '' : ' title="Scheduled timing — bus not currently tracked"';
  return `<div class="${classes.join(' ')}"${title}>${value}${load}</div>`;
}

/** The anchor panel's live rows: this service's next three buses, or why not. */
function panelServices(code, now) {
  if (!arrivalsFresh) {
    return `<div class="skeleton" aria-hidden="true">
      <div class="sk-row"><span class="sk sk-no"></span><span class="sk sk-eta"></span></div>
    </div>`;
  }
  const buses = filterServiceEta(arrivalsByCode.get(code), serviceNo);
  if (buses === null) return '<p class="card-msg">Timings unavailable — will retry.</p>';
  if (buses.length === 0) return '<p class="card-msg">No buses at this hour.</p>';

  return `<div class="services-head" aria-hidden="true">
      <span>Bus</span><span>Next</span><span>Then</span><span>After</span>
    </div>
    <ul class="services"><li class="service">
      <div class="service-id"><span class="service-no">${escape(serviceNo)}</span></div>
      ${etaCell(buses[0], 0, now)}${etaCell(buses[1], 1, now)}${etaCell(buses[2], 2, now)}
    </li></ul>`;
}

/**
 * The anchor's lead bus, drawn from the board's own artwork — same module, same
 * markup, so a rider reads one silhouette for one vehicle on both pages and the
 * two cannot drift apart. Two things about it are decided here rather than
 * inherited, and both are below.
 *
 * A `type` we were never sent falls back to the single-deck body under a plain
 * "Bus" label. That is a deliberate divergence from the board, where a blank
 * `type` draws nothing at all: there the mark is a footnote to a service number
 * and can simply be absent, but here the mark *is* the position, and one that
 * vanished would say the bus had gone rather than that its deck count is
 * unknown. So it draws the plainest body available and, by relabelling, claims
 * no deck count — "Bus", not "Single deck bus".
 *
 * `Object.hasOwn` rather than a plain lookup because `VEHICLE` is an object
 * literal: an upstream `type` of `constructor` would otherwise resolve through
 * the prototype to a function and take the fallback away.
 *
 * The trails are the second deliberate divergence, and it is the same argument
 * as the first: `incoming` is hard `true` here, never `isIncoming`. On the board
 * a mark sits under a service number as a fleet fact, so the drift has to earn
 * itself by the bus being three minutes out — otherwise nine cards drift at once
 * and say nothing. Here there is exactly one mark and it *is* a bus on the road:
 * the drift says "this vehicle is running", which is true at 3 minutes and at 30
 * alike, and the only alternative reading of a still silhouette on a route line
 * is a bus that has stopped. The board's rule is untouched — this is the one
 * caller that opts out of it.
 */
function busMarkIcon(lead) {
  const type = typeof lead?.type === 'string' ? lead.type : '';
  const art = Object.hasOwn(VEHICLE, type)
    ? VEHICLE[type]
    : { ...VEHICLE.SD, title: 'Bus', label: 'Bus' };
  return vehicleIcon(art, true);
}

function renderWindow() {
  const current = currentWindow();
  if (!current?.win) return;
  const { stops, anchorIdx, win } = current;

  // The fold plan: the window's keeps plus whatever the user spliced open.
  const keep = new Set(win.keepIndices);
  for (const [start, count] of expanded) {
    for (let i = start; i < start + count; i += 1) keep.add(i);
  }
  const plan = foldPlan(stops, [...keep]);
  const from = anchorIdx - win.upstreamCodes.length;

  // One clock read for the whole spine, like the board's cards.
  const now = Date.now();
  const leads = [...win.upstreamCodes, win.anchorCode].map((code) => {
    const buses = filterServiceEta(arrivalsByCode.get(code), serviceNo);
    return Array.isArray(buses) ? (buses[0] ?? null) : null;
  });
  // What the timings support, then which row can carry it. Both rules live in
  // route-logic.js; stale arrivals are the ladder's top rung and belong here,
  // because nothing on screen is a timing yet.
  const placement = arrivalsFresh ? busMarkPlacement(leads, now) : null;
  const target = markTarget(placement, plan, from, anchorIdx);

  // Built once, emitted on exactly one row. `approx` marks the placements that
  // name a row the bus is at *or before* rather than a stop it is at or
  // departing — the title is the only thing on the page that can say so, since
  // the drawing is the board's and stays identical by construction. "On its
  // way", not "approaching this stop": the same title serves the anchor-row
  // approx and the expanded-fold beyond fallback, and neither may claim the
  // bus reached the row it sits on.
  const mark = target
    ? `<span class="bus-mark${target.approx ? ' bus-mark-approx' : ''}"${
        target.approx ? ' title="On its way — exact position unknown"' : ''
      }>${busMarkIcon(leads[leads.length - 1])}</span>`
    : '';
  // Rows ask by their own plan identity rather than by counting, so a row that
  // is not the target cannot accidentally match one that is.
  const markOn = (kind, key) => {
    if (!target || target.row.kind !== kind) return '';
    const at = kind === 'stop' ? target.row.index : target.row.startIndex;
    return at === key ? mark : '';
  };

  const rowFor = (row) => {
    if (row.kind === 'fold') {
      // The mark sits inside the `li` and outside the `button`: a fold row is a
      // range, which is exactly what a bus upstream of the window is, but the
      // whole row is the "show" target and a mark inside it would make the
      // silhouette part of the label.
      //
      // `fold-marked` is what lets the button stop being the full row width. It
      // is a class rather than a `:has()` in the stylesheet because the renderer
      // already knows the answer, and this is the only row on the page whose tap
      // target changes shape.
      const marked = markOn('fold', row.startIndex);
      return `<li class="fold${marked ? ' fold-marked' : ''}"><button type="button" class="fold-btn"
        data-fold="${row.startIndex}" data-count="${row.count}">
        <b>${row.count} stops</b> — show</button>${marked}</li>`;
    }
    const index = row.index;
    const stop = stops[index];
    const classes = ['row'];
    if (index === 0 || index === stops.length - 1) classes.push('term');
    const inWin = index >= from && index < anchorIdx;
    // Only a segment placement licenses dimming: it is the one rung that claims
    // the bus is past these stops. `beyond` and `approx` say the opposite or
    // say nothing, and greying a stop on either would be an invented fact.
    // Strictly *behind* the mark, not at it — the marked row is the stop the
    // bus is at or departing, and dimming it would grey the mark's own row.
    // The ETA still goes with the mark, not the dimming: the marked stop's
    // lead is already the *next* vehicle, and printing that beside the bus
    // would read as the bus it sits next to.
    const behindOrAt = placement?.kind === 'segment' && inWin && index - from <= placement.seg;
    const passed = behindOrAt && index - from < placement.seg;
    if (passed) classes.push('passed');
    if (index === anchorIdx) classes.push('here');

    let right = '';
    if (inWin && !behindOrAt) right = etaInline(leads[index - from], now);
    else if (!inWin && index !== anchorIdx && index !== 0 && index !== stops.length - 1) {
      right = `<span class="stop-code">${escape(stop.code)}</span>`;
    }
    const name =
      index === anchorIdx
        ? `<a class="here-link" href="/stop/${escape(stop.code)}"><strong>${escape(
            stop.description,
          )}</strong></a>`
        : escape(stop.description);
    // Name, then the mark, then the row's own right-hand answer. The mark left
    // the `.row-end` group on purpose: out at the right edge it read as one more
    // column of the ETA's, and a rider scanning the rail for *where the bus is*
    // had to cross the whole row to find it. Butted against the name it is read
    // with the stop it belongs to, in one saccade, and the marked row is findable
    // down the left of the list rather than by scanning the ragged right. The
    // separator in the stylesheet is what keeps it from looking like punctuation
    // on the name. The `.row-end` group is still omitted when empty rather than
    // left as a bare span, which would spend the row's gap on nothing.
    return `<li class="${classes.join(' ')}"><span class="row-name">${name}</span>${markOn(
      'stop',
      index,
    )}${right ? `<span class="row-end">${right}</span>` : ''}</li>`;
  };

  // The spine splits at the anchor so the here-panel sits between the halves.
  const above = [];
  const below = [];
  let past = false;
  for (const row of plan) {
    // "Departs terminus": the window reaches the route's start, so the missing
    // upstream rows are replaced by the honest line about why they are missing.
    if (row.kind === 'stop' && row.index === anchorIdx && anchorIdx === 0) {
      above.push('<li class="depart">Departs terminus</li>');
    }
    (past ? below : above).push(rowFor(row));
    if (row.kind === 'stop' && row.index === 0 && anchorIdx > 0 && anchorIdx < UPSTREAM_WINDOW) {
      above.push('<li class="depart">Departs terminus</li>');
    }
    if (row.kind === 'stop' && row.index === anchorIdx) past = true;
  }

  const stop = effectiveStop();
  const distance = userDistanceM(stop);
  const hpName = `${translated ? 'Nearest return stop' : 'You board here'}${
    distance === null ? '' : ` · ${escape(formatMetres(distance))}`
  }`;
  const hpSub = [escape(stop.code), stop.roadName ? escape(stop.roadName) : '']
    .filter(Boolean)
    .join(' · ');

  el.body.innerHTML = `
    <p class="rt-sec">Approaching your stop</p>
    <ul class="spine">${above.join('')}</ul>
    <div class="here-panel">
      <div class="hp-head">
        <div class="hp-title">
          <span class="hp-name">${hpName}</span>
          <span class="hp-sub">${hpSub}</span>
        </div>
        <button type="button" class="hp-change" data-act="change">Change</button>
      </div>
      ${panelServices(stop.code, now)}
      ${panelActions(stop)}
    </div>
    <ul class="spine">${below.join('')}</ul>
    <p class="honesty">${escape(BUS_POSITION_LABEL)}</p>
    ${installHint()}`;
}

/** The one-line home-screen offer, or '' — installHintVisible decides. */
function installHint() {
  const show = installHintVisible({
    hasPrompt: installPrompt !== null,
    dismissed: installDismissed,
    mode,
    anchorSource: anchor?.source,
  });
  if (!show) return '';
  return `<div class="install-hint">
      <span>Check this route often? Put ezbus on your home screen.</span>
      <span class="ih-acts">
        <button type="button" class="hp-act" data-act="install">Add</button>
        <button type="button" class="hp-act ih-dismiss" data-act="install-dismiss">Not now</button>
      </span>
    </div>`;
}

/**
 * Under the live rows, the two ways on from here — the moment the page has
 * just proved itself is the moment to say what else it does. Pin puts this
 * stop on the board (the same key and rows the board and the stop page
 * write), so opening ezbus.sg next time starts here; once pinned, the row
 * offers the board itself. "All buses here" is the stop page: every service at
 * this kerb, not just this one. Pinned state is read fresh from storage on
 * every draw, so a pin made in another tab is not clobbered by a stale copy.
 */
function panelActions(stop) {
  const pinned = isPinnedCode(readPinList(readRaw(PINS_KEY)), stop.code);
  const pin = `<button type="button" class="hp-act${pinned ? ' on' : ''}" data-act="pin" aria-pressed="${pinned}">${
    pinned ? '★ On your board' : '☆ Pin to your board'
  }</button>`;
  const board = pinned ? '<a class="hp-act" href="/">Open board</a>' : '';
  return `<div class="hp-acts">${pin}${board}<a class="hp-act" href="/stop/${escape(stop.code)}">All buses here ›</a></div>`;
}

function togglePin() {
  const stop = effectiveStop();
  if (!stop) return;
  write(PINS_KEY, togglePinList(readPinList(readRaw(PINS_KEY)), stop));
  renderBody();
}

// --- the picker -------------------------------------------------------------------

/** Whether this page may offer the location door at all — originsState's rule. */
const geolocationSupported = window.isSecureContext && !!navigator.geolocation;

function renderPicker() {
  // The search box survives a re-render (direction toggle, guard dismissal):
  // its value is carried across because the input node itself is rebuilt.
  const held = el.body.querySelector('#rt-search')?.value ?? '';

  const heading = hat === 'change' ? 'Choose a new stop' : 'Where will you board?';
  const guard =
    hat === 'guard' && guardSuggestion
      ? `<div class="guard">This route doesn't pass near you — closest stop is
           ${escape(formatMetres(guardSuggestion.distanceM))}.
           <div class="g-actions">
             <button type="button" data-act="use-anyway">Use it anyway</button>
             <button type="button" data-act="dismiss-guard">Pick a stop below</button>
           </div></div>`
      : '';

  const locDoor = geolocationSupported
    ? `<button type="button" class="loc-door${locBusy ? ' busy' : ''}" data-act="loc"
         ${locBusy ? 'disabled' : ''}>📍 ${locBusy ? 'Locating…' : 'Use my location'}</button>
       <p id="door-note" class="door-note" ${locDenied ? '' : 'hidden'}>
         Location unavailable here — search above or tap your stop below instead.</p>`
    : '';

  el.body.innerHTML = `
    ${guard}
    ${hat === 'change' ? '' : nextLine(Date.now())}
    <p class="rt-sec">${heading}</p>
    <div class="rt-search">
      <label class="visually-hidden" for="rt-search">Search stops on this route</label>
      <input id="rt-search" type="search" inputmode="search" enterkeyhint="search"
             autocomplete="off" spellcheck="false"
             placeholder="Search stops on this route" />
    </div>
    ${locDoor}
    <ul id="rt-list" class="spine"></ul>
    <ul id="rt-results" class="rt-results" hidden></ul>
    <p id="picker-note" class="honesty"></p>`;

  const input = el.body.querySelector('#rt-search');
  if (input && held) input.value = held;
  renderPickerList();
  // First render of the picker, or a direction toggle onto another first
  // stop: ask now rather than on the next 30 s tick.
  if (hat !== 'change' && nextStopCode() !== nextCode) void refreshNext();
}

/**
 * The live line above the picker: "Next from <first stop>" and up to three
 * times. Pulses until the first answer lands, then the honest state — the
 * same "Timings unavailable" / "No buses at this hour" pair the anchor panel
 * uses. `aria-live` so a screen reader hears the answer arrive.
 */
function nextLine(now) {
  const origin = route?.directions[dirIndex]?.origin?.description ?? '';
  let times;
  if (!nextFresh || nextCode !== nextStopCode()) {
    times = '<span class="sk sk-eta skeleton" aria-hidden="true"></span>';
  } else {
    const summary = departureSummary(nextEntry, serviceNo, now);
    times =
      summary.state === 'failed'
        ? '<span class="rt-next-msg">Timings unavailable — will retry</span>'
        : summary.state === 'none'
          ? '<span class="rt-next-msg">No buses at this hour</span>'
          : summary.minutes
              .map((mins, index) =>
                mins <= 0
                  ? `<span class="rt-next-eta${index === 0 ? ' lead' : ''}">Arr</span>`
                  : `<span class="rt-next-eta${index === 0 ? ' lead' : ''}">${mins}<span class="eta-unit">min</span></span>`,
              )
              .join('');
  }
  return `<div class="rt-next" id="rt-next" aria-live="polite">
      <span class="rt-next-label">Next bus ${escape(serviceNo)} from ${escape(origin)}</span>
      <span class="rt-next-times">${times}</span>
    </div>`;
}

/** The live line redrawn in place, so the search box keeps its focus. */
function renderNext() {
  const node = el.body.querySelector('#rt-next');
  if (node) node.outerHTML = nextLine(Date.now());
}

/**
 * The picker's list — full spine, or search results replacing it. `pickRows`
 * and the markup are written in this one synchronous block; rows commit by
 * `data-pick` index into that array and nothing else.
 */
function renderPickerList() {
  const list = el.body.querySelector('#rt-list');
  const results = el.body.querySelector('#rt-results');
  const note = el.body.querySelector('#picker-note');
  if (!list || !results || !note) return;

  const stops = route.directions[dirIndex]?.stops ?? [];
  const query = el.body.querySelector('#rt-search')?.value ?? '';
  const hits = searchStops(stops, query);

  const current = hat === 'change' ? effectiveStop() : null;
  const currentIdx = current ? indexOfStop(stops, current) : -1;

  if (hits === null) {
    // No query worth searching: the full route, every row tappable.
    pickRows = stops;
    list.hidden = false;
    results.hidden = true;
    results.innerHTML = '';
    list.innerHTML = stops
      .map((stop, index) => {
        if (index === currentIdx) {
          return `<li class="here pick" data-pick="${index}"><a class="pick-link" href="${pickHref(stop)}" rel="nofollow">
            <span class="cur-tag">current</span><strong>${escape(stop.description)}</strong></a></li>`;
        }
        const term = index === 0 || index === stops.length - 1 ? ' term' : '';
        return `<li class="pick${term}" data-pick="${index}"><a class="pick-link" href="${pickHref(stop)}" rel="nofollow">
          <span class="chev">›</span>${escape(stop.description)}</a></li>`;
      })
      .join('');
    note.textContent = 'Tap your stop to watch the bus approach it.';
    return;
  }

  list.innerHTML = '';
  list.hidden = true;

  if (hits.length === 0) {
    pickRows = [];
    results.hidden = true;
    results.innerHTML = '';
    const other = !route.loop && route.directions.length > 1
      ? ' — it may be on the other direction'
      : '';
    note.textContent = `No stop matching '${query.trim()}' on route ${serviceNo}${other}.`;
    return;
  }

  // Results replace the spine — they are the pick list, same tap behaviour.
  pickRows = hits.map((hit) => hit.stop);
  results.hidden = false;
  results.innerHTML = hits
    .map(({ stop, matches }, index) => {
      const range = (field) => matches.find((m) => m.field === field) ?? null;
      const sub = [
        highlight(stop.roadName, range('roadName')),
        highlight(stop.code, range('code')),
      ]
        .filter(Boolean)
        .join(' · ');
      return `<li class="pick" data-pick="${index}"><a class="pick-link" href="${pickHref(stop)}" rel="nofollow">
        <span class="r-name">${highlight(stop.description, range('description'))}</span>
        <span class="r-sub">${sub}</span>
      </a></li>`;
    })
    .join('');
  note.textContent = 'Matches stop name, code, or road. Tap to anchor.';
}

/**
 * The URL a picker row stands for: this route, anchored at that stop — exactly
 * what a tap commits, so a long-press "open in new tab" or a copied link lands
 * where the tap would. A real link rather than a bare <li>, so the rows are
 * reachable from a keyboard and announced as actionable. `rel="nofollow"` on
 * each: the stops are already linked for crawlers in #rt-static, and these
 * ?stop= variants all canonicalise to /bus/:service anyway.
 */
function pickHref(stop) {
  return `/bus/${encodeURIComponent(serviceNo)}?stop=${encodeURIComponent(stop.code)}`;
}

/**
 * A field with its matched range tinted. The range comes from searchStops, so
 * the match is never re-derived here against different casing rules; every
 * segment is escaped on its way in.
 */
function highlight(value, range) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return '';
  if (!range) return escape(text);
  return (
    escape(text.slice(0, range.start)) +
    `<mark>${escape(text.slice(range.start, range.end))}</mark>` +
    escape(text.slice(range.end))
  );
}

// --- terminal states ---------------------------------------------------------------

/** The "no such service" page — a real page, never a dead JSON error. */
function renderMissing(svc) {
  mode = 'missing';
  // A service the shell was injected for but the API disowned (feed drift):
  // "There's no bus service X" above X's full route would contradict itself.
  dropStatic();
  document.title = 'no such service · ezbus';
  el.head.innerHTML = '';
  el.notices.innerHTML = '';
  const name = svc ? `There's no bus service ${escape(svc)}.` : "That's not a bus service number.";
  el.body.innerHTML = `
    <p class="rt-sec">No such service</p>
    <div class="guard">${name} Check the number on the stop's pole or on the board.
      <div class="g-actions"><a href="/">← Back to board</a></div>
    </div>`;
}

function renderFailed() {
  mode = 'failed';
  // A server-rendered header is still true on a dead connection — the same
  // reason dropStatic leaves the static route in place here.
  if (!serverHead) el.head.innerHTML = '';
  el.notices.innerHTML = '';
  el.body.innerHTML = `
    <div class="guard">Could not load this route. Check your connection.
      <div class="g-actions"><button type="button" data-act="retry">Try again</button></div>
    </div>`;
}

// --- location door -----------------------------------------------------------------

/**
 * Asks for a position. Copied verbatim from app.js.
 *
 * **Deliberately not `async`, and do not make it so.** A `Promise` executor runs
 * synchronously, so `getCurrentPosition` below is reached in the same task as the
 * click that led here — which is the only reason iOS Safari shows the prompt at
 * all. Safari spends the click's transient activation on the first `await`, and a
 * `getCurrentPosition` called after that point silently never prompts. An `await`
 * inserted anywhere above this call — here or in a caller — therefore breaks
 * first-run location on iPhone while working perfectly in desktop Chrome, and no
 * test in this repository can catch it.
 */
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position.coords),
      reject,
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 5 * 60_000 },
    );
  });
}

/**
 * The location door. Synchronous down to `getPosition()` — the transient-
 * activation rule above governs this whole click path, so the busy state is a
 * targeted DOM write rather than a re-render, and nothing here awaits.
 */
function locateForAnchor() {
  if (locBusy) return;
  locBusy = true;
  locDenied = false;
  updateLocDoor();

  getPosition().then(
    (coords) => {
      locBusy = false;
      // The same {lat, lon, at} record app.js writes: a fresh fix is worth the
      // board's 12 h cached first paint too.
      write(LOC_KEY, { lat: coords.latitude, lon: coords.longitude, at: Date.now() });
      applyFix(coords.latitude, coords.longitude);
    },
    () => {
      // Denied, timed out, failed — all one honest line; the other two doors
      // still work and the button stays for retry.
      locBusy = false;
      locDenied = true;
      updateLocDoor();
    },
  );
}

/**
 * A fresh fix through the same ladder rung the load path uses: resolveAnchor
 * with a synthetic gps origin, so the ≤ 2 km anchor / > 2 km guard decision
 * stays in route-logic.js rather than growing a second copy here.
 */
function applyFix(lat, lon) {
  const resolved = resolveAnchor({
    serviceNo,
    queryStop: null,
    anchorsRaw: null,
    originRaw: '{"mode":"gps"}',
    locRaw: JSON.stringify({ lat, lon }),
    directions: route.directions,
  });
  if (resolved.state === 'anchored') {
    notices = [];
    setAnchor(resolved.stop, 'nearest');
    return;
  }
  if (resolved.state === 'guard') {
    guardSuggestion = resolved.suggestion;
    mode = 'guard';
    hat = 'guard';
    renderAll();
    return;
  }
  updateLocDoor();
}

/** The door's three states applied in place, so the search box keeps its focus. */
function updateLocDoor() {
  const door = el.body.querySelector('[data-act="loc"]');
  const note = el.body.querySelector('#door-note');
  if (!door) return;
  door.classList.toggle('busy', locBusy);
  door.disabled = locBusy;
  door.textContent = locBusy ? '📍 Locating…' : '📍 Use my location';
  if (note) note.hidden = !locDenied;
}

// --- the Change morph and the direction toggle ----------------------------------------

function enterChange() {
  changeDirIndex = dirIndex;
  mode = 'picker';
  hat = 'change';
  renderAll();
  // Pre-scrolled so the current row is in sight without hunting for it.
  el.body.querySelector('.cur-tag')?.closest('li')?.scrollIntoView({ block: 'center' });
}

/** The keep chip: back to the window exactly as it was, anchor untouched. */
function leaveChange() {
  mode = 'anchored';
  hat = 'bare';
  dirIndex = changeDirIndex;
  renderAll();
  void refreshArrivals();
}

function onDirTap(target) {
  if (!route || route.loop) return;
  const idx = route.directions.findIndex((d) => d.direction === target);
  if (idx < 0) return;
  const targetDir = route.directions[idx];
  dirNotice = '';

  if (mode === 'anchored') {
    if (idx === dirIndex) return;

    if (translated) {
      // Toggling back: the translated stop was never persisted, so restoring
      // the original is dropping the overlay.
      translated = null;
      dirIndex = route.directions.findIndex((d) => d.direction === anchor.dirNumber);
      if (dirIndex < 0) dirIndex = 0;
    } else {
      const t = translateAnchor(route.directions, anchor.stop, target);
      if (t) {
        translated = { stop: t.stop, distanceM: t.distanceM };
        dirIndex = idx;
      } else {
        // No return stop within reach: no fake anchor — the picker for that
        // direction, with the sentence saying why. The anchor and the URL keep
        // the original stop, so toggling back restores everything.
        dirNotice = `${serviceNo} doesn't stop near ${anchor.stop.description} on the way to ${targetDir.destination.description}.`;
        mode = 'picker';
        hat = 'bare';
        dirIndex = idx;
        renderAll();
        return;
      }
    }
    expanded = new Map();
    arrivalsByCode = new Map();
    arrivalsFresh = false;
    renderAll();
    void refreshArrivals();
    return;
  }

  if (mode === 'picker' || mode === 'guard') {
    // A picker reached by a failed translate: toggling back to the anchor's
    // own direction is the restore.
    if (hat !== 'change' && anchor && target === anchor.dirNumber) {
      translated = null;
      mode = 'anchored';
      hat = 'bare';
      dirIndex = idx;
      expanded = new Map();
      renderAll();
      void refreshArrivals();
      return;
    }
    dirIndex = idx;
    renderAll();
  }
}

// --- wiring -------------------------------------------------------------------------

function onAction(event) {
  const act = event.target.closest('[data-act]');
  if (act) {
    switch (act.dataset.act) {
      case 'dir':
        onDirTap(Number(act.dataset.dir));
        return;
      case 'change':
        enterChange();
        return;
      case 'keep':
        leaveChange();
        return;
      case 'use-anyway':
        if (guardSuggestion) {
          notices = [];
          setAnchor(guardSuggestion.stop, 'nearest');
        }
        return;
      case 'dismiss-guard':
        hat = 'bare';
        mode = 'picker';
        renderAll();
        return;
      // No `await` may sit between this click and getPosition — see the note
      // on getPosition; this handler is synchronous the whole way down.
      case 'loc':
        locateForAnchor();
        return;
      case 'retry':
        mode = 'loading';
        void loadRoute();
        return;
      case 'pin':
        if (mode === 'anchored') togglePin();
        return;
      // prompt() needs the click's user activation, so it is called here,
      // synchronously, before anything else.
      case 'install':
        if (installPrompt) {
          const prompt = installPrompt;
          installPrompt = null;
          void prompt.prompt();
          renderBody();
        }
        return;
      case 'install-dismiss':
        installDismissed = true;
        renderBody();
        return;
    }
  }

  const fold = event.target.closest('[data-fold]');
  if (fold) {
    expanded = new Map(expanded);
    expanded.set(Number(fold.dataset.fold), Number(fold.dataset.count));
    renderBody();
    return;
  }

  const pick = event.target.closest('[data-pick]');
  if (pick) {
    // A modified click (new tab, new window) is the browser's to handle — the
    // row's href already says where it goes. A plain one anchors in place,
    // which is the same destination without a page load.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const stop = pickRows[Number(pick.dataset.pick)];
    if (stop) anchorPicked(stop);
  }
}

el.head.addEventListener('click', onAction);
el.notices.addEventListener('click', onAction);
el.body.addEventListener('click', onAction);

// The route's stops are already in hand, so search is a client-side filter —
// no debounce, no request, just the list redrawn per keystroke.
el.body.addEventListener('input', (event) => {
  if (event.target?.id === 'rt-search' && (mode === 'picker' || mode === 'guard')) {
    renderPickerList();
  }
});

// Chromium's install offer, held for the anchor panel rather than shown as the
// browser's own banner over a page a stranger has only just opened.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  if (mode === 'anchored') renderBody();
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  if (mode === 'anchored') renderBody();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshArrivals();
});

setInterval(() => void refreshArrivals(), REFRESH_MS);
setInterval(() => {
  if (mode === 'anchored' && arrivalsFresh) renderBody();
  else if ((mode === 'picker' || mode === 'guard') && nextFresh) renderNext();
}, TICK_MS);

// --- boot ------------------------------------------------------------------------------

if (!serviceNo) {
  renderMissing(null);
} else {
  void loadRoute();
}
