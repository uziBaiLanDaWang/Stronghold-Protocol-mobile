// A connected socket pair standing in for one WebSocket, shared by the browser offline mode
// (public/js/local/server.js) and the Node-side verification (tools/verify-offline.mjs).
//
// This module deliberately has NO imports and no browser globals, so the exact same code that carries the real
// match engine in a page can be driven from Node in a test.
//
// `server` mimics the subset of the `ws` API server/net.js uses: readyState, bufferedAmount, on/off, send, ping,
// close, terminate (net.js:267-272 send, :551-556 events, :701-711 heartbeat).
// `client` mimics the browser WebSocket surface public/js/net.js uses: readyState, send, close and the
// onopen/onmessage/onerror/onclose callbacks (net.js:230-233).

/** ws / browser WebSocket readyState values. */
export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

/**
 * @param {object} [opts]
 * @param {(msg: object) => void} [opts.onFrame] observe every server→client frame
 * @param {(text: string) => void} [opts.onText] observe raw server→client text (before parsing)
 */
export function createSocketPair({ onFrame, onText } = {}) {
  const pair = {
    closed: false,
    frames: 0,
    server: null,
    client: null,
    open() {},
    closeFromServer(code, reason) {},
    closeFromClient(code, reason) {},
  };

  const listeners = new Map();

  pair.server = {
    readyState: OPEN,
    bufferedAmount: 0,
    on(ev, fn) {
      const list = listeners.get(ev);
      if (list) list.push(fn); else listeners.set(ev, [fn]);
      return this;
    },
    off(ev, fn) {
      const list = listeners.get(ev);
      if (list) listeners.set(ev, list.filter((f) => f !== fn));
      return this;
    },
    _fire(ev, ...args) {
      for (const fn of listeners.get(ev) ?? []) {
        try { fn(...args); } catch (e) { console.error(`[local] socket "${ev}" listener threw`, e); }
      }
    },
    send(payload, cb) {
      pair.frames += 1;
      if (!pair.closed) {
        if (onText && typeof payload === 'string') { try { onText(payload); } catch { /* observer */ } }
        let parsed = null;
        try { parsed = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch { /* non-JSON frame */ }
        if (parsed && onFrame) { try { onFrame(parsed); } catch { /* an observer must not break the link */ } }
        try { pair.client.onmessage?.({ type: 'message', data: payload }); } catch (e) { console.error('[local] onmessage threw', e); }
      }
      if (typeof cb === 'function') cb();
    },
    // A browser answers a ping with a pong automatically; the synthetic peer is always responsive.
    ping() { queueMicrotask(() => { if (!pair.closed) pair.server._fire('pong'); }); },
    close(code = 1000, reason = '') { pair.closeFromServer(code, reason); },
    terminate() { pair.closeFromServer(1006, 'terminated'); },
  };

  pair.client = {
    readyState: CONNECTING, // OPEN once open() runs
    bufferedAmount: 0,
    url: 'ws://local/ws',
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    // net.js serialises with JSON.stringify before sending (net.js:478), so the engine sees a string.
    send: (payload) => { if (!pair.closed) pair.server._fire('message', payload, false); },
    close: (code = 1000, reason = '') => pair.closeFromClient(code, reason),
  };

  /**
   * The page's socket is open. Deferred by a microtask because net.js assigns `ws.onopen` *after* `new WS(url)`
   * returns (net.js:228-230).
   */
  pair.open = () => {
    queueMicrotask(() => {
      if (pair.closed) return;
      pair.client.readyState = OPEN;
      try { pair.client.onopen?.({ type: 'open' }); } catch (e) { console.error('[local] onopen threw', e); }
    });
  };

  const close = (code, reason, from) => {
    if (pair.closed) return;
    pair.closed = true;
    pair.server.readyState = CLOSED;
    pair.client.readyState = CLOSED;
    if (from === 'server') {
      try { pair.client.onclose?.({ type: 'close', code, reason, wasClean: code === 1000 }); } catch (e) { console.error('[local] onclose threw', e); }
    }
    pair.server._fire('close', { code, reason });
  };
  pair.closeFromServer = (code, reason) => close(code, reason, 'server');
  pair.closeFromClient = (code, reason) => close(code, reason, 'client');

  return pair;
}
