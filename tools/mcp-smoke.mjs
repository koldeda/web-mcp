#!/usr/bin/env node
// mcp-smoke.mjs - zero-dependency conformance smoke test for stdio MCP servers.
// Checks what real clients (LM Studio, Bionic, official SDK) rely on.
//
// Usage:
//   node mcp-smoke.mjs [--call '<tool>' '<json-args>'] -- <server command...>
// Examples:
//   node mcp-smoke.mjs -- node ~/.lmstudio/web-mcp/index.js
//   node mcp-smoke.mjs --call web_search '{"query":"yamllint"}' -- node ~/.lmstudio/web-mcp/index.js
//   node mcp-smoke.mjs -- docker run -i --rm --network websearch-internal -e SEARXNG_URL=http://searxng:8080 web-mcp:local

import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1 || sep === argv.length - 1) {
  console.error("usage: node mcp-smoke.mjs [--call <tool> '<json>'] -- <server command...>");
  process.exit(2);
}
const opts = argv.slice(0, sep);
const cmd = argv.slice(sep + 1);
let call = null;
if (opts[0] === '--call') call = { name: opts[1], args: JSON.parse(opts[2] || '{}') };

const TIMEOUT_MS = 15000;
let failed = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { failed++; console.log(`  FAIL  ${m}`); };

const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });

const lines = [];
const waiters = [];
let buf = '';
let rawOut = '';
child.stdout.on('data', (d) => {
  rawOut += d;
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, '');
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { msg = { __unparseable: line }; }
    const w = waiters.shift();
    if (w) w(msg); else lines.push(msg);
  }
});

const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const sendRaw = (s) => child.stdin.write(s + '\n');
const next = (ms = TIMEOUT_MS) => new Promise((resolve) => {
  if (lines.length) return resolve(lines.shift());
  const t = setTimeout(() => { const k = waiters.indexOf(fn); if (k >= 0) waiters.splice(k, 1); resolve(null); }, ms);
  const fn = (m) => { clearTimeout(t); resolve(m); };
  waiters.push(fn);
});

function finish() {
  child.kill();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL CHECKS PASSED');
  if (failed && stderr.trim()) console.log('\n--- server stderr (last 800 chars) ---\n' + stderr.slice(-800));
  process.exit(failed ? 1 : 0);
}

console.log(`mcp-smoke: ${cmd.join(' ')}\n`);

// 1. initialize (newline-delimited JSON, as every MCP client sends it)
send({ jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-smoke', version: '1' } } });
const init = await next();
if (!init) {
  bad('no reply to initialize (newline-delimited JSON). ' +
      (/content-length/i.test(rawOut) ? 'Server uses Content-Length framing - that is LSP, not MCP stdio.' : ''));
  finish();
}
if (init.__unparseable) {
  bad(`stdout line is not JSON: ${init.__unparseable.slice(0, 120)}` +
      (/content-length/i.test(init.__unparseable) ? '  -> Content-Length framing is LSP, not MCP stdio.' : ''));
  finish();
}
init.id === 1 && init.result ? ok('initialize answered') : bad(`bad initialize reply: ${JSON.stringify(init).slice(0, 200)}`);
const r = init.result || {};
typeof r.protocolVersion === 'string' ? ok(`protocolVersion ${r.protocolVersion}`) : bad('protocolVersion missing');
r.serverInfo && r.serverInfo.name ? ok(`serverInfo ${r.serverInfo.name}`) : bad('serverInfo.name missing');
r.capabilities && r.capabilities.tools ? ok('capabilities.tools present') : bad('capabilities.tools missing');
typeof r.instructions === 'string' ? ok('instructions present') : console.log('  info  no instructions field (optional)');

// 2. notification must NOT be answered
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999, reason: 'smoke' } });
const stray = await next(1500);
stray ? bad(`server replied to a notification: ${JSON.stringify(stray).slice(0, 150)}`) : ok('no replies to notifications');

// 3. tools/list
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const tl = await next();
const tools = tl && tl.result && Array.isArray(tl.result.tools) ? tl.result.tools : null;
if (!tools) { bad(`tools/list: no result.tools array: ${JSON.stringify(tl).slice(0, 200)}`); finish(); }
ok(`tools/list -> ${tools.map((t) => t.name).join(', ') || '(none)'}`);
for (const t of tools) {
  const s = t.inputSchema;
  if (!t.name || !s || s.type !== 'object') { bad(`${t.name}: inputSchema must be {type:"object",...}`); continue; }
  if (s.properties) {
    const misplaced = Object.entries(s.properties).filter(([, v]) => v && 'required' in v && typeof v.required !== 'object');
    if (misplaced.length) bad(`${t.name}: "required" misplaced inside properties (${misplaced.map(([k]) => k).join(', ')})`);
  }
  if ('required' in t) bad(`${t.name}: "required" is outside inputSchema`);
  else if (s.required && !Array.isArray(s.required)) bad(`${t.name}: inputSchema.required must be an array`);
  else ok(`${t.name}: schema shape ok`);
}

// 4. tools/call (optional) - result must be {content:[...], isError?}
if (call) {
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: call.name, arguments: call.args } });
  const res = await next(30000);
  const cr = res && res.result;
  if (!cr) bad(`tools/call: no result: ${JSON.stringify(res).slice(0, 200)}`);
  else if (Array.isArray(cr)) bad('tools/call: result is a bare array; must be {content:[...], isError}');
  else if (!Array.isArray(cr.content)) bad('tools/call: result.content missing');
  else {
    const allText = cr.content.every((c) => c && c.type === 'text' && typeof c.text === 'string');
    allText ? ok(`tools/call: result.content ok (${cr.content.length} block(s))`) : bad('tools/call: content blocks must be {type:"text", text:string}');
    if ('isError' in cr && typeof cr.isError !== 'boolean') bad('tools/call: isError must be boolean');
    if (res._meta && 'isError' in res._meta) bad('tools/call: isError is in _meta; must be result.isError');
    if (cr.isError) console.log('  info  tool reported isError=true: ' + (cr.content[0] && cr.content[0].text || '').slice(0, 200));
    else console.log('  info  first 400 chars of output:\n' + (cr.content[0] && cr.content[0].text || '').slice(0, 400).replace(/^/gm, '        '));
  }
}

// 5. robustness: garbage line -> -32700, server stays alive
sendRaw('this is not json');
const pe = await next(3000);
pe && pe.error && pe.error.code === -32700 ? ok('malformed line -> -32700 parse error') : bad(`malformed line: expected -32700, got ${JSON.stringify(pe)}`);
send({ jsonrpc: '2.0', id: 4, method: 'ping' });
const pong = await next(3000);
pong && pong.id === 4 && pong.result ? ok('still alive after malformed input (ping ok)') : bad('server dead/unresponsive after malformed input');

finish();
