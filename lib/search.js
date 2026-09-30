// web_search: query the operator-configured SearXNG instance and return
// compact, neutralised, clearly labelled results.

import { httpGet, directOpener, decodeBody, HttpError } from './http.js';
import { neutralize, oneLine, truncate, wrap, containsMarker } from './text.js';
import { MAX_URL_LENGTH } from './netguard.js';

export const MAX_QUERY_LENGTH = 200;
export const MAX_RESULTS = 8;
export const MAX_TITLE_LENGTH = 200;
export const MAX_SNIPPET_LENGTH = 400;
export const SEARCH_MAX_BYTES = 1024 * 1024;
export const SEARCH_TIMEOUT_MS = 10_000;

// Strip control and line-separator characters, trim, cap length.
export function sanitizeQuery(input) {
  if (typeof input !== 'string') return { ok: false, error: 'query must be a string' };
  const cleaned = input
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return { ok: false, error: 'query must not be empty' };
  return { ok: true, value: truncate(cleaned, MAX_QUERY_LENGTH) };
}

// Validate SEARXNG_URL once at startup. Fails closed.
export function parseSearxngUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`SEARXNG_URL is not a valid absolute URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('SEARXNG_URL must be http or https');
  if (u.username || u.password) throw new Error('SEARXNG_URL must not contain credentials');
  if (u.search || u.hash) throw new Error('SEARXNG_URL must not contain a query string or fragment');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
}

// Host and path come only from the validated base; the query is set via
// URLSearchParams, so it can never change where the request goes.
export function buildSearchUrl(base, query) {
  const u = new URL('search', base);
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'json');
  return u;
}

function isStorableUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  if (/\s/.test(value) || containsMarker(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// SearXNG result objects carry the snippet in "content".
export function shapeResults(rawResults, returnedUrls) {
  const out = [];
  for (const r of rawResults) {
    if (out.length >= MAX_RESULTS) break;
    if (!r || typeof r !== 'object' || !isStorableUrl(r.url)) continue;
    out.push({
      title: truncate(oneLine(neutralize(r.title ?? '')), MAX_TITLE_LENGTH),
      url: r.url,
      snippet: truncate(oneLine(neutralize(r.content ?? '')), MAX_SNIPPET_LENGTH),
    });
    if (returnedUrls) returnedUrls.add(r.url);
  }
  return out;
}

export function formatResults(query, results) {
  if (results.length === 0) return wrap(`No results for: ${query}`);
  const blocks = results.map((r, i) => `[${i + 1}] ${r.title || '(no title)'}\nURL: ${r.url}\n${r.snippet || '(no snippet)'}`);
  return wrap(`Results for: ${query}\n\n${blocks.join('\n\n')}`);
}

// ctx: { baseUrl: URL, returnedUrls: Set, log, timeoutMs?, openSocket? }
export async function webSearch(query, ctx) {
  const san = sanitizeQuery(query);
  if (!san.ok) return { ok: false, error: san.error };
  ctx.log(`[search] ${san.value}`);
  const url = buildSearchUrl(ctx.baseUrl, san.value);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new HttpError('web search timed out')),
    ctx.timeoutMs ?? SEARCH_TIMEOUT_MS,
  );
  try {
    const res = await httpGet(url, {
      signal: controller.signal,
      // SearXNG is operator-configured (localhost or the internal container),
      // so no destination guard here; the model cannot change this URL.
      openSocket: ctx.openSocket ?? directOpener({ guard: false }),
      maxBytes: SEARCH_MAX_BYTES,
      allowedTypes: ['application/json'],
      accept: 'application/json',
    });
    if (res.redirect) return { ok: false, error: `SearXNG answered with a redirect (HTTP ${res.status})` };
    let data;
    try {
      data = JSON.parse(decodeBody(res.body, res.charset));
    } catch {
      return { ok: false, error: 'SearXNG returned invalid JSON (is format=json enabled in settings.yml?)' };
    }
    if (!data || !Array.isArray(data.results)) return { ok: false, error: 'SearXNG response has no results array' };
    const results = shapeResults(data.results, ctx.returnedUrls);
    return { ok: true, text: formatResults(san.value, results) };
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : `unexpected error: ${e.message}`;
    if (/content-type/.test(msg)) return { ok: false, error: `SearXNG did not return JSON (${msg}); enable "json" under search.formats` };
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH/.test(msg)) {
      return { ok: false, error: `cannot reach SearXNG at ${ctx.baseUrl.origin} (${msg}). Is the searxng container running?` };
    }
    return { ok: false, error: `SearXNG request failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
