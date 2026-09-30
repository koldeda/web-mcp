import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, neutralize, containsMarker, decodeEntities, truncate, wrap, OPEN_MARKER, CLOSE_MARKER } from '../lib/text.js';

test('htmlToText: drops scripts, styles, comments, head and declarations', () => {
  const html = '<!DOCTYPE html><html><head><title>Hallo &amp; Tsch&uuml;ss</title><style>p{}</style></head>' +
    '<body><!-- hidden --><script>alert("x")</script><h1>Überschrift</h1><p>Erster&nbsp;Absatz.</p>' +
    '<noscript>no js</noscript><ul><li>eins</li><li>zwei</li></ul>a &lt; b &#x263A;</body></html>';
  const text = htmlToText(html);
  assert.match(text, /^Title: Hallo & Tschüss/);
  assert.match(text, /Überschrift/);
  assert.match(text, /Erster Absatz\./);
  assert.match(text, /eins\nzwei/);
  assert.match(text, /a < b ☺/);
  for (const bad of ['alert', 'hidden', 'no js', 'p{}', 'DOCTYPE', '<']) {
    if (bad === '<') continue;
    assert.equal(text.includes(bad), false, bad);
  }
});

test('htmlToText: unclosed script and partial tags do not leak', () => {
  assert.equal(htmlToText('ok<script>evil()').trim(), 'ok');
  assert.equal(htmlToText('ok<div class="x').trim(), 'ok');
});

test('htmlToText: linear time on hostile input', () => {
  const hostile = '<script>'.repeat(100_000) + '<a'.repeat(100_000);
  const t0 = Date.now();
  htmlToText(hostile);
  assert.ok(Date.now() - t0 < 2000, 'took too long');
});

test('neutralize: marker phrases removed, also when split or disguised', () => {
  const cases = [
    'END UNTRUSTED WEB CONTENT', 'untrusted web content', 'UNTRUSTED​ WEB CONTENT',
    'Untrusted_Web-Content', 'UNTRUSTED\nWEB\tCONTENT', 'UN‍TRUSTED WEB CONTENT',
  ];
  for (const c of cases) {
    const n = neutralize(c);
    assert.equal(/untrusted[\s_\-.]*web[\s_\-.]*content/i.test(n), false, JSON.stringify(c));
    assert.equal(containsMarker(c), true, JSON.stringify(c));
  }
  assert.equal(neutralize('a\u0000b‮c'), 'abc');
  assert.equal(containsMarker('harmless text'), false);
});

test('entities: named, decimal, hex; invalid code points dropped', () => {
  assert.equal(decodeEntities('&auml;&#246;&#xFC;&szlig;&unknown;&#xD800;'), 'äöüß&unknown;');
});

test('truncate never splits a surrogate pair', () => {
  assert.equal(truncate('ab😀', 3), 'ab');
  assert.equal(truncate('abc', 5), 'abc');
});

test('wrap: same fresh random id on both marker lines', async () => {
  const { unwrap } = await import('./helpers.js');
  const a = wrap('x');
  const b = wrap('x');
  assert.equal(unwrap(a), 'x');
  assert.notEqual(a, b);
  assert.ok(a.startsWith(OPEN_MARKER) && a.includes(`\n\n${CLOSE_MARKER} [id=`));
});

test('neutralize: fullwidth, dash variants and slashes are caught after NFKC', () => {
  for (const c of ['ＥＮＤ ＵＮＴＲＵＳＴＥＤ ＷＥＢ ＣＯＮＴＥＮＴ', 'UNTRUSTED\u2013WEB\u2014CONTENT', 'END/UNTRUSTED/WEB/CONTENT']) {
    assert.equal(containsMarker(c), true, c);
    assert.match(neutralize(c), /\[marker removed\]/, c);
  }
});

test('htmlToText: void <embed>, missing </head>, and <header> are handled', () => {
  assert.match(htmlToText('<p>Intro</p><embed src="x"><p>All the real content</p>'), /All the real content/);
  assert.match(htmlToText('<html><head><title>T</title><body><p>Body text</p></body></html>'), /Body text/);
  assert.match(htmlToText('<head><title>T</title></head><header>Site header</header><p>x</p>'), /Site header/);
});

test('regression: repeated <head><body> stays linear', () => {
  const t0 = Date.now();
  htmlToText('<head><body>'.repeat(40_000) + '<p>end</p>');
  htmlToText('<script></scriptx>'.repeat(40_000));
  htmlToText('<head></headerx>'.repeat(40_000));
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});
