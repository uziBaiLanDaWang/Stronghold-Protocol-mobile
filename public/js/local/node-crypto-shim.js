// Browser stand-in for `node:crypto`, mapped through the import map in public/index.html.
//
// The offline solo mode runs the REAL match engine (server/match/Match.js) and the real platform layer
// (server/net.js, server/lobby.js) inside the page. Those two files are the only reachable modules that import
// node:crypto, and they use exactly two entry points:
//   server/net.js:38   import { randomBytes } from 'node:crypto';   → newToken(), playerId generation
//   server/lobby.js:80 import { randomBytes, randomInt } from 'node:crypto'; → bot playerIds, seed, room codes
// Everything else in the engine (server/match/**, server/sim/**, shared/**) is already platform-free.
//
// `crypto.getRandomValues` is available in insecure contexts (only crypto.subtle needs a secure context), so this
// works when the game is opened over plain-HTTP LAN, which is the whole point of the offline mode.

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));

/** Minimal Buffer-ish wrapper: the engine only ever calls `.toString('hex')` on randomBytes results. */
class Bytes {
  constructor(u8) { this._u8 = u8; }
  get length() { return this._u8.length; }
  get byteLength() { return this._u8.length; }
  toString(enc = 'utf8') {
    if (enc === 'hex') {
      let s = '';
      for (let i = 0; i < this._u8.length; i++) s += HEX[this._u8[i]];
      return s;
    }
    if (enc === 'base64') {
      let bin = '';
      for (let i = 0; i < this._u8.length; i++) bin += String.fromCharCode(this._u8[i]);
      return btoa(bin);
    }
    if (enc === 'utf8' || enc === 'utf-8') return new TextDecoder().decode(this._u8);
    throw new Error(`node-crypto shim: unsupported encoding "${enc}"`);
  }
  at(i) { return this._u8.at(i); }
  [Symbol.iterator]() { return this._u8[Symbol.iterator](); }
}

/**
 * node:crypto randomBytes(size) → Buffer.
 * @param {number} size
 */
export function randomBytes(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) throw new Error('node-crypto shim: invalid randomBytes size');
  const u8 = new Uint8Array(Math.floor(n));
  globalThis.crypto.getRandomValues(u8);
  return new Bytes(u8);
}

/**
 * node:crypto randomInt(max) | randomInt(min, max) — half-open [min, max), uniform.
 * Rejection sampling so there is no modulo bias (the engine derives room codes and the master seed from this).
 */
export function randomInt(min, max) {
  if (max === undefined) { max = min; min = 0; }
  const lo = Math.ceil(Number(min));
  const hi = Math.floor(Number(max));
  const span = hi - lo;
  if (!Number.isFinite(span) || span <= 0) throw new Error('node-crypto shim: invalid randomInt range');
  const limit = Math.floor(0x1_0000_0000 / span) * span;
  const buf = new Uint32Array(1);
  let v;
  do { globalThis.crypto.getRandomValues(buf); v = buf[0]; } while (v >= limit);
  return lo + (v % span);
}

/** Not implemented: nothing reachable from the browser engine imports it. Fails loudly rather than silently. */
export function createHash() {
  throw new Error('node-crypto shim: createHash() is not implemented in the browser');
}

export const webcrypto = globalThis.crypto;
export default { randomBytes, randomInt, createHash, webcrypto };
