// tools/make-offline.mjs — assemble a static tree that runs a solo match with NO Node engine at all.
//
// The offline solo mode (?local=1, public/js/local/server.js) runs the real platform + match engine in the page, so
// the whole game reduces to a plain file tree: public/ at the root, plus the shared code the page imports over
// static routes. server/index.js serves exactly this layout through its mounts (/data/, /shared/, /sim/, /engine/,
// / and the generated /data.js); this script materializes the same layout as real files so an ordinary static host
// — an Android WebView's asset loader, `npx serve`, a USB stick with a file server — can serve it with nothing but
// byte-range GETs.
//
//   node tools/make-offline.mjs [--out dist/offline] [--with-assets]
//
// Laid out as:
//   <out>/            public/ (index.html, js/, css/, vendor/, …) — the page itself
//   <out>/shared/     shared/          — constants + protocol, imported by both sides
//   <out>/sim/        server/sim/      — the battle simulation (the client already loads this over /sim/)
//   <out>/engine/     server/          — net.js, lobby.js, match/** (the offline platform layer)
//   <out>/data/       data/*.json      — game data fetched by public/js/data.js
//   <out>/data.js     the browser stand-in for server/data.js, which the engine imports as `../data.js`
//
// Two files are intentionally NOT copied, mirroring the 404s server/index.js returns for them: engine/index.js
// (needs node:http/fs) and sim/nodeData.js (needs node:fs, and server/sim/nodeData.js is in SIM_PRIVATE).

import { cp, mkdir, rm, writeFile, readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_SHIM_JS } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = path.resolve(ROOT, argOf('--out', 'dist/offline'));
const WITH_ASSETS = args.includes('--with-assets');

/** Files that exist in the repo but must never reach a browser (they are 404s on the live server too). */
const NEVER_COPY = ['index.js', 'data.js', 'nodeData.js'];

const log = (...a) => console.log('  ', ...a);

async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function copyDir(from, to, { filter } = {}) {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, filter });
}

async function main() {
  if (OUT === ROOT || ROOT.startsWith(OUT)) throw new Error(`refusing to write into ${OUT}`);
  console.log(`assembling the offline tree at ${path.relative(ROOT, OUT) || OUT}\n`);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // 1. the page. Art/audio (public/assets, public/fonts) is ~330 MB and only copied with --with-assets, so the
  //    default tree stays code-sized.
  const heavy = new Set(['assets', 'fonts']);
  const filter = (src) => {
    const rel = path.relative(path.join(ROOT, 'public'), src);
    if (!rel) return true;
    const top = rel.split(path.sep)[0];
    if (!WITH_ASSETS && heavy.has(top)) return false;
    return true;
  };
  await copyDir(path.join(ROOT, 'public'), OUT, { filter });
  log(`public/          → .${WITH_ASSETS ? '  (with art + audio)' : '  (code only)'}`);

  // 2. the code the page imports over static routes
  await copyDir(path.join(ROOT, 'shared'), path.join(OUT, 'shared'));
  log('shared/          → shared/');
  await copyDir(path.join(ROOT, 'server', 'sim'), path.join(OUT, 'sim'));
  log('server/sim/      → sim/');
  await copyDir(path.join(ROOT, 'server'), path.join(OUT, 'engine'));
  log('server/          → engine/');

  // 3. game data (the client fetches /data/<name>.json)
  await copyDir(path.join(ROOT, 'data'), path.join(OUT, 'data'));
  log('data/            → data/');

  // 4. the browser stand-in for server/data.js, at BOTH paths that engine modules resolve it from:
  //    /engine/match/gamedata.js does `../data.js`   → /engine/data.js
  //    /sim/content/support/index.js does `../../../data.js` → /data.js
  //    (its own `./sim/simdata.js` resolves under both prefixes, since both have a sim/ sibling)
  await writeFile(path.join(OUT, 'data.js'), DATA_SHIM_JS, 'utf8');
  await writeFile(path.join(OUT, 'engine', 'data.js'), DATA_SHIM_JS, 'utf8');
  log('data.js shim     → data.js + engine/data.js');

  // 5. drop the Node-only files, so the tree matches what server/index.js actually exposes (404)
  const removed = [];
  for (const rel of [path.join('engine', 'index.js'), path.join('engine', 'sim', 'nodeData.js'), path.join('sim', 'nodeData.js')]) {
    const p = path.join(OUT, rel);
    if (await exists(p)) { await rm(p, { force: true }); removed.push(rel); }
  }
  if (removed.length) log(`removed (Node-only): ${removed.join(', ')}`);

  // 6. the optional per-machine art manifest (tools/local-extract): only its MANIFEST is missing from the tree
  //    copied in step 1 — data/ came from the repo, and the manifest lives in data/ too, so copy it over.
  if (WITH_ASSETS) {
    if (!(await exists(path.join(ROOT, 'public', 'assets')))) {
      log('--with-assets: public/assets does not exist (run `npm run setup` first) — the tree stays art-less');
    }
    if (await exists(path.join(ROOT, 'data', 'local-assets.json'))) {
      await copyDir(path.join(ROOT, 'data', 'local-assets.json'), path.join(OUT, 'data', 'local-assets.json'));
      log('local-assets.json → data/  (local-client art manifest)');
    }
  }

  const entries = await readdir(OUT);
  console.log(`\ndone. ${entries.length} entries at the root: ${entries.sort().join(' ')}`);
  console.log('\nserve it with anything that returns files, e.g.:');
  console.log(`  npx --yes serve ${path.relative(ROOT, OUT)}`);
  console.log('then open  http://<host>:<port>/?local=1  — no Node engine, no WebSocket.');
}

await main();
