import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ROUTE_HEAD_TARGET,
  ROUTE_STATIC_TARGET,
  buildRouteHead,
  buildRouteJsonLd,
  buildRouteStatic,
} from './route-page.js';
import type { RouteDirectionPayload, RouteStopJoined } from './types.js';

/**
 * The static route-page body, pinned by hand-written fixtures — the same
 * bargain as stop-page.test.ts. Everything here fails as a healthy 200 (a
 * mis-ordered list, a collapsed loop duplicate, a JSON-LD block that will not
 * parse), so `curl` cannot verify any of it.
 */

const joined = (
  code: string,
  seq: number,
  description: string,
  roadName: string,
): RouteStopJoined => ({ seq, code, description, roadName, lat: 1.35, lon: 103.82 });

/** A join miss, exactly as joinRouteStop degrades it: code as description. */
const missed = (code: string, seq: number): RouteStopJoined => ({
  seq,
  code,
  description: code,
  roadName: '',
  lat: 0,
  lon: 0,
});

const direction = (
  dir: 1 | 2,
  stops: RouteStopJoined[],
  times: Partial<Pick<RouteDirectionPayload, 'firstBus' | 'lastBus'>> = {},
): RouteDirectionPayload => {
  const first = stops[0];
  const last = stops[stops.length - 1];
  assert.ok(first && last, 'fixture direction needs stops');
  return {
    direction: dir,
    origin: { code: first.code, description: first.description, roadName: first.roadName, lat: first.lat, lon: first.lon },
    destination: { code: last.code, description: last.description, roadName: last.roadName, lat: last.lat, lon: last.lon },
    // `in`, not `??`: a fixture passing an explicit null means "the feed has
    // no schedule" and must not be papered over with the default.
    firstBus: 'firstBus' in times ? (times.firstBus ?? null) : { wd: '0530', sat: '0535', sun: '0540' },
    lastBus: 'lastBus' in times ? (times.lastBus ?? null) : { wd: '2330', sat: '2335', sun: '2340' },
    stops,
  };
};

const TRUNK = { serviceNo: '74', operator: 'SBST', loop: false, loopDesc: '' };
const LOOP = { serviceNo: '52', operator: 'SBST', loop: true, loopDesc: 'Opp Blk 101' };

const TRUNK_DIRECTIONS = [
  direction(1, [
    joined('10011', 1, 'Demo Stn Exit A', 'Demo Ave 2'),
    joined('10019', 2, 'Demo Stn Exit B', 'Demo Ave 2'),
  ]),
  direction(2, [
    joined('10019', 1, 'Demo Stn Exit B', 'Demo Ave 2'),
    joined('10011', 2, 'Demo Stn Exit A', 'Demo Ave 2'),
  ]),
];

describe('buildRouteStatic', () => {
  const html = buildRouteStatic(TRUNK, TRUNK_DIRECTIONS);

  it('renders one card and one <ol> per direction', () => {
    assert.equal((html.match(/<ol class="rt-stops">/g) ?? []).length, 2);
    assert.equal((html.match(/<details class="card rt-dir" open>/g) ?? []).length, 2);
    assert.ok(html.includes('To Demo Stn Exit B'));
    assert.ok(html.includes('To Demo Stn Exit A'));
  });

  it('keeps each <ol> in the input seq order', () => {
    const lists = [...html.matchAll(/<ol class="rt-stops">(.*?)<\/ol>/gs)].map((m) => m[1] ?? '');
    assert.equal(lists.length, 2);
    const codesOf = (list: string) => [...list.matchAll(/href="\/stop\/(\d{5})"/g)].map((m) => m[1]);
    assert.deepEqual(codesOf(lists[0] ?? ''), ['10011', '10019']);
    assert.deepEqual(codesOf(lists[1] ?? ''), ['10019', '10011']);
  });

  it('links every stop to its stop page with description and road', () => {
    assert.ok(html.includes('href="/stop/10011"'));
    assert.ok(html.includes('<span class="nb-name">Demo Stn Exit A</span>'));
    assert.ok(html.includes('<span class="nb-sub">Demo Ave 2</span>'));
  });

  it('carries the operator and the direction first/last bus line', () => {
    assert.ok(html.includes('Operated by SBST.'));
    assert.ok(html.includes('2 stops · first bus – last: weekdays 05:30 – 23:30 · Sat 05:35 – 23:35 · Sun 05:40 – 23:40'));
  });

  it('renders no times line when the feed has no schedule, no fake dashes', () => {
    const bare = buildRouteStatic(TRUNK, [
      direction(1, TRUNK_DIRECTIONS[0]?.stops ?? [], { firstBus: null, lastBus: null }),
    ]);
    assert.ok(bare.includes('<span class="rt-dir-meta">2 stops</span>'));
    assert.ok(!bare.includes('first bus'));
  });

  it('keeps a loop\'s duplicated origin — 10001 appears twice, in order', () => {
    const loopHtml = buildRouteStatic(LOOP, [
      direction(1, [
        joined('10001', 1, 'Blk 101', 'Demo Ave 1'),
        joined('10009', 2, 'Opp Blk 101', 'Demo Ave 1'),
        joined('10001', 3, 'Blk 101', 'Demo Ave 1'),
      ]),
    ]);
    assert.equal((loopHtml.match(/href="\/stop\/10001"/g) ?? []).length, 2);
    assert.ok(loopHtml.includes('⟲ Loop at Opp Blk 101'));
    const codes = [...loopHtml.matchAll(/href="\/stop\/(\d{5})"/g)].map((m) => m[1]);
    assert.deepEqual(codes, ['10001', '10009', '10001']);
  });

  it('falls back to the origin description for a loop with an empty loopDesc', () => {
    const loopHtml = buildRouteStatic({ ...LOOP, loopDesc: '' }, [
      direction(1, [joined('10001', 1, 'Blk 101', 'Demo Ave 1'), joined('10001', 2, 'Blk 101', 'Demo Ave 1')]),
    ]);
    assert.ok(loopHtml.includes('⟲ Loop at Blk 101'));
  });

  it('renders a join-miss as its bare code, with no road span', () => {
    const html = buildRouteStatic(TRUNK, [
      direction(1, [joined('10011', 1, 'Demo Stn Exit A', 'Demo Ave 2'), missed('99997', 2)]),
    ]);
    assert.ok(html.includes('href="/stop/99997"'));
    assert.ok(html.includes('<span class="nb-name">99997</span></a>'), 'code must stand in as description');
  });

  it('escapes descriptions and roads — <&"\' never reaches the markup raw', () => {
    const nasty = buildRouteStatic({ ...TRUNK, operator: 'S&B <T>' }, [
      direction(1, [
        joined('10011', 1, `Blk <&"'>`, `Rd & "Lane" <1>`),
        joined('10019', 2, 'Plain', 'Rd'),
      ]),
    ]);
    assert.ok(nasty.includes('Blk &lt;&amp;&quot;&#39;&gt;'));
    assert.ok(nasty.includes('Rd &amp; &quot;Lane&quot; &lt;1&gt;'));
    assert.ok(nasty.includes('Operated by S&amp;B &lt;T&gt;.'));
    assert.ok(!nasty.includes('Blk <'), 'raw < leaked into the list');
  });

  it('names the section with a real h2 and each direction with an h3', () => {
    assert.ok(html.includes('<h2 class="rt-sec">Bus 74 — all stops</h2>'));
    assert.equal((html.match(/<h3 class="rt-dir-head">/g) ?? []).length, 2);
  });

  it('collapses to the shell\'s own generic section for empty input', () => {
    assert.equal(buildRouteStatic(TRUNK, []), ROUTE_STATIC_TARGET);
  });

  it('omits the operator line when the feed gave none', () => {
    const html = buildRouteStatic({ ...TRUNK, operator: '' }, TRUNK_DIRECTIONS);
    assert.ok(!html.includes('Operated by'));
  });
});

describe('buildRouteJsonLd', () => {
  /** The script body, exactly as a consumer would slice it out. */
  const bodyOf = (html: string): string => {
    const match = /^<script type="application\/ld\+json">(.*)<\/script>$/s.exec(html);
    assert.ok(match?.[1], 'not a single JSON-LD script tag');
    return match[1];
  };

  const stops = TRUNK_DIRECTIONS[0]?.stops ?? [];

  it('parses with JSON.parse and carries the BreadcrumbList and ItemList', () => {
    const parsed = JSON.parse(bodyOf(buildRouteJsonLd('74', stops))) as Array<Record<string, unknown>>;
    assert.equal(parsed.length, 2);
    const [crumbs, list] = parsed;
    assert.ok(crumbs && list);
    assert.equal(crumbs['@type'], 'BreadcrumbList');
    const trail = crumbs.itemListElement as Array<Record<string, unknown>>;
    assert.equal(trail.length, 3);
    assert.equal(trail[0]?.item, 'https://ezbus.sg/');
    assert.equal(trail[1]?.item, 'https://ezbus.sg/buses');
    assert.equal(trail[1]?.name, 'Buses');
    assert.equal(trail[2]?.item, 'https://ezbus.sg/bus/74');
    assert.equal(trail[2]?.name, 'Bus 74');

    assert.equal(list['@type'], 'ItemList');
    assert.equal(list.numberOfItems, 2);
    const items = list.itemListElement as Array<Record<string, unknown>>;
    assert.deepEqual(
      items.map((item) => [item.position, item.name, item.url]),
      [
        [1, 'Demo Stn Exit A', 'https://ezbus.sg/stop/10011'],
        [2, 'Demo Stn Exit B', 'https://ezbus.sg/stop/10019'],
      ],
    );
  });

  it('cannot be broken out of: a </script> in a description stays JSON-escaped', () => {
    const hostile = [{ code: '10011', description: 'A </script><script>alert(1)' }];
    const body = bodyOf(buildRouteJsonLd('74', hostile));
    assert.ok(!body.includes('<'), 'a raw < survived into the script body');
    const parsed = JSON.parse(body) as Array<Record<string, unknown>>;
    const items = parsed[1]?.itemListElement as Array<Record<string, unknown>>;
    // Round-trips: the escape is JSON's own, so the value is untouched.
    assert.equal(items[0]?.name, 'A </script><script>alert(1)');
  });
});

describe('buildRouteHead', () => {
  const html = buildRouteHead(TRUNK, TRUNK_DIRECTIONS);

  it('makes the route the page\'s one h1, restating the number for readers and crawlers', () => {
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
    assert.ok(
      html.includes(
        '<h1 class="rt-ends"><span class="visually-hidden">Bus 74: </span>Demo Stn Exit A → Demo Stn Exit B</h1>',
      ),
    );
    // The stencil number is shown, but hidden from AT so it is not read twice.
    assert.ok(html.includes('<span class="rt-no" aria-hidden="true">74</span>'));
  });

  it('marks itself server-rendered and carries the lead direction\'s meta line', () => {
    assert.ok(html.startsWith('<div id="rt-head" data-ssr="1">'));
    assert.ok(html.includes('<span class="rt-meta">2 stops · runs 05:30–23:30</span>'));
  });

  it('emits the direction toggle with the lead direction pressed', () => {
    const buttons = [...html.matchAll(/<button[^>]*data-dir="(\d)"[^>]*class="(on)?"[^>]*aria-pressed="(true|false)">([^<]*)<\/button>/g)];
    assert.deepEqual(
      buttons.map((m) => [m[1], m[2] ?? '', m[3], m[4]]),
      [
        ['1', 'on', 'true', 'to Demo Stn Exit B'],
        ['2', '', 'false', 'to Demo Stn Exit A'],
      ],
    );
  });

  it('gives a loop its badge and "loop service" ends, never a toggle', () => {
    const loopHtml = buildRouteHead(LOOP, [
      direction(1, [joined('10001', 1, 'Blk 101', 'Demo Ave 1'), joined('10001', 2, 'Blk 101', 'Demo Ave 1')]),
    ]);
    assert.ok(loopHtml.includes('Blk 101 — loop service</h1>'));
    assert.ok(loopHtml.includes('<p class="loop-badge">⟲ Loop at Opp Blk 101</p>'));
    assert.ok(!loopHtml.includes('dir-toggle'));
  });

  it('drops the "runs" span when the feed has no weekday schedule', () => {
    const bare = buildRouteHead(TRUNK, [
      direction(1, TRUNK_DIRECTIONS[0]?.stops ?? [], { firstBus: null, lastBus: null }),
    ]);
    assert.ok(bare.includes('<span class="rt-meta">2 stops</span>'));
    assert.ok(!bare.includes('dir-toggle'), 'one direction, no toggle');
  });

  it('escapes the service number and descriptions', () => {
    const nasty = buildRouteHead({ ...TRUNK, serviceNo: '7<4' }, [
      direction(1, [joined('10011', 1, 'A <b>', 'Rd'), joined('10019', 2, 'B & "C"', 'Rd')]),
    ]);
    assert.ok(nasty.includes('Bus 7&lt;4: </span>A &lt;b&gt; → B &amp; &quot;C&quot;</h1>'));
    assert.ok(!nasty.includes('<b>'));
  });

  it('collapses to the shell skeleton for empty input', () => {
    assert.equal(buildRouteHead(TRUNK, []), ROUTE_HEAD_TARGET);
  });
});

describe('route page heading and title invariants', () => {
  const shell = readFileSync(new URL('../public/route.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../public/route.js', import.meta.url), 'utf8');

  // The global `h1` rule styles the wordmark; on a page whose h1 is the route,
  // the wordmark must be the <p class="wordmark"> stop.html already uses, or
  // the page carries two h1s and the route is not the heading.
  it('the shell\'s only h1 is the generic hidden one inside the head target', () => {
    const h1s = shell.replace(/<!--[\s\S]*?-->/g, '').match(/<h1\b[^>]*>/g) ?? [];
    assert.deepEqual(h1s, ['<h1 class="visually-hidden">']);
    assert.ok(shell.includes('<p class="wordmark"><a href="/"'));
  });

  it('route.js renders the same h1 as the server', () => {
    assert.ok(script.includes('<h1 class="rt-ends"><span class="visually-hidden">Bus ${escape(route.serviceNo)}: </span>${ends}</h1>'));
    assert.ok(script.includes('<span class="rt-no" aria-hidden="true">'));
  });

  // Google renders JS before indexing. Removing #rt-static on the live view
  // deleted every stop link, time and fact from the indexed page; it may only
  // be closed there, and removed for the "no such service" page alone.
  it('route.js keeps the static section on the live view, only collapsing it', () => {
    const ladder = script.slice(script.indexOf('function applyLadder()'));
    assert.match(ladder.slice(0, 200), /collapseStatic\(\);/);
    const drops = [...script.matchAll(/^\s*dropStatic\(\);/gm)];
    assert.equal(drops.length, 1, 'dropStatic() must have exactly one caller');
    const missing = script.slice(script.indexOf('function renderMissing('));
    assert.ok(missing.slice(0, 400).includes('dropStatic();'), 'that caller must be renderMissing');
  });

  // Google indexes the rendered DOM: a boot-time document.title would replace
  // the injected keyword title for every crawl of every route.
  it('route.js only names the tab when the server did not', () => {
    assert.ok(!script.includes('route & arrivals · ezbus'), 'the old unconditional title is back');
    assert.match(script, /if \(!serverHead\) document\.title =/);
  });
});

describe('shell pairing', () => {
  // The whole injection pattern rests on the shell and the constant matching
  // byte for byte — an edit to one side without the other fails silently as a
  // page that simply stops being injected, which curl in mock mode catches
  // but this catches first and names.
  for (const [name, target] of [
    ['ROUTE_HEAD_TARGET', ROUTE_HEAD_TARGET],
    ['ROUTE_STATIC_TARGET', ROUTE_STATIC_TARGET],
  ] as const) {
    it(`${name} appears verbatim, exactly once, in public/route.html`, () => {
      const shell = readFileSync(new URL('../public/route.html', import.meta.url), 'utf8');
      assert.equal(shell.split(target).length, 2, `target missing or duplicated: ${target.slice(0, 60)}…`);
    });
  }
});
