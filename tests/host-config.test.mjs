import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { configuration, chooseSimulator, tunnelUrl } from '../host/host.mjs';

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072,
  publicKeyEncoding: { format: 'der', type: 'spki' },
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' } });
const environment = { SESSION_ID: 'a'.repeat(32), SESSION_MINUTES: '15',
  RECIPIENT_KEY: publicKey.toString('base64'), GITHUB_RUN_ID: '123',
  GITHUB_REPOSITORY: 'example/harness', BOOTSTRAP_PATH: '/tmp/bootstrap.json' };

test('configuration rejects malformed and overlong capabilities before launching processes', () => {
  assert.equal(configuration(environment).minutes, 15);
  for (const patch of [{ SESSION_ID: '../../file' }, { SESSION_MINUTES: '31' },
    { SESSION_MINUTES: 'NaN' }, { SESSION_MINUTES: '0' }, { GITHUB_RUN_ID: 'abc' },
    { RECIPIENT_KEY: 'invalid' }, { GITHUB_REPOSITORY: 'file:///tmp' }]) {
    assert.throws(() => configuration({ ...environment, ...patch }));
  }
});

test('simulator selection picks available iPhone from newest iOS runtime', () => {
  const result = chooseSimulator({ devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-9-0': [{ name: 'iPhone 9', udid: 'old', isAvailable: true }],
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
      { name: 'iPhone 17', udid: 'new', isAvailable: true },
      { name: 'iPhone 18', udid: 'unavailable', isAvailable: false },
      { name: 'iPad Pro', udid: 'ipad', isAvailable: true },
    ],
  } });
  assert.equal(result.udid, 'new');
  assert.throws(() => chooseSimulator({ devices: {} }));
});

test('tunnel parser accepts only generated Cloudflare HTTPS hostname', () => {
  assert.equal(tunnelUrl('connection https://sample-name.trycloudflare.com registered'),
    'https://sample-name.trycloudflare.com');
  assert.equal(tunnelUrl('https://malicious.example'), null);
  assert.equal(tunnelUrl('http://sample.trycloudflare.com'), null);
});
