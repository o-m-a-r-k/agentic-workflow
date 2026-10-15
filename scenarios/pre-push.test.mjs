import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, sh, tmp, write } from './helpers.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 2026-10-15, named cost: the hook ran the whole scenario suite on this machine before every push, holding every core for 6
// to 11 minutes on a machine shared with other agents' gates. A commit now reaches main only once GitHub CI passed on it;
// the hook asks GitHub (here a stub `gh`) and runs no test itself. Other branches are not checked.
test('a push to main needs CI to have passed on the commit; a branch push is not checked and no suite runs here', () => {
  const base = tmp('pre-push-ci');
  const { dir, remote } = makeRepo(path.join(base, 'source'), { 'a.txt': 'original\n' });
  fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(repo, '.githooks/pre-push'), path.join(dir, '.githooks/pre-push'));
  fs.copyFileSync(path.join(repo, 'scripts/ci-passed.mjs'), path.join(dir, 'scripts/ci-passed.mjs'));
  fs.chmodSync(path.join(dir, '.githooks/pre-push'), 0o755);
  sh(dir, 'git config core.hooksPath .githooks');
  const bin = path.join(base, 'bin');
  const calls = path.join(base, 'gh-calls.txt');
  write(bin, 'gh', `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\nprintf '%s' "$GH_STUB"\n`);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  write(bin, 'npm', '#!/bin/sh\nexit 97\n');
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  const push = (ref, stub) => spawnSync('git', ['push', '-q', remote, ref], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GH_STUB: stub } });
  write(dir, 'a.txt', 'changed\n');
  sh(dir, 'git add a.txt && git commit -q -m change');
  const branch = push('HEAD:refs/heads/release', '[]');
  assert.equal(branch.status, 0, branch.stderr);
  assert.ok(!fs.existsSync(calls), 'a branch push asks nothing');
  const red = push('HEAD:refs/heads/main', JSON.stringify([{ conclusion: 'failure', status: 'completed', databaseId: 1 }]));
  assert.notEqual(red.status, 0);
  assert.match(red.stderr, /CI has not passed on [0-9a-f]{10} \(its runs: failure\)/);
  const green = push('HEAD:refs/heads/main', JSON.stringify([{ conclusion: 'success', status: 'completed', databaseId: 2 }]));
  assert.equal(green.status, 0, green.stderr);
  assert.match(fs.readFileSync(calls, 'utf8'), new RegExp(`run list --commit ${sh(dir, 'git rev-parse HEAD')} --workflow scenarios`));
});
