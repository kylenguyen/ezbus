import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ROUTE_HEAD_TARGET,
  ROUTE_STATIC_TARGET,
  buildKeyStops,
  buildRelated,
  buildRouteDescription,
  buildRouteFacts,
  buildRouteFaq,
  buildRouteFaqJsonLd,
  buildRouteHead,
  categoryLabel,
  fmtFreq,
  freqLine,
  keyStops,
  buildRouteJsonLd,
  buildRouteStatic,
  operatorName,
  rankRelated,
  routeFaq,
} from './route-page.js';
import { compareServiceNos } from './routes.js';
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
  times: Partial<Pick<RouteDirectionPayload, 'firstBus' | 'lastBus' | 'lengthKm'>> = {},
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
    lengthKm: 'lengthKm' in times ? (times.lengthKm ?? null) : 12.34,
    stops,
  };
};

const TRUNK = {
  serviceNo: '74',
  operator: 'SBST',
  loop: false,
  loopDesc: '',
  category: 'TRUNK',
  freq: { peak: '06-08', offpeak: '10-15' },
};
const LOOP = {
  serviceNo: '52',
  operator: 'SBST',
  loop: true,
  loopDesc: 'Opp Blk 101',
  category: 'FEEDER',
  freq: { peak: '08-08', offpeak: null },
};

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

  it('gives each direction plate its stop count and length', () => {
    assert.equal((html.match(/<span class="rt-dir-meta">2 stops · 12\.3 km<\/span>/g) ?? []).length, 2);
  });

  it('drops the length when the feed has none, never a fake 0 km', () => {
    const bare = buildRouteStatic(TRUNK, [
      direction(1, TRUNK_DIRECTIONS[0]?.stops ?? [], { lengthKm: null }),
    ]);
    assert.ok(bare.includes('<span class="rt-dir-meta">2 stops</span>'));
    const zero = buildRouteStatic(TRUNK, [direction(1, TRUNK_DIRECTIONS[0]?.stops ?? [], { lengthKm: 0 })]);
    assert.ok(!zero.includes('0.0 km'));
  });

  it('leads with the facts card, ahead of the stop lists', () => {
    assert.ok(html.indexOf('Bus 74 at a glance') < html.indexOf('Bus 74 — all stops'));
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
    assert.ok(nasty.includes('S&amp;B &lt;T&gt;'), 'unknown operator code passes through, escaped');
    assert.ok(!nasty.includes('Blk <'), 'raw < leaked into the list');
  });

  it('names the section with a real h2 and each direction with an h3', () => {
    assert.ok(html.includes('<h2 class="rt-sec">Bus 74 — all stops</h2>'));
    assert.equal((html.match(/<h3 class="rt-dir-head">/g) ?? []).length, 2);
  });

  it('collapses to the shell\'s own generic section for empty input', () => {
    assert.equal(buildRouteStatic(TRUNK, []), ROUTE_STATIC_TARGET);
  });

  it('omits the operator row when the feed gave neither operator nor category', () => {
    const html = buildRouteStatic({ ...TRUNK, operator: '', category: '' }, TRUNK_DIRECTIONS);
    assert.ok(!html.includes('<dt>Operator</dt>'));
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

describe('route facts formatting', () => {
  it('names the four operators as riders search for them, passing unknowns through', () => {
    assert.equal(operatorName('SBST'), 'SBS Transit');
    assert.equal(operatorName('SMRT'), 'SMRT Buses');
    assert.equal(operatorName('TTS'), 'Tower Transit Singapore');
    assert.equal(operatorName('GAS'), 'Go-Ahead Singapore');
    assert.equal(operatorName('NEW'), 'NEW');
    // A prototype key is not an operator.
    assert.equal(operatorName('constructor'), 'constructor');
  });

  it('phrases the guide\'s named categories and keeps the rest readable', () => {
    assert.equal(categoryLabel('TRUNK'), 'Trunk service');
    assert.equal(categoryLabel('feeder'), 'Feeder service');
    assert.equal(categoryLabel('FLAT FEE $1.10'), 'Flat fee $1.10');
    assert.equal(categoryLabel('  '), '');
  });

  it('formats headways exactly as the stop page does', () => {
    assert.equal(fmtFreq('06-08'), '6–8 min');
    assert.equal(fmtFreq('08-08'), '8 min');
    assert.equal(fmtFreq('10'), '10 min');
    assert.equal(fmtFreq('-'), null);
    assert.equal(fmtFreq(null), null);
    assert.equal(fmtFreq('6 to 8'), null);
  });

  it('states the guide\'s time windows with each headway, and nothing without data', () => {
    assert.equal(
      freqLine({ peak: '06-08', offpeak: '10-15' }),
      'every 6–8 min in the morning peak (06:30–08:30), every 10–15 min off-peak (08:31–16:59)',
    );
    assert.equal(freqLine({ peak: null, offpeak: '10-15' }), 'every 10–15 min off-peak (08:31–16:59)');
    assert.equal(freqLine({ peak: null, offpeak: null }), null);
  });
});

describe('buildRouteFacts', () => {
  const html = buildRouteFacts(TRUNK, TRUNK_DIRECTIONS);

  it('answers how often, how long and who runs it', () => {
    assert.ok(html.includes('<h2 class="rt-sec">Bus 74 at a glance</h2>'));
    assert.ok(
      html.includes(
        '<dt>How often</dt><dd>Every 6–8 min in the morning peak (06:30–08:30), every 10–15 min off-peak (08:31–16:59)</dd>',
      ),
    );
    assert.ok(html.includes('<dt>Route</dt><dd>2 stops · 12.3 km one way · Demo Stn Exit A ⇄ Demo Stn Exit B</dd>'));
    assert.ok(html.includes('<dt>Operator</dt><dd>SBS Transit · Trunk service</dd>'));
  });

  it('tabulates first and last bus per day type, one column per direction', () => {
    assert.ok(html.includes('<th scope="col" class="rt-times-dir">From Demo Stn Exit A</th>'));
    assert.ok(html.includes('<th scope="col" class="rt-times-dir">From Demo Stn Exit B</th>'));
    assert.ok(html.includes('<tr><th scope="row">Weekdays</th><td>05:30 – 23:30</td><td>05:30 – 23:30</td></tr>'));
    assert.ok(html.includes('<tr><th scope="row">Sunday</th><td>05:40 – 23:40</td><td>05:40 – 23:40</td></tr>'));
  });

  it('leaves out a direction with no schedule, and the table when none has one', () => {
    const [d1, d2] = TRUNK_DIRECTIONS;
    assert.ok(d1 && d2);
    const half = buildRouteFacts(TRUNK, [d1, { ...d2, firstBus: null, lastBus: null }]);
    assert.equal((half.match(/rt-times-dir/g) ?? []).length, 1);
    const none = buildRouteFacts(TRUNK, [
      { ...d1, firstBus: null, lastBus: null },
      { ...d2, firstBus: null, lastBus: null },
    ]);
    assert.ok(!none.includes('<table'));
  });

  it('drops the headway row without data and says "loop from" for a loop', () => {
    const loop = buildRouteFacts({ ...LOOP, freq: { peak: null, offpeak: null } }, [
      direction(1, [joined('10001', 1, 'Blk 101', 'Demo Ave 1'), joined('10001', 2, 'Blk 101', 'Demo Ave 1')]),
    ]);
    assert.ok(!loop.includes('How often'));
    assert.ok(loop.includes('<dd>2 stops · 12.3 km · loop from Blk 101</dd>'));
    assert.ok(loop.includes('Feeder service'));
  });

  it('escapes descriptions into the table and the route row', () => {
    const nasty = buildRouteFacts(TRUNK, [
      direction(1, [joined('10011', 1, 'A <b>', 'Rd'), joined('10019', 2, 'B & C', 'Rd')]),
    ]);
    assert.ok(nasty.includes('From A &lt;b&gt;</th>'));
    assert.ok(nasty.includes('A &lt;b&gt; ⇄ B &amp; C'));
  });

  it('renders nothing for empty input', () => {
    assert.equal(buildRouteFacts(TRUNK, []), '');
  });
});

describe('keyStops', () => {
  const route = (names: string[]) =>
    direction(
      1,
      names.map((name, i) => joined(String(10001 + i), i + 1, name, 'Some Rd')),
    );

  it('picks interchanges and stations, normalised and in route order', () => {
    const found = keyStops([
      route(['Toa Payoh Int', 'Blk 123', 'Opp Bishan Stn', 'Bishan Stn Exit A', 'Aft Braddell Stn', 'Sengkang Interchange']),
    ]);
    assert.deepEqual(
      found.map((stop) => [stop.name, stop.code, stop.kind]),
      [
        ['Toa Payoh Int', '10001', 'interchange'],
        ['Bishan Stn', '10003', 'station'],
        ['Braddell Stn', '10005', 'station'],
        ['Sengkang Interchange', '10006', 'interchange'],
      ],
    );
    assert.equal(found[1]?.description, 'Opp Bishan Stn', 'first sighting keeps its own description');
  });

  it('does not mistake schools, roads or other stations for interchanges or MRT stations', () => {
    const found = keyStops([
      route([
        'Opp Canadian Int Sch',
        'Int Bus Pk',
        'Stn Rd',
        'Opp Bishan Fire Stn',
        'Bef Ang Mo Kio Police Stn',
        'Aft Esso Stn',
        'Bt Panjang Petrol Stn',
        'Tuas Pumping Stn',
      ]),
    ]);
    assert.deepEqual(found, []);
  });

  it('adds places only the second direction passes, after the first direction\'s', () => {
    const d1 = route(['Bishan Stn', 'Toa Payoh Int']);
    const d2 = direction(2, [joined('20001', 1, 'Opp Toa Payoh Int', 'X'), joined('20002', 2, 'Caldecott Stn Exit 2', 'Y')]);
    assert.deepEqual(
      keyStops([d1, d2]).map((stop) => stop.name),
      ['Bishan Stn', 'Toa Payoh Int', 'Caldecott Stn'],
    );
  });

  it('caps the list at ten places', () => {
    const many = route(Array.from({ length: 14 }, (_, i) => `Place${i} Stn`));
    assert.equal(keyStops([many]).length, 10);
  });

  it('renders linked rows, escaped, and nothing at all when none were found', () => {
    const html = buildKeyStops('74', keyStops([route(['Opp A<b> Stn', 'Toa Payoh Int'])]));
    assert.ok(html.includes('<h2 class="rt-sec">Interchanges &amp; stations on bus 74</h2>'));
    assert.ok(html.includes('<a href="/stop/10001"><span class="nb-name">A&lt;b&gt; Stn</span><span class="nb-sub">Opp A&lt;b&gt; Stn</span></a>'));
    assert.ok(html.includes('<span class="nb-name">Toa Payoh Int</span><span class="nb-sub">Bus interchange</span>'));
    assert.equal(buildKeyStops('74', []), '');
  });
});

describe('rankRelated', () => {
  // 74 calls at 10011, 10019, 10021, 10029 (direction 2 repeats two of them).
  const d1 = direction(1, ['10011', '10019', '10021', '10029'].map((code, i) => joined(code, i + 1, code, 'Rd')));
  const d2 = direction(2, ['10029', '10011'].map((code, i) => joined(code, i + 1, code, 'Rd')));
  const at: Record<string, string[]> = {
    '10011': ['74', '151', '10', '963'],
    '10019': ['74', '151', '10'],
    '10021': ['74', '151', '2'],
    // A service listed twice at one stop (both its directions) counts once.
    '10029': ['74', '151', '151', '2', '963E'],
  };
  const servicesAt = (code: string) => at[code] ?? [];

  it('ranks by distinct shared stops, never counting the service itself', () => {
    assert.deepEqual(rankRelated('74', [d1, d2], servicesAt, compareServiceNos), [
      { serviceNo: '151', shared: 4 },
      { serviceNo: '2', shared: 2 },
      { serviceNo: '10', shared: 2 },
    ]);
  });

  it('drops services sharing a single stop — a junction, not a parallel route', () => {
    const ranked = rankRelated('74', [d1, d2], servicesAt, compareServiceNos);
    assert.ok(!ranked.some((entry) => entry.serviceNo === '963' || entry.serviceNo === '963E'));
  });

  it('matches itself case-insensitively and caps the list at six', () => {
    const crowd = Object.fromEntries(
      ['10011', '10019'].map((code) => [code, ['972m', ...Array.from({ length: 9 }, (_, i) => String(100 + i))]]),
    );
    const ranked = rankRelated('972M', [d1], (code) => crowd[code] ?? [], compareServiceNos);
    assert.equal(ranked.length, 6);
    assert.ok(!ranked.some((entry) => entry.serviceNo.toUpperCase() === '972M'));
    assert.deepEqual(ranked.map((entry) => entry.serviceNo), ['100', '101', '102', '103', '104', '105']);
  });

  it('renders linked rows in the directory idiom, and nothing without rows', () => {
    const html = buildRelated([{ serviceNo: '151', shared: 4, summary: 'A <x> → B' }]);
    assert.ok(html.includes('<h2 class="rt-sec">Other buses along this route</h2>'));
    assert.ok(
      html.includes(
        '<li><a href="/bus/151"><span class="service-no">151</span><span class="nb-name">A &lt;x&gt; → B</span><span class="nb-sub">4 shared</span></a></li>',
      ),
    );
    assert.equal(buildRelated([]), '');
  });
});

describe('routeFaq', () => {
  const places = keyStops(TRUNK_DIRECTIONS);
  const faq = routeFaq(TRUNK, TRUNK_DIRECTIONS, places);
  const answer = (start: string) => faq.find((item) => item.question.startsWith(start))?.answer;

  it('asks the questions people type, in order', () => {
    assert.deepEqual(
      faq.map((item) => item.question),
      [
        'What time is the first and last bus 74?',
        'How often does bus 74 come?',
        'Where does bus 74 go?',
        'Which company operates bus 74?',
        'How do I check when bus 74 is coming?',
      ],
    );
  });

  it('answers first/last bus per direction and day, saying where the times apply', () => {
    assert.equal(
      answer('What time'),
      'From Demo Stn Exit A and Demo Stn Exit B: first bus 05:30, last bus 23:30 on weekdays; ' +
        'first bus 05:35, last bus 23:35 on Saturdays; first bus 05:40, last bus 23:40 on Sundays. ' +
        'These are scheduled departures from the first stop, so the bus reaches stops further along the route later.',
    );
  });

  it('says same-time days once, and a missing last bus in words rather than a dash', () => {
    const [d1, d2] = TRUNK_DIRECTIONS;
    assert.ok(d1 && d2);
    const dirs = [
      { ...d1, firstBus: { wd: '0530', sat: '0530', sun: '0530' }, lastBus: { wd: '-', sat: '-', sun: '-' } },
      { ...d2, firstBus: { wd: '0545', sat: '0600', sun: '0600' }, lastBus: { wd: '2350', sat: '2350', sun: '2350' } },
    ];
    const text = routeFaq(TRUNK, dirs, []).find((item) => item.question.startsWith('What time'))?.answer ?? '';
    assert.ok(text.startsWith(
      'From Demo Stn Exit A: first bus 05:30, every day (no last bus time is published). ' +
        'From Demo Stn Exit B: first bus 05:45, last bus 23:50 on weekdays; first bus 06:00, last bus 23:50 on weekends.',
    ));
    assert.ok(!text.includes('––'));
  });

  it('answers frequency with the windows, route with places passed, operator by name', () => {
    assert.ok(answer('How often')?.startsWith('Bus 74 runs every 6–8 min in the morning peak (06:30–08:30), every 10–15 min'));
    assert.equal(
      answer('Where'),
      'Bus 74 runs between Demo Stn Exit A and Demo Stn Exit B, calling at 2 stops over about 12.3 km one way. It passes Demo Stn.',
    );
    assert.equal(answer('Which company'), 'Bus 74 is run by SBS Transit as a trunk service.');
  });

  it('leaves out questions it cannot answer rather than answering vaguely', () => {
    const bare = routeFaq(
      { ...TRUNK, operator: '', category: '', freq: { peak: null, offpeak: null } },
      [direction(1, TRUNK_DIRECTIONS[0]?.stops ?? [], { firstBus: null, lastBus: null, lengthKm: null })],
      [],
    );
    assert.deepEqual(
      bare.map((item) => item.question),
      ['Where does bus 74 go?', 'How do I check when bus 74 is coming?'],
    );
    assert.equal(bare[0]?.answer, 'Bus 74 runs between Demo Stn Exit A and Demo Stn Exit B, calling at 2 stops.');
  });

  it('phrases a loop by where it turns, and lists several places naturally', () => {
    const loopFaq = routeFaq(
      LOOP,
      [direction(1, [joined('10001', 1, 'Blk 101', 'Demo Ave 1'), joined('10001', 2, 'Blk 101', 'Demo Ave 1')])],
      [
        { name: 'A Int', code: '1', description: 'A Int', kind: 'interchange' },
        { name: 'B Stn', code: '2', description: 'B Stn', kind: 'station' },
        { name: 'C Stn', code: '3', description: 'C Stn', kind: 'station' },
      ],
    );
    assert.equal(
      loopFaq.find((item) => item.question.startsWith('Where'))?.answer,
      'Bus 52 is a loop service from Blk 101, turning at Opp Blk 101, calling at 2 stops over about 12.3 km. It passes A Int, B Stn and C Stn.',
    );
  });

  it('ends with what the page does, pointing at the pin the panel offers', () => {
    const pitch = answer('How do I check');
    assert.ok(pitch?.includes('live arrival times for bus 74 at that stop'));
    assert.ok(pitch?.endsWith('if you pin the stop, it is waiting on your ezbus board next time.'));
  });

  it('is empty without a direction', () => {
    assert.deepEqual(routeFaq(TRUNK, [], []), []);
  });
});

describe('buildRouteFaq and its JSON-LD', () => {
  const items = [
    { question: 'Q <one>?', answer: 'A & "one".' },
    { question: 'Q two?', answer: 'A </script><script>x' },
  ];

  it('renders escaped disclosure rows under the route\'s questions heading', () => {
    const html = buildRouteFaq('74', items);
    assert.ok(html.startsWith('<h2 class="rt-sec">Bus 74 questions</h2>'));
    assert.ok(html.includes('<details class="faq-item"><summary>Q &lt;one&gt;?</summary><p>A &amp; &quot;one&quot;.</p></details>'));
    assert.equal(buildRouteFaq('74', []), '');
  });

  it('mirrors the visible text exactly in a parseable FAQPage, unbreakable by </script>', () => {
    const tag = buildRouteFaqJsonLd(items);
    const body = /^<script type="application\/ld\+json">(.*)<\/script>$/s.exec(tag)?.[1];
    assert.ok(body, 'not a single JSON-LD script tag');
    assert.ok(!body.includes('<'));
    const parsed = JSON.parse(body) as {
      '@type': string;
      mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
    };
    assert.equal(parsed['@type'], 'FAQPage');
    assert.deepEqual(
      parsed.mainEntity.map((q) => [q.name, q.acceptedAnswer.text]),
      items.map((item) => [item.question, item.answer]),
    );
    assert.equal(buildRouteFaqJsonLd([]), '');
  });
});

describe('buildRouteDescription', () => {
  it('leads with the route, then headway and first/last bus, then the operator\'s name', () => {
    assert.equal(
      buildRouteDescription(TRUNK, TRUNK_DIRECTIONS),
      'Bus 74 timing & route: every stop from Demo Stn Exit A to Demo Stn Exit B with live arrival times. ' +
        'Every 6–8 min at peak, first bus 05:30, last bus 23:30 on weekdays. Operated by SBS Transit.',
    );
  });

  it('phrases a loop by where it turns', () => {
    const text = buildRouteDescription(LOOP, [
      direction(1, [joined('10001', 1, 'Blk 101', 'Demo Ave 1'), joined('10001', 2, 'Blk 101', 'Demo Ave 1')]),
    ]);
    assert.ok(text.startsWith('Bus 52 timing & route: loop service from Blk 101 via Opp Blk 101, every stop'));
    assert.ok(text.includes('Every 8 min at peak, first bus 05:30'));
  });

  it('drops each clause whose data is missing, keeping the sentence well-formed', () => {
    const bare = buildRouteDescription({ ...TRUNK, operator: '', freq: { peak: null, offpeak: null } }, [
      direction(1, TRUNK_DIRECTIONS[0]?.stops ?? [], { firstBus: null, lastBus: null }),
    ]);
    assert.equal(
      bare,
      'Bus 74 timing & route: every stop from Demo Stn Exit A to Demo Stn Exit B with live arrival times.',
    );
    const timesOnly = buildRouteDescription({ ...TRUNK, freq: { peak: null, offpeak: null } }, TRUNK_DIRECTIONS);
    assert.ok(timesOnly.includes(' First bus 05:30, last bus 23:30 on weekdays. Operated'));
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

  // The search visitor's way into the product: after the route content, never
  // above the live view, and always pointing at the board.
  it('the shell ends <main> with the what-ezbus-is block linking to the board', () => {
    const why = shell.indexOf('<section class="rt-why"');
    assert.ok(why > shell.indexOf(ROUTE_STATIC_TARGET), 'must come after the route content');
    assert.ok(why < shell.indexOf('</main>'));
    assert.ok(shell.slice(why, shell.indexOf('</main>')).includes('<a href="/">Open the live board</a>'));
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

  // Picker rows were bare <li>s with a click handler: unreachable from a
  // keyboard and not announced as actionable. Every row kind is now a link.
  it('route.js renders every picker row kind as a nofollow link to ?stop=', () => {
    const links = script.match(/<a class="pick-link" href="\$\{pickHref\(stop\)\}" rel="nofollow">/g) ?? [];
    assert.equal(links.length, 3, 'current row, spine row and search result');
    assert.ok(script.includes('return `/bus/${encodeURIComponent(serviceNo)}?stop=${encodeURIComponent(stop.code)}`;'));
  });

  it('route.js leaves modified clicks on a picker row to the browser', () => {
    const handler = script.slice(script.indexOf("const pick = event.target.closest('[data-pick]');"));
    const guard = handler.indexOf('event.metaKey || event.ctrlKey');
    const prevent = handler.indexOf('event.preventDefault();');
    assert.ok(guard > 0 && prevent > guard, 'the modifier check must run before preventDefault');
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
