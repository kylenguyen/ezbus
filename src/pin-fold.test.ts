import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Invariant tests for the pinned-stop fold — the board half of it. The decision
 * itself is pure and unit tested for real in [origin.test.ts](./origin.test.ts)
 * (`pinFold`, `foldRowCopy`); what is left here is the glue, and `app.js` needs a
 * DOM so it is never imported. These are source-level assertions in the manner of
 * [board-head.test.ts](./board-head.test.ts): each one stands for a behaviour that
 * a plausible tidy-up of `app.js` would silently delete, and that no amount of
 * `curl` would notice afterwards.
 *
 * The computed URLs are the same bargain the other source-level suites document: a
 * literal `'../public/app.js'` trips TS6059 under `rootDir: "src"`, while a URL
 * built at runtime is never resolved by tsc.
 */
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

/** One function's source, by name, so an assertion can be scoped to it. */
function fn(name: string): string {
  const from = appSource.indexOf(`function ${name}(`);
  assert.notEqual(from, -1, `${name}() must exist in app.js`);
  // Top-level functions only: the next line that starts in column zero with `}`
  // closes it, which is what the file's formatting guarantees.
  const end = appSource.indexOf('\n}\n', from);
  assert.notEqual(end, -1, `${name}() must be a top-level function`);
  return appSource.slice(from, end);
}

describe('pinned fold — the board row', () => {
  // The row is a real <button> with `data-fold`, matching the `[data-pin]` idiom
  // the board's one delegated listener already uses. `aria-expanded` is the whole
  // of what a screen-reader user is told about the fold, and it is on the control
  // that toggles it — a div with a click handler would give them neither.
  it('renders the row as a button the board delegation can find', () => {
    assert.ok(
      appSource.includes('<button class="pin-fold" type="button" data-fold'),
      'the fold row must be a real button carrying data-fold',
    );
    assert.match(
      appSource,
      /data-fold aria-expanded="\$\{open\}"/,
      'aria-expanded must track the open state, not be hard-coded',
    );
  });

  // The copy is decided in origin.js and asserted verbatim there. A second,
  // hand-written copy of it in app.js is the failure this guards: it would drift
  // from the tested string the first time either was edited, and the singular /
  // plural and the m/km switch would then be wrong in exactly one of the two.
  it('takes every string on the row from foldRowCopy', () => {
    assert.match(appSource, /^\s*foldRowCopy,$/m, 'foldRowCopy must be imported from origin.js');
    assert.match(fn('foldRow'), /foldRowCopy\(/, 'the row markup must call foldRowCopy');
    assert.ok(
      !/pinned stops? ·/.test(appSource),
      'app.js must not hand-write the row label — foldRowCopy owns it',
    );
    for (const action of ["'Show'", "'Hide'", '"Show"', '"Hide"']) {
      assert.ok(!appSource.includes(action), `app.js must not hand-write the action label ${action}`);
    }
  });

  // Every interpolation into board markup goes through the local escape(), and the
  // row is not an exception just because its strings were composed on our side.
  it('escapes the row copy like every other interpolation', () => {
    const row = fn('foldRow');
    assert.match(row, /\$\{escape\(label\)\}/, 'the label must go through escape()');
    assert.match(row, /\$\{escape\(action\)\}/, 'the action must go through escape()');
  });

  // The decision is made once per render and fed back in as `previous`, which is
  // the only thing that makes the 800–1000 m band sticky. Dropping the write-back
  // would leave `pinFold` with no memory and the board flipping shape on jitter.
  it('computes the fold once per render and remembers the answer', () => {
    const shells = fn('renderShells');
    assert.match(shells, /pinFold\(\{[^}]*previous: foldPrev/, 'the last decision must feed back in');
    assert.match(shells, /foldPrev = fold/, 'the new decision must be stored back');
    assert.match(appSource, /^\s*pinFold,$/m, 'pinFold must be imported from origin.js');
    assert.match(shells, /located/, 'the fold must be given the board response’s located flag');
  });

  // `renderShells` short-circuits on a matching signature, so the signature has to
  // encode how the pins are *drawn* and not only which stops are on the board.
  // Without the prefix, folded and opened are the same string and tapping the row
  // repaints nothing at all — the bug this assertion exists to catch.
  it('encodes the fold rendering state in the shell signature', () => {
    const shells = fn('renderShells');
    const signature = shells.slice(shells.indexOf('const signature ='), shells.indexOf('if (signature'));
    for (const prefix of ["'O|'", "'F|'", "'E|'"]) {
      assert.ok(
        shells.includes(prefix),
        `the three fold rendering states must be distinguishable — ${prefix} missing`,
      );
    }
    assert.match(signature, /drawn \+/, 'the signature must be prefixed with the fold state');
  });

  // A folded, closed board draws no pinned cards; an opened one draws them in the
  // order the server sent, which is pins first. Both come off one filter.
  it('skips the pinned cards only while the fold is shut', () => {
    const shells = fn('renderShells');
    assert.match(shells, /const showPins = !folded \|\| foldOpen/, 'open must override folded');
    assert.match(
      shells,
      /showPins \? board : board\.filter\(\(stop\) => !stop\.pinned\)/,
      'the pinned cards must be dropped from the card list, not hidden in CSS',
    );
    assert.match(
      shells,
      /el\.board\.innerHTML = \(folded \? foldRow\(/,
      'the row must be written before the cards, so it lands first in the grid',
    );
  });

  // The fold row is a child of #board and is not a stop. Observing it would put
  // `undefined` into `visible`, which the arrivals refresh reads to decide what to
  // ask the server for — a fabricated stop code in a query string.
  it('observes stop cards only, never the fold row', () => {
    const shells = fn('renderShells');
    assert.match(
      shells,
      /observer\.observe\(card\)/,
      'the visibility observer must still be wired to the cards',
    );
    assert.match(
      shells,
      /el\.board\.querySelectorAll\('\[data-code\]'\)/,
      'only elements carrying a data-code may be observed',
    );
    assert.ok(
      !shells.includes('el.board.children'),
      'iterating every child of #board would observe the fold row too',
    );
  });

  // Toggling is a rendering choice about stops already in hand: the pinned cards'
  // arrivals came down with the board. A fetch here would spend a round trip and
  // LTA quota to redraw what is already in memory.
  it('toggles without touching the network', () => {
    const from = appSource.indexOf("el.board.addEventListener('click'");
    assert.notEqual(from, -1, 'the board click delegation must exist');
    const handler = appSource.slice(from, appSource.indexOf('\n});\n', from));
    assert.match(handler, /\[data-fold\]/, 'the delegation must match the fold row');
    assert.match(handler, /foldOpen = !foldOpen/, 'the click must flip the override');
    assert.match(handler, /render\(\)/, 'and repaint');
    for (const call of ['fetch(', 'loadBoard(', 'refreshArrivals(']) {
      assert.ok(!handler.includes(call), `the fold toggle must not ${call} anything`);
    }
  });

  // The row survives the toggle by copy — it flips to `Hide` rather than
  // disappearing — but not by identity: the repaint rebuilds `#board` wholesale, so
  // the pressed button is a new element and focus would land on <body>. A keyboard
  // user would then have to tab the whole page to reach the control they are using.
  it('keeps focus on the row across the repaint', () => {
    const from = appSource.indexOf("el.board.addEventListener('click'");
    const handler = appSource.slice(from, appSource.indexOf('\n});\n', from));
    assert.match(
      handler,
      /querySelector\('\[data-fold\]'\)\?\.focus\(\)/,
      'focus must be put back on the redrawn fold row',
    );
  });

  // Both halves of the fold state belong to the origin the board was ranked from.
  // `resetBoard` is the one function every origin change goes through — the address
  // switch through `switchOrigin`, and `startWithLocation` leaving place mode,
  // which calls it directly — so the reset lives there rather than in either.
  it('resets the fold on every origin-switch path', () => {
    const reset = fn('resetBoard');
    assert.match(reset, /foldOpen = false/, 'the override must not survive an origin switch');
    assert.match(reset, /foldPrev = null/, 'nor may a decision made from another origin’s distances');
    assert.match(fn('switchOrigin'), /resetBoard\(\)/, 'switchOrigin must go through resetBoard');
    assert.match(
      fn('startWithLocation'),
      /resetBoard\(\)/,
      'the location door must go through resetBoard too — it does not use switchOrigin',
    );
  });

  // The flag is the fold's only evidence, and `pinFold` reads it as a literal
  // `true`. Captured with the stops it describes, so a board and the claim that it
  // was ranked from a coordinate cannot come apart.
  it('captures located from the board response', () => {
    assert.match(
      fn('loadBoard'),
      /located = data\.located === true/,
      'located must be read off /api/board, as a literal true',
    );
  });
});

describe('pinned fold — the row’s look', () => {
  const rule = cssSource.slice(cssSource.indexOf('.pin-fold {'), cssSource.indexOf('.pin-fold:active'));

  it('draws the approved dashed accent edge', () => {
    assert.notEqual(cssSource.indexOf('.pin-fold {'), -1, 'a .pin-fold rule must exist');
    assert.match(
      rule,
      /border: 1px dashed var\(--accent\);/,
      'the fold reads as a gap in the board: dashed, and accent because it is the pins',
    );
    assert.ok(
      !/box-shadow:\s*none/.test(rule),
      'never `box-shadow: none` in this sheet — dark mode’s --shadow is a transparent shadow',
    );
  });

  it('uses the radius token rather than a literal', () => {
    assert.match(rule, /border-radius: var\(--radius\);/, 'the 4px estate radius is a token');
  });

  // The row is the only way back to the pins, so it is a thumb target like any
  // other: style-guide.md's 2.75rem floor, and no exception for a full-width row.
  it('clears the 44 px touch floor', () => {
    const min = /min-height: ([\d.]+)rem;/.exec(rule);
    assert.ok(min, '.pin-fold must set a min-height');
    assert.ok(
      Number(min[1]) >= 2.75,
      `min-height ${min[1]}rem is below the 2.75rem touch floor`,
    );
  });

  it('marks the row with the pin’s own accent star', () => {
    assert.ok(appSource.includes('<span class="pin-fold-star" aria-hidden="true">★</span>'));
    assert.match(
      cssSource,
      /\.pin-fold-star \{[^}]*color: var\(--accent\);[^}]*\}/,
      'the star carries the accent, and no new colour family',
    );
  });
});
