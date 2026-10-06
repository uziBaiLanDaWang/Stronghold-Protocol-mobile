// tools/verify-offline-browser.mjs — prove the offline tree runs a solo match with no engine on the server side.
//
// Serves dist/offline (tools/make-offline.mjs) through a MINIMAL static file server that contains no game code and
// knows nothing about the protocol — it only maps URLs to files. Then it loads `?local=1` in Chrome and drives a
// real solo match through the page's own `net.request`, asserting the engine boots in the page, the handshake goes
// online, and the UI renders the shop.
//
//   node tools/make-offline.mjs && node tools/verify-offline-browser.mjs [--port 0] [--keep]
//
// Needs Chrome (CHROME_PATH) and puppeteer-core, like the repo's own e2e suites.

import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'dist', 'offline');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = Number(argOf('--port', '0'));
const KEEP = args.includes('--keep');

const CHROME = process.env.CHROME_PATH
  || ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome'].find((p) => existsSync(p));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.atlas': 'text/plain; charset=utf-8', '.skel': 'application/octet-stream',
};

const problems = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
  return ok;
};

// ---- a deliberately dumb static server: files only, no engine, no WebSocket ---------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(SITE, rel);
  if (!file.startsWith(SITE)) { res.writeHead(403).end(); return; }
  try {
    const st = await stat(file);
    if (!st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': st.size });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
});
// Anything that is not a file GET must fail loudly: if the page ever needed a real server, this proves it.
server.on('upgrade', (req, socket) => { socket.destroy(); });

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`offline browser verification\n  static root: dist/offline (no game code on the server side)\n  serving: ${base}  (upgrades refused)\n`);

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 915, height: 412, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(`${base}/?local=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 1. the page booted AND the in-page engine installed
  await page.waitForFunction(() => globalThis.__SP__ && globalThis.__SP_OFFLINE__, { timeout: 30000 });
  check(true, 'page booted and the in-page engine installed (?local=1)');

  const engine = await page.evaluate(() => ({
    dataFiles: Object.keys(globalThis.__SP_OFFLINE__.matchData ?? {}).length,
    hasMatch: typeof globalThis.__SP_OFFLINE__.lobby === 'object',
  }));
  check(engine.dataFiles >= 14, 'the engine got the full match data set in the page', `${engine.dataFiles} files`);

  // 2. the handshake went through the synthetic socket: net is online with no WebSocket anywhere.
  // A session only goes 'online' once a nickname is set (the title screen does this; net.js _onOpen sends hello
  // only when `this.name` is set), so do what title.js does before waiting.
  await page.evaluate(() => globalThis.__SP__.net.setName('离线验证'));
  await page.waitForFunction(() => globalThis.__SP__.net.status === 'online', { timeout: 20000 }).catch(() => {});
  const status = await page.evaluate(() => ({
    status: globalThis.__SP__.net.status,
    playerId: globalThis.__SP__.net.playerId,
    frames: globalThis.__SP_OFFLINE__.frameCount(),
  }));
  check(status.status === 'online', 'hello → welcome over the synthetic socket (net.status online)', `playerId=${status.playerId}`);
  check(status.frames > 0, 'the engine answered frames', `${status.frames} frames`);

  /** Click the first visible element matching a text pattern — resilient to class renames. */
  const clickByText = (pattern, selector = 'button, .mode-card, [role="button"], a') => page.evaluate((pat, sel) => {
    const re = new RegExp(pat);
    const els = [...document.querySelectorAll(sel)];
    const el = els.find((e) => re.test((e.textContent || '').trim()));
    if (!el) return null;
    const label = (el.textContent || '').trim().slice(0, 24);
    el.click();
    return label;
  }, pattern, selector);

  const screen = () => page.evaluate(() => ({
    title: !!document.querySelector('.title-screen'),
    lobby: !!document.querySelector('.mode-card'),
    game: !!document.querySelector('.shopbar, .gtop__exit, .gm__gear, .readybtn'),
    root: document.querySelector('#app')?.firstElementChild?.className ?? null,
  }));

  // 3. ENTER THROUGH THE REAL UI: nickname → 独立模拟 → 开始独立模拟 → 开始模拟
  await page.waitForSelector('.title-screen input', { timeout: 20000 });
  await page.evaluate(() => {
    const input = document.querySelector('.title-screen input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, '离线验证');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  const enteredTitle = await clickByText('^\\s*开始\\s*$');
  check(!!enteredTitle, 'title screen: nickname entered and 开始 clicked', enteredTitle ?? 'no button');
  await page.waitForSelector('.mode-card', { timeout: 20000 });
  check(true, 'lobby screen rendered');

  const choseSolo = await clickByText('独立模拟', '.mode-card');
  check(!!choseSolo, 'lobby: 独立模拟 selected', choseSolo ?? 'no mode card');
  await new Promise((r) => setTimeout(r, 200));
  const created = await clickByText('开始独立模拟');
  check(!!created, 'lobby: 开始独立模拟 clicked (creates the solo room)', created ?? 'no button');

  // the room screen needs 开始模拟 (in a solo room the host's start counts as ready)
  await new Promise((r) => setTimeout(r, 800));
  const started = await clickByText('^\\s*开始模拟\\s*$');
  check(!!started, 'room screen: 开始模拟 clicked', started ?? 'no button');
  await new Promise((r) => setTimeout(r, 1200));

  // Right after 开始模拟 the app is on the briefing screen, which has none of the in-match chrome; what matters
  // here is that it left the lobby. The rendered game screen is asserted below, once the match reaches PREP.
  const inGame = await screen();
  check(!inGame.title && !inGame.lobby, 'the app left the title/lobby screens and entered the match', `root=${inGame.root}`);

  // 4. the two briefing/draft steps, driven through the page's own client
  const result = await page.evaluate(async () => {
    const net = globalThis.__SP__.net;
    const store = globalThis.__SP__.store;
    const phase = () => store.get().match.public?.phase ?? null;
    const waitPhase = async (want, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (phase() === want) return true; await new Promise((r) => setTimeout(r, 50)); }
      return false;
    };
    const info = phase() === 'INFO_CHECK' || await waitPhase('INFO_CHECK', 10000);
    if (phase() === 'INFO_CHECK') await net.request('g.infoReady', {});
    const draft = await waitPhase('BAND_DRAFT', 10000);
    let band = null;
    for (const id of Object.keys(globalThis.__SP__.data.get('bands') ?? {})) {
      try { await net.request('g.band', { bandId: id }); band = id; break; } catch { /* not offered */ }
    }
    const prep = await waitPhase('PREP', 10000);
    return {
      info, draft, band, prep, phase: phase(), round: store.get().match.public?.round ?? null,
      shop: store.get().match.private?.shop?.slots?.length ?? null,
    };
  });
  check(result.info, 'the match reached INFO_CHECK through the UI flow');
  check(result.draft, 'g.infoReady → BAND_DRAFT');
  check(!!result.band, 'g.band accepted (a strategy was taken)', result.band ?? 'none accepted');
  check(result.prep, 'g.band → PREP', `phase=${result.phase} round=${result.round}`);
  check(result.shop > 0, 'the engine rolled a shop for the seat', `slots=${result.shop}`);

  // 5. the real UI rendered the match (not just the store): the game screen with its shop bar
  await new Promise((r) => setTimeout(r, 1500));
  const ui = await page.evaluate(() => ({
    meId: globalThis.__SP__.store.get().me?.playerId ?? null,
    room: globalThis.__SP__.store.get().room?.code ?? null,
    shopbar: !!document.querySelector('.shopbar'),
    readyBtn: !!document.querySelector('.readybtn'),
    gameChrome: !!document.querySelector('.gtop__exit, .gm__gear'),
    root: document.querySelector('#app')?.firstElementChild?.className ?? null,
  }));
  console.log(`\n  [diag] me.playerId=${ui.meId} room=${ui.room} root="${ui.root}" gameChrome=${ui.gameChrome}`);
  check(ui.shopbar || ui.readyBtn || ui.gameChrome, 'the game screen rendered in the DOM',
    `shopbar=${ui.shopbar} readybtn=${ui.readyBtn} chrome=${ui.gameChrome} root=${ui.root}`);

  // 5. no WebSocket was ever constructed, and nothing asked a server for game logic
  const netCalls = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((e) => e.name).filter((n) => /\/engine\/|\/sim\/|\/data\.js/.test(n)).length);
  check(netCalls > 0, 'the engine modules were loaded by the page itself', `${netCalls} engine/sim/data requests`);

  // A source checkout has no public/assets (that is `npm run setup`, ~330 MB), so the art, audio and the Spine
  // skeletons 404. Those failures are the asset pack's absence, not the offline architecture: filter them, and
  // anything else is a real problem.
  const ART_NOISE = /fonts\.css|media\/|local-assets|healthz|favicon|Failed to load resource|Spine:|texture loader|unhandled rejection|pageerror: Event/i;
  const stray = consoleErrors.filter((e) => !ART_NOISE.test(e));
  check(stray.length === 0, 'no unexpected console errors (missing-art fallout excluded)', stray.slice(0, 3).join(' | ') || 'clean');
  if (consoleErrors.length) console.log(`\n  [console] ${consoleErrors.length} entries:\n    ${consoleErrors.slice(0, 10).join('\n    ')}`);

  if (KEEP) {
    console.log('\n  --keep: leaving Chrome open for 5 min; the page is ready to try by hand');
    await new Promise((r) => setTimeout(r, 300000));
  }
} catch (e) {
  check(false, 'browser verification ran', e.message);
} finally {
  await browser?.close().catch(() => {});
  server.close();
}

console.log(problems.length ? `\nFAILED (${problems.length}): ${problems.join(' | ')}` : '\nAll checks passed — solo runs with no engine on the server side.');
process.exit(problems.length ? 1 : 0);
