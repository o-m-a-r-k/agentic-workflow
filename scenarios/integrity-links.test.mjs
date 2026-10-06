import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commitIn, criteriaFile, ok, singleRepoProject, tmp, wf } from './helpers.mjs';

// 0.1.22: named finding (0.1.21 review): chmod, chflags and writes followed a symlink planted at an evidence path, so
// the engine could chmod, unflag or overwrite an arbitrary file outside the evidence. Every case below plants a link to
// a victim file or folder outside the project, runs the engine, and checks the refusal is named and the victim is
// byte-identical with the same mode and flags. The immutable flag is on (where the platform has one).

const env = { env: { WF_EVIDENCE_FLAGS: '1' } };
const flagsOf = (p) => (process.platform === 'darwin' ? spawnSync('stat', ['-f', '%Xf', p], { encoding: 'utf8' }).stdout.trim() : spawnSync('lsattr', ['-d', p], { encoding: 'utf8' }).stdout.split(' ')[0]);
// The attacker's way to lift the immutable flag, per platform (chattr only works as root with CAP_LINUX_IMMUTABLE).
const unflag = (p) => (process.platform === 'darwin' ? spawnSync('chflags', ['-R', 'nouchg', p], { stdio: 'ignore' }) : spawnSync('chattr', ['-R', '-i', p], { stdio: 'ignore' }));
const snap = (p) => {
  const st = fs.statSync(p);
  return st.isDirectory()
    ? { mode: st.mode & 0o7777, flags: flagsOf(p), entries: fs.readdirSync(p).sort().map((f) => snap(path.join(p, f))) }
    : { mode: st.mode & 0o7777, flags: flagsOf(p), bytes: fs.readFileSync(p).toString('base64') };
};
function victims() {
  const dir = tmp('victim');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'do not touch\n');
  fs.chmodSync(path.join(dir, 'secret.txt'), 0o640);
  fs.mkdirSync(path.join(dir, 'folder'));
  fs.writeFileSync(path.join(dir, 'folder', 'output.log'), 'victim log\n');
  fs.chmodSync(path.join(dir, 'folder'), 0o750);
  return { dir, file: path.join(dir, 'secret.txt'), folder: path.join(dir, 'folder') };
}
const unlockAll = (root) => {
  unflag(path.join(root, '.wf-evidence'));
  spawnSync('chmod', ['-R', 'u+w', path.join(root, '.wf-evidence')], { stdio: 'ignore' });
};
// The way an attacker would: lift the protection of one entry and put a link in its place.
const swapForLink = (entry, target) => {
  unflag(entry);
  spawnSync('chmod', ['-R', 'u+w', entry], { stdio: 'ignore' });
  fs.chmodSync(path.dirname(entry), 0o755);
  fs.rmSync(entry, { recursive: true, force: true });
  fs.symlinkSync(target, entry);
};
function gated(name, item) {
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf a > shots/home.png', artifacts: ['shots/*.png'] }];
  const { base, root } = singleRepoProject(name, { gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'], env)).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id], env));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id], env));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id], env));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'q\n' });
  const g = JSON.parse(ok(wf(root, ['gate', '--attempt', e.id, '--json'], env)).out);
  return { base, root, id: e.id, dir: path.join(root, '.wf-evidence', 'attempts', e.id), log: g.steps[0].log };
}
const refused = (r, re) => {
  assert.notEqual(r.code, 0, `${r.out}${r.err}`);
  assert.match(`${r.err}${r.out}`, re);
};

test('a symlink at a recorded file: verification names it; nothing is chmodded, unflagged or written through it', () => {
  const v = victims();
  const { root, id, log } = gated('links-file', 'ENG-220');
  try {
    const before = snap(v.file);
    swapForLink(log, v.file);
    for (const args of [['status'], ['verify'], ['export'], ['gate'], ['verify', '--accept-changes', '--reason', 'x'], ['handoff', 'reviewer', '--agent', 'r']]) {
      refused(wf(root, [...args, '--attempt', id], env), /output\.log: symlink/);
      assert.deepEqual(snap(v.file), before, args.join(' '));
    }
  } finally {
    unlockAll(root);
  }
});

test('a symlink at a file the engine is about to write is refused, never written through', () => {
  const v = victims();
  const { root, id, dir } = gated('links-next', 'ENG-221');
  try {
    const before = snap(v.file);
    // `wf export` rewrites export/attempt.html; plant the link there first (the folder too, as an attacker could).
    ok(wf(root, ['export', '--attempt', id], env));
    swapForLink(path.join(dir, 'export', 'attempt.html'), v.file);
    refused(wf(root, ['export', '--attempt', id], env), /attempt\.html: symlink|attempt\.html is a symlink/);
    assert.deepEqual(snap(v.file), before);
  } finally {
    unlockAll(root);
  }
});

test('a symlinked attempt folder, a symlinked manifest-listed folder, a symlinked anchor: each refused, the target untouched', () => {
  const v = victims();
  const { root, id, dir, log } = gated('links-dirs', 'ENG-222');
  try {
    // A folder the manifest lists files under (the gate step folder) replaced by a link to the victim folder.
    const stepDir = path.dirname(log);
    const beforeFolder = snap(v.folder);
    swapForLink(stepDir, v.folder);
    for (const args of [['status'], ['verify'], ['gate'], ['export']]) {
      refused(wf(root, [...args, '--attempt', id], env), /ui: symlink|ui is a symlink/);
      assert.deepEqual(snap(v.folder), beforeFolder, args.join(' '));
    }
    fs.rmSync(stepDir);
    // The anchor replaced by a link to the victim file.
    const anchor = path.join(root, '.wf-worktrees', '_anchor', `${id}.json`);
    const beforeFile = snap(v.file);
    spawnSync('chmod', ['u+w', anchor]);
    fs.rmSync(anchor);
    fs.symlinkSync(v.file, anchor);
    refused(wf(root, ['status', '--attempt', id], env), /anchor .* is not a regular file/);
    assert.deepEqual(snap(v.file), beforeFile);
    fs.rmSync(anchor);
    // The whole attempt folder replaced by a link to the victim folder.
    unlockAll(root);
    fs.renameSync(dir, `${dir}.moved`);
    fs.symlinkSync(v.folder, dir);
    for (const args of [['status'], ['verify'], ['evidence', 'release']]) {
      refused(wf(root, [...args, '--attempt', id], env), /symlink/);
      assert.deepEqual(snap(v.folder), beforeFolder, args.join(' '));
    }
  } finally {
    if (fs.existsSync(root)) unlockAll(root);
  }
});

test('the anchor folder and a release target that are links are never written through', () => {
  const v = victims();
  const { root, id } = gated('links-anchor-dir', 'ENG-223');
  try {
    const anchors = path.join(root, '.wf-worktrees', '_anchor');
    const before = snap(v.folder);
    fs.renameSync(anchors, `${anchors}.moved`);
    fs.symlinkSync(v.folder, anchors);
    refused(wf(root, ['status', '--attempt', id], env), /anchor/);
    refused(wf(root, ['abandon', '--reason', 'x', '--attempt', id], env), /anchor/);
    assert.deepEqual(snap(v.folder), before, 'no anchor or cache written into the linked folder');
    fs.rmSync(anchors);
    fs.renameSync(`${anchors}.moved`, anchors);
    ok(wf(root, ['abandon', '--reason', 'x', '--attempt', id], env));
    // `released/` as a link: the release refuses before moving anything.
    const released = path.join(root, '.wf-evidence', 'released');
    fs.symlinkSync(v.folder, released);
    refused(wf(root, ['evidence', 'release', '--attempt', id], env), /released is a symlink/);
    assert.deepEqual(snap(v.folder), before);
    assert.ok(fs.lstatSync(path.join(root, '.wf-evidence', 'attempts', id)).isDirectory(), 'the attempt was not moved');
  } finally {
    unlockAll(root);
  }
});
