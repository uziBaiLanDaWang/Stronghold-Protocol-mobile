// tools/verify-offline.mjs — verify the offline-solo architecture WITHOUT a browser.
//
// The claim (public/js/local/server.js) is that the real platform layer (server/net.js, server/lobby.js) and the
// real match engine (server/match/Match.js) run without Node, once the only genuinely Node part — the socket — is
// replaced. This script drives exactly that wiring in a single process:
//
//   engine ── Network.handleConnection() ── synthetic socket pair ── protocol client
//
// using the SAME socket-pair module the page uses. It speaks the wire protocol by hand (hello → welcome →
// room.create → room.start) and asserts the real match boots into INFO_CHECK with an m.public and an m.private.
//
// Run: node tools/verify-offline.mjs
//
// Note the sim/battle side is not exercised here: battles are simulated client-side (SP_COMBAT=client), so a solo
// match waits for its human after the briefing. That part needs the page.

import { Network, SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { Match } from '../server/match/Match.js';
import { getData } from '../server/data.js';
import { createSocketPair } from '../public/js/local/socket-pair.js';
import { PROTOCOL_VERSION, PHASE } from '../shared/constants.js';

const TIMEOUT_MS = 8000;
const QUIET = process.argv.includes('--quiet');

const log = QUIET
  ? { info() {}, warn() {}, error() {}, debug() {} }
  : {
    info: (...a) => console.log('  [engine]', ...a),
    warn: (...a) => console.warn('  [engine]', ...a),
    error: (...a) => console.error('  [engine]', ...a),
    debug: () => {},
  };

const problems = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
  return ok;
};

// ---- the wire ---------------------------------------------------------------------------------------------
const frames = [];
const waiters = new Set();
function onFrame(msg) {
  frames.push(msg);
  for (const w of [...waiters]) {
    if (w.match(msg)) { waiters.delete(w); clearTimeout(w.timer); w.resolve(msg); }
  }
}
function waitFor(match, label, timeoutMs = TIMEOUT_MS) {
  const hit = frames.find(match);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const w = { match, resolve, timer: null };
    w.timer = setTimeout(() => { waiters.delete(w); reject(new Error(`timeout waiting for ${label}`)); }, timeoutMs);
    waiters.add(w);
  });
}

// ---- engine -----------------------------------------------------------------------------------------------
console.log('offline solo verification — real engine, no browser\n');

const pair = createSocketPair();
const registry = new SessionRegistry({});
const lobby = new Lobby({ registry, log, MatchClass: Match, getData, options: {} });
const network = new Network({ registry, handler: lobby, log, options: {} });

check(typeof network.handleConnection === 'function', 'server/net.js exposes handleConnection');
network.handleConnection(pair.server, { socket: { remoteAddress: '127.0.0.1' }, headers: {} });
pair.open();

// ---- protocol client (the role public/js/net.js plays in the page) ------------------------------------------
let rid = 0;
const pending = new Map();
pair.client.onmessage = ({ data }) => {
  let msg;
  try { msg = JSON.parse(data); } catch { problems.push(`unparseable frame: ${String(data).slice(0, 120)}`); return; }
  onFrame(msg);
  if (msg.rid != null && (msg.t === 'ok' || msg.t === 'error')) {
    const p = pending.get(msg.rid);
    if (p) {
      pending.delete(msg.rid);
      clearTimeout(p.timer);
      if (msg.t === 'ok') p.resolve(msg); else p.reject(new Error(`${p.t} rejected: ${msg.code} ${msg.detail ?? ''}`));
    }
  }
};
const send = (obj) => pair.client.send(JSON.stringify(obj));
function request(t, fields = {}, timeoutMs = TIMEOUT_MS) {
  const id = ++rid;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${t} reply`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer, t });
    send({ t, ...fields, rid: id });
  });
}

try {
  // 1. handshake (net.js `_sendHello` → server/net.js welcome)
  const welcomePromise = waitFor((m) => m.t === 'welcome', 'welcome');
  send({ t: 'hello', rid: ++rid, name: '离线验证', version: PROTOCOL_VERSION });
  const welcome = await welcomePromise;
  check(!!welcome.playerId && !!welcome.token, 'hello → welcome (session created)', `playerId=${welcome.playerId}`);
  check(welcome.version === PROTOCOL_VERSION, 'protocol version matches', `v${welcome.version}`);

  // 2. create the solo room (this is what the title screen sends)
  await request('room.create', { mode: 'solo', difficulty: 'NORMAL' });
  const roomState = await waitFor((m) => m.t === 'room.state', 'room.state');
  check(roomState.mode === 'solo' && roomState.hostId === welcome.playerId, 'room.create → room.state (solo, host is us)',
    `code=${roomState.code}`);

  // 3. start the match — the engine constructs Match and runs its first phase
  await request('room.start', {});
  const pub = await waitFor((m) => m.t === 'm.public', 'm.public');
  const priv = await waitFor((m) => m.t === 'm.private', 'm.private');
  check(!!priv, 'room.start → m.private (the seat sees its own board)');
  check(pub.phase === PHASE.INFO_CHECK, 'match booted into INFO_CHECK', `phase=${pub.phase} round=${pub.round ?? '?'}`);
  check(pub.players?.length === 1, 'exactly one seat (solo)', `players=${pub.players?.length}`);
  check(frames.some((m) => m.t === 'room.state' && m.inMatch === true), 'room.state reports inMatch');

  // 4. the match is alive and advanced by the engine alone: the briefing confirm starts the strategy draft.
  // The phase change lands on a scheduler tick, so wait for the broadcast rather than reading it synchronously.
  await request('g.infoReady', {});
  const next = await waitFor((m) => m.t === 'm.public' && m.phase !== PHASE.INFO_CHECK, 'the phase after g.infoReady', 5000)
    .catch(() => null);
  check(!!next, 'g.infoReady → the engine advances the phase on its own', next ? `phase=${next.phase}` : 'no further m.public within 5s');

  // 5. the strategy draft: m.public carries it, the client offers the 40 strategies from its own data
  if (next?.phase === PHASE.BAND_DRAFT) {
    const draft = next.draft;
    check(!!draft && Array.isArray(draft.order), 'm.public carries the strategy draft',
      draft ? `turns=${draft.order.length} untimed=${draft.untimed}` : 'no draft in m.public');
    // The frame lists the turn order, not the offers: the client renders them from data/bands.json, so try the real
    // band ids until the engine accepts one (a band already taken by a teammate is refused).
    let picked = null;
    for (const bandId of Object.keys(getData().bands ?? {})) {
      try { await request('g.band', { bandId }); picked = bandId; break; } catch { /* not offered this draft */ }
    }
    check(!!picked, 'g.band accepted (a strategy could be taken)', picked ?? 'no band was accepted');

    // 6. PREP is the phase a player actually plays: the engine must have rolled a shop for the seat
    if (picked) {
      const prep = await waitFor((m) => m.t === 'm.public' && m.phase === PHASE.PREP, 'PREP after g.band', 6000).catch(() => null);
      check(!!prep, 'g.band → PREP (the shop phase)', prep ? `round=${prep.round}` : 'no PREP within 6s');
      if (prep) {
        const priv = frames.filter((m) => m.t === 'm.private').at(-1);
        const shop = priv?.shop ?? priv?.private?.shop ?? null;
        const slots = shop?.slots ?? shop?.offers ?? [];
        check(Array.isArray(slots) && slots.length > 0, 'PREP rolled a shop the player can buy from',
          Array.isArray(slots) ? `${slots.length} slots` : `m.private keys: ${Object.keys(priv ?? {}).join(',')}`);
      }
    }
  }
} catch (e) {
  check(false, 'protocol flow completed', e.message);
} finally {
  try { network.close(); } catch { /* ignore */ }
  if (!QUIET) {
    const counts = frames.reduce((acc, m) => { acc[m.t] = (acc[m.t] ?? 0) + 1; return acc; }, {});
    console.log(`\n  frames: ${frames.length}  ${JSON.stringify(counts)}`);
  }
}

console.log(problems.length ? `\nFAILED (${problems.length}): ${problems.join(' | ')}` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);
