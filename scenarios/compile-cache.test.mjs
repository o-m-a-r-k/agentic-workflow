// The scenario helpers give `wf` processes Node's on-disk compile cache. That cache is code the engine runs, so it
// must never sit at a path another user or an agent can predict or pre-create. Named failure (security review of the
// first version): the cache was `<tmp>/wf-scenarios-node-cache`, a fixed name in a shared /tmp on Linux, so anyone
// could pre-create it, or a link in its place, and plant compiled code the next suite run would execute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileCacheDir, singleRepoProject, wf } from './helpers.mjs';

const helpers = new URL('./helpers.mjs', import.meta.url).href;
const otherProcessDir = () => spawnSync(process.execPath, ['--input-type=module', '-e', `import { compileCacheDir } from ${JSON.stringify(helpers)}; process.stdout.write(compileCacheDir())`], { encoding: 'utf8' }).stdout;

test('the compile cache is a fresh private folder of this user per process, never a fixed path, removed at exit', () => {
  const dir = compileCacheDir();
  const st = fs.lstatSync(dir);
  assert.ok(st.isDirectory() && !st.isSymbolicLink());
  if (process.getuid) assert.equal(st.uid, process.getuid());
  assert.equal(st.mode & 0o077, 0, 'no group or other access');
  assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir()));
  const other = otherProcessDir();
  assert.match(path.basename(other), /^wf-node-cache-.{6}$/);
  assert.notEqual(other, dir, 'another process gets its own folder');
  assert.equal(fs.existsSync(other), false, 'removed when that process exits');
});

test('a folder or link planted at the old fixed path is never used: nothing is read from or written into it', () => {
  const planted = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wf-planted-'));
  fs.chmodSync(planted, 0o777);
  const old = path.join(fs.realpathSync(os.tmpdir()), 'wf-scenarios-node-cache');
  let link = false;
  if (!fs.existsSync(old)) {
    fs.symlinkSync(planted, old);
    link = true;
  }
  try {
    const { root } = singleRepoProject('compile-cache', {});
    const r = wf(root, ['status', '--json'], { ownerSilent: true });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(fs.readdirSync(planted), [], 'nothing written through the planted path');
    assert.ok(fs.readdirSync(compileCacheDir()).length > 0, 'the wf process used the private cache');
  } finally {
    if (link) fs.unlinkSync(old);
    fs.rmSync(planted, { recursive: true, force: true });
  }
});
