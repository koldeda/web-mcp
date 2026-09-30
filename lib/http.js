// Minimal HTTP client on node:http/net/tls with:
//  - one hard deadline (AbortSignal) covering connect, TLS, headers AND body,
//  - a byte cap on both the raw and the decompressed body,
//  - pluggable socket openers: direct (optionally IP-guarded and pinned to the
//    checked address) or through an HTTP CONNECT proxy.
// No redirects are followed here; callers decide what to do with a 3xx.

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import dns from 'node:dns/promises';
import { isBlockedIp } from './netguard.js';
import { safeFragment } from './text.js';

export const USER_AGENT = 'Mozilla/5.0 (compatible; local-web-mcp/1.0)';

export class HttpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HttpError';
  }
}

function abortError(signal) {
  const r = signal && signal.reason;
  return r instanceof HttpError ? r : new HttpError('request timed out');
}

// Wait for a socket event, rejecting on error/close/abort.
function waitFor(socket, event, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off(event, onOk);
      socket.off('error', onErr);
      socket.off('close', onClose);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onOk = () => { cleanup(); resolve(); };
    const onErr = (e) => { cleanup(); reject(new HttpError(`connection failed: ${e.code || e.message}`)); };
    const onClose = () => { cleanup(); reject(new HttpError('connection closed')); };
    const onAbort = () => { cleanup(); socket.destroy(); reject(abortError(signal)); };
    if (signal && signal.aborted) return onAbort();
    socket.once(event, onOk);
    socket.once('error', onErr);
    socket.once('close', onClose);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Reject as soon as the deadline fires, even if the promise never settles.
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function hostOf(url) {
  const h = url.hostname;
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function portOf(url) {
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
}

async function defaultResolve(host) {
  const records = await dns.lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

// Direct TCP connection. With guard=true every resolved address is checked
// and the socket is pinned to the checked address (no second DNS lookup, so
// DNS rebinding cannot swap it). resolve/dial are injectable for tests only.
export function directOpener({ guard, resolve = defaultResolve, dial = null } = {}) {
  return async (url, signal) => {
    const host = hostOf(url);
    const port = portOf(url);
    let addresses;
    if (net.isIP(host)) {
      addresses = [host];
    } else {
      try {
        addresses = await raceAbort(resolve(host), signal);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(`could not resolve ${safeFragment(host, 80)}: ${safeFragment(e.code || 'error')}`);
      }
    }
    if (!addresses || addresses.length === 0) throw new HttpError(`no address for ${host}`);
    if (guard) {
      const bad = addresses.find((a) => isBlockedIp(a));
      if (bad) throw new HttpError(`destination ${safeFragment(host, 80)} resolves to blocked address ${safeFragment(bad)}`);
    }
    const target = dial ? dial(addresses[0], port) : { host: addresses[0], port };
    const socket = net.connect(target);
    await waitFor(socket, 'connect', signal);
    return socket;
  };
}

// Tunnel through an HTTP proxy with CONNECT (used for http and https alike).
// The proxy resolves DNS and enforces its own destination blocklist.
export function proxyOpener(proxyUrl) {
  const p = new URL(proxyUrl);
  const proxyHost = hostOf(p);
  const proxyPort = Number(p.port) || 3128;
  return async (url, signal) => {
    const host = hostOf(url);
    const port = portOf(url);
    const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    await waitFor(socket, 'connect', signal);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    const head = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const cleanup = () => {
        socket.off('data', onData);
        socket.off('error', onErr);
        socket.off('close', onClose);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) {
          if (buf.length > 8192) { cleanup(); socket.destroy(); reject(new HttpError('proxy response header too large')); }
          return;
        }
        cleanup();
        socket.pause();
        const rest = buf.subarray(end + 4);
        if (rest.length) socket.unshift(rest);
        resolve(buf.subarray(0, end).toString('latin1'));
      };
      const onErr = (e) => { cleanup(); reject(new HttpError(`proxy connection failed: ${e.code || e.message}`)); };
      const onClose = () => { cleanup(); reject(new HttpError('proxy closed the connection')); };
      const onAbort = () => { cleanup(); socket.destroy(); reject(abortError(signal)); };
      socket.on('data', onData);
      socket.once('error', onErr);
      socket.once('close', onClose);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
    const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
    const code = m ? Number(m[1]) : 0;
    if (code !== 200) {
      socket.destroy();
      throw new HttpError(`blocked by egress proxy (CONNECT ${safeFragment(authority, 90)} -> HTTP ${code || '?'})`);
    }
    return socket;
  };
}

function decoderFor(encoding) {
  switch (encoding) {
    case '':
    case 'identity':
      return null;
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      throw new HttpError('unsupported content-encoding (only gzip, deflate, br)');
  }
}

// One GET request. Resolves to either
//   { redirect: true, status, location }  or
//   { redirect: false, status, contentType, charset, body: Buffer }
export async function httpGet(url, { signal, openSocket, maxBytes, allowedTypes, accept }) {
  if (signal && signal.aborted) throw abortError(signal);
  let socket = await openSocket(url, signal);
  if (url.protocol === 'https:') {
    const host = hostOf(url);
    socket = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] });
    await waitFor(socket, 'secureConnect', signal);
  }
  const conn = socket;
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = null;
    let decoder = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      // Stop everything, including a decompressor that may still hold input
      // (otherwise a small "zip bomb" keeps burning CPU after rejection).
      if (decoder) decoder.destroy();
      if (response) response.destroy();
      conn.destroy();
      fn(v);
    };
    const onAbort = () => finish(reject, abortError(signal));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const req = http.request({
      method: 'GET',
      host: hostOf(url),
      path: `${url.pathname}${url.search}`,
      headers: {
        Host: url.host,
        'User-Agent': USER_AGENT,
        Accept: accept,
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'close',
      },
      // No `agent` option: with agent:false Node ignores createConnection.
      // The proxy opener leaves the socket paused after the CONNECT reply;
      // resume it once the HTTP parser has attached (nothing can arrive
      // before our request is written).
      createConnection: () => {
        if (conn.isPaused()) process.nextTick(() => conn.resume());
        return conn;
      },
    });
    req.on('error', (e) => finish(reject, e instanceof HttpError ? e : new HttpError(`request failed: ${e.code || e.message}`)));
    req.on('response', (res) => {
      response = res;
      const status = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = res.headers.location;
        res.resume();
        if (!location) return finish(reject, new HttpError(`HTTP ${status} without Location header`));
        return finish(resolve, { redirect: true, status, location });
      }
      if (status < 200 || status > 299) {
        res.resume();
        return finish(reject, new HttpError(`HTTP ${status}`));
      }
      const ctHeader = String(res.headers['content-type'] || '');
      const contentType = ctHeader.split(';')[0].trim().toLowerCase();
      if (!allowedTypes.includes(contentType)) {
        res.resume();
        // The header value itself is never echoed (it is attacker-controlled).
        const known = ['application/pdf', 'application/json', 'image/png', 'image/jpeg', 'application/octet-stream'];
        const shown = !contentType ? 'none' : known.includes(contentType) ? contentType : 'other';
        return finish(reject, new HttpError(`content-type "${shown}" is not allowed (only ${allowedTypes.join(', ')})`));
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.resume();
        return finish(reject, new HttpError(`response too large (> ${maxBytes} bytes)`));
      }
      try {
        decoder = decoderFor(String(res.headers['content-encoding'] || '').trim().toLowerCase());
      } catch (e) {
        res.resume();
        return finish(reject, e);
      }
      const charsetMatch = /charset\s*=\s*["']?([\w.:-]+)/i.exec(ctHeader);
      const charset = charsetMatch ? charsetMatch[1].toLowerCase() : null;
      const chunks = [];
      let raw = 0;
      let decoded = 0;
      const tooLarge = () => finish(reject, new HttpError(`response too large (> ${maxBytes} bytes)`));
      res.on('data', (c) => {
        raw += c.length;
        if (raw > maxBytes) tooLarge();
      });
      const body = decoder ? res.pipe(decoder) : res;
      body.on('data', (c) => {
        decoded += c.length;
        if (decoded > maxBytes) return tooLarge();
        chunks.push(c);
      });
      body.on('end', () => finish(resolve, { redirect: false, status, contentType, charset, body: Buffer.concat(chunks) }));
      body.on('error', (e) => finish(reject, new HttpError(`could not read response: ${e.code || e.message}`)));
      res.on('aborted', () => finish(reject, new HttpError('response aborted')));
    });
    req.end();
  });
}

export function decodeBody(buf, charset) {
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      // unknown label: fall back to UTF-8
    }
  }
  return new TextDecoder('utf-8').decode(buf);
}
