import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp } from './helpers.mjs';

// The documented demo keeps working: a refused gate, a refused self-review, a delivery and the ticket's readback.
test('examples/hello-ticket/demo.sh runs end to end and cleans up after itself', () => {
  const dir = path.join(tmp('demo'), 'run');
  const r = spawnSync('sh', [path.join(import.meta.dirname, '..', 'examples', 'hello-ticket', 'demo.sh')], { encoding: 'utf8', env: { ...process.env, DEMO_DIR: dir } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const out = r.stdout;
  assert.match(out, /tracker: admitted performed on the ticket files and read back/);
  // The failing step's own output differs by Node version; wf's verdict and exit code do not.
  assert.match(out, /wf gate: failed {3}unit[\s\S]*gate failed \([^)]+\)\n {2}failed {6}unit[^\n]*\n\(exit 1: refused\)/);
  assert.match(out, /implementer-1 planned, wrote or owns this change and cannot review it\n\(exit 75: refused\)/);
  assert.match(out, /delivered HT-1\.1: hello-ticket@[0-9a-f]+\ntracker: delivered performed on the ticket files and read back; attempt closed/);
  assert.match(out, /status: Ready for UAT[\s\S]*<!-- wf:comment id=c-1 [^\n]+-->\nHT-1 is ready for UAT\./);
  assert.match(out, /greet: add the comma\n[0-9a-f]+ greet by name/);
  assert.equal(fs.existsSync(dir), false, 'the temporary folder is removed');
});
