# SEO keyword pass (phase 2) — implementation plan

Approved 23 Aug 2026. Phase 1 (indexable per-stop/per-service pages, sitemap,
JSON-LD, injected titles/canonicals, crawl-check) is done — see
`docs/seo-implementation-plan.md`. This phase blends the colloquial Singapore
search term **"bus timing"** into every page's title and description, injects
per-stop meta descriptions (currently generic on ~5,000 pages), adds a
4-question FAQ block with FAQPage JSON-LD on the homepage, and makes
light-touch visible-copy changes. **No URL, sitemap, robots.txt, or canonical
changes anywhere.**

Decisions already made (do not re-litigate):

- Homepage title keeps the lowercase house voice: `ezbus · live SG bus timing & arrival times — no app needed`.
- Stop and route titles both gain keywords (patterns below).
- FAQ lives on the homepage only, above the footer, as collapsed `<details>`.
  Known trade-off, accepted: Google no longer shows FAQ rich results for
  non-government sites — the win is question/voice-query coverage, not snippets.
- Visible copy is light touch: reword existing strings; no new sections beyond
  the FAQ.

## Task graph

```
Lane 1 (server-injected pages):   T1 stop pages ──→ T2 route pages
Lane 2 (homepage):                T4 head meta ──→ T5 tagline ──→ T6 FAQ block
Lane 3 (independent):             T3 buses directory
All lanes ──→ T7 end-to-end verification
```

Lanes 1, 2, 3 may run as parallel agents. **Within** a lane, tasks are
serialized because they edit the same files (T1/T2 both touch the adjacent
constant blocks at `src/index.ts:479-498`; T4/T5/T6 all touch
`public/index.html`). Cross-lane conflicts are structurally impossible
(disjoint files), but every task still rebases on latest `main` immediately
before committing and re-runs its verification after the rebase.

## Conventions binding every task

- **One commit per task.** Message style matches the repo's short imperative
  history (e.g. "fix home ui", "Update arr in bus page to due").
- **Paired-constant invariant.** `/stop/:code` and `/bus/:service` inject head
  tags by exact-string replacement: each generic tag in `public/stop.html` /
  `public/route.html` has a verbatim constant in `src/index.ts`
  (`STOP_TITLE_TAG`, `ROUTE_TITLE_TAG`, …). Editing a tag without its constant
  makes injection **silently stop** — no error, no test failure by default.
  Edit tag and constant in the same commit, always, and verify injection with
  a live curl (steps per task below).
- `npm test` builds via `tsc` first and runs `node --test` over `dist/`.
  Never hand-edit `dist/`.
- Local verification server: `npm run build && node dist/index.js &` — runs in
  **mock mode** (no LTA AccountKey needed) on port 8080. `/sitemap.xml` is 503
  until both indexes load; wait for `/healthz` to report stops > 0 and
  routes > 0. Kill the server when done.
- Copy rule: each keyword phrase appears at most once per page, in natural
  prose. No stuffing.

---

## T1 — Stop pages: keyword titles + per-stop meta description injection

**Files:** `public/stop.html`, `src/index.ts` (stop constants + `/stop/:code`
handler around line 519), tests pinning affected strings.

**Context:** the stop shell's head comment and the constants block in
`src/index.ts` document the replacement mechanism. Today the handler injects
title, og:title, og:url, canonical, and three body regions. The **meta
description is not a replacement target** — every stop page ships the same
generic description. This task adds that injection; it is the
highest-leverage single change in the phase.

**Changes:**

1. Injected title pattern → `bus stop {code} · {description}, {roadName} · live timing · ezbus`
   (was `{code} · {description}, {roadName} · ezbus`). Applies to `<title>`
   and og:title.
2. Generic shell title → `bus stop timing · ezbus` (was
   `bus stop arrivals · ezbus`). Update the tag in `stop.html` AND
   `STOP_TITLE_TAG` / `STOP_OG_TITLE_TAG` in `src/index.ts` in this commit.
3. New injection: add `STOP_DESC_TAG` and `STOP_OG_DESC_TAG` constants
   (verbatim copies of the generic tags) and two `.replace()` calls in the
   handler. Injected value:
   `Live bus timing at bus stop {code} ({description}, {roadName}): next arrivals for every service, how full the bus is, and today's first & last bus.`
   Escape with the existing `escapeHtml`. Generic fallback description →
   `Live bus timing at this Singapore stop — next buses from LTA, plus today's first and last bus.`
4. Fallback body line in the `#sp-nearby` section →
   `Checking bus timing? Open the ezbus board to see live arrivals at every stop near you.`

**Verification:**

- `grep -rn "bus stop arrivals · ezbus" src public` → zero hits after the
  change; the new generic title appears exactly twice (shell tag + constant),
  likewise each new description tag/constant pair.
- `npm test` green (update any assertion pinning old strings —
  `src/stop-page.test.ts` pins body swap targets to the shell and must still
  pass).
- Mock server up. Pick two real codes from `curl -s localhost:8080/sitemap.xml`.
  For each: `curl -s localhost:8080/stop/{code}` — `<title>` starts
  `bus stop {code} ·`, meta description contains that stop's name, and the two
  pages' descriptions differ from each other and from the shell's generic one.
- `curl -s localhost:8080/stop/00000` → generic shell: generic title, generic
  description, canonical `https://ezbus.sg/`, no placeholder text leaked.

**Commit:** `Add bus-timing keywords and per-stop descriptions to stop pages`

---

## T2 — Route pages: "timing & route" titles + descriptions

**Depends on T1** (adjacent constants region in `src/index.ts`).

**Files:** `public/route.html`, `src/index.ts` (route constants + `/bus/:service`
handler around line 571), tests pinning affected strings.

**Context:** same paired-constant invariant as T1. The route handler already
injects a per-service description (`ROUTE_OG_DESC_TAG` swaps both the plain and
og description? — check: today only og:description is a swap target; the plain
`meta name="description"` tag may need the same treatment as T1 gave the stop
shell. Verify and make both per-service). Titles come from
`service.serviceNo`, `lead.origin.description`, `lead.destination.description`,
`service.loop` / `service.loopDesc`, operator from `service.operator`.

**Changes:**

1. Injected title → `bus {serviceNo} timing & route · {origin} → {destination} · ezbus`;
   loop variant → `bus {serviceNo} timing & route · loop at {loopDesc or origin} · ezbus`.
2. Generic shell title → `bus timing & routes in Singapore · ezbus` (tag +
   constants in the same commit).
3. Injected description →
   `Bus {serviceNo} timing and full route: every stop from {origin} to {destination} with live arrival times. Operated by {operator}.`
   Operator name stays — it captures "SBS Transit / SMRT bus timing" searches.
   Ensure the plain meta description is per-service, not just og:description.
4. Generic shell description gains "bus timing" naturally, e.g.
   `Bus timing for any Singapore route — where it goes, stop by stop, and live arrivals as your bus approaches.`

**Verification:**

- `grep -rn "bus routes in Singapore · ezbus" src public` → zero hits; new
  pairs verbatim-matched between shell and constants.
- `npm test` green.
- Mock server: `curl -s localhost:8080/bus/{serviceNo from sitemap}` — title
  contains `timing & route`, description names the operator. Find a loop
  service via `/buses` and confirm the loop title form. Lower-case the service
  in the URL and confirm the canonical still carries DataMall's spelling.
- `curl -s localhost:8080/bus/ZZZ9` → generic shell, homepage canonical.

**Commit:** `Add timing & route keywords to bus service pages`

---

## T3 — Buses directory

**Independent; parallel-safe** (touches only `public/buses.html`, whose head is
fully static — the sole injection target is the `#buses-list` body anchor,
which this task must not disturb).

**Changes:**

1. Title/og:title → `all Singapore bus services · timing & routes · ezbus`.
2. Meta + og description →
   `Every public bus service in Singapore — number, route and operator — each linking to live bus timing for every stop on its route.`
3. The `#buses-list` static fallback sentence gains "bus timing" naturally,
   e.g. `Looking for Singapore bus timing? Open the ezbus board to see every bus arriving near you, live.`
   **Caution:** the fallback lives inside the swap-target section paired with
   `BUSES_LIST_TARGET` in `src/buses-page.ts`; a unit test pins the anchor to
   the shell. If the anchor string includes the sentence, update the constant
   and test in step.

**Verification:**

- `npm test` green — `src/buses-page.test.ts`'s shell-pinning test proves the
  swap target survived.
- Mock server: `curl -s localhost:8080/buses` — new `<title>`, and the
  server-rendered list has replaced the fallback sentence (the fallback must
  NOT appear in the served page).
- `curl -s localhost:8080/buses.html` (express.static path) still serves valid
  generic HTML with the fallback visible.

**Commit:** `Add bus-timing keywords to the services directory`

---

## T4 — Homepage head meta

**Files:** `public/index.html` head only.

**Context:** the homepage head is never injected — no constants pair with it.
Confirm with `grep -rn "live bus arrival times in Singapore" src/` before
editing (expect zero hits in `src/`).

**Changes:**

1. Title + og:title → `ezbus · live SG bus timing & arrival times — no app needed`.
2. Meta description →
   `Check bus timing at any stop in Singapore — live arrival times from LTA DataMall, the nearest stops to you, and how full the next bus is. No app, no sign-up.`
3. og:description (shorter) →
   `Check bus timing at any stop in Singapore — live arrivals from LTA DataMall. No app, no sign-up.`

**Verification:**

- `npm test` green.
- Mock server: `curl -s localhost:8080/ | grep -c 'bus timing'` ≥ 2.
- `grep -rn "live bus arrival times in Singapore" . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git`
  → hits only in docs/README history, none in `public/` or `src/`.

**Commit:** `Lead homepage title with SG bus timing keywords`

---

## T5 — Tagline wording

**Depends on T4** (same file: `public/index.html`).

**Files:** `public/origin.js` (`taglineFor`, ~line 283), `src/origin.test.ts`
(the `taglineFor` describe block pins exact strings), `public/index.html`
(static `#tagline`, one line).

**Context:** the static tagline is only the pre-JS paint — `app.js` overwrites
it via `taglineFor(origin, mock)` on load. Both must change together. The
mock-mode honesty rule in `taglineFor`'s comment is non-negotiable: mock mode
must keep saying `· demo timings, not live` and must NOT name LTA.

**Changes (exact strings):**

- GPS: `Stops nearest you · live bus timing from LTA`
- Place: `Stops near {name} · live bus timing from LTA`
- No door yet: `Any stop in Singapore · live bus timing from LTA`
- Mock variants: **unchanged** (`{where} · demo timings, not live`).
- Static `#tagline` in `index.html` → `Stops nearest you · live bus timing from LTA`
  (mirrors the current file's choice of the GPS wording as the default paint).

**Verification:**

- Update the pinned assertions in `src/origin.test.ts`; `npm test` green.
- Mock server in a browser: tagline shows the mock suffix once, no doubled
  clause.
- Visual check at 360 px width: the longer line still fits without ugly
  wrapping (`style-guide.md` governs; the tagline shares its region with the
  masthead).

**Commit:** `Reword tagline to carry live bus timing`

---

## T6 — FAQ block + FAQPage JSON-LD

**Depends on T5** (same file: `public/index.html`).

**Files:** `public/index.html` (between the board and `<footer class="footer">`),
`public/styles.css` (minimal `<details>` styling).

**Context — read before touching styles.css:** the file's header documents
invariants (token blocks at the top of the file; the `theme-color` metas in
every shell duplicate `--bg` per scheme and must stay in step). Style the FAQ
with existing tokens only; it must read correctly in light and dark. Read
`style-guide.md` first. The intro dialog and the gate flow must be unaffected —
the FAQ is inert static content below the board.

**Changes:**

1. Four collapsed `<details>` rows, small type, in a `<section>` with an
   accessible heading. Draft copy — **verify every factual claim against
   actual behaviour before committing; adjust wording if a claim is wrong**:
   - *How accurate are the bus timings?* — Live estimates from LTA DataMall —
     the same source the official apps use — fetched fresh each time a stop is
     loaded. The final minute before arrival shows as "due".
   - *Where does the data come from?* — LTA DataMall, Singapore's official
     land transport data service, covering SBS Transit, SMRT, Tower Transit
     and Go-Ahead services. (Verify the operator list against the data before
     naming operators.)
   - *Do I need an app or sign-up?* — No. ezbus is a website — open ezbus.sg
     in any browser, allow location or type an address, and your nearest stops
     appear. Nothing about you is stored on our servers.
   - *Can I check the first and last bus?* — Yes — every bus stop page shows
     the scheduled first and last bus for each service on weekdays, Saturdays
     and Sundays.
2. One `<script type="application/ld+json">` with `@type: FAQPage` whose
   question/answer text **exactly mirrors** the visible text (Google requires
   the markup to match on-page content). Escape `<` as `<` as the
   existing JSON-LD builders do.

**Verification:**

- `npm test` green.
- Mock server: extract the ld+json from `curl -s localhost:8080/`; it parses,
  `@type` is `FAQPage`, 4 questions, and each answer string appears verbatim
  in the page's visible HTML.
- Browser check, light and dark themes, mobile width: rows render collapsed,
  open/close works, no layout shift to the board above, intro dialog and gate
  unaffected.

**Commit:** `Add FAQ block with FAQPage structured data`

---

## T7 — End-to-end verification

**Depends on all of T1–T6.**

**Files:** `tools/crawl-check.mjs` (extend; keep its zero-dependency rule —
`node:` builtins only).

**Changes — new phase-2 assertions added to the existing crawler:**

- Every `/stop/` page: `<title>` matches `^bus stop \d{5} ·` and its meta
  description is non-generic (differs from the shell's generic string).
- Every `/bus/` page: `<title>` contains `timing & route`.
- Homepage: `<title>` contains `bus timing`; exactly one FAQPage JSON-LD that
  parses with exactly 4 questions.
- All existing checks keep running unchanged (canonical uniqueness, JSON-LD
  parseability, depth-3 BFS from `/`, two-sided sitemap bounds).

**Full end-to-end run (documented procedure):**

1. `npm test` — entire suite green.
2. `npm run build && node dist/index.js &` (mock mode), wait for `/healthz`,
   then `node tools/crawl-check.mjs` — exits 0 across all ~5,400 URLs with the
   new assertions active.
3. Keyword sweep — all must hold:
   - `grep -rn "bus stop arrivals · ezbus\|bus routes in Singapore · ezbus\|live bus arrival times in Singapore\|all bus services in Singapore · ezbus" public src` → zero hits.
   - Every page-type title contains "bus timing" or "timing" per its pattern
     (covered mechanically by crawl-check).
4. Manual spot-check in a browser: homepage, one stop page, one route page,
   `/buses` — light + dark, mobile width. Board behaviour unchanged; FAQ
   collapsed by default.
5. Post-deploy (outside this repo): request re-indexing of the homepage in
   Google Search Console; watch the sitemap re-crawl pick up new titles over
   the following weeks. No sitemap resubmission needed — URLs are unchanged.

**Commit:** `Extend crawl-check with bus-timing keyword assertions`

---

## Out of scope (explicitly)

New landing pages (per-operator, "near me"), og-card image text changes,
keyword repetition beyond one natural use per phrase per page, any visible
weight added above the board, and any URL/sitemap/canonical change.

One caveat carried from the evaluation: the keyword list is the SEO
evaluation's assertion, not verified search-volume data. The "bus timing"
colloquialism is consistent with competitor naming (SG Bus Timing, Singabus
Bus Timing, BusSing SG Bus Timings) and is taken on trust.
