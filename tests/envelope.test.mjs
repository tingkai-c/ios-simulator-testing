import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keypair, seal, unseal } from '../skills/ios-simulator-testing/scripts/lib/envelope.mjs';

const alice = keypair();
const bob = keypair();
test('only the recipient can decrypt a session bootstrap', () => {
  const payload = { token: 'synthetic-private-token', baseUrl: 'https://test.example/agent-device' };
  const sealed = seal(payload, alice.publicKey, 'session-one');
  assert.deepEqual(unseal(sealed, alice.privateKey, 'session-one'), payload);
  assert.ok(!JSON.stringify(sealed).includes(payload.token));
  assert.throws(() => unseal(sealed, bob.privateKey, 'session-one'));
});
test('tampering and replay to another session fail authentication', () => {
  const sealed = seal({ token: 'secret' }, alice.publicKey, 'session-one');
  assert.throws(() => unseal(sealed, alice.privateKey, 'session-two'));
  const bytes = Buffer.from(sealed.ciphertext, 'base64');
  bytes[0] ^= 1;
  assert.throws(() => unseal({ ...sealed, ciphertext: bytes.toString('base64') }, alice.privateKey, 'session-one'));
});
