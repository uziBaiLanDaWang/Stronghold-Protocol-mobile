// public/js/shell.js — the Android shell's bridge.
//
// android/java/**/MainActivity.java wraps this client in a WebView and exposes a small object on
// window.__SP_SHELL__, for the two things a page cannot work out on its own:
//
//   * whether it came out of the APK's bundle (the offline engine, no server) or off a server - the lobby only
//     offers a server address in the former case;
//   * changing origin. A page cannot navigate itself to another server and keep its session, so the shell owns
//     navigation and the page only asks.
//
// The bridge is installed for the bundled page ONLY and removed before a server page is loaded, so a page served by
// someone else's server has no interface into the app at all.
//
// In a plain browser none of this exists: every accessor degrades to a no-op, isBundled() is false, and the lobby
// renders exactly what upstream renders.

/** The bridge object, or null in a plain browser. */
function bridge() {
  try { return globalThis.__SP_SHELL__ ?? null; } catch { return null; }
}

/** The port the game's own server listens on (README: 默认监听 TCP 3000). */
export const DEFAULT_SERVER_PORT = 3000;

/** True when this page is the copy inside the APK, running the bundled offline engine. */
export function isBundled() {
  try { return !!(bridge() && bridge().bundled()); } catch { return false; }
}

/** The server address the player connected to last ('' when there is none). */
export function shellServer() {
  try { return String(bridge()?.server() ?? ''); } catch { return ''; }
}

/** Remember an address for the next launch. No-op in a browser. */
export function rememberServer(address) {
  try { bridge()?.setServer(String(address ?? '')); } catch { /* a browser has nowhere to put it */ }
}

/**
 * Ask the shell to load the client FROM `url` (the escape hatch: a server running a different version ships its own
 * client, which is then guaranteed to match).
 * @returns {boolean} false when there is no shell (a browser cannot be told to do this)
 */
export function shellConnect(url) {
  const s = bridge();
  if (!s) return false;
  try { s.connect(url); return true; } catch { return false; }
}

/**
 * Fetch a server's /healthz through the shell, which has no CORS to worry about (this page is on the asset origin,
 * so doing it here would be a cross-origin request).
 * @param {string} serverUrl already normalised
 * @returns {{app: string, version: number, build: string}|null}
 */
export function probeServer(serverUrl) {
  const s = bridge();
  if (!s || !serverUrl) return null;
  let health;
  try { health = new URL('/healthz', serverUrl).href; } catch { return null; }
  try {
    const text = s.probe(health);
    const j = text ? JSON.parse(text) : null;
    return j && j.ok
      ? { app: String(j.app ?? ''), version: Number(j.version ?? 0), build: String(j.build ?? '') }
      : null;
  } catch { return null; }
}

/** The `ws://` endpoint of a server (the game is always mounted at the root: README, 联机方式). */
export function wsUrlFor(serverUrl) {
  try {
    const u = new URL(serverUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = '';
    u.hash = '';
    return u.href;
  } catch { return ''; }
}

/** The server this page is currently talking to over the network ('' when it is the local engine). */
let remote = '';
export function remoteServerUrl() { return remote; }

/**
 * Point the client on THIS page at a server, instead of loading that server's copy of the client.
 *
 * This is what the app does by default, and it is the reason the two schemes line up: the client, its ~316 MB of
 * art and audio, its data tables and even the battle sim all stay in the APK, and the only thing that crosses the
 * network is one WebSocket. It is the same client and the same sim either way, so a match behaves identically - so
 * long as both ends are the same build, which is what probeServer() checks before calling this.
 *
 * The offline engine's socket is let go first: it is a server of one, and net.js only talks to one server at a time.
 *
 * @returns {Promise<boolean>} false when the address is unusable or there is no offline engine to step away from
 */
export async function connectWithLocalClient(serverUrl) {
  const ws = wsUrlFor(serverUrl);
  if (!ws) return false;
  const [{ net }, { detachLocalEngine }] = await Promise.all([
    import('./net.js'),
    import('./local/server.js'),
  ]);
  net.close();                 // drop the in-process socket without letting net.js schedule a reconnect
  detachLocalEngine();
  net.url = ws;                // net.js prefers this over defaultWsUrl() (net.js:219)
  net.connect();
  remote = serverUrl;
  return true;
}

/** Back to the offline engine: the page is reloaded, which reinstalls it (main.js, ?local=1). */
export function backToLocalClient() {
  remote = '';
  try { globalThis.location.reload(); return true; } catch { return false; }
}

/**
 * Turn what someone typed into a URL to load.
 *
 * Accepts a bare host, a host:port, a full http(s) URL, or an invite link a friend shared - the query is kept, so
 * pasting `http://192.168.1.5:3000/?room=ABCD` and connecting drops straight into that room. A bare http address
 * with no port gets the default 3000, because that is what `npm start` prints and what people type.
 *
 * @param {string} raw
 * @returns {string} the URL, or '' when it is not usable
 */
export function normalizeServer(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  // People paste these out of a chat client, which likes to wrap them in brackets.
  s = s.replace(/^[<([「【]+/, '').replace(/[>)\]」】]+$/, '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try { u = new URL(s); } catch { return ''; }
  if (!u.hostname) return '';
  if (!u.port && u.protocol === 'http:') u.port = String(DEFAULT_SERVER_PORT);
  return u.href;
}

/**
 * The same server, for starting a NEW room: any `?room=` the typed address carried is dropped, since that one
 * belongs to the room the link was pointing at.
 * @param {string} url an already normalised URL
 */
export function serverRootFor(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('room');
    return u.href;
  } catch { return url; }
}
