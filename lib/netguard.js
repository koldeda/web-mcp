// Network guard: decides which destinations fetch_page may contact.
// Everything here is pure (no I/O) so it can be tested exhaustively.

import net from 'node:net';
import { safeFragment } from './text.js';

// ---- IPv4 ------------------------------------------------------------------

// [network, prefix length]. Private, loopback, link-local, CGNAT/Tailscale,
// documentation, benchmarking, multicast and reserved ranges.
const V4_BLOCKED = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT, used by Tailscale
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private, Docker networks
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private, home LAN
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
];

function v4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const V4_RULES = V4_BLOCKED.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (v4ToInt(base) & mask) >>> 0, mask };
});

export function isBlockedIPv4(ip) {
  if (!net.isIPv4(ip)) return true; // fail closed
  const n = v4ToInt(ip);
  return V4_RULES.some((r) => ((n & r.mask) >>> 0) === r.net);
}

// ---- IPv6 ------------------------------------------------------------------

// Expand any valid IPv6 text form (including "::" and an embedded dotted
// IPv4 tail) into 8 16-bit groups. Returns null for anything unexpected.
export function expandIPv6(ip) {
  if (typeof ip !== 'string' || ip.includes('%') || !net.isIPv6(ip)) return null;
  let s = ip.toLowerCase();
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!net.isIPv4(tail)) return null;
    const n = v4ToInt(tail);
    s = `${s.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array(fill).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function embeddedV4(hi, lo) {
  return [hi >>> 8, hi & 0xff, lo >>> 8, lo & 0xff].join('.');
}

export function isBlockedIPv6(ip) {
  const g = expandIPv6(ip);
  if (!g) return true; // fail closed
  const zeroUpTo = (n) => g.slice(0, n).every((x) => x === 0);

  // ::ffff:a.b.c.d (IPv4-mapped): judge by the embedded IPv4 address.
  if (zeroUpTo(5) && g[5] === 0xffff) return isBlockedIPv4(embeddedV4(g[6], g[7]));
  // ::ffff:0:a.b.c.d (IPv4-translated): same.
  if (zeroUpTo(4) && g[4] === 0xffff && g[5] === 0) return isBlockedIPv4(embeddedV4(g[6], g[7]));
  // ::/96 covers ::, ::1 and the deprecated IPv4-compatible form: block.
  if (zeroUpTo(6)) return true;
  // 64:ff9b::/96 (NAT64): judge by the embedded IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedIPv4(embeddedV4(g[6], g[7]));
  }
  // 64:ff9b:1::/48 (local-use NAT64): block.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
  // 2002::/16 (6to4): judge by the embedded IPv4 address in groups 1-2.
  if (g[0] === 0x2002) return isBlockedIPv4(embeddedV4(g[1], g[2]));
  // 2001:0::/32 (Teredo, embeds an obfuscated IPv4): block.
  if (g[0] === 0x2001 && g[1] === 0) return true;
  // 2001:db8::/32 (documentation): block.
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  // 100::/64 (discard prefix): block.
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 old site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  return true; // not an IP at all: fail closed
}

// ---- Hostnames -------------------------------------------------------------

const BLOCKED_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'home.arpa',
  'ts.net', // Tailscale MagicDNS
  'lan',
  'intranet',
  'localdomain',
];

// Returns null if the hostname may be contacted, otherwise a reason.
export function checkHostname(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return 'missing hostname';
  let h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (net.isIP(h)) return isBlockedIp(h) ? `blocked address ${safeFragment(h)}` : null;
  h = h.replace(/\.+$/, ''); // "localhost.." must not slip through
  if (h.length === 0 || h.split('.').some((label) => label.length === 0)) return 'invalid hostname';
  // Single-label names (e.g. "searxng", "egress", "router") are local by nature.
  if (!h.includes('.')) return `single-label hostname "${safeFragment(h)}" is not allowed`;
  if (BLOCKED_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`))) {
    return `hostname "${safeFragment(h, 60)}" is on the local-name blocklist`;
  }
  return null;
}

// ---- URLs ------------------------------------------------------------------

export const MAX_URL_LENGTH = 1000;

// Full check for a URL fetch_page is about to contact (also used on every
// redirect hop). Returns { ok: true, url } or { ok: false, error }.
export function validateFetchUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, error: 'url must be a non-empty string' };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, error: `url longer than ${MAX_URL_LENGTH} characters` };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'url is not a valid absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `scheme ${safeFragment(url.protocol, 12)} is not allowed (http/https only)` };
  }
  if (url.username || url.password) return { ok: false, error: 'credentials in URLs are not allowed' };
  if (url.port !== '' && url.port !== '80' && url.port !== '443') {
    return { ok: false, error: `port ${url.port} is not allowed (80/443 only)` };
  }
  const reason = checkHostname(url.hostname);
  if (reason) return { ok: false, error: reason };
  return { ok: true, url };
}
