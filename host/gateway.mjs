import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

export const MAX_ZIP_BYTES = 256 * 1024 * 1024;
const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;

function respond(response, status, message) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ message }));
}

function authenticated(request, token) {
  const actual = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function upload(request, destination, maximum) {
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    request.resume();
    throw new RangeError('Upload exceeds limit');
  }
  const handle = await open(destination, 'wx', 0o600);
  let bytes = 0;
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > maximum) {
        request.resume();
        throw new RangeError('Upload exceeds limit');
      }
      await handle.writeFile(chunk);
    }
  } finally {
    await handle.close();
  }
}

async function defaultStateOperation({ operation, udid, bundle, file, workDir, signal }) {
  const log = await open(join(workDir, 'state.log'), 'a', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('python3', [fileURLToPath(new URL('./state.py', import.meta.url)),
        operation, '--udid', udid, '--bundle', bundle, '--file', file], {
        stdio: ['ignore', log.fd, log.fd], signal, timeout: 600000,
      });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('State operation failed')));
    });
  } finally {
    await log.close();
  }
}

/** One job, one simulator, one bearer capability. No filesystem or shell API. */
export function createGateway({ token, udid, workDir, onFinish = () => {}, proxyPort = 4310,
  stateOperation = defaultStateOperation, maxZipBytes = MAX_ZIP_BYTES, signal }) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid control token');
  let stateBusy = false;
  let proxyRequests = 0;
  const server = http.createServer(async (request, response) => {
    response.on('error', () => {});
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return respond(response, 400, 'Invalid request'); }
    if (request.method === 'GET' && url.pathname === '/health') {
      return respond(response, 200, 'Simulator harness');
    }
    if (!authenticated(request, token)) {
      request.resume();
      return respond(response, 401, 'Authentication required');
    }
    if (request.method === 'POST' && url.pathname === '/finish') {
      request.resume();
      respond(response, 200, 'Session finishing');
      setImmediate(onFinish);
      return;
    }
    if (url.pathname === '/agent-device' || url.pathname.startsWith('/agent-device/')) {
      if (stateBusy) return respond(response, 409, 'Fixture operation in progress');
      proxyRequests++;
      const headers = { ...request.headers, host: '127.0.0.1' };
      delete headers.connection;
      const upstream = http.request({ hostname: '127.0.0.1', port: proxyPort,
        path: request.url, method: request.method, headers }, (incoming) => {
        response.writeHead(incoming.statusCode, incoming.headers);
        pipeline(incoming, response).catch(() => {});
      });
      upstream.once('error', () => {
        if (!response.headersSent) respond(response, 502, 'Device service unavailable');
        else response.destroy();
      });
      let finished = false;
      const release = () => { if (!finished) { proxyRequests--; finished = true; } };
      response.once('close', release);
      response.once('finish', release);
      request.once('aborted', () => upstream.destroy());
      pipeline(request, upstream).catch(() => upstream.destroy());
      return;
    }
    const operation = url.pathname === '/state/export' && request.method === 'GET' ? 'export'
      : url.pathname === '/state/import' && request.method === 'POST' ? 'import' : null;
    if (!operation) {
      request.resume();
      return respond(response, 404, 'Unknown operation');
    }
    const bundle = url.searchParams.get('bundle') ?? '';
    if (!BUNDLE.test(bundle) || url.searchParams.getAll('bundle').length !== 1) {
      request.resume();
      return respond(response, 400, 'Invalid bundle identifier');
    }
    if (stateBusy || proxyRequests > 0) {
      request.resume();
      return respond(response, 409, 'Device operation in progress');
    }
    const operationLock = Symbol('fixture');
    stateBusy = operationLock;
    const releaseState = () => { if (stateBusy === operationLock) stateBusy = false; };
    let directory;
    try {
      directory = await mkdtemp(join(workDir, 'fixture-'));
      const file = join(directory, `${randomUUID()}.zip`);
      if (operation === 'import') await upload(request, file, maxZipBytes);
      await stateOperation({ operation, udid, bundle, file, workDir, signal });
      if (operation === 'export') {
        const size = (await stat(file)).size;
        if (size > maxZipBytes) throw new RangeError('Export exceeds limit');
        releaseState();
        response.writeHead(200, { 'content-type': 'application/zip',
          'content-length': size, 'cache-control': 'no-store' });
        await pipeline(createReadStream(file), response);
      } else {
        releaseState();
        respond(response, 200, 'Fixture loaded; reopen the app');
      }
    } catch (error) {
      releaseState();
      if (!response.headersSent) respond(response, error instanceof RangeError ? 413 : 422,
        error instanceof RangeError ? 'Fixture exceeds limit' : 'Fixture operation failed');
      else response.destroy();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      releaseState();
    }
  });
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 30 * 1000;
  server.keepAliveTimeout = 5000;
  return server;
}
