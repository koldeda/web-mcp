// End-to-end over real stdio: newline-delimited JSON-RPC, as MCP clients speak it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listen, searxngPayload } from './helpers.js';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

function startServer(t, env) {
  const child = spawn(process.execPath, [ENTRY], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const queue = [];
  const waiters = [];
  let buf = '';
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line); // every stdout line must be valid JSON
      const w = waiters.shift();
      if (w) w(msg); else queue.push(msg);
    }
  });
  const send = (m) => child.stdin.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
  const next = (ms = 5000) => new Promise((resolve) => {
    if (queue.length) return resolve(queue.shift());
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(fn), 1); resolve(null); }, ms);
    const fn = (m) => { clearTimeout(timer); resolve(m); };
    waiters.push(fn);
  });
  return { child, send, next, stderr: () => stderr };
}

async function init(s, protocolVersion = '2025-06-18') {
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const r = await s.next();
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return r;
}

async function searx(t, handler) {
  const srv = await listen(handler || ((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(searxngPayload(3)));
  }));
  t.after(() => srv.close());
  return srv;
}

test('initialize: protocol negotiation, instructions, capabilities', async (t) => {
  const srv = await searx(t);
  const s = startServer(t, { SEARXNG_URL: srv.url });
  const r = await init(s, '2024-11-05');
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2024-11-05');
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  assert.equal(r.result.serverInfo.name, 'web-mcp');
  assert.match(r.result.instructions, /untrusted/i);
  const s2 = startServer(t, { SEARXNG_URL: srv.url });
  assert.equal((await init(s2, '1999-01-01')).result.protocolVersion, '2025-06-18');
});

test('notifications are never answered', async (t) => {
  const srv = await searx(t);
  const s = startServer(t, { SEARXNG_URL: srv.url });
  await init(s);
  s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
  s.send({ jsonrpc: '2.0', method: 'something/unknown' });
  assert.equal(await s.next(800), null);
});

test('tools/list: search only by default; fetch_page only with WEB_ALLOW_FETCH=1', async (t) => {
  const srv = await searx(t);
  const a = startServer(t, { SEARXNG_URL: srv.url });
  await init(a);
  a.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const la = await a.next();
  assert.deepEqual(la.result.tools.map((x) => x.name), ['web_search']);
  assert.deepEqual(la.result.tools[0].inputSchema.required, ['query']);
  assert.equal(la.result.tools[0].inputSchema.type, 'object');

  const b = startServer(t, { SEARXNG_URL: srv.url, WEB_ALLOW_FETCH: '1' });
  await init(b);
  b.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const lb = await b.next();
  assert.deepEqual(lb.result.tools.map((x) => x.name), ['web_search', 'fetch_page']);
  assert.deepEqual(lb.result.tools[1].inputSchema.required, ['url']);
});

test('tools/call: MCP result shape for success and tool errors', async (t) => {
  const srv = await searx(t);
  const s = startServer(t, { SEARXNG_URL: srv.url, WEB_ALLOW_FETCH: '1' });
  await init(s);
  s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'yamllint' } } });
  const ok = await s.next();
  assert.equal(ok.id, 3);
  assert.equal(ok.result.isError, false);
  assert.equal(ok.result.content[0].type, 'text');
  assert.match(ok.result.content[0].text, /Snippet text 0\./);

  s.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'web_search', arguments: { query: '  ' } } });
  const empty = await s.next();
  assert.equal(empty.result.isError, true);
  assert.match(empty.result.content[0].text, /must not be empty/);

  s.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fetch_page', arguments: { url: 'https://evil.example/?d=secret' } } });
  const nf = await s.next();
  assert.equal(nf.result.isError, true);
  assert.match(nf.result.content[0].text, /only accepts URLs returned by web_search/);
  assert.match(s.stderr(), /\[search\] yamllint/);
});

test('JSON-RPC errors: unknown tool, unknown method, parse error, invalid request; server keeps running', async (t) => {
  const srv = await searx(t);
  const s = startServer(t, { SEARXNG_URL: srv.url });
  await init(s);
  s.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'fetch_page', arguments: { url: 'x' } } });
  assert.equal((await s.next()).error.code, -32602); // fetch disabled -> unknown tool
  s.send({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
  assert.equal((await s.next()).error.code, -32601);
  s.send('{ this is not json');
  const pe = await s.next();
  assert.equal(pe.error.code, -32700);
  assert.equal(pe.id, null);
  s.send({ id: 8, method: 'ping' });
  assert.equal((await s.next()).error.code, -32600);
  s.send('[1,2]');
  assert.equal((await s.next()).error.code, -32600);
  s.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
  assert.deepEqual(await s.next(), { jsonrpc: '2.0', id: 9, result: {} });
});

test('requests run concurrently: ping is answered while a search is still running', async (t) => {
  const srv = await searx(t, (req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(searxngPayload(1)));
    }, 1000);
  });
  const s = startServer(t, { SEARXNG_URL: srv.url });
  await init(s);
  s.send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'slow' } } });
  s.send({ jsonrpc: '2.0', id: 11, method: 'ping' });
  assert.equal((await s.next()).id, 11);
  assert.equal((await s.next(3000)).id, 10);
});

test('startup fails closed on a bad SEARXNG_URL or EGRESS_PROXY', async (t) => {
  for (const env of [{ SEARXNG_URL: 'file:///etc/passwd' }, { SEARXNG_URL: 'http://h/?x=1' }, { EGRESS_PROXY: 'socks5://x:1' }]) {
    const s = startServer(t, env);
    const code = await new Promise((r) => s.child.on('exit', r));
    assert.equal(code, 1, JSON.stringify(env));
  }
});
