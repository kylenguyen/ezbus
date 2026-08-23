// Screenshots tools/og-card.html into public/og-card.png (1200×630) with
// headless Chrome. The card left make-icons.mjs's SDF renderer when it grew
// real type — see the comment at the top of og-card.html.
//
// Dev-machine only: Chrome is a build-time dependency here, never a runtime
// one — the PNG is checked in and served static. Run after touching
// og-card.html, or point CHROME_BIN at a browser if yours lives elsewhere:
//
//   node tools/make-og-card.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const chrome = CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('No Chrome found. Set CHROME_BIN to a Chrome/Chromium binary.');
  process.exit(1);
}

const src = fileURLToPath(new URL('./og-card.html', import.meta.url));
const out = fileURLToPath(new URL('../public/og-card.png', import.meta.url));

const result = spawnSync(
  chrome,
  [
    '--headless=new',
    `--screenshot=${out}`,
    '--window-size=1200,630',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    // No waits needed: the woff2 is inlined as a data URI in og-card.html, and
    // --virtual-time-budget turned out to shoot *before* the font activated.
    '--disable-gpu',
    `file://${src}`,
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

if (result.status !== 0 || !existsSync(out) || statSync(out).size === 0) {
  console.error(`Chrome exited ${result.status}; no card written.`);
  process.exit(1);
}
console.log('public/og-card.png');
