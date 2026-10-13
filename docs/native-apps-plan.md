# ezbus native apps — implementation plan

## 1. Goal and scope

Build iOS and Android apps with native UI and no WebView. Replace the web client with the
same codebase: **Expo (React Native) + Expo Router + react-native-web**.

v1 covers the board (`/`), the stop page (`/stop/:code`) and the route page
(`/bus/:service`), at parity with today's web in behaviour and copy. The Express API is
reused unchanged.

Out of scope for v1:
- home-screen widgets and Live Activities;
- push notifications;
- background location;
- accounts and settings screens;
- the `/buses` directory on native;
- the stop page's nearby-stops list on native (it is server-rendered only today).

## 2. Context every task needs

Read AGENTS.md and style-guide.md before any task. Their rules apply to the new client
unchanged, unless this plan says otherwise. The product rule decides every UI question:
**a commuter gets to a departure time as fast as possible, one-handed, on cellular.**

### 2.1 Target layout

```
src/                 Express server (unchanged role)
shared/              origin.js, route-logic.js, stop-logic.js, vehicle-marks.js — pure, unit-tested
client/              Expo app (own package.json + lockfile)
  app/_layout.tsx            root stack, theme provider, fonts
  app/+html.tsx              web document shell (no ScrollViewStyleReset)
  app/index.tsx              board
  app/stop/[code].tsx        stop screen
  app/bus/[service].tsx      route screen
  board/                     board controller + board components
  stop/  route/              stop and route components
  components/                shared presentational pieces (card, ETA cell, skeleton, button)
  platform/                  storage, location, net, lifecycle, share, install (*.native.ts / *.web.ts)
  theme/tokens.ts            colour, type and spacing tokens
  test/                      jest-expo tests
e2e/maestro/         native E2E flows        e2e/web/   Playwright specs
```

### 2.2 The decision rule for the new glue

Every rule is decided in `shared/*.js`. React components, hooks and the platform layer
apply the decisions and **make none**. If a task finds it needs a new rule, the rule goes
into `shared/` as a pure exported function with `node:test` coverage in `src/*.test.ts`,
using the computed-specifier import:

```ts
await import(new URL('../shared/x.js', import.meta.url).href)
```

The existing exports that screens must call, rather than re-derive:

| Area | Functions (in `shared/`) |
| --- | --- |
| Boot and origin | `decideBoot`, `readOriginRecord`, `originCoord`, `boardParams`, `shouldRelocateOnFocus`, `isUsableCoord` |
| Intro and gate | `introVariant`, `dismissGate`, `gateState`, `refusalCopy`, `ADDRESS_DOOR_LABEL`, `gateMessageFor`, `noStopsMessage` |
| Chip, finder, destinations | `chipState`, `taglineFor`, `originsState`, `finderState`, `commitDecision`, `moveActive`, `placeFromRow`, `readRecents`, `rememberRecent`, `titleCase`, `SEARCH_DEBOUNCE_MS` |
| Cards | `minutesUntil`, `isIncoming`, `distanceLabel`, `formatMetres`, `formatDistance`, `VEHICLE`, `vehicleIcon`, `trail` |
| Hint and pin fold | `hintDecision`, `readHintRecord`, `dismissedHintRecord`, `HINT_COPY`, `HINT_DISMISS_LABEL`, `HINT_MAX_SHOWINGS`, `pinFold`, `foldRowCopy`, `PIN_FOLD_M`, `PIN_UNFOLD_M` |
| Stop | `parseStopPath`, `dayTypeFor`, `fmtHHMM`, `fmtFreq`, `serviceStatus`, `sharePayload` |
| Route | `parseServicePath`, `readAnchors`, `rememberAnchor`, `resolveAnchor`, `directionFor`, `translateAnchor`, `searchStops`, `windowFor`, `arrivalsParams`, `foldPlan`, `filterServiceEta`, `readPinList`, `isPinnedCode`, `togglePinList`, `installHintVisible`, `departureSummary`, `inferBusSegment`, `busMarkPlacement`, `markTarget`, `haversineM`, `GUARD_DISTANCE_M`, `ANCHOR_LRU_MAX` |

**Copy.** All copy produced by these functions is used verbatim. The static copy that lives
only in HTML is lifted verbatim into `client/` constants:
- the intro heading, the example card caption `Example`, and the door labels and details
  (`public/index.html`);
- stop and route headings and labels (`public/stop.html`, `public/route.html`).

### 2.3 Storage contract (unchanged names and JSON shapes)

`bus-board.pins.v1`, `bus-board.loc.v1`, `bus-board.origin.v1`, `bus-board.recent.v1`,
`bus-board.hint.v1`, `bus-route.anchor.v1`. AGENTS.md "No login…" describes each one's owner
and writers. In particular:
- `loc.v1` is the sole owner of the fix.
- `origin.v1` is written only when a coordinate is in hand.
- The route toggle's translated stop is never persisted.

Every read and write sits inside a `try`. Corrupt or blocked storage reads as a first visit.

### 2.4 Platform layer contract (`client/platform/`, one signature for both files)

| Module | Exports | Web | Native |
| --- | --- | --- | --- |
| `storage` | `readRaw(key): string\|null`, `write(key, value): void`, `clearAll(): void` (dev only) | `localStorage` | react-native-mmkv (synchronous) |
| `location` | `getPosition(): Promise<{lat,lon}>` (rejects with `{code:1\|2\|3}`), `isLocationUsable(): boolean`, `openLocationSettings(): void` | `navigator.geolocation.getCurrentPosition`, called synchronously inside the executor; `isLocationUsable = isSecureContext && !!navigator.geolocation`; settings is a no-op | expo-location; `isLocationUsable = true`; `Linking.openSettings()` |
| `net` | `apiUrl(path): string` | `path` (same origin) | `https://ezbus.sg` + `path` from `app.config.ts` `extra.apiBase` (the only config read) |
| `lifecycle` | `onForeground(cb)`, `onBackground(cb)`, `isForeground()` | `visibilitychange` | `AppState` |
| `share` | `shareLink({title,url}): Promise<'shared'\|'copied'\|'failed'>` | `navigator.share`, then clipboard | RN `Share` |
| `install` | `useInstallPrompt(): {hasPrompt, prompt()}` | `beforeinstallprompt` | always `{hasPrompt:false}` |

**Web: the iOS Safari activation rule still binds.** Nothing is awaited between a press and
`getCurrentPosition`. Press handlers that start location call `getPosition()` first,
synchronously, and do state updates after.

### 2.5 Fixtures and commands

- **Server:** `npm run build && npm test`. Run against the stub with
  `node tools/stub-datamall.mjs` (port 9099) and then:
  `LTA_ACCOUNT_KEY=stub-key LTA_BASE_URL=http://localhost:9099 ARRIVAL_TTL_MS=1 node dist/index.js`
- **Stub data:**
  - 250 stops, codes `10001`–`10250`, at `lat 1.3521 + (i%25)*0.001`,
    `lon 103.8198 + floor(i/25)*0.001`.
  - Origin `1.3521,103.8198` is nearest stop `10001`.
  - Services `10` (stops 0–124), `2` (50–149), `857` (100–159), and loop `359` (200–239).
  - Modes are switched with `GET :9099/_mode?set=ok|empty|429|500|slow[&code=…]`.
  - Counters are read from `GET :9099/_stats`.
- **Finder fixtures:**
  - `310155`: one address row.
  - `43179`: one stop row. It is a real code, so in stub mode it 404s on `/api/stop`; use
    `10001` for stop-screen checks.
  - `toa payoh`: up to 10 rows.
  - `t`: no request is sent.
- **Geometry:** 0.001° of latitude is about 111 m. Moved > 200 m: `1.3545,103.8198`. Not
  moved: `1.3530,103.8198`. Pin fold with `10001` pinned:
  - `1.3621,103.8198`: about 1,110 m, folded;
  - `1.3600,103.8198`: about 880 m, the band, holds its previous state;
  - `1.3585,103.8198`: about 710 m, expanded.
- **Device location:**
  - iOS simulator: `xcrun simctl location booted set <lat>,<lon>`.
  - Android emulator: `adb emu geo fix <lon> <lat>`.
  - Web: Playwright `context.setGeolocation`.
- **Phone-width targets:**
  - Web at 375×667 and 320×568.
  - The smallest current iPhone simulator, and an Android emulator at 360×640 dp.
- **Client:** `cd client && npx tsc --noEmit && npx jest`. Dev builds run with
  `npx expo run:ios` / `npx expo run:android`; web with `npx expo start --web`, proxied to
  `:8080` (see T3).

## 3. Task graph, execution and git protocol

```
T1 ─┬─ T2 ─────────────┐
    └─ T3 ─┬─ T4 ─ T6 ─┼─ T7 ─┬─ T8  ─┐
           │           │      ├─ T9  ─┤
           ├─ T5 ──────┘      └─ T10 ─┤
           │           T6,T5 ─ T11 ───┤
           │           T6,T5 ─ T12 ───┼─ T14 (E2E harness) ─┬─ T15 (native release builds)
           └─ T13 (deep links) ───────┘                     └─ T16 (web cut-over)
```

| Wave | Tasks (parallel within a wave) |
| --- | --- |
| 1 | T1 |
| 2 | T2, T3 |
| 3 | T4, T5, T13 |
| 4 | T6 |
| 5 | T7, T11, T12 |
| 6 | T8, T9, T10 |
| 7 | T14 |
| 8 | T15, T16 |

**Git protocol.**
1. Branch per task off the latest `main`: `native/T<n>-<slug>`. Start only after every
   dependency is merged.
2. **One commit per task**: squash before merge. The subject is the task's Commit line,
   followed by the attribution trailer the session requires.
3. **Before merging**, rebase onto the current `main`. On conflict:
   - Resolve it, keeping both sides' intent.
   - **Never hand-merge `client/package-lock.json`.** Take `main`'s version, re-run
     `npm install` in `client/`, and re-add this task's dependencies.
   - Re-run **this task's full Verify** plus the regression gate: `npm run build && npm test`
     at the root, and `npx tsc --noEmit && npx jest` in `client/`.
   - Amend the single commit.
4. **Parallel-safe file ownership:**
   - T7 creates the board's slot points (`board/slots.ts`). T8, T9 and T10 each add their
     own files under `board/`, and edit `app/index.tsx` only at their named slot line.
   - T11 and T12 own `stop/` and `route/` respectively.
   - Only T1, T2, T13 and T16 edit `src/`.
   - Only T3 and T14 edit `.github/workflows/bus-arrival.yml`.
5. A task whose Verify fails is not merged. A **Gate** failure (marked ⛔) stops dependent
   tasks and goes to the maintainer.

---

## 4. Tasks

### T1 — Move the pure modules to `shared/`

- **Depends on:** none.
- **Context:** `public/{origin,route-logic,stop-logic,vehicle-marks}.js` are pure ES modules
  that the vanilla web loads at `/origin.js` etc. The tests import them with a computed
  specifier from `src/origin.test.ts`, `src/stop-logic.test.ts` and
  `src/route-logic.test.ts`. The Dockerfile's runtime stage does `COPY public ./public`.
- **Do:**
  - `git mv` the four files to `shared/`.
  - In `src/index.ts`, add a second `express.static` for `shared/`, mounted at `/` with the
    same `setHeaders` (`STATIC_CACHE_CONTROL`).
  - Repoint the three computed specifiers to `../shared/…`, keeping them computed.
  - Add `COPY shared ./shared` to the runtime stage.
  - Update path mentions in AGENTS.md and style-guide.md.
- **Outcome:** the vanilla web behaves identically, with the modules in a location the app
  can import.
- **Verify:**
  1. `npm run build` is clean.
  2. `npm test` is green, with the same pass count as `main` before the change (record both
     numbers).
  3. `git diff -M --stat main` lists the four files as `R100`.
  4. For each module, `curl -s localhost:8080/origin.js | diff - shared/origin.js` is empty,
     and `curl -sI` shows `200` and `Cache-Control: no-cache`.
  5. Against the stub, at 375 px in Chrome DevTools, the board loads from
     `1.3521,103.8198`, `/stop/10001` renders arrivals, and `/bus/10?stop=10001` renders the
     window. There are no console errors.
  6. `node tools/crawl-check.mjs` (per its header) passes.
  7. `docker build -t ezbus:t1 .` succeeds. `docker run` serves `/healthz` → `"ok":true`.
- **Commit:** `Move pure decision modules to shared/`

### T2 — App-surface copy and the location-error mapping (pure)

- **Depends on:** T1.
- **Context:** `refusalCopy(err)` returns browser-specific copy for `code 1` ("Allow it in
  your browser settings"). Native location reports failure differently. Permission status
  `denied` is not an error, and position errors carry string codes. The UI must keep
  reading `{code: 1|2|3}`.
- **Do:**
  - `refusalCopy(err, { surface = 'web' } = {})`. `'web'` returns exactly today's strings.
    `'app'` returns `Location is off for ezbus. Allow it in Settings.` for code 1, and the
    same strings as web for 2 and 3.
  - A new export, `toLocationError({ permission, error, timedOut })` → `{code}`:
    - `permission === 'denied'` → 1;
    - `timedOut` → 3;
    - anything else → 2.
  - Look up the exact error codes of the installed expo-location version and list them in a
    comment. Add tests in `src/origin.test.ts`.
- **Outcome:** native refusal handling is decided by pure, tested code.
- **Verify:**
  1. `npm test` is green, and every pre-existing `refusalCopy` assertion is unedited
     (`git diff` shows additions only in the test file).
  2. New tests cover:
     - each `surface` × code;
     - an absent options argument;
     - `toLocationError` for denied, timed out, services disabled, an unknown error and
       `undefined` input.
  3. `grep -nE "window|document|navigator|localStorage|Date\.now" shared/origin.js` shows no
     new non-comment hits.
- **Commit:** `Add app-surface refusal copy and location error mapping`

### T3 — Expo client scaffold, test runner, web shell and CI

- **Depends on:** T1.
- **Context:** this is a new `client/` package, kept separate from the server so the server
  image stays Express-only.
  - Metro must resolve `../shared` (`watchFolders`, plus `resolver.nodeModulesPaths`
    pointing at `client/node_modules`).
  - Types come type-only from `../src/types.ts`.
  - Native modules (MMKV) rule out Expo Go, so use dev builds.
- **Do:**
  - `client/` with Expo (current SDK), Expo Router, TypeScript `strict` +
    `noUncheckedIndexedAccess`, `allowJs` for `shared/`, and jest-expo with
    `@testing-library/react-native`.
  - `app.config.ts` with:
    - placeholder bundle ids `sg.ezbus.app` (iOS and Android), changeable in T15;
    - `extra.apiBase`;
    - `userInterfaceStyle: 'automatic'`;
    - portrait orientation.
  - Route files for `/`, `/stop/[code]` and `/bus/[service]`. Each renders the parsed param
    and one call to `fetch(apiUrl('/api/board?…'))` (a temporary `net` inline; T5 replaces
    it).
  - `app/+html.tsx`. It has the viewport meta with `viewport-fit=cover`, the two
    `theme-color` metas, and **no `ScrollViewStyleReset`**, so the document scrolls.
  - Expo web dev-server proxy for `/api` → `:8080`.
  - `tools/measure-web-payload.mjs`. It loads a URL in headless Chrome at 375×667 with
    "Slow 4G" throttling, then reports:
    - transferred JS and CSS bytes (gzip);
    - time to first render of an element with `data-testid="eta"` (or the vanilla
      `.eta-value`).
    It reports the median of 5 cold loads.
  - CI: a `client` job running `npm ci`, `npx tsc --noEmit`, `npx jest` and
    `npx expo export -p web`.
- **Outcome:** an empty app runs on iOS, Android and web. The test runner works, and the
  payload and SEO feasibility are measured.
- **Verify:**
  1. In `client/`: `npx tsc --noEmit` is clean, `npx jest` passes one smoke test (it renders
     the board route and finds the text `ezbus`), and `npx expo export -p web` writes
     `dist/`.
  2. `npx expo run:ios` and `npx expo run:android` launch, and the board route shows a
     number of stops from the stub server. On Android emulators the server is
     `10.0.2.2:8080`; this is set through `extra.apiBase` in a dev profile.
  3. Web: `npx expo start --web`. `/stop/10001` and `/bus/10` render their params from a
     deep URL loaded directly (no client-side navigation).
  4. ⛔ **Gate — payload.** Run `node tools/measure-web-payload.mjs` on the vanilla board
     (`:8080/`) and on the exported scaffold, served statically with `/api` proxied. Put
     both results in the PR description. The maintainer sets the web budget from them, and
     T16 enforces it.
  5. ⛔ **Gate — SEO coexistence.**
     - Copy `dist/index.html` and, by hand, insert a 3,000-px-tall
       `<section id="rt-static">` and a JSON-LD script **after** the React root.
     - Serve it and load it in headless Chrome at 375 px.
     - After hydration, `document.getElementById('rt-static')` still exists.
     - The page scrolls as one document to the section's end.
     - `document.documentElement.scrollWidth === innerWidth`.
  6. CI: the new `client` job is green on the PR.
- **Commit:** `Scaffold Expo client with router, tests, web shell and CI`

### T4 — Theme tokens, fonts and breakpoints

- **Depends on:** T3.
- **Context:** style-guide.md is the specification.
  - Tokens are the two `:root` blocks at the top of `public/styles.css`: `--bg`,
    `--surface`, `--surface-2`, `--border`, `--text`, `--muted`, `--accent`, `--on-accent`,
    `--seats`, `--standing` and `--limited`, plus shadow and radius.
  - Archivo Narrow 700 is only for the service number, the stop-page code and the wordmark.
    Everything else uses the system face.
  - Native needs a TTF/OTF Latin subset generated from the same OFL source (the woff2 cannot
    load).
  - Breakpoints:
    - width < 344 drops the third arrival column;
    - height < 620 drops the intro example;
    - width ≥ 640 gives the multi-column board.
- **Do:**
  - `theme/tokens.ts` with `light` and `dark` objects, and `useTheme()` selecting by
    `useColorScheme()`.
  - `theme/layout.ts`: `useBreakpoints()` returns `{ narrow, short, wide }` from
    `useWindowDimensions`.
  - The font asset, loaded in `_layout.tsx` with the splash held until it loads.
  - Status bar style and the splash background set from `bg` for each scheme.
  - `src/tokens.test.ts`: a pure `node:test`. It parses both `:root` blocks in
    `public/styles.css` and asserts every colour equals `client/theme/tokens.ts`. It reads
    `tokens.ts` as text with a regex, so there is no TS import.
- **Outcome:** one token source the components consume, provably in step with the web.
- **Verify:**
  1. `npm test` (with the new tokens test) and the client `tsc`/`jest` are green.
  2. Change one hex in `tokens.ts` and the tokens test fails. Revert it.
  3. A jest test of `useBreakpoints` with mocked dimensions:
     - 343×700 → `narrow`;
     - 375×619 → `short`;
     - 640×900 → `wide`;
     - 375×667 → none.
  4. Run the dev builds in both schemes, toggling simulator appearance. Screenshot a temporary
     swatch screen of every token. `muted` on `surface` and on `bg`, and each crowding colour
     on `surface`, measure WCAG AA (≥ 4.5:1 for text) with a contrast checker, in both
     schemes. Delete the swatch screen before the commit.
  5. On a test label, the display font renders `966B` on iOS, Android and web.
- **Commit:** `Add Void Deck tokens, display font and breakpoints to the client`

### T5 — Platform layer and typed API client

- **Depends on:** T2, T3.
- **Context:** this implements §2.4 exactly. The API shapes are in `src/types.ts`:
  - `BoardResponse` from `/api/board`;
  - `ArrivalsResponse` from `/api/arrivals`;
  - `PlacesResponse` from `/api/places`;
  - `StopResponse` from `/api/stop/:code`, which returns `400 {error:'bad_code'}` or
    `404 {error:'unknown_stop'}`;
  - `RouteResponse` from `/api/route/:service`.

  There is no CORS on the server. Native clients do not need it, and the web is same-origin.
- **Do:**
  - `platform/{storage,location,net,lifecycle,share,install}.{native,web}.ts`.
    - Native location: `requestForegroundPermissionsAsync` → `getCurrentPositionAsync`, with
      the same timeout as web `getPosition()` in `public/app.js`. It rejects with
      `toLocationError(...)`.
  - `api/client.ts`: `getBoard(params)`, `getArrivals(codes)`, `getPlaces(q)`,
    `getStop(code)` and `getRoute(service)`. Each is typed and rejects on non-2xx with
    `{status, error}`.
  - jest tests for `api/client.ts` (mocked `fetch`) and for the storage wrapper (a throwing
    backend reads `null`, and the write swallows the error).
- **Outcome:** screens get every side effect through one typed seam.
- **Verify:**
  1. Client `tsc` and `jest` are green. The tests cover:
     - URL building for all five calls, including `encodeURIComponent` on `q`, `code` and
       `service`;
     - non-2xx rejection;
     - storage throwing on read and on write.
  2. A temporary dev-only `/_debug` screen exercises each module on the iOS simulator,
     Android emulator and web. Delete it before the commit.
     - Storage: write `bus-board.loc.v1`, force-quit, relaunch, and the value persists.
       Write a corrupt value and `readRaw` returns it while the parsers return defaults.
     - Location:
       - grant → coordinate equals the simulator location;
       - deny → `{code:1}`;
       - services off (Android) or no location (simulator "None") → `{code:2}`;
       - no answer within the timeout → `{code:3}`.
     - Lifecycle: background then foreground logs both callbacks once each.
     - Share: native opens the share sheet; on web, desktop Chrome copies to the clipboard
       and reports `'copied'`.
  3. ⛔ **Gate — iOS Safari activation.**
     - Serve the web build over HTTPS on a LAN (a dev certificate, or a tunnel).
     - On a **real iPhone** in Safari, tap a `Pressable` whose `onPress` calls
       `getPosition()` first. The native prompt appears on the first tap.
  4. ⛔ **Gate — production reachability.**
     - On a physical device on cellular, with `apiBase` at `https://ezbus.sg`, `getBoard`
       returns `200` JSON.
     - Response headers show no Cloudflare challenge (no `cf-mitigated`, and not
       `text/html`).
  5. ⛔ **Gate — synchronous storage.** `readRaw` returns synchronously in a release-mode
     build on both platforms. Log `typeof` the return value: it is not a Promise.
- **Commit:** `Add platform adapters and typed API client`

### T6 — Board presentational components

- **Depends on:** T4.
- **Context:** card anatomy is in style-guide.md "Card anatomy". The markup to match is
  `renderShells`, `renderServices`, `renderEta`, `renderTags` and `foldRow` in
  `public/app.js`.
  - Name first, with a chevron.
  - The pin is absolutely positioned on the name line, top right.
  - One meta line: road · distance chip · code last. The code is also in the accessible
    name.
  - Crowding shows for the **next** bus only.
  - `Monitored: false` gets `*`.
  - The ETA column uses the system face and `tabular-nums`. The service number uses the
    display face.
  - Vehicle tags come from `vehicleIcon(...)`, rendered with `SvgXml`. When `isIncoming`,
    the trails animate using Reanimated. Under reduce-motion they hold still at full ink.
  - Skeleton: two bars in the head, filled with `border`, pulsing.
  - Nothing under 11 px. Targets ≥ 44 pt / 48 dp.
- **Do:**
  - `components/BoardCard.tsx`, `EtaCell.tsx`, `ServiceRow.tsx`, `VehicleTag.tsx`,
    `SkeletonCard.tsx`, `FoldRow.tsx` and `PinButton.tsx`.
  - Pure props in, callbacks out. No fetching and no storage.
  - The stop-name press is `onOpenStop(code)`; the service-number press is
    `onOpenRoute(serviceNo, code)`.
  - A dev-only `/_gallery` route with fixture `BoardStop` objects:
    - arriving in 0, 1–3 and 10+ minutes;
    - monitored and scheduled;
    - SEA/SDA/LSD;
    - `services: []`;
    - `services: null`;
    - pinned;
    - an 8-character road name.

    It is guarded by `__DEV__`.
  - jest render tests.
- **Outcome:** board cards render pixel-faithfully from data, on every platform.
- **Verify:**
  1. jest checks, per fixture:
     - minutes text equals `minutesUntil` for the injected `now`;
     - `*` appears only when `monitored === false`;
     - exactly one crowding pill per service, on the first bus;
     - `services: []` shows the "nothing running" text and `null` the failure text, both as
       in `public/app.js`;
     - the accessible label contains the stop code.
  2. Look at `/_gallery` side by side with the vanilla board in the same stub state, at 375 px
     web, on the iOS simulator and on the Android emulator, in both schemes. Name, meta,
     columns, pill and the pinned 3 px accent bar match. Record screenshots in the PR.
  3. At width 343 the third column is hidden. At 320 px web,
     `scrollWidth === innerWidth`.
  4. With reduce-motion on (iOS Accessibility → Motion; Android "Remove animations"), the
     skeleton does not pulse and incoming trails are drawn static.
  5. Measure with the platform inspector: the pin and the name press targets are at least
     44 pt and 48 dp.
- **Commit:** `Add board card, ETA, vehicle tag and skeleton components`

### T7 — Board controller: boot, load, refresh, pins, gate and skeleton

- **Depends on:** T5, T6.
- **Context:** this ports the state machine in `public/app.js` faithfully. The functions are
  `boot`, `decideBoot` usage, `loadBoard`, `refreshArrivals`, `paintBodies`, `busy`,
  `gate`, `hideGate`, `clearHatch`, `showSkeleton`, `clearSkeleton`, `rememberLoc`,
  `locate`, `onLocationRefused` and `togglePin`. These orderings are load-bearing:
  - `busy()` calls `gate()` first, then shows the skeleton.
  - `gate()` cancels the 3 s escape hatch and clears the skeletons.
  - The hatch arms only for waits on a position.
  - `showSkeleton` tests whether real cards are rendered, not whether the board array is
    empty.
  - A pin toggled mid-load coalesces into `pendingLoad`. The coalesced call resolves
    `undefined`, and only a real failure resolves `false`.
  - The board coordinate always comes from `originCoord(origin, lastLoc)`.
  - Arrivals refresh every 30 s, for **visible cards only**, with a 10 s local re-render.
    Both pause in the background.
  - On foreground, `shouldRelocateOnFocus` decides whether to re-locate. The 200 m re-rank
    uses `loc.v1` only.
- **Do:**
  - `board/useBoardController.ts`: a reducer plus effects that hold the state above. It
    calls only `shared/`, `platform/` and `api/`.
  - `app/index.tsx` renders the masthead, the gate, a `FlatList` of `BoardCard`s with
    `onViewableItemsChanged`, and pull-to-refresh calling `refreshArrivals`.
  - A light haptic on pin toggle (expo-haptics).
  - `board/slots.ts` exposes the named insertion points for T8 (`IntroSlot`), T9
    (`ChipSlot`, `FinderSlot`) and T10 (`HintSlot`, `FoldSlot`). Each renders `null` until
    filled.
  - For this task, boot with a stored origin only. Seed storage by hand to test.
  - jest tests with fake timers and a mocked API.
- **Outcome:** a returning visitor's board works end to end on all platforms.
- **Verify:**
  1. jest:
     - busy → gate ordering: after `busy()` the gate is hidden and skeletons show; after
       `gate()` the hatch timer is cleared and no skeleton is rendered;
     - the hatch arms for a position wait and not for a board wait;
     - a pin toggled during an in-flight load yields one follow-up load whose `pinned`
       param includes the pin, and the first call resolves `undefined`;
     - a failed load resolves `false` and keeps the previous board array;
     - 30 s refresh requests only visible codes; nothing fires while backgrounded;
     - re-locate on foreground follows `shouldRelocateOnFocus` for 4 min 59 s versus 5 min.
  2. Manual, on iOS, Android and web 375 px, against the stub. Seed `origin.v1 {mode:'gps'}`
     and `loc.v1` at `1.3521,103.8198` with `at` = now.
     - The board paints `10001` first before any fix completes. In airplane mode the cached
       board shape still paints.
     - Pin `10002`: it moves to the top. Relaunch and it is still pinned.
     - Move the simulated location to `1.3530,…`, then foreground: no re-rank. Move to
       `1.3545,…`: re-ranks.
     - `_mode?set=500&code=10002`: only that card shows the failure state. `_mode?set=empty`:
       cards read as nothing running.
  3. `_stats` with `ARRIVAL_TTL_MS=1`:
     - foreground idle for 120 s → 4 arrivals requests (±1), each carrying only on-screen
       codes;
     - backgrounded for 120 s → 0.
  4. Pull-to-refresh triggers exactly one arrivals request.
- **Commit:** `Add board controller with refresh, pins, gate and skeleton`

### T8 — Entry choice dialog, gate doors and the location flow

- **Depends on:** T7.
- **Context:** this is the first-visit journey in AGENTS.md "What this is" and
  `docs/first-run-journey.md`.
  - The dialog contains, in order: an accent band with the heading, one real `BoardCard`
    captioned `Example`, the question, and two **equal** door cards (glyph, label, one line
    of detail). It is not a primary button and a ghost.
  - The example is dropped when `short` (height < 620).
  - The variant comes from `introVariant({isSecureContext, hasGeolocation})`, fed by
    `isLocationUsable()`. When unusable, the location door is omitted.
  - Dismissing it lands on the gate, built from `dismissGate(variant)` and `gateState`, and
    stores nothing:
    - native: a backdrop tap and Android back;
    - web: a backdrop tap and Escape.
  - Location door: `startWithLocation` calls `getPosition()` **first**, then closes the
    dialog and shows `busy`. On success it writes `loc.v1`, then `origin.v1 {mode:'gps'}`.
  - On refusal it shows `refusalCopy(err, {surface})`, where `surface` is `'app'` on native,
    with both doors. Native code 1 adds an "Open Settings" action through
    `openLocationSettings`.
  - The address door opens the finder (T9's `FinderSlot`). Until T9 merges, it opens a stub
    panel.
  - Native: `NSLocationWhenInUseUsageDescription` is the intro's own sentence. Android
    declares `ACCESS_COARSE_LOCATION` and `ACCESS_FINE_LOCATION`.
- **Do:** `board/IntroDialog.tsx` (RN `Modal`, with focus moved into the dialog), the gate
  door wiring, `startWithLocation` in the controller, and permission strings in
  `app.config.ts`. Fill `IntroSlot`.
- **Outcome:** a stranger gets from first launch to a board through the location door, and
  every refusal path explains itself.
- **Verify** (fresh install or cleared storage each run, on iOS, Android and web 375 px):
  1. First launch shows the dialog with the band, the `Example` card and two equal doors.
     There is no permission prompt before a door is tapped.
  2. Location door → grant: the board ranks from the simulated location. Relaunch: no
     dialog, and no prompt.
  3. Location door → deny: the gate shows the code 1 copy (app or web variant) and both
     doors. On native, "Open Settings" opens the app's settings page.
  4. With no location (simulator "None", Android location off), the gate shows code 2 copy.
     With no answer, the hatch "Enter an address" appears after 3 s, and code 3 copy shows
     on timeout.
  5. Dismiss by backdrop, by Android back and by Escape on web: each gives the gate
     sentence `Nothing to show yet — choose how to start.` and both doors. Storage is still
     empty (inspect it). Relaunch and the dialog is back.
  6. At 320×568 web and the smallest simulator in landscape-height terms (height < 620):
     the example is gone and both doors are fully visible without scrolling.
  7. On web over plain http on a LAN IP, there is no location door, and the gate's single
     door is `Enter an address`.
  8. Real iPhone Safari over HTTPS: the location door prompts on the first tap.
  9. Screen reader: the dialog's heading is announced first, and both doors are reachable
     and announced with label and detail.
- **Commit:** `Add first-visit entry choice, gate doors and location flow`

### T9 — Chip, destinations list, address finder and origin switching

- **Depends on:** T7.
- **Context:** the finder rules are in AGENTS.md Gotchas, and the functions are
  `openSearch`, `closeSearch`, `renderOrigins`, `applyFinder`, `runSearch`, `startSearch`,
  `commitSearch`, `choosePlace`, `switchOrigin` and `rememberPlace` in `public/app.js`.
  - The chip shows `chipState(origin)`, and its caret opens the destinations panel:
    - the location row, per `originsState`, omitted when unusable;
    - the current row marked selected, with the re-locate action as a **separate** control
      (no ✓);
    - recents (`readRecents`, up to 5);
    - the search box.
    Focus lands on the list, not in the box.
  - Typing: debounce `SEARCH_DEBOUNCE_MS`; the newest request wins; under 2 characters
    sends nothing.
    - Rows render through `finderState`.
    - `searchRows` and the rendered list come from **one** state object set in one update,
      because commit is by index.
    - Enter or submit uses `commitDecision`: a full 6-digit postal code or a 5-digit stop
      code commits without a tap. Arrow keys on web use `moveActive`.
  - Choosing a row: `placeFromRow` → `switchOrigin`, which writes `origin.v1 {mode:'place',…}`
    and `rememberRecent` → `recent.v1`, then loads. If the load returns `false`, it rolls
    back both the origin record and the board.
  - Choosing an address pins nothing.
- **Do:** `board/Chip.tsx`, `board/DestinationsPanel.tsx`, `board/Finder.tsx`, and the
  controller's `switchOrigin`, `choosePlace` and search state. Fill `ChipSlot` and
  `FinderSlot`, and wire T8's address door to open the panel with focus in the box.
- **Outcome:** the address door, recents and switching between origins work everywhere.
- **Verify:**
  1. jest:
     - a slow response for `toa` arriving after `toa payoh` is discarded;
     - rows and list stay index-aligned across rapid typing (commit index 2 always equals
       the third rendered row's label);
     - a failed `switchOrigin` restores the previous `origin.v1` and board.
  2. Manual, on iOS, Android and web 375 px:
     - `310155` + submit commits without a tap, and the chip shows the short label.
     - `10001` + submit commits the stop.
     - `toa payoh` lists up to 10 rows, and tapping the 3rd commits that exact address.
     - `t` makes no network request (check `_stats` and the devtools network panel).
  3. Commit six different addresses. Recents shows five, most recent first, and the oldest
     is gone. Relaunch, and they persist.
  4. Open the panel from the chip. The first board card stays visible, focus is on the list
     (no keyboard raised on native), and the current row is selected with a separate
     re-locate control.
  5. Stop the server, then choose a recent: the chip and board revert to the previous origin,
     with the failure copy shown.
  6. Pins are unchanged after any origin switch (inspect `pins.v1`).
  7. Web keyboard: arrow keys move the highlight, and Enter takes the highlighted row over
     the typed text.
- **Commit:** `Add origin chip, destinations panel and address finder`

### T10 — Navigation hint and pin fold

- **Depends on:** T7.
- **Context:**
  - The hint is decided by `hintDecision({raw, boardHasCards})`.
    - It shows `HINT_COPY` and a `HINT_DISMISS_LABEL` button above the board.
    - Each showing increments `hint.v1` up to `HINT_MAX_SHOWINGS`.
    - "Got it" writes `dismissedHintRecord()`.
    - It never shows on the gate or an empty board.
  - The pin fold is decided by `pinFold({pinnedStops, located, previous})`, with the last
    answer kept for hysteresis, and `foldRowCopy`. The folded row shows/hides the pinned
    cards.
- **Do:** `board/Hint.tsx` and the fold state in the controller. Fill `HintSlot` and
  `FoldSlot`.
- **Outcome:** the board teaches its tappable bus number and folds faraway pins exactly as
  on the web.
- **Verify:**
  1. jest:
     - the hint shows across N launches and not on launch `HINT_MAX_SHOWINGS + 1`;
     - "Got it" on the first showing retires it;
     - no showing is counted when the board has no cards.
  2. Pin `10001` and set the location in turn to the three fold coordinates in §2.5. The
     result is folded, then folded (the band holds), then expanded. Reverse the order:
     expanded, expanded, folded.
  3. The folded row reads `1 pinned stop · 1.1 km away` (per `formatMetres`) with `Show`.
     Tap it: the cards show and the label becomes `Hide`.
  4. On the gate and on an empty board, there is no hint and `hint.v1` is unchanged.
- **Commit:** `Add navigation hint and pinned-stop fold`

### T11 — Stop screen

- **Depends on:** T5, T6.
- **Context:** the reference is `public/stop.js` and `public/stop.html`, and the plan of
  record is `docs/stop-page-plan.md`.
  - The plate leads with the code at pole size (display face), then the name and road.
  - Live arrivals come from one `getArrivals([code])` call every 30 s, paused in the
    background.
  - The schedule comes from `getStop(code)` with `serviceStatus`, `dayTypeFor`, `fmtHHMM`
    and `fmtFreq`.
  - The opposite-stop chip shows only when `opposite` is non-null.
  - Share is `sharePayload(stop, origin)`, where `origin` is `https://ezbus.sg` on native and
    `location.origin` on web.
  - The pin uses `pins.v1`, the same rows as the board. A distance shows only from a
    `loc.v1` fix under 12 h old; the stop screen never prompts for location.
  - Errors: `bad_code` and `unknown_stop` each have their own state, as in `stop.js`.
  - The service number links to `/bus/<no>?stop=<code>`.
  - On native, the nearby-stops list is omitted.
- **Do:** `app/stop/[code].tsx` and `stop/*` components, then wire the board's
  `onOpenStop`.
- **Outcome:** the stop page is at parity on all platforms, reached from the board or a deep
  URL.
- **Verify** (against the stub, on iOS, Android and web 375 px):
  1. Board → tap `10001`'s name. The stop screen shows code `10001`, its arrivals and its
     schedule. Back returns to the board at the same scroll position, with no new
     `/api/board` request.
  2. Web direct load of `/stop/10001`. `/stop/99999` shows the unknown-stop state and
     `/stop/abc` the bad-code state.
  3. Set the device date to a weekday, a Saturday and a Sunday. The service status and first
     and last times equal the vanilla `/stop/10001` at the same date.
  4. Share: native sheet text contains `https://ezbus.sg/stop/10001`. Web copies the same
     URL with the local origin.
  5. Pin here, go back, and the board shows it pinned. Unpin on the board, reopen, and it is
     unpinned.
  6. `_stats`: one single-code arrivals call per 30 s in the foreground, and 0 in the
     background.
  7. With a `loc.v1` older than 12 h, no distance shows and no prompt appears.
- **Commit:** `Add stop screen`

### T12 — Route screen

- **Depends on:** T5, T6.
- **Context:** the reference is `public/route.js`, with all rules in `shared/route-logic.js`.
  - The anchor comes from `resolveAnchor({serviceNo, queryStop, anchorsRaw, originRaw,
    locRaw, directions})`, in this order: `?stop=`, the remembered anchor, the nearest stop.
  - `rememberAnchor` writes `bus-route.anchor.v1`, an LRU of `ANCHOR_LRU_MAX`. It is written
    only on a real anchor: `?stop=`, a picker choice, a nearest inference, or the guard's
    "use it anyway".
  - The distance guard applies beyond `GUARD_DISTANCE_M`.
  - The direction toggle uses `translateAnchor`, and the result is displayed but **not
    persisted**.
  - A remembered code the route no longer serves shows its notice once, then drops.
  - The approach window comes from `windowFor`, with fold from `foldPlan`. Arrivals come
    from `arrivalsParams`, as one call of at most 5 codes per 30 s. The bus mark uses
    `busMarkPlacement` / `markTarget` / `inferBusSegment`.
  - The picker's "next from the first stop" line is one 1-code call per 30 s.
  - The full stop list per direction is rendered from `getRoute`.
  - A loop service has one direction.
  - Install offer: `installHintVisible({hasPrompt,…})`, with `hasPrompt` from
    `useInstallPrompt`, so it is always hidden on native.
  - The SEO blocks (FAQ, "at a glance", related services) are **not** rendered by the client.
    The server provides them on web (T16).
  - **The web route screen must never remove or modify `#rt-static` and never set
    `document.title` when a server `<title>` is present.** On web it may collapse the static
    stop-list `<details>` only.
- **Do:** `app/bus/[service].tsx` and `route/*` components, then wire the board's and stop
  screen's `onOpenRoute`.
- **Outcome:** the route page is at parity on all platforms.
- **Verify** (against the stub, on iOS, Android and web 375 px):
  1. Anchoring:
     - Board → tap service `10` on `10001` opens `/bus/10?stop=10001`, anchored at
       `10001`, and `anchor.v1` contains `{"10":"10001"}`.
     - Reopen `/bus/10` with no query: it anchors `10001` from memory.
     - Clear `anchor.v1`, set the location near stop index 60, and open `/bus/2`: it anchors
       the nearest stop on route 2.
  2. Set the location more than 2 km from route `857`, then open `/bus/857`: the guard shows,
     and "use it anyway" anchors and persists.
  3. Toggle direction twice: the originally chosen stop is restored, and `anchor.v1` is
     byte-identical before and after the toggles.
  4. Hand-edit `anchor.v1` to `{"10":"10200"}` (not served by `10`). The notice shows once,
     and on the next visit the key no longer contains `10`.
  5. `/bus/359` shows one direction (the loop). `/bus/ZZZ` shows the no-such-service state.
  6. `_stats`: the anchored view makes one arrivals request per 30 s with at most 5 codes;
     the picker makes one 1-code request per 30 s; backgrounded makes 0.
  7. For a fixed stub timing, the bus mark position matches the vanilla `/bus/10?stop=10050`
     side by side.
  8. Web, with a hand-inserted `#rt-static` in the shell as in T3 step 5: after using the
     toggle, the picker and refresh, the element is still present and `document.title` is
     unchanged.
- **Commit:** `Add route screen`

### T13 — Universal Links and App Links

- **Depends on:** T3.
- **Context:** shared links are `https://ezbus.sg/stop/<code>` and `/bus/<service>`. Expo
  Router uses the same paths, so a verified link opens the right screen.
  - iOS needs `/.well-known/apple-app-site-association`: JSON, no redirect,
    `Content-Type: application/json`, listing `<TeamID>.<bundleId>` and the paths `/stop/*`
    and `/bus/*`.
  - Android needs `/.well-known/assetlinks.json` with the package name and the release
    signing SHA-256.
  - The Team ID and the signing SHA are inputs from the maintainer (§6). Until they exist,
    use placeholders read from `config.ts` env (`APPLE_APP_ID`, `ANDROID_CERT_SHA256`), and
    serve 404 when they are unset.
- **Do:**
  - Two routes in `src/index.ts` with `Cache-Control: public, max-age=3600`, with env
    reading in `src/config.ts` only.
  - Tests in a new `src/well-known.test.ts`, which builds the JSON with a pure function
    exported from a new `src/well-known.ts`.
  - `app.config.ts`: `ios.associatedDomains: ['applinks:ezbus.sg']`, and an Android
    `intentFilters` entry with `autoVerify: true` for those path prefixes.
- **Outcome:** a shared link opens the app when it is installed, and the site otherwise.
- **Verify:**
  1. `npm test`: the JSON shape is correct for set env, and the routes give 404 when the env
     is unset.
  2. `curl -sI localhost:8080/.well-known/apple-app-site-association` returns `200`,
     `application/json` and no redirect when the env is set. The same holds for
     `assetlinks.json`.
  3. Before T15 there are no release identities, so test the routing locally:
     `xcrun simctl openurl booted "ezbus://stop/10001"` and
     `adb shell am start -W -a android.intent.action.VIEW -d "ezbus://stop/10001"` both open
     the stop screen. `ezbus://bus/10?stop=10001` opens the anchored route.
  4. A full verified-domain check is part of T15.
- **Commit:** `Serve app-link association files and configure deep links`

### T14 — End-to-end harness

- **Depends on:** T8, T9, T10, T11, T12, T13.
- **Context:** the journeys in §5 must be repeatable by any agent.
  - Native uses Maestro flows (YAML) on the iOS simulator and the Android emulator. Location
    is set with `xcrun simctl location` / `adb emu geo fix` from a wrapper script.
  - Web uses Playwright specs at 375×667 and 320×568 with `setGeolocation` and
    `grantPermissions`.
  - Both run against the stub server with `ARRIVAL_TTL_MS=1`.
  - The client's elements need stable `testID`s (RN-web renders them as `data-testid`). Add
    any that are missing.
- **Do:**
  - `e2e/maestro/*.yaml`, `e2e/web/*.spec.ts`, and `e2e/run-native.sh` /
    `e2e/run-web.sh`. The scripts start the stub, start the server, clear app state, run,
    and collect screenshots.
  - CI runs the web suite in the `client` job. Native suites are run locally or on macOS
    runners as decided in §6.
- **Outcome:** §5 is executable with two commands.
- **Verify:**
  1. `e2e/run-web.sh` passes all specs, twice in a row (no flakes).
  2. `e2e/run-native.sh ios` and `e2e/run-native.sh android` pass all flows.
  3. Fault injection: change `HINT_MAX_SHOWINGS` locally to 0 and the hint flow fails.
     Revert it. Each suite fails on at least one deliberately broken journey.
- **Commit:** `Add Maestro and Playwright end-to-end suites`

### T15 — Native release builds and store readiness

- **Depends on:** T14.
- **Context:** this needs the inputs in §6: the bundle ids, the Apple Team ID, the Android
  signing key, the build pipeline, and the privacy sign-off.
  - Icons come from the `tools/make-icons.mjs` geometry (extend it to emit the iOS and
    Android adaptive sizes). Do not hand-draw them.
  - The splash uses `bg` for each scheme.
  - Privacy labels and Data safety are drafted from the facts:
    - location is sent per request and never stored or logged;
    - there are no analytics, no accounts and no tracking.

    The compliance owner confirms the wording.
- **Do:**
  - Release build profiles (EAS or `expo prebuild` + Xcode/Gradle, per §6).
  - Production `apiBase`.
  - Icons and splash.
  - Set `APPLE_APP_ID` / `ANDROID_CERT_SHA256` in the k8s manifest env. They are not
    secrets, but a Secret is used if the maintainer prefers.
  - Store metadata drafts in `client/store/`.
- **Outcome:** signed release builds are installed through TestFlight and Play internal
  testing.
- **Verify:**
  1. Release builds install from TestFlight and Play internal testing on a physical iPhone
     and a physical Android phone.
  2. `e2e/run-native.sh` passes against **release** builds pointed at a staging server
     backed by the stub.
  3. Verified links:
     - On a device, tap `https://ezbus.sg/stop/10001` in Notes or Messages and the app opens
       the stop screen.
     - With the app uninstalled, Safari or Chrome opens the site.
     - `adb shell pm get-app-links sg.ezbus.app` shows `ezbus.sg: verified`.
  4. Cold launch on a mid-range Android phone over cellular, from tap to the first ETA
     visible on a returning visit: record the median of 5 in the PR.
  5. For 30 min of normal use across two devices, `/healthz` shows `upstreamCallsPerMin`
     consistent with the visible-cards-only refresh, and `breakerOpen:false`.
  6. The privacy-label wording, with the compliance owner's sign-off, is attached to the PR.
- **Commit:** `Configure release builds, icons and store metadata`

### T16 — Web cut-over

- **Depends on:** T14.
- **Context:** Express keeps rendering the SEO surface. Today it injects into
  `public/stop.html`, `route.html` and `buses.html`:
  - head tags (title, description, `og:*`, canonical);
  - `#sp-plate`, `#sp-sched` and `#sp-nearby` + JSON-LD (stop);
  - `#rt-head` with `data-ssr="1"`, and `#rt-static` + two JSON-LD blocks (route);
  - `#buses-list`.

  The code is in `src/index.ts` (routes `/stop/:code`, `/bus/:service`, `/buses`) and in
  `src/stop-page.ts`, `src/route-page.ts` and `src/buses-page.ts`. Retarget it to the Expo
  export's `index.html`:
  - head tags are replaced in place;
  - the static blocks are inserted **after** the React root, never inside it.

  `/buses` stays a server-only page with no React root. Hashed export assets get
  `Cache-Control: public, max-age=31536000, immutable`. HTML stays `no-cache`. `/api/*` is
  unchanged.
- **Do:**
  - Dockerfile: add a client build stage that runs `npx expo export -p web`. The runtime
    stage copies only `client/dist` (and `shared/` while needed).
  - `src/index.ts`: serve the export, and retarget the injections.
  - Port the source-level guards in `src/route-page.test.ts` to assert against
    `client/app/bus/[service].tsx` and `client/route/*`:
    - no removal of `#rt-static`;
    - no `document.title` write when `data-ssr` is present.
  - Delete `public/app.js`, `stop.js`, `route.js`, `index.html`, `stop.html` and
    `route.html`, and `styles.css` together with `src/tokens.test.ts`, which now has nothing
    to compare against. `tokens.ts` becomes the source.
  - Keep in `public/`: `fonts/`, the icons, `manifest.webmanifest`, `og-card.png` and
    `robots.txt`.
  - Update AGENTS.md (stack, architecture, commands, Verifying, Gotchas, the
    additive-only API rule for shipped binaries), style-guide.md (token source, fonts,
    motion implementation) and README.
- **Outcome:** ezbus.sg is served by the React codebase with no SEO, state or payload
  regression.
- **Verify:**
  1. `npm run build && npm test` are green, including the ported guards. Client `tsc`,
     `jest` and `e2e/run-web.sh` are green.
  2. ⛔ `node tools/measure-web-payload.mjs` on the built image stays within the T3 budget.
     Over budget blocks the merge.
  3. `node tools/crawl-check.mjs` against the built image passes. A post-hydration DOM dump
     of `/bus/10` and `/stop/10001` contains `#rt-static`, `#sp-nearby`, all JSON-LD blocks
     and the server `<title>`. `/sitemap.xml` is byte-identical to `main`.
  4. State carry-over. On the **pre-cut-over** build:
     - set pins `10001,10002`, an address origin (`310155`), three recents, a retired hint,
       and an anchor for `10`;
     - restart on the cut-over image at the same origin and reload;
     - the same chip, pins and recents appear, with no intro and no hint, and `/bus/10`
       anchors at the remembered stop.
  5. `curl -sI` shows an `immutable` header on an export JS asset, `no-cache` on `/` and
     `/bus/10`, and `no-store` on `/api/board`.
  6. At 320 and 375 px in both schemes, on `/`, `/stop/10001` and `/bus/10`:
     `scrollWidth === innerWidth`.
  7. Real iPhone Safari on staging HTTPS: the location door prompts on the first tap.
  8. `docker build` succeeds. In k8s staging, `/healthz` becomes ready. Liveness is
     unchanged.
- **Commit:** `Serve the web from the React client and retire the vanilla glue`

---

## 5. End-to-end verification (after all tasks merge)

Run on `main` with the stub, then on staging with the real DataMall key. Every row runs on
**iOS (release build), Android (release build) and web (375×667 and 320×568)**. Automated
rows run through `e2e/run-native.sh ios|android` and `e2e/run-web.sh`; manual rows are
marked M.

| # | Journey | Expected |
| --- | --- | --- |
| 1 | Fresh install → location door → grant | Board from the device location, `10001` first at `1.3521,103.8198`; relaunch has no dialog |
| 2 | Fresh → address door → `310155` → submit | Board ranked from that address; chip shows it; recents has 1 |
| 3 | Fresh → dismiss (backdrop / Android back / Escape) | Gate with both doors; storage empty; dialog returns on relaunch |
| 4 | Deny, no location, timeout | Code 1, 2 and 3 copy respectively; app shows "Settings" copy, web shows browser copy |
| 5 | Height < 620 | Example dropped, both doors visible |
| 6 | Returning, offline within 12 h | Cached board shape paints; recovers when online |
| 7 | Move 100 m vs 270 m and foreground | No re-rank vs re-rank |
| 8 | Pin mid-load (`slow` mode) | One follow-up load including the pin |
| 9 | Origin switch with the server down | Chip and board roll back |
| 10 | Finder branches `310155`, `10001`, `toa payoh`, `t` | Commit, commit, ≤ 10 rows, no request |
| 11 | Six commits | Five recents, newest first |
| 12 | Hint | Shows on boards with cards, retires on "Got it" or at `HINT_MAX_SHOWINGS`; never on gate |
| 13 | Pin fold coordinates | folded → hold → expanded, and reverse |
| 14 | Board → stop → route → back → back | Correct screens; board not refetched on back |
| 15 | Route anchor, guard, toggle twice, stale anchor | As T12 steps 1–4 |
| 16 | Stub `500` on one code, `empty`, `429` | One card failed; nothing running; board degrades; `/healthz` `breakerOpen` behaves as AGENTS.md |
| 17 | Upstream cost (`_stats`, 2 min foreground / background) | Visible-only refresh; 0 when backgrounded |
| 18 (M) | Shared `https://ezbus.sg/stop/10001` link | Opens app when installed, site otherwise |
| 19 (M) | Real iPhone Safari, location door | Prompt on first tap |
| 20 (M) | Both colour schemes, reduce-motion, largest text, VoiceOver/TalkBack | AA contrast, static trails, no clipping, cards announce name + code |
| 21 (M) | Web SEO | crawl-check passes; post-hydration DOM keeps `#rt-static`, JSON-LD, server `<title>` |
| 22 (M) | Web payload | Within the T3 budget |
| 23 (M) | Staging with the real key, 30 min across two devices plus web | `upstreamCallsPerMin` in line with today's per-client rate; no breaker trips |

**Done:** every row passes on every platform, `npm test` and the client suites are green on
`main`, and the results table (pass/fail per platform, with the measured numbers) is
attached to the release PR.

## 6. Inputs needed from the maintainer before T13–T15

1. The build pipeline: EAS cloud, which uploads the source to Expo, or self-hosted macOS and
   Linux runners.
2. Apple Developer Program and Google Play Console accounts and their owner. This provides
   the Apple Team ID and the Android release signing key.
3. Final bundle id and package name (placeholder `sg.ezbus.app`).
4. Whether OTA JS updates (expo-updates) are wanted. They are not assumed in this plan.
5. The compliance owner's sign-off on the privacy-label wording and on the LTA DataMall terms
   for distribution in a store app.
