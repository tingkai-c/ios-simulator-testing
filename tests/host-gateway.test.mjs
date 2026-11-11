import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createGateway } from '../host/gateway.mjs';

const token = 'a'.repeat(64);
const headers = { authorization: `Bearer ${token}` };

async function fixture(t, overrides = {}) {
  const workDir = await mkdtemp(join(tmpdir(), 'ios-gateway-test-'));
  const server = createGateway({ token, udid: 'test-simulator', workDir, ...overrides });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(workDir, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${server.address().port}`, server, workDir };
}

test('unauthenticated endpoints reveal only generic health; auth cannot use prefixes', async (t) => {
  let finished = false;
  const { url } = await fixture(t, { onFinish: () => { finished = true; } });
  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { message: 'Simulator harness' });
  for (const authorization of [undefined, 'Bearer ', `Bearer ${token}extra`, `Basic ${token}`]) {
    const result = await fetch(`${url}/finish`, { method: 'POST',
      headers: authorization ? { authorization } : {} });
    assert.equal(result.status, 401);
  }
  assert.equal(finished, false);
  assert.equal((await fetch(`${url}/finish`, { method: 'POST', headers })).status, 200);
  await new Promise(setImmediate);
  assert.equal(finished, true);
});

test('authenticated proxy preserves request body, path, and bearer without logging', async (t) => {
  let received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { path: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks) };
    res.writeHead(201, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from([0, 255, 4]));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const { url } = await fixture(t, { proxyPort: upstream.address().port });
  const result = await fetch(`${url}/agent-device/upload?part=2`, {
    method: 'POST', headers, body: Buffer.from([9, 0, 255, 8]),
  });
  assert.equal(result.status, 201);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), Buffer.from([0, 255, 4]));
  assert.equal(received.path, '/agent-device/upload?part=2');
  assert.equal(received.authorization, headers.authorization);
  assert.deepEqual(received.body, Buffer.from([9, 0, 255, 8]));
});

test('fixture transfers are authenticated and bound to fixed simulator and validated bundle', async (t) => {
  const calls = [];
  const { url } = await fixture(t, { stateOperation: async (call) => {
    calls.push(call);
    if (call.operation === 'export') await writeFile(call.file, 'exported fixture');
    else assert.equal(await readFile(call.file, 'utf8'), 'incoming fixture');
  } });
  assert.equal((await fetch(`${url}/state/export?bundle=com.example.app`)).status, 401);
  assert.equal((await fetch(`${url}/state/export?bundle=../../file`, { headers })).status, 400);
  assert.equal((await fetch(`${url}/state/export?bundle=com.a&bundle=com.b`, { headers })).status, 400);
  const exported = await fetch(`${url}/state/export?bundle=com.example.app`, { headers });
  assert.equal(exported.status, 200);
  assert.equal(await exported.text(), 'exported fixture');
  const imported = await fetch(`${url}/state/import?bundle=com.example.app`, {
    method: 'POST', headers, body: 'incoming fixture',
  });
  assert.equal(imported.status, 200);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.udid, 'test-simulator');
    assert.equal(call.bundle, 'com.example.app');
  }
});

test('oversized upload is rejected before fixture mutation and errors disclose no diagnostics', async (t) => {
  let called = false;
  const { url } = await fixture(t, { maxZipBytes: 32, stateOperation: async () => {
    called = true;
    throw new Error('private-secret-file-path');
  } });
  const oversized = await fetch(`${url}/state/import?bundle=com.example.app`, {
    method: 'POST', headers, body: Buffer.alloc(33),
  });
  assert.equal(oversized.status, 413);
  assert.equal(called, false);
  const failed = await fetch(`${url}/state/import?bundle=com.example.app`, {
    method: 'POST', headers, body: Buffer.alloc(1),
  });
  assert.equal(failed.status, 422);
  assert.equal((await failed.text()).includes('private-secret'), false);
});

test('fixture operation blocks RPC and other fixture operations until it finishes', async (t) => {
  let started, release;
  const underway = new Promise((resolve) => { started = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const { url } = await fixture(t, { stateOperation: async ({ file }) => {
    started(); await hold; await writeFile(file, 'fixture');
  } });
  const exporting = fetch(`${url}/state/export?bundle=com.example.app`, { headers });
  await underway;
  assert.equal((await fetch(`${url}/agent-device/rpc`, { method: 'POST', headers, body: '{}' })).status, 409);
  assert.equal((await fetch(`${url}/state/export?bundle=com.example.app`, { headers })).status, 409);
  release();
  const result = await exporting;
  assert.equal(result.status, 200);
  assert.equal(await result.text(), 'fixture');
});
