import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../host/host.mjs';
import { seal } from '../skills/ios-simulator-testing/scripts/lib/envelope.mjs';

// Synthetic smoke entrypoint only. The production workflow runs host/host.mjs.
const filenames = ['host-error.log', 'commands.log', 'proxy.log', 'tunnel.log'];
const maximumPerFile = 1024 * 1024;

async function encryptedFailure({ stage, privateDir }) {
  const logs = {};
  for (const filename of filenames) {
    let handle;
    try {
      handle = await open(join(privateDir, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) continue;
      const length = Math.min(info.size, maximumPerFile);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, info.size - length));
      logs[filename] = buffer.subarray(0, bytesRead).toString();
    } catch {
      // A subprocess may fail before creating its log.
    } finally {
      await handle?.close();
    }
  }
  const encrypted = seal({ runId: process.env.GITHUB_RUN_ID, stage, logs },
    process.env.RECIPIENT_KEY, process.env.SESSION_ID);
  await writeFile(join(process.env.RUNNER_TEMP, 'encrypted-native-host.json'),
    JSON.stringify(encrypted), { mode: 0o600 });
}

try { process.exitCode = await main({ onFailure: encryptedFailure }); }
catch {
  process.stderr.write('Synthetic simulator host failed. Private diagnostics were not published.\n');
  process.exitCode = 1;
}
