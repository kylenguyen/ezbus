import { operatorShortName } from './route-page.js';
import { escapeHtml } from './stop-page.js';

/**
 * The /buses services directory — every service in the fleet as one crawlable
 * list, rendered server-side at request time. It is the one new URL in the SEO
 * plan: the homepage→index edge of the crawl graph (every route page is two
 * clicks from `/` through it), and a working directory for the commuter who
 * types a bus number nowhere near a stop. Live arrivals are deliberately
 * absent, the same rule stop-page.ts and route-page.ts state.
 *
 * Everything here is a pure function — hand-written records in, HTML string
 * out — so the tests can feed fixtures without the server, the same bargain
 * `buildRoutes` strikes in routes.ts. Row order is the caller's: `routes.all()`
 * already sorts by `compareServiceNos`, and re-sorting here would be a second
 * owner of the ordering.
 *
 * BUSES_LIST_TARGET is the body-region swap anchor, verbatim from
 * public/buses.html — the same exact-string whole-region pattern as the other
 * shells: the file served unreplaced (cold route index, or /buses.html via
 * express.static) is already valid, sensibly generic HTML.
 * buses-page.test.ts pins the pairing.
 */

// --- the swap target, verbatim from public/buses.html --------------------------

/** The generic invite to the board — the sentence for a shell served
 *  unreplaced. A loaded route index swaps it for the full directory. */
export const BUSES_LIST_TARGET =
  '<section id="buses-list"><p class="card-msg">Looking for Singapore bus timing? <a href="/">Open the ezbus board</a> to see every bus arriving near you, live.</p></section>';

// --- the directory ---------------------------------------------------------------

/** One service, endpoints already joined to descriptions — the caller resolves
 *  them through `servicePayloads` so this stays pure and fixture-friendly. */
export interface BusesRow {
  serviceNo: string;
  operator: string;
  loop: boolean;
  /** Empty string for a normal two-direction service, as RouteService spells it. */
  loopDesc: string;
  /** Lead-direction endpoint descriptions; empty when the feed gave no stops. */
  origin: string;
  destination: string;
}

/**
 * Which jump-bar range a service belongs to, by its leading digits: `1–99`,
 * then one range per hundred, then `Others` for the few with no numeric
 * prefix (`NR7`), which `compareServiceNos` already sorts last. The id is
 * the in-page anchor the bar links to.
 */
export const busRange = (serviceNo: string): { id: string; label: string } => {
  const digits = /^\d+/.exec(serviceNo);
  if (!digits) return { id: 'from-other', label: 'Others' };
  const n = Number(digits[0]);
  if (n < 100) return { id: 'from-1', label: '1–99' };
  const start = Math.floor(n / 100) * 100;
  return { id: `from-${start}`, label: `${start}–${start + 99}` };
};

/**
 * The whole fleet as one card of 44px link rows: service number in the stencil
 * face (the same argument as `.service-no` on the board — this number is
 * matched against the blind on the front of the bus), endpoints or the loop
 * turn, operator trailing right. One page, no pagination: ~370 rows is a few
 * tens of KB. Empty input (cold route index) collapses to the shell's own
 * generic section rather than an empty list.
 */
export const buildBusesIndex = (rows: BusesRow[]): string => {
  if (rows.length === 0) return BUSES_LIST_TARGET;
  // ~370 rows is a long scroll on a phone for someone who knows their number;
  // the jump bar gets them within a screen of it in one tap. Ranges, not
  // operators: a rider knows the number on the blind, rarely who runs it.
  const ranges: Array<{ id: string; label: string }> = [];
  const items = rows
    .map((row) => {
      const no = escapeHtml(row.serviceNo);
      const summary = row.loop
        ? `⟲ Loop at ${escapeHtml(row.loopDesc || row.origin)}`
        : row.origin || row.destination
          ? `${escapeHtml(row.origin)} → ${escapeHtml(row.destination)}`
          : '';
      const name = summary ? `<span class="nb-name">${summary}</span>` : '';
      const operator = row.operator
        ? `<span class="nb-sub">${escapeHtml(operatorShortName(row.operator))}</span>`
        : '';
      const range = busRange(row.serviceNo);
      // First row of each range carries the anchor. Checked against every
      // range seen, not just the last, so an id can never repeat even if a
      // caller hands rows over out of directory order.
      const opens = !ranges.some((seen) => seen.id === range.id);
      if (opens) ranges.push(range);
      return `<li${opens ? ` id="${range.id}"` : ''}><a href="/bus/${no}"><span class="service-no">${no}</span>${name}${operator}</a></li>`;
    })
    .join('');
  const jump =
    ranges.length < 2
      ? ''
      : `<nav class="bus-jump" aria-label="Jump to bus numbers">` +
        ranges.map((range) => `<a href="#${range.id}">${range.label}</a>`).join('') +
        `</nav>`;
  return (
    `<section id="buses-list" aria-label="All bus services in Singapore">` +
    `<div class="card rt-dir">` +
    `<div class="card-head"><div class="card-title">` +
    `<h2 class="rt-dir-head">All bus services in Singapore</h2>` +
    `<p class="rt-dir-meta">${rows.length} services · tap one for its route and live timings</p>` +
    `</div></div>` +
    jump +
    `<ul class="rt-stops bus-index">${items}</ul>` +
    `</div>` +
    `</section>`
  );
};
