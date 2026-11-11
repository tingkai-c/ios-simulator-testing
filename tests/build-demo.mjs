import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = 'com.example.simulatorharness.demo';

async function command(executable, args, { capture = false } = {}) {
  const child = spawn(executable, args, {
    stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    timeout: 240000, killSignal: 'SIGKILL',
  });
  let output = '';
  if (capture) child.stdout.on('data', (chunk) => { output += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output.trim())
      : reject(new Error(`Synthetic build command failed (${code ?? 'signal'})`)));
  });
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Synthetic simulator build requires macOS');
  const outputDirectory = process.env.RUNNER_TEMP || tmpdir();
  const directory = await mkdtemp(join(outputDirectory, 'harness-demo-build-'));
  const app = join(directory, 'HarnessDemo.app');
  const archive = join(outputDirectory, 'harness-demo.zip');
  try {
    await mkdir(app);
    const sdk = await command('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { capture: true });
    await command('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-sdk', sdk, '-target',
      'arm64-apple-ios18.0-simulator', '-parse-as-library', join(root, 'tests/demo-app.swift'),
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
    await rm(archive, { force: true });
    await command('ditto', ['-c', '-k', '--keepParent', app, archive]);
    const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
    await writeFile(join(outputDirectory, 'harness-demo.sha256'), `${checksum}  harness-demo.zip\n`);
    process.stdout.write('Synthetic ARM64 simulator app packaged as harness-demo.zip.\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

try { await main(); }
catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
