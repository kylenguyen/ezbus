# Pinned-stop fold — implementation plan (concept B: "pins that step aside")

Approved 23 Aug 2026, from the design proposal artifact:
https://claude.ai/code/artifact/af3e7d04-2da7-4bab-9b44-33252a5d0506

**Problem.** Pinned stops always render as full cards at the top of the board
([public/app.js](../public/app.js) `renderShells`). Two or three pins fill the first
screenful, so at a new location the stops 60 m away start below the fold.

**Fix.** Distance decides: when *every* pin is beyond walking range of the board's
origin, all pins fold into one row — `★ 2 pinned stops · 11 km away — Show`. Near a
pin, the board is pixel-identical to today. The server already returns `distanceM`
for every pinned stop when the request carries a coordinate
([src/index.ts](../src/index.ts) `/api/board`), so this is a client-only change.

Rules of the road for every task — read before touching anything: **AGENTS.md wins on
behaviour, style-guide.md wins on looks.** `public/origin.js` stays pure — no DOM,
storage, clock or `fetch` — and the module-contract test in
[src/origin.test.ts](../src/origin.test.ts) enforces it; `public/app.js` is the glue.
Every interpolation goes through the local `escape()`. User-facing copy is pinned
verbatim by tests. New tests append to the end of existing test files, never reorder.

Each task below is written to be executed by a separate agent with no other context
than this document and the repository.

---

## Shared contract (fixed — do not renegotiate mid-task)

| Thing | Value |
| --- | --- |
| Fold threshold | `PIN_FOLD_M = 1000` — fold when the *nearest* pin is ≥ this |
| Unfold threshold | `PIN_UNFOLD_M = 800` — unfold when *any* pin is < this (hysteresis) |
| Fold states | `'none'` (no pins) · `'expanded'` · `'folded'` |
| Row copy | `` `${n} pinned stop${n === 1 ? '' : 's'} · ${formatMetres(nearestM)} away` ``; action label `Show` / `Hide` |
| New CSS class / hook | `.pin-fold`, click target `data-fold` |
| New app.js state | `foldPrev` (last decision, feeds hysteresis) · `foldOpen` (user override, boolean) |
| Storage | **No new localStorage key.** Fold state is computed; `foldOpen` is in-memory only |
| Server | **No change** — `/api/board` already returns `distanceM` per pinned stop |

## Decisions taken (23 Aug 2026)

1. **All-or-nothing fold.** If any pin is within range, all pins render expanded. Two
   simultaneous pin representations on one board is complexity the mixed case does
   not earn.
2. **Unknown distance → expanded.** `located: false`, or a non-numeric `distanceM` on
   any pin, keeps today's behaviour. The fold only ever acts on evidence.
3. **`foldOpen` is session memory.** It resets on origin switch and on reload; a
   reload recomputes the fold from distance, which is the correct answer anyway. No
   settings, per AGENTS.md.
4. **The row stays when opened**, flipping to `Hide`, so the way back is where the
   way in was.
5. **Pinning a nearby stop while folded unfolds everything** (the new pin is
   < 800 m), for free, via the existing board reload in `togglePin`.

---

## T1 — The fold decision, pure (parallel-safe)

**Files:** `public/origin.js`, `src/origin.test.ts` (append). Touches nothing else —
the only task safe to run in a parallel worktree.

**Context for the agent:** origin.js holds every board decision as pure input/output
functions; `formatMetres` (already exported) handles the m/km rendering. The
module-contract test forbids `Date.now`, `document`, `localStorage`, `fetch(` in the
module source.

**Build:**

- `pinFold({ pinnedStops, located, previous })` → `'none' | 'expanded' | 'folded'`.
  Rules, in order: no pins → `'none'`; `!located` or any pin's `distanceM`
  non-numeric → `'expanded'`; nearest pin < `PIN_UNFOLD_M` → `'expanded'`; nearest
  ≥ `PIN_FOLD_M` → `'folded'`; in the 800–1000 m band → `previous` if it is
  `'expanded'` or `'folded'`, otherwise `'expanded'` — first sight of the band gets
  the benefit of the doubt.
- `foldRowCopy(count, nearestM, open)` → `{ label, action }` per the contract table.
- Export `PIN_FOLD_M`, `PIN_UNFOLD_M`.

**Verify:** `npm test` green. New cases must cover: no pins; unlocated; one unknown
distance among known; near and far first-load; both hysteresis directions across the
band; mixed near+far pins → expanded; copy singular/plural; copy at 11 km (km
formatting via `formatMetres`) and at 950 m; `open` flipping the action label.
Confirm the module-contract test still passes untouched.

**Commit:** `Add pinned-stop fold decision to origin.js`

## T2 — The fold row on the board (depends on T1)

**Files:** `public/app.js`, `public/styles.css`, new `src/pin-fold.test.ts`.

**Context for the agent:** `renderShells()` in app.js rebuilds card shells only when
`shellSignature` changes; the signature must now encode the fold, or toggling
repaints nothing. Pinned cards render inside `renderShells`; board click delegation
already handles `[data-pin]`; `switchOrigin` and `resetBoard` are where cross-origin
state must reset. Style guide: 4 px radius, 44 px touch floor, accent owns
interactive affordances, both colour schemes. Note the transparent-`--shadow`
comment in the dark block of styles.css before composing any `box-shadow`.

**Build:**

- Compute
  `const fold = pinFold({ pinnedStops: board.filter((s) => s.pinned), located, previous: foldPrev })`
  once per render; store the decision back to `foldPrev`. (`located` comes from the
  board response — keep it in module state next to `mock`.)
- When `fold === 'folded' && !foldOpen`: skip pinned cards in `renderShells` and
  render one `<button class="pin-fold" data-fold aria-expanded="false">` first, with
  copy from `foldRowCopy`. When `foldOpen`: render the row with `Hide` /
  `aria-expanded="true"` followed by the full pinned cards (today's markup,
  unchanged).
- Prefix `shellSignature` with the fold rendering state (e.g. `F|`, `O|`, `E|`).
- Click on `[data-fold]`: flip `foldOpen`, call `render()` — **no fetch**.
- Reset `foldOpen = false; foldPrev = null` in `switchOrigin` (and on the `MOVED_M`
  re-rank path if it does not pass through `switchOrigin` — verify).
- `styles.css`: `.pin-fold` styled per style-guide — dashed accent border per the
  approved mock, `--radius`, min-height ≥ 2.75rem, accent star, both schemes.
- `src/pin-fold.test.ts` (the board-head.test.ts pattern — source-level assertions,
  no DOM): app.js contains `data-fold` and `aria-expanded`; the fold row copy comes
  from `foldRowCopy` (no second hand-written copy in app.js); styles.css contains
  `.pin-fold`.

**Verify:** `npm test` green. Manual script — mock mode is automatic with no LTA key:
`npm run dev`, open the served port.

1. Fresh profile (clear site data). Enter via the address door: search
   `Ang Mo Kio`, choose an address. Pin the top two stops (★). Full cards at the
   top — unchanged behaviour.
2. Open the origin chip, search `Orchard Road`, choose it. **Expected:** one
   `.pin-fold` row (`2 pinned stops · … away — Show`), then only nearby cards; the
   first nearby card visible without scrolling at 360 px width (devtools device
   mode).
3. Tap `Show` → pinned full cards appear under the row, row reads `Hide`, the
   network tab shows **zero** new requests. Tap `Hide` → they fold again.
4. Switch back to the Ang Mo Kio address → pins expand automatically, no fold row.
5. While folded, pin a nearby Orchard stop → the board reloads and all pins expand
   (the new pin is < 800 m).
6. Repeat step 2 in dark mode (OS toggle); keyboard: Tab reaches the row, Enter
   toggles, focus ring visible.
7. Unpin everything → no fold row, the board is pure nearby (`fold === 'none'`).

**Commit:** `Fold far-away pinned stops into one board row`

## T3 — Refresh economy (depends on T2)

**Files:** `public/app.js`, extend `src/pin-fold.test.ts`.

**Context for the agent:** `refreshArrivals` in app.js refreshes visible cards *plus
all pins unconditionally*. A folded, closed pin has no card on screen; fetching its
arrivals every 30 s is spent LTA quota and radio time (AGENTS.md: cellular data is a
cost).

**Build:** in `refreshArrivals`, add pins to `wanted` only when they are rendered
(fold is `'none'` or `'expanded'`, or `foldOpen` is true). Leave the no-observer
fallback ("refresh the lot") alone — correctness beats economy there. `/api/board`
requests keep sending all pin codes always: the fold needs their distances.

**Verify:** `npm test` green (new source-level assertion: the pins loop in
`refreshArrivals` is guarded by the fold state). Manual, in mock mode: fold the board
as in T2 step 2, watch the network tab across two 30 s refreshes —
`/api/arrivals?stops=` omits the pinned codes; tap `Show` — the next refresh includes
them and the opened cards' timings are live, not stale.

**Commit:** `Skip hidden pinned stops in the arrivals refresh`

## T4 — End-to-end verification (no planned commit)

Run after T1–T3 are merged, in one sitting, from a clean checkout:

1. **Suite:** `npm test` — everything green, including the three new test surfaces.
2. **First-visit journey** (fresh profile, 360 px, mock mode): intro → address door →
   board → pin two stops → switch to a far address → fold row → Show/Hide → switch
   back → auto-expand. Every expectation from T2's script holds.
3. **GPS journey:** devtools Sensors → set location to Ang Mo Kio
   (1.3691, 103.8454), enter via the location door, pin a stop; change the sensor to
   Orchard (1.3048, 103.8318), reload → fold row appears from a real fix; sensor
   back → expands. Also confirm the pre-fix paint (cached coordinate) never flashes
   the wrong state.
4. **Hysteresis:** unit tests only — the 800–1000 m band is impractical to walk in a
   browser. Re-read the T1 cases and confirm they encode the band in both
   directions.
5. **Edge sweep:** 8 pins (the `MAX_STOPS` cap — the folded row must still say 8,
   and Show must show all 8); unpin the last pin while `foldOpen`; empty board gate;
   place mode with no GPS grant at all.
6. **Regression sweep:** coach hint, skeleton, gate paths, stop page and `/bus/:n`
   untouched (`git diff --stat` shows only the planned files); footer mock notice;
   light + dark at 360 px and 768 px; tap targets ≥ 44 px.
7. **Network economy:** one `/api/board` per load or origin switch; the fold toggle
   fires zero requests; folded pins absent from `/api/arrivals`.

Any defect: fix as a follow-up commit scoped to the task that owns the file, then
re-run this checklist from step 1.

## Execution order & merge policy

`T1 → T2 → T3 → T4`, one commit each. T1 is the only task safe to run in a parallel
worktree (it owns `origin.js` + `origin.test.ts` exclusively). T2 and T3 both edit
`app.js` and must run sequentially in one tree. If T1 ran in a worktree, rebase it
onto `main` before T2 starts; after any rebase or conflict resolution, `npm test`
plus the owning task's manual script must be re-run before the commit stands.
