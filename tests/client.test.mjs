import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBootstrap, deviceEnv, alreadyClosed } from '../skills/ios-simulator-testing/scripts/simulator.mjs';

const expected = { sessionId: 'a'.repeat(32), runId: 123, repository: 'owner/harness' };
const valid = {
  ...expected, runId: '123', agentDeviceVersion: '0.21.36', token: 'b'.repeat(64),
  udid: '01234567-89AB-CDEF-0123-456789ABCDEF', baseUrl: 'https://random-host.trycloudflare.com/agent-device',
  controlUrl: 'https://random-host.trycloudflare.com', expiresAt: new Date(Date.now() + 600_000).toISOString(),
};
test('accept a session only for its exact run and known endpoint', () => {
  assert.equal(checkBootstrap(valid, expected), valid);
  for (const mutation of [
    { sessionId: 'c'.repeat(32) }, { runId: '124' }, { repository: 'other/harness' },
    { agentDeviceVersion: '0.0.0' }, { token: 'short' }, { udid: 'booted' },
    { baseUrl: 'https://random-host.trycloudflare.com.evil.test/agent-device' },
    { baseUrl: 'https://user:password@random-host.trycloudflare.com/agent-device' },
    { controlUrl: 'http://127.0.0.1' }, { expiresAt: new Date(0).toISOString() },
    { expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  ]) assert.throws(() => checkBootstrap({ ...valid, ...mutation }, expected));
});

test('fixture operations can follow an earlier close without ignoring transport/auth failures', () => {
  assert.equal(alreadyClosed({ code: 0 }), true);
  assert.equal(alreadyClosed({ code: 1, stdout: JSON.stringify({ error: { code: 'SESSION_NOT_FOUND' } }) }), true);
  assert.equal(alreadyClosed({ code: 1, stdout: JSON.stringify({ error: { code: 'UNAUTHORIZED' } }) }), false);
  assert.equal(alreadyClosed({ code: 1, stdout: 'connection failed' }), false);
});

test('an existing agent-device profile cannot reroute private uploads', () => {
  process.env.AGENT_DEVICE_DAEMON_BASE_URL = 'https://wrong-host.example';
  process.env.AGENT_DEVICE_CONFIG = '/other-agent/config.json';
  try {
    const env = deviceEnv(valid, '/private/session/session.json');
    assert.equal(env.AGENT_DEVICE_DAEMON_BASE_URL, undefined);
    assert.equal(env.AGENT_DEVICE_CONFIG, '/private/session/device-config.json');
    assert.equal(env.AGENT_DEVICE_HOME, '/private/session/device-home');
    assert.equal(env.AGENT_DEVICE_DAEMON_AUTH_TOKEN, valid.token);
    assert.equal(env.AGENT_DEVICE_SESSION, expected.sessionId);
    assert.equal(env.AGENT_DEVICE_STATE_DIR, '/private/session/device');
  } finally {
    delete process.env.AGENT_DEVICE_DAEMON_BASE_URL;
    delete process.env.AGENT_DEVICE_CONFIG;
  }
});
