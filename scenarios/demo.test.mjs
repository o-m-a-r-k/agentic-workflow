import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp } from './helpers.mjs';

// The documented demo (README, docs/SCENARIOS.md) keeps working end to end. What it shows is asserted by the lifecycle,
// review-order, implementer-open and tracker-files scenarios; this one only runs the script the docs tell a reader to run.
test('examples/hello-ticket/demo.sh runs end to end and cleans up after itself', () => {
  const dir = path.join(tmp('demo'), 'run');
  const r = spawnSync('sh', [path.join(import.meta.dirname, '..', 'examples', 'hello-ticket', 'demo.sh')], { encoding: 'utf8', env: { ...process.env, DEMO_DIR: dir } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(fs.existsSync(dir), false, 'the temporary folder is removed');
});
