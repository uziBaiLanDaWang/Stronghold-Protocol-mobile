// Offline solo mode: run the REAL platform + match engine inside the page, with no Node process and no WebSocket.
//
// DESIGN background: server/net.js (sessions, protocol validation, hello/welcome, rate limits, heartbeat),
// server/lobby.js (rooms, `room.create` / `room.start` / `room.loadout`, seat wiring) and server/match/Match.js
// (rounds, economy, shop, waves, AI) are all platform-free ES modules — the only files in server/ that touch Node
// APIs are index.js (http/fs), data.js (fs) and sim/nodeData.js (fs), and the two the engine needs (net.js,
// lobby.js) only reach `node:crypto` / `node:net`, which public/index.html maps to browser shims.
//
// So instead of re-implementing the protocol, this module reuses it verbatim and replaces the only genuinely Node
// part: the socket. `createSocketPair()` (js/local/socket-pair.js) stands in for one WebSocket, its server end is
// adopted by `Network.handleConnection()` exactly as a ws upgrade is, and the client end is handed to
// public/js/net.js through `net.WS` — a seam net.js already has (`const WS = this.WS || globalThis.WebSocket`,
// net.js:218). Everything in between is the production code path:
//   hello → welcome → ping/pong → room.create → room.state → room.start → m.public / m.private
//
// Nothing here runs unless offline mode is requested (`?local=1`); the engine is a dynamic import, so an online
// player never downloads it.

import { data } from '/js/data.js';
import { net } from '/js/net.js';
import { createSocketPair } from './socket-pair.js';

/** The data files server/data.js getData() would have produced, minus the optional ones (tuning, emotes, assets). */
export const MATCH_DATA_FILES = Object.freeze([
  'config', 'chess', 'bonds', 'garrisons', 'items', 'bands', 'effects', 'choices',
  'enemies', 'factions', 'waves', 'stages', 'bosses', 'tokens',
]);

/** The address the engine sees for the synthetic connection (loopback, so it never enters the trusted-proxy path). */
const LOCAL_ADDR = '127.0.0.1';

/** Recursively freeze, matching server/data.js deepFreeze so the engine cannot mutate the shared data. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const k of Object.keys(value)) deepFreeze(value[k]);
  }
  return value;
}

/** Console-backed logger in the shape Match/Lobby/Network expect; also kept in a ring buffer for diagnostics. */
export function createLocalLog(limit = 400) {
  const lines = [];
  const push = (level, args) => {
    const text = args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    lines.push({ level, text });
    if (lines.length > limit) lines.shift();
    if (level === 'error') console.error('[local]', text);
    else if (level === 'warn') console.warn('[local]', text);
    else console.debug('[local]', text);
  };
  return {
    lines,
    info: (...a) => push('info', a),
    warn: (...a) => push('warn', a),
    error: (...a) => push('error', a),
    debug: (...a) => push('debug', a),
  };
}

/**
 * Load the game data the match engine needs out of the client's lazy data store, shaped exactly like
 * server/data.js getData(): a plain, deep-frozen `{ <file>: <parsed JSON> }` object.
 * Missing keys are fatal here — Match would silently fall back to its DEFAULTS and the economy would be wrong.
 * @returns {Promise<Record<string, any>>}
 */
export async function loadMatchData({ store = data } = {}) {
  await store.loadAll(MATCH_DATA_FILES);
  const raw = {};
  const missing = [];
  for (const name of MATCH_DATA_FILES) {
    const value = store.get(name);
    if (value == null) missing.push(name);
    else raw[name] = value;
  }
  if (missing.length) throw new Error(`offline mode: game data not available: ${missing.join(', ')}`);
  if (!raw.chess || !raw.config) throw new Error('offline mode: chess/config data is empty');
  return deepFreeze(raw);
}

/**
 * Boot the real Network + Lobby + Match inside the page and point the client's `net` singleton at them.
 *
 * @param {object} [opts]
 * @param {(msg: object) => void} [opts.onFrame] observe every server→client frame (diagnostics / tests)
 * @param {(err: Error) => void} [opts.onError]
 * @returns {Promise<{ network: any, lobby: any, log: any, matchData: object, socket: () => any,
 *                    frameCount: () => number, dispose: () => void }>}
 */
export async function installLocalServer({ onFrame, onError } = {}) {
  const [{ Network, SessionRegistry }, { Lobby }, { Match }] = await Promise.all([
    import('/engine/net.js'),
    import('/engine/lobby.js'),
    import('/engine/match/Match.js'),
  ]);

  const log = createLocalLog();
  const matchData = await loadMatchData();

  const registry = new SessionRegistry({});
  const lobby = new Lobby({
    registry,
    log,
    MatchClass: Match,
    getData: () => matchData,
    options: {},
  });
  const network = new Network({ registry, handler: lobby, log, options: {} });

  let pair = null;

  /**
   * The class public/js/net.js instantiates instead of the browser WebSocket (net.js:218).
   *
   * It returns the pair's CLIENT FACADE rather than itself, because net.js reads and assigns those members on the
   * instance it gets back: `ws.readyState` (net.js:214/476 — every send is silently dropped unless this is OPEN),
   * `ws.send`, `ws.close` and the onopen/onmessage/onclose callbacks that `connect()` assigns right after the
   * constructor returns (net.js:230-233). A constructor returning an object yields that object from `new`.
   */
  class LocalWebSocket {
    constructor() {
      const next = createSocketPair({ onFrame });
      pair = next;
      try {
        // Adopt the server end exactly as server/index.js does for a ws upgrade (index.js:685).
        network.handleConnection(next.server, { socket: { remoteAddress: LOCAL_ADDR }, headers: {} });
      } catch (e) {
        log.error('[local] handleConnection threw', e);
        onError?.(e);
      }
      next.open();
      return next.client;
    }
  }

  net.WS = LocalWebSocket;
  // A local server has nothing to reconnect to, and reconnecting would drop the running match.
  net.attachBrowserHooks = () => {};

  const api = {
    network,
    lobby,
    log,
    matchData,
    socket: () => pair,
    frameCount: () => pair?.frames ?? 0,
    dispose() {
      try { network.close(); } catch { /* ignore */ }
      net.WS = null; // fall back to globalThis.WebSocket
    },
  };
  globalThis.__SP_LOCAL__ = api;
  return api;
}

/**
 * Let go of the in-process engine, handing net.js back to the browser's own WebSocket and to Net.prototype's own
 * browser hooks (which {@link installLocalServer} had stubbed out).
 *
 * Used when the app points this page's client at a real server instead (public/js/shell.js): the client on the page
 * keeps running - same code, same sim, same assets - and only its transport changes. The caller closes the client
 * side first (`net.close()`), so nothing here can schedule a reconnect against a socket that is going away.
 */
export function detachLocalEngine() {
  try { globalThis.__SP_LOCAL__?.dispose(); } catch { /* already gone */ }
  net.WS = null;                  // connect() falls back to globalThis.WebSocket (net.js:218)
  delete net.attachBrowserHooks;  // and to the prototype method the offline mode had replaced
}
