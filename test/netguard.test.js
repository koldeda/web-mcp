import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, expandIPv6, checkHostname, validateFetchUrl } from '../lib/netguard.js';

test('IPv4: every blocked range is blocked (edges included)', () => {
  const blocked = [
    '0.0.0.0', '0.255.255.255', '10.0.0.0', '10.255.255.255', '100.64.0.0', '100.100.100.100',
    '100.127.255.255', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.0',
    '172.17.0.2', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.0.1', '192.168.255.255',
    '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.255',
    '240.0.0.1', '255.255.255.255',
  ];
  for (const ip of blocked) assert.equal(isBlockedIp(ip), true, ip);
});

test('IPv4: public addresses and range neighbours are allowed', () => {
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.215.14', '100.63.255.255', '100.128.0.0',
    '172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0', '198.17.255.255',
    '198.20.0.0', '223.255.255.255', '11.0.0.1', '126.255.255.255', '128.0.0.1'];
  for (const ip of allowed) assert.equal(isBlockedIp(ip), false, ip);
});

test('IPv6: expansion handles ::, embedded IPv4 and rejects zone ids', () => {
  assert.deepEqual(expandIPv6('::'), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(expandIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIPv6('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.deepEqual(expandIPv6('2001:db8::1:0:0:1'), [0x2001, 0xdb8, 0, 0, 1, 0, 0, 1]);
  assert.equal(expandIPv6('fe80::1%eth0'), null);
  assert.equal(expandIPv6('not-an-ip'), null);
});

test('IPv6: local, private, special and embedded-private forms are blocked', () => {
  const blocked = [
    '::', '::1', '::127.0.0.1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:7f00:1',
    '::ffff:169.254.169.254', '64:ff9b::10.0.0.1', '64:ff9b::7f00:1', '64:ff9b:1::1',
    '2002:7f00:1::', '2002:c0a8:101::1', '2001:0:4136:e378::1', '2001:db8::1', '100::1',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1',
  ];
  for (const ip of blocked) assert.equal(isBlockedIp(ip), true, ip);
});

test('IPv6: public addresses (incl. mapped/NAT64/6to4 of public IPv4) are allowed', () => {
  const allowed = ['2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8',
    '64:ff9b::8.8.8.8', '2002:0808:0808::1'];
  for (const ip of allowed) assert.equal(isBlockedIp(ip), false, ip);
});

test('non-IP input fails closed', () => {
  assert.equal(isBlockedIp('example.com'), true);
  assert.equal(isBlockedIp(''), true);
});

test('hostnames: local names blocked, normal names allowed', () => {
  for (const h of ['localhost', 'LOCALHOST.', 'foo.localhost', 'printer.local', 'db.internal',
    'nas.home.arpa', 'my-mac.tail1234.ts.net', 'router.lan', 'searxng', 'egress', '[::1]', '127.0.0.1']) {
    assert.notEqual(checkHostname(h), null, h);
  }
  for (const h of ['example.com', 'de.wikipedia.org', 'github.com', 'localhost.example.com', '[2606:4700:4700::1111]']) {
    assert.equal(checkHostname(h), null, h);
  }
});

test('URL validation: scheme, credentials, ports, length, host', () => {
  assert.equal(validateFetchUrl('https://example.com/a?b=c').ok, true);
  assert.equal(validateFetchUrl('http://example.com:80/').ok, true);
  assert.equal(validateFetchUrl('https://example.com:443/').ok, true);
  const bad = [
    'file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/', 'javascript:alert(1)',
    'https://user:pw@example.com/', 'https://user@example.com/', 'http://example.com:8080/',
    'https://example.com:22/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.100/', 'http://printer.local/', 'http://searxng:8080/', 'not a url',
    `https://example.com/${'a'.repeat(1000)}`,
  ];
  for (const u of bad) assert.equal(validateFetchUrl(u).ok, false, u);
});

test('hostnames: trailing dots and empty labels cannot bypass the blocklist', () => {
  for (const h of ['localhost..', 'foo.ts.net..', 'printer.local...', 'a..b.com', '.']) {
    assert.notEqual(checkHostname(h), null, h);
  }
  assert.equal(checkHostname('example.com.'), null);
  assert.equal(isBlockedIp('::ffff:0:7f00:1'), true); // IPv4-translated loopback
});
