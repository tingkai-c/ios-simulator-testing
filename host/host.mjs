import { spawn } from 'node:child_process';
import { randomBytes, createPublicKey } from 'node:crypto';
import { open, chmod, mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createGateway } from './gateway.mjs';
import { seal } from '../skills/ios-simulator-testing/scripts/lib/envelope.mjs';
import '../skills/ios-simulator-testing/scripts/lib/tunnel-dns.cjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = '0.21.36';
export const HOST_STAGES = Object.freeze(['simulator discovery', 'simulator boot', 'UI runner preparation',
  'proxy startup', 'tunnel startup', 'tunnel edge connection', 'tunnel public health', 'session serving', 'cleanup']);

export function configuration(env = process.env) {
  const minutes = Number(env.SESSION_MINUTES ?? 15);
  if (!/^[a-f0-9]{32}$/.test(env.SESSION_ID ?? '')) throw new Error('Invalid session identifier');
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 30) throw new Error('Invalid session duration');
  if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? '')) throw new Error('Invalid run identifier');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) throw new Error('Invalid repository');
  if (!env.BOOTSTRAP_PATH) throw new Error('Missing bootstrap output path');
  if (!env.RECIPIENT_KEY || env.RECIPIENT_KEY.length > 8192) throw new Error('Invalid recipient key');
  const key = createPublicKey({ key: Buffer.from(env.RECIPIENT_KEY, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 3072) {
    throw new Error('Recipient key must be RSA 3072 or stronger');
  }
  return { sessionId: env.SESSION_ID, minutes, recipientKey: env.RECIPIENT_KEY,
    runId: env.GITHUB_RUN_ID, repository: env.GITHUB_REPOSITORY,
    bootstrapPath: resolve(env.BOOTSTRAP_PATH), temporaryRoot: env.RUNNER_TEMP || tmpdir() };
}

export function chooseSimulator(list) {
  const candidates = Object.entries(list.devices ?? {}).flatMap(([runtime, devices]) => {
    if (!runtime.includes('.iOS-')) return [];
    const version = runtime.split('.iOS-')[1].split('-').map(Number);
    return devices.filter((device) => device.isAvailable && /^iPhone\b/.test(device.name))
      .map((device) => ({ ...device, version }));
  });
  candidates.sort((a, b) => {
    for (let index = 0; index < Math.max(a.version.length, b.version.length); index++) {
      const delta = (b.version[index] ?? 0) - (a.version[index] ?? 0);
      if (delta) return delta;
    }
    return a.name.localeCompare(b.name, 'en', { numeric: true });
  });
  if (!candidates.length) throw new Error('No available iPhone simulator');
  return candidates[0];
}

export function tunnelUrl(log) {
  const match = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
  return match?.[0] ?? null;
}

export async function main({ onFailure } = {}) {
  process.umask(0o077);
  let config;
  try { config = configuration(); }
  catch {
    process.stderr.write('Simulator session configuration is invalid.\n');
    if (process.env.HOST_EXIT_PATH) {
      await writeFile(process.env.HOST_EXIT_PATH, JSON.stringify({ ok: false }), { mode: 0o600 });
    }
    return 1;
  }
  const privateDir = await mkdtemp(join(config.temporaryRoot, 'ios-simulator-'));
  await chmod(privateDir, 0o700);
  const deviceConfig = join(privateDir, 'device-config.json');
  await writeFile(deviceConfig, '{}', { mode: 0o600 });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_DEVICE_')));
  const environment = { ...inherited,
    NODE_OPTIONS: `${inherited.NODE_OPTIONS ?? ''} --require ${JSON.stringify(join(ROOT, 'skills/ios-simulator-testing/scripts/lib/tunnel-dns.cjs'))}`.trim(),
    AGENT_DEVICE_SESSION: config.sessionId,
    AGENT_DEVICE_STATE_DIR: join(privateDir, 'daemon'), AGENT_DEVICE_HOME: join(privateDir, 'device-home'),
    AGENT_DEVICE_CONFIG: deviceConfig, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' };
  const executable = join(ROOT, 'skills/ios-simulator-testing/node_modules/.bin/agent-device');
  const children = new Set();
  const handles = [];
  let simulator, gateway, ending = false;
  const controller = new AbortController();
  let finish;
  const ended = new Promise((resolveEnded) => { finish = resolveEnded; });
  const terminate = () => {
    ending = true;
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }
    finish();
  };
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  let timer, succeeded = false, infrastructureFailed = false;
  let stage = 'simulator discovery';

  async function launch(command, args, filename, { capture = false, timeout = 0 } = {}) {
    const log = await open(join(privateDir, filename), 'a', 0o600);
    handles.push(log);
    const child = spawn(command, args, { env: environment, detached: true,
      stdio: ['ignore', capture ? 'pipe' : log.fd, log.fd], timeout });
    children.add(child);
    let output = '';
    if (capture) child.stdout.on('data', (chunk) => {
      if (output.length < 2 * 1024 * 1024) output += chunk;
      log.write(chunk).catch(() => {});
    });
    const completion = new Promise((resolveChild, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        children.delete(child);
        if (code === 0) resolveChild(output);
        else reject(new Error(`Host subprocess stopped (${code ?? signal})`));
      });
    });
    // Long-lived children may fail before the startup waiter attaches.
    completion.catch(() => {});
    return { child, completion };
  }

  async function run(command, args, options = {}) {
    const process = await launch(command, args, 'commands.log', { timeout: 300000, ...options });
    return process.completion;
  }

  async function waitFor(check, deadline, liveChildren = []) {
    while (Date.now() < deadline) {
      if (ending || liveChildren.some((child) => child.exitCode !== null || child.signalCode !== null)) {
        throw new Error('Session stopped during startup');
      }
      const result = await check();
      if (result) return result;
      await delay(300);
    }
    throw new Error('Startup timed out');
  }

  try {
    process.stdout.write('Preparing simulator session.\n');
    // Setup has its own bound; the interactive lifetime starts only when ready.
    timer = setTimeout(terminate, 12 * 60 * 1000);
    const list = JSON.parse(await run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { capture: true }));
    simulator = chooseSimulator(list);
    stage = 'simulator boot';
    if (simulator.state !== 'Booted') await run('xcrun', ['simctl', 'boot', simulator.udid]);
    await run('xcrun', ['simctl', 'bootstatus', simulator.udid, '-b']);
    stage = 'UI runner preparation';
    await run(executable, ['prepare', 'ios-runner', '--platform', 'ios', '--udid', simulator.udid,
      '--timeout', '420000'], { timeout: 450000 });
    if (ending) throw new Error('Session stopped during setup');
    stage = 'proxy startup';
    const token = randomBytes(32).toString('hex');
    const proxy = await launch(executable, ['proxy', '--host', '127.0.0.1', '--port', '4310',
      '--daemon-auth-token', token], 'proxy.log');
    await waitFor(async () => {
      try { return (await fetch('http://127.0.0.1:4310/health', { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    }, Date.now() + 30000, [proxy.child]);
    gateway = createGateway({ token, udid: simulator.udid, workDir: privateDir,
      onFinish: terminate, signal: controller.signal });
    await new Promise((resolveListen, reject) => {
      gateway.once('error', reject);
      gateway.listen(4320, '127.0.0.1', resolveListen);
    });
    stage = 'tunnel startup';
    const cloud = await launch('cloudflared', ['tunnel', '--no-autoupdate', '--protocol', 'http2',
      '--metrics', '127.0.0.1:20241', '--url',
      'http://127.0.0.1:4320'], 'tunnel.log');
    const endpoint = await waitFor(async () => tunnelUrl(await readFile(join(privateDir, 'tunnel.log'), 'utf8')),
      Date.now() + 90000, [cloud.child, proxy.child]);
    stage = 'tunnel edge connection';
    await waitFor(async () => {
      try { return (await fetch('http://127.0.0.1:20241/ready', { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    }, Date.now() + 90000, [cloud.child, proxy.child]);
    stage = 'tunnel public health';
    await waitFor(async () => {
      try { return (await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(3000) })).ok; }
      catch { return false; }
    }, Date.now() + 120000, [cloud.child, proxy.child]);
    const expiresAt = new Date(Date.now() + config.minutes * 60000).toISOString();
    const payload = { sessionId: config.sessionId, runId: config.runId, repository: config.repository,
      baseUrl: `${endpoint}/agent-device`, controlUrl: endpoint, token, udid: simulator.udid,
      expiresAt, agentDeviceVersion: VERSION };
    const envelope = seal(payload, config.recipientKey, config.sessionId);
    await mkdir(dirname(config.bootstrapPath), { recursive: true });
    await writeFile(config.bootstrapPath, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
    stage = 'session serving';
    process.stdout.write('Simulator session ready; encrypted connection bundle created.\n');
    clearTimeout(timer);
    timer = setTimeout(terminate, config.minutes * 60000);
    // A lost tunnel/proxy ends the job rather than leaving a billed idle simulator.
    const serviceStopped = () => {
      if (!ending) { infrastructureFailed = true; terminate(); }
    };
    proxy.completion.then(serviceStopped, serviceStopped);
    cloud.completion.then(serviceStopped, serviceStopped);
    await ended;
    if (infrastructureFailed) throw new Error('Device service or tunnel stopped unexpectedly');
    succeeded = true;
    return 0;
  } catch (error) {
    await writeFile(join(privateDir, 'host-error.log'), String(error?.stack ?? error), { mode: 0o600 });
    if (onFailure) {
      try { await onFailure({ stage, privateDir }); } catch {}
    }
    process.stderr.write(`Simulator session failed at ${stage}. Private diagnostics were not published.\n`);
    return 1;
  } finally {
    stage = 'cleanup';
    ending = true;
    clearTimeout(timer);
    controller.abort();
    if (gateway) {
      gateway.closeAllConnections();
      gateway.close();
    }
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }
    // The daemon may detach from the proxy's process group.
    try { await run(executable, ['daemon', 'stop', '--clean'], { timeout: 15000 }); } catch {}
    if (simulator) {
      try { await run('xcrun', ['simctl', 'shutdown', simulator.udid], { timeout: 15000 }); } catch {}
    }
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    await Promise.allSettled(handles.map((handle) => handle.close()));
    await rm(privateDir, { recursive: true, force: true });
    if (process.env.HOST_EXIT_PATH) {
      await writeFile(process.env.HOST_EXIT_PATH, JSON.stringify({ ok: succeeded }), { mode: 0o600 });
    }
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', terminate);
    process.stdout.write('Simulator session finished.\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(); }
  catch {
    process.stderr.write('Simulator host failed. Private diagnostics were not published.\n');
    process.exitCode = 1;
  }
}
