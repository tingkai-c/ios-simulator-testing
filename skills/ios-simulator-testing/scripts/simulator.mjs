#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { keypair, unseal } from './lib/envelope.mjs';

const skillDir = fileURLToPath(new URL('..', import.meta.url));
const deviceBin = join(skillDir, 'node_modules', '.bin', 'agent-device');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const workflow = 'session.yml';
const maxFixture = 256 * 1024 * 1024;

export function checkBootstrap(data, expected, now = Date.now()) {
  if ((data.iosVersion !== undefined && !/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(data.iosVersion))
      || (expected.requestedIosVersion && expected.requestedIosVersion !== 'newest' && data.iosVersion !== expected.requestedIosVersion)) {
    throw new Error('Bootstrap iOS runtime does not match the requested version');
  }
  if (data.sessionId !== expected.sessionId || String(data.runId) !== String(expected.runId)
      || data.repository !== expected.repository || data.agentDeviceVersion !== '0.21.36') {
    throw new Error('Bootstrap identity or version does not match the requested run');
  }
  const endpoint = new URL(data.baseUrl);
  if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(endpoint.hostname)
      || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.pathname !== '/agent-device' || data.controlUrl !== endpoint.origin) {
    throw new Error('Bootstrap contains an unexpected tunnel endpoint');
  }
  if (!/^[a-f0-9]{64}$/.test(data.token) || !/^[a-f0-9-]{36}$/i.test(data.udid)
      || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= now
      || Date.parse(data.expiresAt) > now + 45 * 60_000) {
    throw new Error('Bootstrap contains invalid or expired session credentials');
  }
  return data;
}

function command(bin, args, { input, env = process.env, inherit = false, timeout = 120_000 } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(bin, args, { env, stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    let stdout = '', stderr = '';
    if (!inherit) {
      child.stdout.on('data', (value) => { stdout += value; });
      child.stderr.on('data', (value) => { stderr += value; });
      child.stdin.end(input);
    }
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); done({ code: code ?? 1, stdout, stderr }); });
  });
}

async function gh(args, input) {
  const result = await command('gh', args, { input });
  if (result.code !== 0) throw new Error('GitHub request failed; check gh authentication and repository Actions permissions');
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

async function save(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function load(path, credentials = true) {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error('Session file must have mode 0600');
  const session = JSON.parse(await readFile(path, 'utf8'));
  if (credentials) checkBootstrap(session, session);
  return session;
}

export function deviceEnv(session, path) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_DEVICE_')));
  return {
    ...inherited,
    AGENT_DEVICE_DAEMON_AUTH_TOKEN: session.token,
    AGENT_DEVICE_SESSION: session.sessionId,
    AGENT_DEVICE_STATE_DIR: join(dirname(path), 'device'),
    AGENT_DEVICE_HOME: join(dirname(path), 'device-home'),
    AGENT_DEVICE_CONFIG: join(dirname(path), 'device-config.json'),
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
    NODE_OPTIONS: `${inherited.NODE_OPTIONS ?? ''} --require ${JSON.stringify(join(skillDir, 'scripts/lib/tunnel-dns.cjs'))}`.trim(),
  };
}

async function connect(session, path) {
  const result = await command(deviceBin, ['connect', 'proxy', '--daemon-base-url', session.baseUrl], { env: deviceEnv(session, path) });
  if (result.code !== 0) throw new Error('Simulator connection failed; stop this run before starting a replacement');
}

async function findRun(session) {
  const runs = await gh(['api', `repos/${session.repository}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100`]);
  return runs.workflow_runs.find((run) => run.display_title === `simulator-${session.sessionId}`);
}

async function terminate(session) {
  if (session.token) {
    try {
      const response = await fetch(`${session.controlUrl}/finish`, {
        method: 'POST', headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return;
    } catch { /* Cancel the exact GitHub run if its tunnel is no longer reachable. */ }
  }
  if (!session.runId) session.runId = (await findRun(session))?.id;
  if (session.runId) {
    const run = await gh(['api', `repos/${session.repository}/actions/runs/${session.runId}`]);
    if (run.status !== 'completed') await gh(['api', '--method', 'POST', `repos/${session.repository}/actions/runs/${session.runId}/cancel`]);
  }
}

async function start(options) {
  const repository = options.repo;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('--repo owner/name is required');
  if (!/^[a-f0-9]{40}$/.test(options.sha ?? '')) throw new Error('--sha must be a reviewed full commit SHA from the public harness repository');
  const ref = options.ref ?? 'main';
  const commit = await gh(['api', `repos/${repository}/commits/${encodeURIComponent(ref)}`]);
  if (commit.sha !== options.sha) throw new Error('The workflow ref no longer matches the reviewed SHA');
  const minutes = Number(options.minutes ?? 15);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 30) throw new Error('--minutes must be an integer from 5 to 30');
  const runner = options.runner ?? 'macos-latest';
  if (!['macos-latest', 'xcode-27'].includes(runner)) throw new Error('Unsupported runner');
  const iosVersion = options['ios-version'] ?? '26.2';
  if (iosVersion !== 'newest' && !/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(iosVersion)) throw new Error('Unsupported iOS runtime version');
  const sessionId = randomBytes(16).toString('hex');
  const stateRoot = resolve(options['state-dir'] ?? join(homedir(), '.local', 'state', 'ios-simulator-testing'));
  const path = join(stateRoot, sessionId, 'session.json');
  const keys = keypair();
  let session = { sessionId, repository, ref, sha: options.sha, requestedIosVersion: iosVersion, privateKey: keys.privateKey };
  await save(path, session);
  process.stderr.write(`Session state: ${path}\n`);
  try {
    await gh(['api', '--method', 'POST', `repos/${repository}/actions/workflows/${workflow}/dispatches`, '--input', '-'], JSON.stringify({
      ref,
      inputs: { session_id: sessionId, recipient_key: keys.publicKey, lifetime_minutes: String(minutes), runner, ios_version: iosVersion },
    }));
    let run;
    const discoveryDeadline = Date.now() + 120_000;
    while (!run && Date.now() < discoveryDeadline) {
      run = await findRun(session);
      if (!run) await sleep(5000);
    }
    if (!run) throw new Error('Dispatched run has not appeared; inspect this session before retrying');
    session.runId = run.id;
    session.runUrl = run.html_url;
    await save(path, session);
    if (run.head_sha !== session.sha) throw new Error('Dispatched workflow SHA differs from the reviewed SHA');
    process.stderr.write(`Waiting for simulator: ${run.html_url}\n`);
    const deadline = Date.now() + 15 * 60_000;
    let artifact;
    while (!artifact && Date.now() < deadline) {
      const artifacts = await gh(['api', `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`]);
      artifact = artifacts.artifacts.find((item) => item.name === `session-${sessionId}` && !item.expired);
      if (artifact) break;
      const current = await gh(['api', `repos/${repository}/actions/runs/${run.id}`]);
      if (current.status === 'completed') throw new Error('Simulator job ended before readiness; public logs contain only sanitized status');
      await sleep(10_000);
    }
    if (!artifact) throw new Error('Simulator readiness timed out');
    const download = join(dirname(path), 'bootstrap');
    await mkdir(download, { mode: 0o700 });
    const result = await command('gh', ['run', 'download', String(run.id), '--repo', repository, '--name', artifact.name, '--dir', download]);
    if (result.code) throw new Error('Could not download encrypted session bootstrap');
    const envelope = JSON.parse(await readFile(join(download, 'envelope.json'), 'utf8'));
    const ready = checkBootstrap(unseal(envelope, session.privateKey, sessionId), session);
    session = { ...session, ...ready };
    delete session.privateKey;
    await save(path, session);
    await save(join(dirname(path), 'device-config.json'), {});
    await connect(session, path);
    return { sessionId, runId: run.id, runUrl: run.html_url, stateFile: path, expiresAt: session.expiresAt };
  } catch (error) {
    try { await terminate(session); } catch { /* Keep state so stop can be retried without starting another run. */ }
    throw error;
  }
}

async function stateTransfer(kind, options, session, path) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/.test(options.bundle ?? '')) throw new Error('--bundle must be a bundle identifier');
  const closed = await command(deviceBin, ['close', '--json'], { env: deviceEnv(session, path) });
  if (!alreadyClosed(closed)) throw new Error('Could not close the device session before changing app data');
  let body;
  if (kind === 'import') {
    if (!options.file || (await stat(options.file)).size > maxFixture) throw new Error('--file must name a fixture ZIP up to 256 MiB');
    body = await readFile(options.file);
  } else if (!options.out) throw new Error('--out is required');
  const response = await fetch(`${session.controlUrl}/state/${kind}?bundle=${encodeURIComponent(options.bundle)}`, {
    method: kind === 'import' ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${session.token}`, ...(body ? { 'content-type': 'application/zip' } : {}) },
    body, signal: AbortSignal.timeout(360_000),
  });
  if (!response.ok) throw new Error(`Fixture ${kind} failed (${response.status}); no remote diagnostic output is published`);
  if (kind === 'export') {
    const output = resolve(options.out);
    // Exclusive creation avoids overwriting a user's existing data.
    await writeFile(output, Buffer.from(await response.arrayBuffer()), { flag: 'wx', mode: 0o600 });
    return { exported: output };
  }
  return { imported: true, bundleId: options.bundle };
}

export function alreadyClosed(result) {
  if (result.code === 0) return true;
  try { return JSON.parse(result.stdout).error?.code === 'SESSION_NOT_FOUND'; }
  catch { return false; }
}

const help = `Usage: node simulator.mjs <start|exec|state-import|state-export|status|stop> [options] [-- agent-device arguments]

start --repo OWNER/REPO --sha FULL_SHA [--ref main] [--runner macos-latest|xcode-27] [--ios-version 26.2|newest] [--minutes 15] [--state-dir PRIVATE_DIR]
exec --state SESSION_JSON -- snapshot -i
state-export --state SESSION_JSON --bundle com.example.app --out fixture.zip
state-import --state SESSION_JSON --bundle com.example.app --file fixture.zip
status|stop --state SESSION_JSON

Requires Node 24+, gh, and bun install in the skill directory. Session keys and tokens stay in private local state.
`;

export async function main(argv) {
  process.umask(0o077);
  const [action, ...rest] = argv;
  if (!action || action === '--help') { process.stdout.write(help); return; }
  const divider = rest.indexOf('--');
  const rawArgs = divider < 0 ? [] : rest.slice(divider + 1);
  const { values: options } = parseArgs({ args: divider < 0 ? rest : rest.slice(0, divider), options: {
    repo: { type: 'string' }, ref: { type: 'string' }, sha: { type: 'string' }, runner: { type: 'string' }, minutes: { type: 'string' },
    'ios-version': { type: 'string' }, 'state-dir': { type: 'string' }, state: { type: 'string' }, bundle: { type: 'string' },
    out: { type: 'string' }, file: { type: 'string' },
  } });
  if (action === 'start') { console.log(JSON.stringify(await start(options))); return; }
  if (!options.state) throw new Error('--state SESSION_JSON is required');
  const path = resolve(options.state);
  const session = await load(path, !['status', 'stop'].includes(action));
  if (action === 'exec') {
    if (!rawArgs.length || ['connect', 'disconnect', 'proxy', 'daemon', 'mcp'].includes(rawArgs[0])
        || rawArgs.some((item) => /^--(session|config|remote-config|daemon-base-url|daemon-auth-token|state-dir|udid|platform)(=|$)/.test(item))) {
      throw new Error('Pass device commands after --; this helper owns connection and device selection');
    }
    const result = await command(deviceBin, [...rawArgs, '--platform', 'ios', '--udid', session.udid], { env: deviceEnv(session, path), inherit: true, timeout: 600_000 });
    process.exitCode = result.code;
    return;
  }
  let result;
  if (action === 'state-import' || action === 'state-export') {
    result = await stateTransfer(action.slice(6), options, session, path);
  } else if (action === 'status') {
    if (!session.runId) session.runId = (await findRun(session))?.id;
    if (!session.runId) throw new Error('This session has no visible run yet');
    const run = await gh(['api', `repos/${session.repository}/actions/runs/${session.runId}`]);
    result = { sessionId: session.sessionId, runId: run.id, status: run.status, conclusion: run.conclusion, runUrl: run.html_url, expiresAt: session.expiresAt };
  } else if (action === 'stop') {
    await terminate(session);
    // Retain nonsecret run identity for status, remove credentials and device connection files.
    delete session.token;
    delete session.privateKey;
    await rm(join(dirname(path), 'device'), { recursive: true, force: true });
    await save(path, session);
    result = { stopRequested: true, runId: session.runId };
  } else throw new Error('Unknown command; run --help');
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
import './lib/tunnel-dns.cjs';
