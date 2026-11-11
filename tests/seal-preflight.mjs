// Used only by the public-tool-only preflight, never a source of plaintext artifacts.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { seal } from '../skills/ios-simulator-testing/scripts/lib/envelope.mjs';

process.umask(0o077);
const root = join(homedir(), '.agent-device');
const logs = [];
let remaining = 4 * 1024 * 1024;
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && /\.(log|ndjson)$/.test(entry.name) && remaining > 0) {
      const content = (await readFile(path)).subarray(-remaining).toString();
      remaining -= Buffer.byteLength(content);
      logs.push({ path: relative(root, path), content });
    }
  }
}
await collect(root);
const encrypted = seal({ runId: process.env.GITHUB_RUN_ID, logs }, process.env.RECIPIENT_KEY, 'preflight');
await writeFile(join(process.env.RUNNER_TEMP, 'encrypted-preflight.json'), JSON.stringify(encrypted), { mode: 0o600 });
console.log('Setup diagnostics encrypted for the requesting agent.');
