import { escapeHtml } from './stop-page.js';
import type { RouteDirectionPayload, RouteStopJoined, RouteStopTimes, ServiceFreq } from './types.js';

/**
 * The route page's server-rendered static body — everything stable about a
 * service (both directions' full stop lists, first/last bus, operator, loop,
 * structured data) rendered to HTML at request time so a crawler's fetch of
 * /bus/:service is a complete page, not a stencil. These lists are the bulk of
 * the internal link graph: ~370 route pages each linking 20–80 stop pages.
 * Live arrivals are deliberately absent, the same rule stop-page.ts states.
 *
 * Everything here is a pure function — hand-written records in, HTML string
 * out — so the tests can feed fixtures without the server, the same bargain
 * `buildRoutes` strikes in routes.ts.
 *
 * ROUTE_STATIC_TARGET is the body-region swap anchor, verbatim from
 * public/route.html — the same exact-string whole-region pattern as the head
 * tags: the shell served unreplaced (unknown service, or /route.html via
 * express.static) is already valid, sensibly generic HTML. Edit the target in
 * the shell and the constant here in the same commit; route-page.test.ts pins
 * the pairing. The section stays in the page once the live view renders —
 * Google indexes the rendered DOM, and removing it there threw away every stop
 * link, time and fact below for every crawl. route.js closes the per-direction
 * stop lists instead (the interactive spine shows the same stops), so with JS
 * on the reader sees them collapsed under the live view, and with JS off this
 * section is the page.
 */

// --- the swap targets, verbatim from public/route.html ------------------------

/** The header's skeleton plus a generic hidden h1 — the wait state, kept for a
 *  shell served unreplaced. Known services swap it for buildRouteHead. */
export const ROUTE_HEAD_TARGET =
  '<div id="rt-head"><h1 class="visually-hidden">Singapore bus timing &amp; routes</h1><div class="rt-head skeleton" aria-hidden="true"><span class="sk sk-rtno"></span><div class="rt-title"><span class="sk sk-name"></span><span class="sk sk-sub"></span></div></div></div>';

/** The generic invite to the board — the no-JS sentence for a shell served
 *  unreplaced. Known services swap it for the full route plus JSON-LD. */
export const ROUTE_STATIC_TARGET =
  '<section id="rt-static"><p class="card-msg">Looking for a Singapore bus route? <a href="/">Open the ezbus board</a> to see every bus arriving near you, live.</p></section>';

// --- display formatting --------------------------------------------------------

/** The service facts the static body needs — `RouteService` satisfies it
 *  structurally, and the tests can hand-write it without a directions Map. */
export interface RouteStaticInfo {
  serviceNo: string;
  operator: string;
  loop: boolean;
  /** Empty string for a normal two-direction service, as RouteService spells it. */
  loopDesc: string;
  /** DataMall `Category`; empty when BusServices has no record. */
  category: string;
  /** AM headways, raw (`"06-08"`); null where the feed has none. */
  freq: ServiceFreq;
}

/** DataMall HHMM: hours 00-23, minutes 00-59 — the same rule stop-page.ts
 *  applies, so '' and '-' render as the en dash, never as a time. */
const HHMM_RE = /^([01]\d|2[0-3])([0-5]\d)$/;

const fmtHHMM = (hhmm: string): string | null => {
  const match = HHMM_RE.exec(hhmm.trim());
  return match ? `${match[1]}:${match[2]}` : null;
};

/** One day-type's span, "05:30 – 23:30", or null when the feed has neither end. */
const daySpan = (
  first: RouteStopTimes | null,
  last: RouteStopTimes | null,
  day: 'wd' | 'sat' | 'sun',
): string | null => {
  const from = first ? fmtHHMM(first[day]) : null;
  const to = last ? fmtHHMM(last[day]) : null;
  if (!from && !to) return null;
  return `${from ?? '–'} – ${to ?? '–'}`;
};

/**
 * DataMall operator codes as riders know them — "SBS Transit bus 74" is how
 * the service is searched for, never "SBST". An unknown code passes through
 * unchanged rather than being guessed at.
 */
const OPERATOR_NAMES: Record<string, string> = {
  SBST: 'SBS Transit',
  SMRT: 'SMRT Buses',
  TTS: 'Tower Transit Singapore',
  GAS: 'Go-Ahead Singapore',
};

export const operatorName = (code: string): string =>
  Object.hasOwn(OPERATOR_NAMES, code) ? (OPERATOR_NAMES[code] ?? code) : code;

/**
 * The same operators in as few characters as still read as the name — for a
 * row where the operator trails a route summary on a 320 px phone (/buses):
 * "Tower Transit Singapore" there squeezed the route ends down to "Test…".
 */
const OPERATOR_SHORT_NAMES: Record<string, string> = {
  SBST: 'SBS Transit',
  SMRT: 'SMRT',
  TTS: 'Tower Transit',
  GAS: 'Go-Ahead',
};

export const operatorShortName = (code: string): string =>
  Object.hasOwn(OPERATOR_SHORT_NAMES, code) ? (OPERATOR_SHORT_NAMES[code] ?? code) : code;

/**
 * DataMall `Category` as a phrase: the guide lists EXPRESS, FEEDER,
 * INDUSTRIAL, TOWNLINK, TRUNK and a family of flat-fee categories. The named
 * five read as "Trunk service" and so on; anything else (a flat-fee label, a
 * category added after Aug 2026) is shown as the feed spells it, sentence-cased,
 * rather than dropped. Empty in, empty out.
 */
export const categoryLabel = (category: string): string => {
  const raw = category.trim();
  if (!raw) return '';
  if (/^(EXPRESS|FEEDER|INDUSTRIAL|TOWNLINK|TRUNK)$/i.test(raw)) {
    return `${raw.charAt(0).toUpperCase()}${raw.slice(1).toLowerCase()} service`;
  }
  return `${raw.charAt(0).toUpperCase()}${raw.slice(1).toLowerCase()}`;
};

/**
 * A DataMall headway for display: `'06-08'` → `'6–8 min'`, `'08-08'` →
 * `'8 min'`, a bare `'10'` → `'10 min'`, anything else null. The same rule as
 * fmtFreq in public/stop-logic.js, which the stop page uses — one rule for one
 * field on both pages; edit them together.
 */
export const fmtFreq = (freq: string | null): string | null => {
  const raw = (freq ?? '').trim();
  const range = /^(\d{1,3})-(\d{1,3})$/.exec(raw);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    return lo === hi ? `${lo} min` : `${lo}–${hi} min`;
  }
  return /^\d{1,3}$/.test(raw) ? `${Number(raw)} min` : null;
};

/** "23.4 km", one decimal — or null for an unknown or zero length. */
const fmtKm = (km: number | null): string | null =>
  km !== null && Number.isFinite(km) && km > 0 ? `${km.toFixed(1)} km` : null;

/**
 * The headway sentence, or null when the feed gave neither figure. The two
 * windows are the guide's own (§2.2): AM peak 06:30–08:30, AM off-peak
 * 08:31–16:59. Stated, because "every 8 min" with no window would overclaim
 * for the evening and the night.
 */
export const freqLine = (freq: ServiceFreq): string | null => {
  const peak = fmtFreq(freq.peak);
  const offpeak = fmtFreq(freq.offpeak);
  const parts = [
    peak ? `every ${peak} in the morning peak (06:30–08:30)` : '',
    offpeak ? `every ${offpeak} off-peak (08:31–16:59)` : '',
  ].filter(Boolean);
  return parts.length === 0 ? null : parts.join(', ');
};

// --- the header ----------------------------------------------------------------

/**
 * The route header, server-rendered — the markup route.js's renderHead builds
 * for the lead direction, so the first paint is the answer and the client's
 * rewrite on /api/route lands on the same pixels. **The two must stay in
 * step**: edit this and renderHead in public/route.js together.
 *
 * The h1 is the ends line, restating the stencilled number in a
 * visually-hidden prefix — the stop plate's idiom — so the page's heading
 * reads "Bus 74: A → B" to a screen reader and to a crawler, while the plate
 * keeps the number-leads layout. The number itself is aria-hidden so it is
 * not announced twice.
 *
 * `data-ssr` on the wrapper tells route.js the head (and therefore the title)
 * came from the server. The direction toggle is emitted too, inert until
 * route.js wires it: leaving it out would make the header jump a row the
 * moment the script lands. Empty input collapses to the shell's skeleton.
 */
export const buildRouteHead = (
  service: RouteStaticInfo,
  directions: RouteDirectionPayload[],
): string => {
  const lead = directions[0];
  if (!lead) return ROUTE_HEAD_TARGET;
  const no = escapeHtml(service.serviceNo);
  const ends = service.loop
    ? `${escapeHtml(lead.origin.description)} — loop service`
    : `${escapeHtml(lead.origin.description)} → ${escapeHtml(lead.destination.description)}`;
  const first = lead.firstBus ? fmtHHMM(lead.firstBus.wd) : null;
  const last = lead.lastBus ? fmtHHMM(lead.lastBus.wd) : null;
  const meta = [`${lead.stops.length} stops`, first && last ? `runs ${first}–${last}` : '']
    .filter(Boolean)
    .join(' · ');
  const toggle = service.loop
    ? `<p class="loop-badge">⟲ Loop at ${escapeHtml(service.loopDesc || lead.destination.description)}</p>`
    : directions.length > 1
      ? `<div class="dir-toggle" role="group" aria-label="Direction of travel">` +
        directions
          .map(
            (direction, index) =>
              `<button type="button" data-act="dir" data-dir="${direction.direction}"` +
              ` class="${index === 0 ? 'on' : ''}" aria-pressed="${index === 0}">` +
              `to ${escapeHtml(direction.destination.description)}</button>`,
          )
          .join('') +
        `</div>`
      : '';
  return (
    `<div id="rt-head" data-ssr="1">` +
    `<div class="rt-head"><span class="rt-no" aria-hidden="true">${no}</span>` +
    `<div class="rt-title">` +
    `<h1 class="rt-ends"><span class="visually-hidden">Bus ${no}: </span>${ends}</h1>` +
    `<span class="rt-meta">${escapeHtml(meta)}</span>` +
    `</div></div>` +
    toggle +
    `</div>`
  );
};

// --- the static body -------------------------------------------------------------

// --- interchanges and stations -------------------------------------------------------

/** One place a route passes that riders navigate by, linked to the first stop
 *  that names it. */
export interface KeyStop {
  /** The place, normalised: "Bishan Stn", never "Opp Bishan Stn Exit A". */
  name: string;
  code: string;
  /** The stop's own description, for the row's secondary line. */
  description: string;
  kind: 'interchange' | 'station';
}

const KEY_STOP_PREFIX = /^(?:opp|aft|bef|nr)\s+/i;
const KEY_STOP_EXIT = /\s+exit\s+[a-z0-9]+$/i;
const INTERCHANGE_RE = /\b(?:int|interchange)$/i;
const STATION_RE = /\bstn$/i;
/** "Stn" that is not a train station. Stop names abbreviate these the same way. */
const NOT_A_TRAIN_STATION_RE =
  /\b(?:fire|police|petrol|power|pumping|sub|ambulance|radio|esso|shell|caltex|spc|sinopec)\s+stn$/i;
const KEY_STOP_MAX = 10;

/**
 * The bus interchanges and MRT/LRT stations a route passes, read off LTA's stop
 * descriptions — "Toa Payoh Int", "Opp Bishan Stn", "Bishan Stn Exit A" — which
 * is the only source we have: nothing in DataMall's bus feeds says "this stop
 * serves a station". A heuristic, then, and a conservative one: the place word
 * must END the name once a leading Opp/Aft/Bef/Nr and a trailing "Exit X" are
 * stripped, so "Int Sch" (an international school) and "Stn Rd" never qualify,
 * and "Stn" after fire/police/petrol and friends is excluded. It can miss a
 * station whose stops are named after a mall instead; it should not invent one.
 *
 * Deduplicated by the normalised name (the kerb pair and every exit of one
 * station are one place), first sighting wins — direction 1 in route order,
 * then anything only direction 2 passes. Capped, because a list of 25 places is
 * a second route listing rather than a summary.
 */
export const keyStops = (directions: RouteDirectionPayload[]): KeyStop[] => {
  const seen = new Map<string, KeyStop>();
  for (const direction of directions) {
    for (const stop of direction.stops) {
      if (seen.size >= KEY_STOP_MAX) break;
      const name = stop.description.trim().replace(KEY_STOP_PREFIX, '').replace(KEY_STOP_EXIT, '').trim();
      const kind = INTERCHANGE_RE.test(name)
        ? 'interchange'
        : STATION_RE.test(name) && !NOT_A_TRAIN_STATION_RE.test(name)
          ? 'station'
          : null;
      if (!kind) continue;
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, { name, code: stop.code, description: stop.description, kind });
    }
  }
  return [...seen.values()];
};

/** The linked list of key stops, or '' when the heuristic found none. */
export const buildKeyStops = (serviceNo: string, stops: KeyStop[]): string => {
  if (stops.length === 0) return '';
  const rows = stops
    .map((stop) => {
      const sub = stop.description !== stop.name ? stop.description : stop.kind === 'interchange' ? 'Bus interchange' : 'Station';
      return (
        `<li><a href="/stop/${escapeHtml(stop.code)}">` +
        `<span class="nb-name">${escapeHtml(stop.name)}</span>` +
        `<span class="nb-sub">${escapeHtml(sub)}</span></a></li>`
      );
    })
    .join('');
  return (
    `<h2 class="rt-sec">Interchanges &amp; stations on bus ${escapeHtml(serviceNo)}</h2>` +
    `<div class="card"><ul class="rt-stops">${rows}</ul></div>`
  );
};

// --- other buses along the route ----------------------------------------------------

/** Another service that shares stops with this one. */
export interface RelatedService {
  serviceNo: string;
  /** Distinct stop codes the two have in common, across both directions. */
  shared: number;
}

const RELATED_MIN_SHARED = 2;
const RELATED_MAX = 6;

/**
 * The services that run alongside this one, ranked by how many distinct stops
 * they share — the "is there another bus I could take" answer, and the
 * route-to-route edges of the crawl graph. `servicesAt` is the stop page's own
 * reverse index (`routes.servicesAt`), passed in so this stays pure.
 *
 * A single shared stop is an interchange or a busy junction, not a parallel
 * route, so two is the floor. Ties go to bus-directory order via `compare`, so
 * the list is stable across requests.
 */
export const rankRelated = (
  serviceNo: string,
  directions: RouteDirectionPayload[],
  servicesAt: (code: string) => string[],
  compare: (a: string, b: string) => number,
): RelatedService[] => {
  const self = serviceNo.toUpperCase();
  const codes = new Set(directions.flatMap((direction) => direction.stops.map((stop) => stop.code)));
  const counts = new Map<string, { serviceNo: string; shared: number }>();
  for (const code of codes) {
    // A service listed twice at one stop (both directions) counts once there.
    const here = new Set(servicesAt(code));
    for (const other of here) {
      const key = other.toUpperCase();
      if (key === self) continue;
      const entry = counts.get(key) ?? { serviceNo: other, shared: 0 };
      entry.shared += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()]
    .filter((entry) => entry.shared >= RELATED_MIN_SHARED)
    .sort((a, b) => b.shared - a.shared || compare(a.serviceNo, b.serviceNo))
    .slice(0, RELATED_MAX);
};

/** One related row, its endpoints already resolved by the caller. */
export interface RelatedRow extends RelatedService {
  /** "A → B" or "⟲ Loop at X" — plain text, escaped here. Empty if unknown. */
  summary: string;
}

/** The related-services rows in the /buses row idiom, or '' when there are none. */
export const buildRelated = (rows: RelatedRow[]): string => {
  if (rows.length === 0) return '';
  const items = rows
    .map((row) => {
      const no = escapeHtml(row.serviceNo);
      const name = row.summary ? `<span class="nb-name">${escapeHtml(row.summary)}</span>` : '';
      return (
        `<li><a href="/bus/${no}"><span class="service-no">${no}</span>${name}` +
        `<span class="nb-sub">${row.shared} shared</span></a></li>`
      );
    })
    .join('');
  return (
    `<h2 class="rt-sec">Other buses along this route</h2>` +
    `<div class="card"><ul class="rt-stops bus-index">${items}</ul></div>`
  );
};

// --- the facts ---------------------------------------------------------------------

const DAY_ROWS: Array<['wd' | 'sat' | 'sun', string]> = [
  ['wd', 'Weekdays'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
];

/**
 * "Bus 74 at a glance" — the questions a search for a bus number is usually
 * asking, answered in one card: how often, how long, who runs it, and first and
 * last bus. Every line is omitted when the feed has no data for it; nothing is
 * estimated. The schedule is a real <table> transposed for a phone — a row per
 * day type, a column per direction — because three day columns of
 * "05:30 – 23:30" do not fit 375 px beside a stop name, and two directions do.
 * The times are the seq-1 record's, i.e. departures from the first stop, and
 * the table says so.
 */
export const buildRouteFacts = (
  service: RouteStaticInfo,
  directions: RouteDirectionPayload[],
): string => {
  const lead = directions[0];
  if (!lead) return '';
  const no = escapeHtml(service.serviceNo);

  const rows: Array<[string, string]> = [];
  const freq = freqLine(service.freq);
  if (freq) rows.push(['How often', `${freq.charAt(0).toUpperCase()}${freq.slice(1)}`]);

  const length = fmtKm(lead.lengthKm);
  const ends = service.loop
    ? `loop from ${escapeHtml(lead.origin.description)}`
    : `${escapeHtml(lead.origin.description)} ⇄ ${escapeHtml(lead.destination.description)}`;
  rows.push([
    'Route',
    [`${lead.stops.length} stops`, length ? `${length}${service.loop ? '' : ' one way'}` : '', ends]
      .filter(Boolean)
      .join(' · '),
  ]);

  const operator = [
    service.operator ? escapeHtml(operatorName(service.operator)) : '',
    escapeHtml(categoryLabel(service.category)),
  ]
    .filter(Boolean)
    .join(' · ');
  if (operator) rows.push(['Operator', operator]);

  const list = rows
    .map(([term, detail]) => `<div><dt>${term}</dt><dd>${detail}</dd></div>`)
    .join('');

  const withTimes = directions.filter((direction) => direction.firstBus || direction.lastBus);
  const table =
    withTimes.length === 0
      ? ''
      : `<table class="sp-week rt-times">` +
        `<caption class="visually-hidden">First and last bus ${no} from the first stop, by day</caption>` +
        `<thead><tr><th scope="col">First – last</th>` +
        withTimes
          .map(
            (direction) =>
              `<th scope="col" class="rt-times-dir">From ${escapeHtml(direction.origin.description)}</th>`,
          )
          .join('') +
        `</tr></thead><tbody>` +
        DAY_ROWS.map(
          ([day, label]) =>
            `<tr><th scope="row">${label}</th>` +
            withTimes
              .map((direction) => `<td>${daySpan(direction.firstBus, direction.lastBus, day) ?? '–'}</td>`)
              .join('') +
            `</tr>`,
        ).join('') +
        `</tbody></table>`;

  return (
    `<h2 class="rt-sec">Bus ${no} at a glance</h2>` +
    `<div class="card rt-facts">` +
    `<dl class="rt-facts-list">${list}</dl>` +
    table +
    `</div>`
  );
};

/**
 * The per-service meta description: the route, then the two numbers a search
 * snippet can answer outright — headway and first/last bus — then the operator
 * by the name riders search for. Each clause is dropped when its data is
 * missing. Plain text; the caller escapes it into the attribute.
 */
export const buildRouteDescription = (
  service: RouteStaticInfo,
  directions: RouteDirectionPayload[],
): string => {
  const lead = directions[0];
  if (!lead) return '';
  const route = service.loop
    ? `Bus ${service.serviceNo} timing & route: loop service from ${lead.origin.description}` +
      `${service.loopDesc ? ` via ${service.loopDesc}` : ''}, every stop with live arrival times.`
    : `Bus ${service.serviceNo} timing & route: every stop from ${lead.origin.description} to ` +
      `${lead.destination.description} with live arrival times.`;
  const peak = fmtFreq(service.freq.peak);
  const first = lead.firstBus ? fmtHHMM(lead.firstBus.wd) : null;
  const last = lead.lastBus ? fmtHHMM(lead.lastBus.wd) : null;
  const times = [first ? `first bus ${first}` : '', last ? `last bus ${last}` : '']
    .filter(Boolean)
    .join(', ');
  const clauses = [peak ? `every ${peak} at peak` : '', times ? `${times} on weekdays` : ''].filter(
    Boolean,
  );
  const sentence = clauses.join(', ');
  const scheduleLine = sentence ? ` ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.` : '';
  const operator = service.operator ? ` Operated by ${operatorName(service.operator)}.` : '';
  return `${route}${scheduleLine}${operator}`;
};

/**
 * The full route as crawlable HTML: one card per direction — heading, first/last
 * bus, and a real `<ol>` of every stop in seq order, each linked to its stop
 * page — plus the operator line. Duplicated codes stay duplicated: a loop
 * legitimately calls at its origin twice, and collapsing the pair would
 * straighten the loop into a line (the duplicates are the two ends of the list,
 * never adjacent, so the repeated link reads fine). A join-miss stop arrives
 * with its code as description and no road, and renders exactly that — the same
 * degradation /api/route/:service documents. Empty input (cold route index)
 * collapses to the shell's own generic section.
 *
 * Each direction is a `<details open>`: with JS off the lists are the page and
 * read open; route.js closes them once the live view renders, because the
 * interactive spine above already shows the same stops and both open would be
 * the route twice. Closed is not removed — the links stay in the rendered DOM
 * a crawler indexes, which is the whole point of server-rendering them.
 */
export const buildRouteStatic = (
  service: RouteStaticInfo,
  directions: RouteDirectionPayload[],
  related: RelatedRow[] = [],
  faq: FaqItem[] = [],
): string => {
  if (directions.length === 0) return ROUTE_STATIC_TARGET;
  const no = escapeHtml(service.serviceNo);
  const cards = directions
    .map((direction) => {
      const heading = service.loop
        ? `⟲ Loop at ${escapeHtml(service.loopDesc || direction.origin.description)}`
        : `To ${escapeHtml(direction.destination.description)}`;
      // First/last bus lives in the facts table now; the plate keeps the count
      // and the length, which differ per direction.
      const length = fmtKm(direction.lengthKm);
      const meta = [`${direction.stops.length} stops`, length].filter(Boolean).join(' · ');
      const rows = direction.stops
        .map((stop) => {
          const road = stop.roadName ? `<span class="nb-sub">${escapeHtml(stop.roadName)}</span>` : '';
          return (
            `<li><a href="/stop/${escapeHtml(stop.code)}">` +
            `<span class="nb-name">${escapeHtml(stop.description)}</span>${road}</a></li>`
          );
        })
        .join('');
      return (
        `<details class="card rt-dir" open>` +
        // <summary> takes phrasing content plus headings only — no wrapper
        // div — so the h3 and the meta line are its direct children and the
        // stylesheet stacks them.
        `<summary class="card-head">` +
        `<h3 class="rt-dir-head">${heading}</h3>` +
        `<span class="rt-dir-meta">${meta}</span>` +
        `</summary>` +
        `<ol class="rt-stops">${rows}</ol>` +
        `</details>`
      );
    })
    .join('');
  return (
    `<section id="rt-static" aria-label="About bus ${no}">` +
    buildRouteFacts(service, directions) +
    buildKeyStops(service.serviceNo, keyStops(directions)) +
    `<h2 class="rt-sec">Bus ${no} — all stops</h2>` +
    cards +
    buildRelated(related) +
    buildRouteFaq(service.serviceNo, faq) +
    `</section>`
  );
};

// --- questions ---------------------------------------------------------------------

/** One question and its answer, plain text — escaped where rendered. */
export interface FaqItem {
  question: string;
  answer: string;
}

const DAY_PHRASES: Array<['wd' | 'sat' | 'sun', string]> = [
  ['wd', 'weekdays'],
  ['sat', 'Saturdays'],
  ['sun', 'Sundays'],
];

/** "A", "A and B", "A, B and C". */
const listPhrase = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** When a group of day types runs: "every day", "on weekends", "on weekdays and Saturdays". */
const daysPhrase = (days: Array<'wd' | 'sat' | 'sun'>): string => {
  if (days.length === DAY_PHRASES.length) return 'every day';
  if (days.join() === 'sat,sun') return 'on weekends';
  return `on ${listPhrase(DAY_PHRASES.filter(([day]) => days.includes(day)).map(([, phrase]) => phrase))}`;
};

/**
 * One direction's first and last bus as prose: day types with the same times
 * are said once ("first bus 05:30, last bus 23:30, every day"), and an end the
 * feed leaves blank is said to be missing rather than rendered as a dash.
 * '' when the feed has no time at all.
 */
const scheduleSentence = (first: RouteStopTimes | null, last: RouteStopTimes | null): string => {
  const groups = new Map<string, Array<'wd' | 'sat' | 'sun'>>();
  let anyLast = false;
  for (const [day] of DAY_PHRASES) {
    const from = first ? fmtHHMM(first[day]) : null;
    const to = last ? fmtHHMM(last[day]) : null;
    if (to) anyLast = true;
    const times = [from ? `first bus ${from}` : '', to ? `last bus ${to}` : ''].filter(Boolean).join(', ');
    if (times) groups.set(times, [...(groups.get(times) ?? []), day]);
  }
  if (groups.size === 0) return '';
  const parts = [...groups].map(([times, days]) =>
    groups.size === 1 ? `${times}, ${daysPhrase(days)}` : `${times} ${daysPhrase(days)}`,
  );
  return `${parts.join('; ')}${anyLast ? '' : ' (no last bus time is published)'}`;
};

/**
 * The route's questions, answered from the same data as the facts card — the
 * phrasings people type ("first bus 74", "how often does 74 come", "where does
 * 74 go"). A question whose answer would be empty or a guess is left out, not
 * answered vaguely. The last one is the honest pitch: what this page does that
 * a timetable cannot.
 *
 * Plain strings, so the visible <details> and the FAQPage JSON-LD are built
 * from the very same values — Google requires the two to match, and with one
 * source they cannot drift.
 */
export const routeFaq = (
  service: RouteStaticInfo,
  directions: RouteDirectionPayload[],
  places: KeyStop[],
): FaqItem[] => {
  const lead = directions[0];
  if (!lead) return [];
  const no = service.serviceNo;
  const items: FaqItem[] = [];

  const schedules = new Map<string, string[]>();
  for (const direction of directions) {
    const schedule = scheduleSentence(direction.firstBus, direction.lastBus);
    if (schedule) schedules.set(schedule, [...(schedules.get(schedule) ?? []), direction.origin.description]);
  }
  if (schedules.size > 0) {
    const lines = [...schedules].map(([schedule, origins]) => `From ${listPhrase(origins)}: ${schedule}.`);
    items.push({
      question: `What time is the first and last bus ${no}?`,
      answer:
        `${lines.join(' ')} These are scheduled departures from the first stop, ` +
        `so the bus reaches stops further along the route later.`,
    });
  }

  const freq = freqLine(service.freq);
  if (freq) {
    items.push({
      question: `How often does bus ${no} come?`,
      answer:
        `Bus ${no} runs ${freq}, according to LTA's published schedule. ` +
        `Live arrival times for your stop are at the top of this page.`,
    });
  }

  const length = fmtKm(lead.lengthKm);
  const route = service.loop
    ? `Bus ${no} is a loop service from ${lead.origin.description}` +
      `${service.loopDesc ? `, turning at ${service.loopDesc}` : ''}, calling at ${lead.stops.length} stops` +
      `${length ? ` over about ${length}` : ''}.`
    : `Bus ${no} runs between ${lead.origin.description} and ${lead.destination.description}, ` +
      `calling at ${lead.stops.length} stops${length ? ` over about ${length} one way` : ''}.`;
  const passes = places.length > 0 ? ` It passes ${listPhrase(places.map((place) => place.name))}.` : '';
  items.push({ question: `Where does bus ${no} go?`, answer: `${route}${passes}` });

  if (service.operator) {
    const category = categoryLabel(service.category);
    items.push({
      question: `Which company operates bus ${no}?`,
      answer: `Bus ${no} is run by ${operatorName(service.operator)}${category ? ` as a ${category.toLowerCase()}` : ''}.`,
    });
  }

  items.push({
    question: `How do I check when bus ${no} is coming?`,
    answer:
      `Pick your stop on this page, or tap "Use my location", and ezbus shows live arrival times ` +
      `for bus ${no} at that stop, how full the next bus is and roughly where it is on the route. ` +
      `It's free, with no app to install and no sign-up — and if you pin the stop, it is waiting ` +
      `on your ezbus board next time.`,
  });

  return items;
};

/** The questions as disclosure rows — the homepage FAQ's markup and styles. */
export const buildRouteFaq = (serviceNo: string, items: FaqItem[]): string => {
  if (items.length === 0) return '';
  const rows = items
    .map(
      (item) =>
        `<details class="faq-item"><summary>${escapeHtml(item.question)}</summary>` +
        `<p>${escapeHtml(item.answer)}</p></details>`,
    )
    .join('');
  return `<h2 class="rt-sec">Bus ${escapeHtml(serviceNo)} questions</h2><div class="rt-faq">${rows}</div>`;
};

/** FAQPage JSON-LD from the same items — serialised, never concatenated, and
 *  `<` escaped exactly as buildRouteJsonLd does. '' for no items. */
export const buildRouteFaqJsonLd = (items: FaqItem[]): string => {
  if (items.length === 0) return '';
  const page = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
  return `<script type="application/ld+json">${JSON.stringify(page).replace(/</g, '\\u003c')}</script>`;
};

// --- structured data ---------------------------------------------------------------

/**
 * JSON-LD: the Home → Buses → this service BreadcrumbList and an ItemList of
 * the first direction's stops (name + url per element) — no invented schema
 * types. Built as objects and serialised with JSON.stringify — never
 * string-concatenated — then every `<` escaped to the JSON escape
 * (backslash-u003c), the same anti-`</script` treatment as buildStopJsonLd.
 */
export const buildRouteJsonLd = (
  serviceNo: string,
  stops: Array<Pick<RouteStopJoined, 'code' | 'description'>>,
): string => {
  const url = `https://ezbus.sg/bus/${serviceNo}`;
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'ezbus', item: 'https://ezbus.sg/' },
      { '@type': 'ListItem', position: 2, name: 'Buses', item: 'https://ezbus.sg/buses' },
      { '@type': 'ListItem', position: 3, name: `Bus ${serviceNo}`, item: url },
    ],
  };
  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `Stops on bus ${serviceNo}`,
    numberOfItems: stops.length,
    itemListElement: stops.map((stop, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: stop.description,
      url: `https://ezbus.sg/stop/${stop.code}`,
    })),
  };
  const json = JSON.stringify([breadcrumb, itemList]).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
};
