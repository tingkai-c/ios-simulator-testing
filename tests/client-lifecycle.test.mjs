import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../skills/ios-simulator-testing/scripts/simulator.mjs', import.meta.url));
const sha = 'a'.repeat(40);
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args)+'\\n');
const path = args.find(value => value.startsWith('repos/')) || '';
const send = value => console.log(JSON.stringify(value));
if (path.includes('/commits/')) send({sha: process.env.FAIL_MODE==='ref' ? 'b'.repeat(40) : 'a'.repeat(40)});
else if (path.endsWith('/dispatches')) fs.writeFileSync(process.env.DISPATCH_INPUT, fs.readFileSync(0));
else if (path.includes('/workflows/') && path.includes('/runs?')) {
 const input = JSON.parse(fs.readFileSync(process.env.DISPATCH_INPUT));
 send({workflow_runs:[{id:123,display_title:'simulator-'+input.inputs.session_id,head_sha:process.env.FAIL_MODE==='run'?'b'.repeat(40):'a'.repeat(40),html_url:'https://github.com/owner/harness/actions/runs/123'}]});
} else if (path.includes('/artifacts?')) {
 const calls=fs.readFileSync(process.env.CALL_LOG,'utf8').trim().split('\\n').map(JSON.parse).filter(a=>a.some(x=>x.includes('/artifacts?')));
 if(process.env.FAIL_MODE==='transient' && calls.length===1) { console.error('error connecting to api.github.com'); process.exit(1); }
 send({artifacts:[]});
}
else if (path.endsWith('/cancel')) {}
else if (path.endsWith('/runs/123')) send({id:123,status:['readiness','transient'].includes(process.env.FAIL_MODE)?'completed':'in_progress'});
else { console.error('Unexpected fake GitHub request'); process.exit(1); }
`;

for (const mode of ['ref', 'run', 'readiness', 'transient']) {
  test(`startup ${mode} failure does not leave a second or untracked simulator job`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'simulator-client-test-'));
    try {
      await writeFile(join(directory, 'gh'), fakeGh, { mode: 0o700 });
      const log = join(directory, 'calls.jsonl');
      const result = spawnSync(process.execPath, [script, 'start', '--repo', 'owner/harness', '--sha', sha,
        '--state-dir', join(directory, 'state')], {
        encoding: 'utf8', timeout: 15000,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FAIL_MODE: mode,
          CALL_LOG: log, DISPATCH_INPUT: join(directory, 'dispatch.json') },
      });
      assert.equal(result.status, 1);
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
      const dispatches = calls.filter((args) => args.some((arg) => arg.endsWith('/dispatches')));
      assert.equal(dispatches.length, mode === 'ref' ? 0 : 1, result.stderr);
      if (mode !== 'ref') assert.equal(JSON.parse(await readFile(join(directory, 'dispatch.json'), 'utf8')).inputs.ios_version, '26.2');
      const cancellations = calls.filter((args) => args.some((arg) => arg.endsWith('/cancel')));
      assert.equal(cancellations.length, mode === 'run' ? 1 : 0);
      if (cancellations.length) assert.ok(cancellations[0].includes('repos/owner/harness/actions/runs/123/cancel'));
      assert.equal(calls.some((args) => args.includes('download')), false);
      if (mode === 'transient') assert.equal(calls.filter(args=>args.some(arg=>arg.includes('/artifacts?'))).length, 2);
      assert.equal(result.stdout.includes('PRIVATE KEY'), false);
      assert.equal(result.stderr.includes('PRIVATE KEY'), false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
