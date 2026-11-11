import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { keypair, seal, unseal } from '../skills/ios-simulator-testing/scripts/lib/envelope.mjs';
import { checkBootstrap } from '../skills/ios-simulator-testing/scripts/simulator.mjs';
import { HOST_STAGES } from '../host/host.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const executable = join(root, 'skills/ios-simulator-testing/node_modules/.bin/agent-device');
const bundle = 'com.example.simulatorharness.demo';
let stage = 'preflight';

/** Native-only integration: the public tunnel transports synthetic inputs only. */
async function main() {
  if (process.platform !== 'darwin') throw new Error('Native smoke requires macOS');
  process.umask(0o077);
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'native-smoke-'));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_DEVICE_')));
  const sessionId = randomBytes(16).toString('hex');
  const keys = keypair();
  const bootstrap = join(directory, 'envelope.json');
  const publicOutput = join(directory, 'public-host.log');
  const privateLog = await open(join(directory, 'client.log'), 'a', 0o600);
  const hostLog = await open(publicOutput, 'a', 0o600);
  const deadline = Date.now() + 20 * 60 * 1000;
  const children = new Set();
  let host, connection, hostComplete, passed = false;
  const clientEnv = { ...clean,
    NODE_OPTIONS: `${clean.NODE_OPTIONS ?? ''} --require ${JSON.stringify(join(root, 'skills/ios-simulator-testing/scripts/lib/tunnel-dns.cjs'))}`.trim(),
    AGENT_DEVICE_STATE_DIR: join(directory, 'client-state'),
    AGENT_DEVICE_HOME: join(directory, 'client-home'), AGENT_DEVICE_CONFIG: join(directory, 'client-config.json'),
    AGENT_DEVICE_SESSION: sessionId, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' };
  await writeFile(clientEnv.AGENT_DEVICE_CONFIG, '{}', { mode: 0o600 });

  async function command(command, args, { capture = false, environment = clientEnv, timeout = 240000 } = {}) {
    const remaining = deadline - Date.now();
    if (remaining < 1) throw new Error('Native smoke exceeded deadline');
    const child = spawn(command, args, { cwd: directory, env: environment,
      stdio: ['ignore', capture ? 'pipe' : privateLog.fd, privateLog.fd],
      timeout: Math.min(timeout, remaining), killSignal: 'SIGKILL' });
    children.add(child);
    let output = '';
    if (capture) child.stdout.on('data', (chunk) => { output += chunk; privateLog.write(chunk).catch(() => {}); });
    return new Promise((resolve, reject) => {
      child.once('error', () => {
        process.stderr.write(`Synthetic command ${basename(command)} could not start.\n`);
        reject(new Error('Native smoke command could not start'));
      });
      child.once('exit', (code) => {
        children.delete(child);
        if (code === 0) resolve(output.trim());
        else {
          process.stderr.write(`Synthetic command ${basename(command)} failed (exit ${code ?? 'signal'}).\n`);
          reject(new Error('Native smoke command failed'));
        }
      });
    });
  }

  async function device(...args) {
    if (connection && !['connect', 'disconnect'].includes(args[0])) {
      if (!args.includes('--platform')) args.push('--platform', 'ios');
      args.push('--udid', connection.udid);
    }
    return command(executable, args);
  }
  async function countIs(value) {
    await device('wait', `label="Count: ${value}"`, '120000');
    await device('is', 'visible', `label="Count: ${value}"`);
  }
  async function state(operation, bytes) {
    const result = await fetch(`${connection.controlUrl}/state/${operation}?bundle=${bundle}`, {
      method: operation === 'export' ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${connection.token}`, ...(bytes ? { 'content-type': 'application/zip' } : {}) },
      body: bytes, signal: AbortSignal.timeout(Math.min(360000, deadline - Date.now())),
    });
    assert.equal(result.status, 200, 'Fixture transfer failed');
    return Buffer.from(await result.arrayBuffer());
  }

  try {
    stage = 'synthetic app build';
    process.stdout.write('Building synthetic simulator app.\n');
    const app = join(directory, 'HarnessDemo.app');
    await mkdir(app);
    const sdk = await command('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { capture: true });
    const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    await command('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-sdk', sdk, '-target',
      `${architecture}-apple-ios18.0-simulator`, '-parse-as-library', join(root, 'tests/demo-app.swift'),
      '-framework', 'UIKit', '-o', join(app, 'HarnessDemo')]);
    await writeFile(join(app, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundle}</string>
<key>CFBundleExecutable</key><string>HarnessDemo</string>
<key>CFBundleName</key><string>HarnessDemo</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>MinimumOSVersion</key><string>18.0</string>
<key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
<key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
<key>LSRequiresIPhoneOS</key><true/><key>UILaunchScreen</key><dict/>
</dict></plist>`);
    await command('codesign', ['--force', '--sign', '-', '--timestamp=none', app]);
    stage = 'host startup';
    process.stdout.write('Starting isolated simulator host.\n');
    host = spawn(process.execPath, [join(root, 'tests/native-host.mjs')], {
      cwd: root, env: { ...clean, SESSION_ID: sessionId, SESSION_MINUTES: '15', SIMULATOR_IOS_VERSION: '26.2',
        RECIPIENT_KEY: keys.publicKey, BOOTSTRAP_PATH: bootstrap,
        GITHUB_RUN_ID: process.env.GITHUB_RUN_ID || '1',
        GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || 'example/harness',
        RUNNER_TEMP: directory, HOST_EXIT_PATH: join(directory, 'host-exit.json') },
      stdio: ['ignore', hostLog.fd, hostLog.fd],
    });
    hostComplete = new Promise((resolve, reject) => {
      host.once('error', reject);
      host.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Native host failed')));
    });
    hostComplete.catch(() => {});
    while (Date.now() < deadline) {
      if (host.exitCode !== null) throw new Error('Native host ended before readiness');
      let envelope;
      try { envelope = JSON.parse(await readFile(bootstrap, 'utf8')); } catch {}
      if (envelope) {
        connection = unseal(envelope, keys.privateKey, sessionId);
        break;
      }
      await delay(500);
    }
    assert(connection, 'Host did not become ready');
    checkBootstrap(connection, { sessionId, runId: process.env.GITHUB_RUN_ID || '1',
      repository: process.env.GITHUB_REPOSITORY || 'example/harness' });
    assert.equal(connection.sessionId, sessionId);
    assert.equal(connection.runId, process.env.GITHUB_RUN_ID || '1');
    assert.equal(connection.repository, process.env.GITHUB_REPOSITORY || 'example/harness');
    assert.match(connection.token, /^[a-f0-9]{64}$/);
    assert.match(connection.controlUrl, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
    assert.equal(connection.baseUrl, `${connection.controlUrl}/agent-device`);
    assert.equal(connection.agentDeviceVersion, '0.21.36');
    assert(Date.parse(connection.expiresAt) > Date.now());
    clientEnv.AGENT_DEVICE_DAEMON_AUTH_TOKEN = connection.token;
    stage = 'remote connect';
    process.stdout.write('Testing remote upload, observation, tap, and assertion.\n');
    await device('connect', 'proxy', '--daemon-base-url', connection.baseUrl);
    stage = 'remote app upload';
    await device('install', bundle, app, '--platform', 'ios');
    stage = 'remote app launch';
    await device('open', bundle, '--platform', 'ios');
    stage = 'initial counter assertion';
    await device('snapshot', '-i');
    await countIs(0);
    stage = 'counter tap and assertion';
    await device('click', 'label="Increment"');
    await countIs(1);
    await device('close');
    stage = 'fixture export';
    process.stdout.write('Testing app-data export and restore.\n');
    const checkpoint = await state('export');
    assert.equal(checkpoint.subarray(0, 2).toString(), 'PK');
    await device('open', bundle, '--platform', 'ios');
    await countIs(1);
    await device('click', 'label="Increment"');
    await countIs(2);
    await device('close');
    stage = 'fixture import';
    await state('import', checkpoint);
    stage = 'restored UI assertion and capture';
    await device('open', bundle, '--platform', 'ios');
    await countIs(1);
    const screenshot = join(directory, 'synthetic-screen.png');
    await device('screenshot', screenshot);
    assert.deepEqual((await readFile(screenshot)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await device('close');
    await device('disconnect');
    stage = 'session cleanup';
    const finish = await fetch(`${connection.controlUrl}/finish`, { method: 'POST',
      headers: { authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(10000) });
    assert.equal(finish.status, 200);
    await Promise.race([hostComplete, delay(Math.max(1, deadline - Date.now()), undefined, { ref: false })
      .then(() => { throw new Error('Host cleanup exceeded native smoke deadline'); })]);
    assert.equal((await readFile(publicOutput, 'utf8')).includes(connection.token), false,
      'Host public output leaked the control token');
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'host-exit.json'), 'utf8')), { ok: true });
    passed = true;
    process.stdout.write('Synthetic native smoke passed.\n');
  } finally {
    for (const child of children) child.kill('SIGKILL');
    if (host && host.exitCode === null) {
      host.kill('SIGTERM');
      await Promise.race([hostComplete.catch(() => {}), delay(35000, undefined, { ref: false })]);
      if (host.exitCode === null) host.kill('SIGKILL');
    }
    await privateLog.close();
    await hostLog.close();
    if (!passed) {
      if (process.env.DIAGNOSTIC_RECIPIENT_KEY) {
        const logs = (await readFile(join(directory, 'client.log'))).subarray(-4 * 1024 * 1024).toString();
        let hostFailure;
        try { hostFailure = unseal(JSON.parse(await readFile(join(directory, 'encrypted-native-host.json'), 'utf8')), keys.privateKey, sessionId); } catch {}
        const encrypted = seal({ runId: process.env.GITHUB_RUN_ID, stage, logs, hostFailure }, process.env.DIAGNOSTIC_RECIPIENT_KEY, 'native-smoke');
        await writeFile(join(process.env.RUNNER_TEMP, 'encrypted-native-smoke.json'), JSON.stringify(encrypted), { mode: 0o600 });
      }
      const hostOutput = await readFile(publicOutput, 'utf8').catch(() => '');
      const failedStage = HOST_STAGES.find((value) => hostOutput.split(/\r?\n/).includes(
        `Simulator session failed at ${value}. Private diagnostics were not published.`));
      if (failedStage) {
        // Reconstruct from the fixed allowlist; never echo arbitrary host output.
        process.stderr.write(`Simulator session failed at ${failedStage}. Private diagnostics were not published.\n`);
      }
    }
    if (passed) await rm(directory, { recursive: true, force: true });
    // On failure, only generic status is public; diagnostic files remain local.
  }
}

try { await main(); }
catch {
  process.stderr.write(`Synthetic native smoke failed at ${stage}; private diagnostic files were not published.\n`);
  process.exitCode = 1;
}
