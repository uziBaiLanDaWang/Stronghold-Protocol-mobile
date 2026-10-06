// Browser stand-in for `node:net`, mapped through the import map in public/index.html.
//
// server/net.js:39 is the only reachable import (`import { isIP } from 'node:net'`); it gates the forwarding-header
// trust rules and the per-network limit key (clientAddress / normalizeIp). The offline solo mode connects over a
// synthetic in-page socket with the address 127.0.0.1, so this only has to be correct enough to classify that —
// but a wrong answer would silently change the rate-limit bucket, so the parser is a real one.

/** Is `s` a dotted-quad IPv4 literal? */
function isIPv4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    if (Number(p) > 255) return false;
    if (p.length > 1 && p[0] === '0') return false; // leading zeros are not valid in the strict form
  }
  return true;
}

/** Is `s` an IPv6 literal (including `::` compression and an IPv4-mapped tail)? */
function isIPv6(s) {
  if (!s.includes(':')) return false;
  let head = s;
  // an IPv4-mapped / -compatible tail counts as two groups
  const tail = s.slice(s.lastIndexOf(':') + 1);
  let extraGroups = 0;
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return false;
    head = s.slice(0, s.lastIndexOf(':'));
    extraGroups = 2;
  }
  const hasCompression = head.includes('::');
  if (head.indexOf('::') !== head.lastIndexOf('::')) return false; // at most one `::`
  const groups = head.split(':').filter((g) => g.length > 0);
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
  }
  const total = groups.length + extraGroups;
  if (hasCompression) return total <= 7;
  return total === 8;
}

/**
 * node:net isIP(input) → 0 (not an IP) | 4 | 6.
 * @param {unknown} input
 */
export function isIP(input) {
  const s = String(input ?? '').trim();
  if (!s) return 0;
  if (isIPv4(s)) return 4;
  if (isIPv6(s)) return 6;
  return 0;
}

/** Node also exports these; kept as honest stubs so a future import fails loudly instead of at runtime. */
export function createServer() {
  throw new Error('node-net shim: createServer() is not available in the browser');
}

export default { isIP, createServer };
