import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createLookup } = createRequire(import.meta.url)('../skills/ios-simulator-testing/scripts/lib/tunnel-dns.cjs');
const missing = Object.assign(new Error('missing'), { code: 'ENOTFOUND' });
const host = 'synthetic-tunnel.trycloudflare.com';
const lookup = (fn, name, options = {}) => new Promise((resolve) => fn(name, options, (...args) => resolve(args)));

test('normal DNS results pass through without fallback', async () => {
  const fn = createLookup((_name, _options, callback) => callback(null, '127.0.0.1', 4), () => { throw new Error('unexpected'); });
  assert.deepEqual(await lookup(fn, host), [null, '127.0.0.1', 4]);
});
test('only unresolved exact tunnel hostnames use the fallback', async () => {
  let calls = 0;
  const fn = createLookup((_name, _options, callback) => callback(missing), async () => { calls++; return [{ address: '192.0.2.1', family: 4 }]; });
  assert.deepEqual(await lookup(fn, host), [null, '192.0.2.1', 4]);
  for (const name of ['example.com', 'trycloudflare.com', 'a.trycloudflare.com.example.com']) {
    assert.deepEqual(await lookup(fn, name), [missing, undefined, undefined]);
  }
  assert.equal(calls, 1);
});
test('fallback preserves all-address and IPv6 lookup contracts', async () => {
  const records = [{ address: '2001:db8::1', family: 6 }];
  const fn = createLookup((_name, _options, callback) => callback(missing), async (name, family) => {
    assert.equal(name, host); assert.equal(family, 6); return records;
  });
  assert.deepEqual(await lookup(fn, host, { all: true, family: 6 }), [null, records]);
  assert.deepEqual(await lookup(fn, host, 6), [null, records[0].address, 6]);
});
test('fallback failure and other system errors retain the original error', async () => {
  const failed = createLookup((_name, _options, callback) => callback(missing), async () => { throw new Error('unavailable'); });
  assert.deepEqual(await lookup(failed, host), [missing]);
  const refused = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
  const fn = createLookup((_name, _options, callback) => callback(refused), () => { throw new Error('unexpected'); });
  assert.deepEqual(await lookup(fn, host), [refused, undefined, undefined]);
});
