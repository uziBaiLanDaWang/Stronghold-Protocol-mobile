// tools/verify-online.mjs — is a game server reachable from here, and is it serving a usable client?
//
//   node tools/verify-online.mjs                    # start a server in-process and test it (self-check)
//   node tools/verify-online.mjs 192.168.1.5:3000   # test a server on the LAN
//
// The Android app's online mode loads the client FROM the server (see android/java/**/MainActivity.java): it is a
// WebView pointed at that address, exactly like a desktop browser. So "can my phone join?" reduces to three
// questions this script answers in order:
//
//   1. does the address answer HTTP at all        (right IP? firewall? AP isolation? server running?)
//   2. does it serve the client and its modules    (index.html + an ES module with a JavaScript type)
//   3. does the WebSocket at /ws complete a handshake and accept the protocol (hello -> welcome -> room.create)
//
// Run it on the machine that hosts the game and point it at the LAN address the app will use: that is what proves
// the address works from another device, rather than from localhost.

import { PROTOCOL_VERSION } from '../shared/constants.js';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('-'));

const problems = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  !!  '} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) problems.push(label);
  return ok;
};

/** Accepts host, host:port, or a full http(s):// URL (what someone types into the app). */
function baseUrl(raw) {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);
  if (!u.port && u.protocol === 'http:') u.port = '3000';     // the port `npm start` prints
  return u;
}

async function httpCheck(url, { expectType = null, contains = null } = {}) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl?.signal, redirect: 'follow' });
    const text = await res.text();
    const type = res.headers.get('content-type') || '';
    const okType = !expectType || type.includes(expectType);
    const okBody = !contains || text.includes(contains);
    return { status: res.status, type, ok: res.ok && okType && okBody, text };
  } catch (e) {
    return { status: 0, type: '', ok: false, error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** One WebSocket round trip: hello -> welcome, then room.create -> room.state. */
function wsCheck(base) {
  const httpUrl = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${httpUrl}//${base.host}/ws`;
  return new Promise((resolve) => {
    const seen = [];
    let settled = false;
    const done = (ok, why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already gone */ }
      // Let the close frame flush before the process is allowed to end: exiting on top of an in-flight close trips
      // a libuv assertion on Windows (UV_HANDLE_CLOSING in async.c).
      setTimeout(() => resolve({ ok, why, seen }), 60);
    };
    const timer = setTimeout(() => done(false, 'timed out after 10 s'), 10000);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      done(false, `cannot open ${url}: ${e?.message || e}`);
      return;
    }
    ws.onerror = () => done(false, `socket error on ${url}`);
    ws.onclose = () => { if (!settled) done(false, 'closed before the handshake finished'); };
    ws.onopen = () => {
      // NB: the nickname must satisfy shared/protocol.js (name: isStr(v, NAME_MAX_LEN), NAME_MAX_LEN = 12).
      ws.send(JSON.stringify({ t: 'hello', rid: 1, name: 'verifier', version: PROTOCOL_VERSION }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      seen.push(msg.t);
      if (msg.t === 'error') { done(false, `server replied ${msg.code}`); return; }
      if (msg.t === 'welcome') {
        ws.send(JSON.stringify({ t: 'room.create', rid: 2, mode: 'solo', difficulty: 'NORMAL' }));
        return;
      }
      if (msg.t === 'room.state') { done(true, `room ${msg.code}`); }
    };
  });
}

async function main() {
  let srv = null;
  let base;
  if (target) {
    base = baseUrl(target);
    console.log(`checking ${base.href}\n`);
  } else {
    const { startServer } = await import('../server/index.js');
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = baseUrl(`127.0.0.1:${srv.port}`);
    console.log(`no address given - started a server in-process and checking ${base.href}\n`);
  }

  // 1. is anything listening?
  const health = await httpCheck(new URL('/healthz', base).href);
  if (check(health.ok, 'the server answers HTTP', health.status ? `HTTP ${health.status}` : health.error)) {
    try {
      const j = JSON.parse(health.text);
      check(j.ok === true, 'healthz reports ok', `app ${j.app}, protocol v${j.version}, build ${j.build}`);
    } catch { check(false, 'healthz is JSON'); }
  } else {
    console.log('\n  nothing answered. Things to check, in order:');
    console.log('    - is the game running on that machine?  (npm start)');
    console.log('    - is the address the one the start window printed? (http://192.168.x.x:3000)');
    console.log('    - Windows Firewall: allow "Private networks" for Node (npm run doctor prints the command)');
    console.log('    - guest Wi-Fi / router often enables "AP isolation": devices cannot reach each other');
    console.log('    - the phone and the host must be on the same network');
  }

  // 2. is the client served? (this is what the app loads in online mode)
  const page = await httpCheck(new URL('/', base).href, { expectType: 'text/html', contains: 'STRONGHOLD PROTOCOL' });
  check(page.ok, 'the client page is served', page.ok ? 'index.html' : `HTTP ${page.status} ${page.type} ${page.error ?? ''}`);
  const mod = await httpCheck(new URL('/js/net.js', base).href, { expectType: 'javascript' });
  check(mod.ok, 'ES modules are served with a JavaScript type', mod.ok ? 'js/net.js' : `HTTP ${mod.status} ${mod.type}`);
  const sim = await httpCheck(new URL('/sim/spec.js', base).href, { expectType: 'javascript' });
  check(sim.ok, 'the shared battle sim is served', sim.ok ? 'sim/spec.js' : `HTTP ${sim.status} ${sim.type}`);

  // 3. does the protocol work? (what the app needs to actually play)
  const ws = await wsCheck(base);
  check(ws.ok, 'WebSocket /ws: hello -> welcome -> room.create', ws.ok ? ws.why : ws.why);
  console.log(`       frames seen: ${ws.seen.join(' -> ') || '(none)'}`);

  if (srv) await srv.close();
  console.log(problems.length
    ? `\nFAILED (${problems.length}): ${problems.join(' | ')}`
    : '\nThe server is reachable and playable from another device.');
  // Set the code and let the loop drain instead of calling process.exit() on top of closing sockets; the unref'd
  // timer is only a backstop against a handle that refuses to let go.
  process.exitCode = problems.length ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
}

await main();
