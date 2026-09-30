// fetch_page: read the text of a page that web_search returned earlier in
// this process. Disabled unless WEB_ALLOW_FETCH=1.

import { httpGet, directOpener, proxyOpener, decodeBody, HttpError } from './http.js';
import { validateFetchUrl } from './netguard.js';
import { htmlToText, neutralize, truncate, wrap } from './text.js';

export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
export const FETCH_MAX_REDIRECTS = 3;
export const FETCH_MAX_PER_PROCESS = 5;
export const FETCH_MAX_CHARS = 20_000;
export const FETCH_MAX_ATTEMPTS = 20; // failed attempts count too
const ALLOWED_TYPES = ['text/html', 'text/plain'];

function logUrl(u) {
  return String(u).replace(/[\u0000-\u001F\u007F-\u009F]/g, '').slice(0, 300);
}

// ctx: {
//   returnedUrls: Set, counter: { successes, inFlight, attempts }, log,
//   proxy: string|null            (EGRESS_PROXY; null = direct guarded mode)
//   resolve?, dial?, timeoutMs?, maxFetches?   (test hooks, never from env)
// }
export async function fetchPage(rawUrl, ctx) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return { ok: false, error: 'url must be a non-empty string' };
  if (!ctx.returnedUrls.has(rawUrl)) {
    return { ok: false, error: 'fetch_page only accepts URLs returned by web_search in this session (exact match)' };
  }
  const max = ctx.maxFetches ?? FETCH_MAX_PER_PROCESS;
  const c = ctx.counter;
  c.inFlight = c.inFlight || 0;
  c.attempts = c.attempts || 0;
  // Reserve the slot before any await, so parallel calls cannot exceed it.
  if (c.successes + c.inFlight >= max) return { ok: false, error: `fetch limit reached (${max} pages per session)` };
  if (c.attempts >= (ctx.maxAttempts ?? FETCH_MAX_ATTEMPTS)) return { ok: false, error: 'too many fetch attempts in this session' };
  c.inFlight += 1;
  c.attempts += 1;
  try {
    return await fetchOnce(rawUrl, ctx);
  } finally {
    c.inFlight -= 1;
  }
}

async function fetchOnce(rawUrl, ctx) {
  const openSocket = ctx.proxy
    ? proxyOpener(ctx.proxy)
    : directOpener({ guard: true, resolve: ctx.resolve, dial: ctx.dial });

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new HttpError('page fetch timed out')),
    ctx.timeoutMs ?? FETCH_TIMEOUT_MS,
  );
  let hop = 0;
  try {
    let current = rawUrl;
    for (; ; hop++) {
      const v = validateFetchUrl(current);
      if (!v.ok) return { ok: false, error: hop === 0 ? v.error : `redirect blocked: ${v.error}` };
      ctx.log(hop === 0 ? `[fetch] ${logUrl(current)}` : `[fetch] redirect ${hop} -> ${logUrl(current)}`);
      const res = await httpGet(v.url, {
        signal: controller.signal,
        openSocket,
        maxBytes: FETCH_MAX_BYTES,
        allowedTypes: ALLOWED_TYPES,
        accept: 'text/html, text/plain;q=0.9',
      });
      if (res.redirect) {
        if (hop >= FETCH_MAX_REDIRECTS) return { ok: false, error: `too many redirects (max ${FETCH_MAX_REDIRECTS})` };
        try {
          current = new URL(res.location, v.url).href;
        } catch {
          // never echo the attacker's Location value
          return { ok: false, error: 'redirect to an invalid URL' };
        }
        continue;
      }
      const raw = decodeBody(res.body, res.charset);
      const text = res.contentType === 'text/html' ? htmlToText(raw) : raw;
      let clean = neutralize(text).trim();
      const cut = clean.length > FETCH_MAX_CHARS;
      clean = truncate(clean, FETCH_MAX_CHARS);
      ctx.counter.successes += 1;
      const note = cut ? `\n\n[truncated at ${FETCH_MAX_CHARS} characters]` : '';
      return { ok: true, text: wrap(`URL: ${neutralize(v.url.href)}\n\n${clean || '(page has no readable text)'}${note}`) };
    }
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : `unexpected error: ${e.message}`;
    return { ok: false, error: hop > 0 && /blocked|resolves to/.test(msg) ? `redirect blocked: ${msg}` : msg };
  } finally {
    clearTimeout(timer);
  }
}
