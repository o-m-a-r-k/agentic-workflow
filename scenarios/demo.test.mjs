import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp } from './helpers.mjs';

// The documented demo keeps working, in the order of work: the gate refused before a clean code review, a refused
// self-review, a code-review finding fixed and verified, one gate, the evidence review, a delivery and the readback.
test('examples/hello-ticket/demo.sh runs end to end and cleans up after itself', () => {
  const dir = path.join(tmp('demo'), 'run');
  const r = spawnSync('sh', [path.join(import.meta.dirname, '..', 'examples', 'hello-ticket', 'demo.sh')], { encoding: 'utf8', env: { ...process.env, DEMO_DIR: dir } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const out = r.stdout;
  assert.match(out, /tracker: admitted performed on the ticket files and read back/);
  assert.match(out, /the gate runs after a clean code review[\s\S]*no review round covers the current tree[\s\S]*\(exit 75: refused\)/);
  assert.match(out, /implementer-1 planned, wrote or owns this change and cannot review it\n\(exit 75: refused\)/);
  assert.match(out, /review recorded \(1 finding\(s\)\)\.\n[\s\S]*1 finding\(s\) from earlier rounds to verify against the code/);
  assert.match(out, /\$ wf gate --attempt HT-1\.1\n[\s\S]*gate passed \(/);
  assert.match(out, /\$ wf accept --attempt HT-1\.1\nreview accepted\./);
  assert.match(out, /delivered HT-1\.1: hello-ticket@[0-9a-f]+\ntracker: delivered performed on the ticket files and read back; attempt closed/);
  assert.match(out, /status: Ready for UAT[\s\S]*<!-- wf:comment id=c-1 [^\n]+-->\nHT-1 is ready for UAT\./);
  assert.match(out, /greet: add the comma\n[0-9a-f]+ greet by name/);
  assert.equal(fs.existsSync(dir), false, 'the temporary folder is removed');
});
