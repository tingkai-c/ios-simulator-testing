// No simulator, app inputs, credentials, proxy, or private data exist in this test.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const server = http.createServer((_request, response) => response.end('public-health-only'));
await new Promise((done) => server.listen(4320, '127.0.0.1', done));
let log = '';
const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:4320']);
child.stdout.on('data', (chunk) => { log += chunk; });
child.stderr.on('data', (chunk) => { log += chunk; });
let success = false;
try {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    const endpoint = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
    if (endpoint) {
      try {
        const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(3000) });
        if (response.ok && (await response.text()) === 'public-health-only') { success = true; break; }
      } catch (error) { console.log('Health request:', error.cause?.code ?? error.name); }
    }
    await delay(2000);
  }
  console.log(log);
  if (!success) throw new Error('Public health-only tunnel could not be reached');
  console.log('Public health-only tunnel passed.');
} finally {
  child.kill('SIGTERM');
  server.closeAllConnections();
  server.close();
}
