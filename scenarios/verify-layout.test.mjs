// `npm run verify` copies the checkout into a Linux container; from a linked git worktree that copy must still be a git
// checkout. The container is played on the host here: every read-only mount is a copy under a prefix, and the host's
// git directory is moved away before the script runs, so the copy can work only through its own relinked git dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRepo, sh, tmp, write } from './helpers.mjs';
import { verifyLayout } from '../scripts/verify-layout.mjs';

function playContainer(dir, hide) {
  const box = path.join(tmp('verify-box'), 'c');
  const layout = verifyLayout(dir, box);
  for (const b of layout.binds) {
    fs.mkdirSync(path.dirname(b.at), { recursive: true });
    fs.cpSync(b.host, b.at, { recursive: true, verbatimSymlinks: true });
  }
  fs.mkdirSync(path.join(box, 'tmp'), { recursive: true });
  // The host's git directories are out of reach, as they are in the container.
  const hidden = `${hide}.away`;
  fs.renameSync(hide, hidden);
  try {
    const r = spawnSync('sh', ['-c', `set -e; ${layout.script}`], { encoding: 'utf8', env: { ...process.env, ...layout.env } });
    assert.equal(r.status, 0, r.stderr);
    const git = (args) => spawnSync('git', args, { cwd: layout.checkout, encoding: 'utf8' });
    return { layout, git };
  } finally {
    fs.renameSync(hidden, hide);
  }
}

test('verify from a linked worktree: the container copy is a git checkout through its own copies of the git dirs', () => {
  const base = tmp('verify-wt');
  const { dir } = makeRepo(path.join(base, 'main'), { 'a.txt': 'a\n' });
  const wt = path.join(base, 'wt');
  sh(dir, `git worktree add -q ${JSON.stringify(wt)} -b side`);
  write(wt, 'b.txt', 'b\n');
  sh(wt, 'git add -A && git -c user.email=t@example.test -c user.name=t commit -q -m side');
  const head = sh(wt, 'git rev-parse HEAD');
  const before = fs.readFileSync(path.join(dir, '.git', 'worktrees', 'wt', 'gitdir'), 'utf8');
  const { layout, git } = playContainer(wt, path.join(dir, '.git'));
  assert.deepEqual(layout.binds.map((b) => path.basename(b.at)), ['w', 'g'], 'the checkout and the common git dir are mounted');
  assert.equal(layout.env.WF_VERIFY_GITDIR_REL, 'worktrees/wt');
  assert.match(fs.readFileSync(path.join(layout.checkout, '.git'), 'utf8'), new RegExp(`^gitdir: ${layout.checkout.replace(/\/w$/, '/g')}/worktrees/wt\n$`));
  const rev = git(['rev-parse', 'HEAD']);
  assert.equal(rev.status, 0, rev.stderr);
  assert.equal(rev.stdout.trim(), head);
  assert.equal(git(['status', '--short']).stdout, '', 'the copy is clean: same index, same tree');
  assert.deepEqual(git(['ls-files']).stdout.trim().split('\n').sort(), ['a.txt', 'b.txt']);
  // The suite commits inside the copy; the host's git directories never see it.
  assert.equal(git(['-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'in the box']).status, 0);
  assert.equal(sh(wt, 'git rev-parse HEAD'), head);
  assert.equal(fs.readFileSync(path.join(dir, '.git', 'worktrees', 'wt', 'gitdir'), 'utf8'), before);
});

test('verify from a plain checkout: only the checkout is mounted, its .git directory travels with it', () => {
  const base = tmp('verify-plain');
  const { dir } = makeRepo(path.join(base, 'main'), { 'a.txt': 'a\n' });
  const layout = verifyLayout(dir, path.join(base, 'c'));
  assert.equal(layout.binds.length, 1);
  assert.deepEqual(layout.env, {});
  const away = path.join(base, 'elsewhere');
  fs.mkdirSync(away);
  const { git } = playContainer(dir, away);
  assert.equal(git(['rev-parse', 'HEAD']).stdout.trim(), sh(dir, 'git rev-parse HEAD'));
});
