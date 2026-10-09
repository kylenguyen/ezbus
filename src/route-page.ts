import { escapeHtml } from './stop-page.js';
import type { RouteDirectionPayload, RouteStopJoined, RouteStopTimes } from './types.js';

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

/** "first bus – last: weekdays 05:30 – 23:30 · Sat … · Sun …", or '' with no data. */
const timesLine = (direction: RouteDirectionPayload): string => {
  const spans: Array<[string, string | null]> = [
    ['weekdays', daySpan(direction.firstBus, direction.lastBus, 'wd')],
    ['Sat', daySpan(direction.firstBus, direction.lastBus, 'sat')],
    ['Sun', daySpan(direction.firstBus, direction.lastBus, 'sun')],
  ];
  const parts = spans
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([label, span]) => `${label} ${span}`);
  return parts.length === 0 ? '' : `first bus – last: ${parts.join(' · ')}`;
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
): string => {
  if (directions.length === 0) return ROUTE_STATIC_TARGET;
  const no = escapeHtml(service.serviceNo);
  const cards = directions
    .map((direction) => {
      const heading = service.loop
        ? `⟲ Loop at ${escapeHtml(service.loopDesc || direction.origin.description)}`
        : `To ${escapeHtml(direction.destination.description)}`;
      const meta = [`${direction.stops.length} stops`, timesLine(direction)]
        .filter(Boolean)
        .join(' · ');
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
  const operator = service.operator
    ? `<p class="honesty">Operated by ${escapeHtml(service.operator)}.</p>`
    : '';
  return (
    `<section id="rt-static" aria-label="About bus ${no}">` +
    `<h2 class="rt-sec">Bus ${no} — all stops</h2>` +
    cards +
    operator +
    `</section>`
  );
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
