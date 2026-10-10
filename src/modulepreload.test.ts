import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Every module a page's entry script reaches must be named in that page's
 * `<link rel="modulepreload">` list. A module runs only once its whole import
 * graph has arrived, and an import is discovered only once the importing file
 * has downloaded — so a module left off the list is a serial round trip on a
 * cold cellular load before the page can paint anything. `vehicle-marks.js`
 * was missing from the board and route shells for exactly that reason.
 *
 * Computed URLs for the TS6059 reason given in board-head.test.ts.
 */
const read = (file: string) => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');

/** Relative static imports of a module, as `/name.js` paths. */
function importsOf(file: string): string[] {
  return [...read(file).matchAll(/^import[\s\S]*?from '\.\/([\w-]+\.js)';/gm)].map((m) => m[1]!);
}

/** Every module reachable from `entry`, excluding the entry itself. */
function graphOf(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = importsOf(entry);
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...importsOf(next));
  }
  return seen;
}

function preloadsOf(page: string): Set<string> {
  return new Set(
    [...read(page).matchAll(/<link rel="modulepreload" href="\/([\w-]+\.js)" \/>/g)].map((m) => m[1]!),
  );
}

const PAGES = [
  { page: 'index.html', entry: 'app.js' },
  { page: 'route.html', entry: 'route.js' },
  { page: 'stop.html', entry: 'stop.js' },
];

describe('modulepreload lists', () => {
  for (const { page, entry } of PAGES) {
    it(`${page} preloads exactly the modules ${entry} imports`, () => {
      const graph = graphOf(entry);
      assert.ok(graph.size > 0, `${entry} should import at least one module`);
      assert.deepEqual(
        [...preloadsOf(page)].sort(),
        [...graph].sort(),
        `${page} must preload every module in ${entry}'s import graph, and nothing else`,
      );
    });
  }
});
