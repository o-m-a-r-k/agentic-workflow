import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonical, isInside, touchesEvidence } from '../engine/paths.mjs';
import { LinkRefused, chmodNoFollow, linkSeams, writeNoFollow } from '../engine/evidence.mjs';
import { check } from '../hooks/guard-evidence.mjs';
import { commitIn, criteriaFile, ok, OUT_OF_ORDER, singleRepoProject, tmp, wf } from './helpers.mjs';

// 0.1.23: named findings (0.1.22 review): a hard link at an evidence path shared its data with a file outside; a link
// swapped in between a check and its use; path checks that disagreed with how the OS resolves a path.

const env = { env: { WF_EVIDENCE_FLAGS: '1' } };
const flagsOf = (p) => (process.platform === 'darwin' ? spawnSync('stat', ['-f', '%Xf', p], { encoding: 'utf8' }).stdout.trim() : spawnSync('lsattr', ['-d', p], { encoding: 'utf8' }).stdout.split(' ')[0]);
const snap = (p) => ({ mode: fs.statSync(p).mode & 0o7777, flags: flagsOf(p), bytes: fs.readFileSync(p).toString('base64') });
const unflag = (p) => (process.platform === 'darwin' ? spawnSync('chflags', ['-R', 'nouchg', p], { stdio: 'ignore' }) : spawnSync('chattr', ['-R', '-i', p], { stdio: 'ignore' }));
const unlockAll = (root) => {
  unflag(path.join(root, '.wf-evidence'));
  spawnSync('chmod', ['-R', 'u+w', path.join(root, '.wf-evidence')], { stdio: 'ignore' });
};
const victim = () => {
  // Same volume as the evidence (a hard link cannot cross devices).
  const dir = tmp('hl-victim');
  const file = path.join(dir, 'secret.txt');
  fs.writeFileSync(file, 'do not touch\n');
  fs.chmodSync(file, 0o640);
  return file;
};
function gated(name, item, steps) {
  const { base, root } = singleRepoProject(name, { gate: { steps } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'], env)).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id], env));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id], env));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id], env));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'q\n' });
  const g = JSON.parse(ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json'], env)).out);
  return { base, root, id: e.id, dir: path.join(root, '.wf-evidence', 'attempts', e.id), g };
}
const refused = (r, re) => {
  assert.notEqual(r.code, 0, `${r.out}${r.err}`);
  assert.match(`${r.err}${r.out}`, re);
};

test('a hard link at a recorded path is refused everywhere; the outside file keeps its bytes, mode and flags', () => {
  const v = victim();
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf a > shots/home.png', artifacts: ['shots/*.png'] }];
  const { root, id, g } = gated('hl-recorded', 'ENG-230', visual);
  try {
    const log = g.steps[0].log;
    unflag(log);
    fs.chmodSync(path.dirname(log), 0o755);
    fs.chmodSync(log, 0o644);
    fs.rmSync(log);
    fs.linkSync(v, log);
    const before = snap(v);
    for (const args of [['status'], ['verify'], ['export'], ['gate', ...OUT_OF_ORDER], ['handoff', 'reviewer', '--agent', 'r'], ['verify', '--accept-changes', '--reason', 'x']]) {
      refused(wf(root, [...args, '--attempt', id], env), /output\.log: hard link/);
      assert.deepEqual(snap(v), before, args.join(' '));
    }
  } finally {
    unlockAll(root);
  }
});

test('a hard link never brings outside data in: scratch and worktree hard links are neither copied nor collected', () => {
  const v = victim();
  const steps = [{ id: 'ui', repo: 'app', artifacts: ['shots/*.png'], run: `mkdir -p shots && printf a > shots/home.png && ln ${JSON.stringify(v)} shots/secret.png && ln ${JSON.stringify(v)} "$WF_EVIDENCE/secret.txt"` }];
  const { root, g } = gated('hl-copy', 'ENG-231', steps);
  try {
    const step = g.steps[0];
    assert.deepEqual(step.artifacts.map((a) => a.source), ['shots/home.png']);
    assert.ok(!fs.existsSync(path.join(path.dirname(step.log), 'out', 'secret.txt')));
  } finally {
    unlockAll(root);
  }
});

test('writes replace a name, never shared data; appends and chmod refuse a file with two names', () => {
  const dir = tmp('hl-write');
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'outside\n');
  const inside = path.join(dir, 'inside.txt');
  fs.linkSync(outside, inside);
  assert.throws(() => writeNoFollow(inside, 'x', { append: true }), /hard link/);
  assert.throws(() => chmodNoFollow(inside, 0o444), /hard link/);
  writeNoFollow(inside, 'new\n');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n', 'the rename replaced the name, not the shared data');
  assert.equal(fs.readFileSync(inside, 'utf8'), 'new\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['inside.txt', 'outside.txt'], 'no temporary file left');
});

test('a swap between the check and the use is refused (chmod by descriptor; flags re-checked and undone)', () => {
  const dir = tmp('hl-race');
  const target = path.join(dir, 'evidence.log');
  const other = path.join(dir, 'other.txt');
  fs.writeFileSync(target, 'e');
  fs.writeFileSync(other, 'o');
  fs.chmodSync(other, 0o640);
  try {
    linkSeams.beforeOpen = (p) => {
      fs.rmSync(p);
      fs.copyFileSync(other, p);
    };
    assert.throws(() => chmodNoFollow(target, 0o444), (e) => e instanceof LinkRefused && /replaced between its check and its use/.test(e.message));
  } finally {
    linkSeams.beforeOpen = null;
  }
  assert.equal(fs.statSync(other).mode & 0o777, 0o640);
});

test('macOS: a hard link swapped in while the immutable flag is set gets the change undone, and the call refuses', { skip: process.platform !== 'darwin' }, async () => {
  const { recordFiles } = await import('../engine/evidence.mjs');
  assert.ok(recordFiles);
  const v = victim();
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf a > shots/home.png', artifacts: ['shots/*.png'] }];
  const { root, id } = gated('hl-flag-race', 'ENG-232', visual);
  const before = snap(v);
  try {
    // The next file the engine records (an export page) is swapped for a hard link to the victim just before chflags.
    linkSeams.beforeFlag = (files) => {
      for (const f of files) {
        if (!f.endsWith('attempt.html')) continue;
        fs.rmSync(f);
        fs.linkSync(v, f);
      }
    };
    const { exportAttempt } = await import('../engine/export.mjs');
    const { openEvidence, loadState, append } = await import('../engine/ledger.mjs');
    const { seal, setVerifyLevel } = await import('../engine/evidence.mjs');
    process.env.WF_EVIDENCE_FLAGS = '1';
    setVerifyLevel('full');
    openEvidence(root, id);
    exportAttempt(root, loadState(root, id));
    assert.throws(() => seal(append), /replaced while its flag was changed/);
  } finally {
    linkSeams.beforeFlag = null;
    delete process.env.WF_EVIDENCE_FLAGS;
    unlockAll(root);
  }
  assert.deepEqual(snap(v), before, 'the flag set on the swapped-in hard link was undone');
});

test('one canonical path answer: `..` after a link, prefix collisions, case, Unicode, trailing slashes and `.`', () => {
  const base = tmp('paths');
  const root = path.join(base, 'Proj');
  fs.mkdirSync(path.join(root, '.wf-evidence', 'attempts', 'A'), { recursive: true });
  fs.mkdirSync(path.join(root, '.wf-evidence-x', 'out'), { recursive: true });
  fs.symlinkSync(path.join(root, '.wf-evidence', 'attempts', 'A'), path.join(base, 'shortcut'));
  const ev = path.join(root, '.wf-evidence');
  // `shortcut/..` is the link target's parent for the OS (attempts/), not `base` as path.resolve says.
  assert.equal(canonical(path.join(base, 'shortcut') + '/..'), fs.realpathSync.native(path.join(ev, 'attempts')));
  assert.equal(touchesEvidence(`${base}/shortcut/..`), true);
  assert.equal(isInside(`${base}/shortcut/../B`, ev), true);
  // A prefix is not a parent.
  assert.equal(isInside(path.join(root, '.wf-evidence-x', 'out'), ev), false);
  assert.equal(touchesEvidence(path.join(root, '.wf-evidence-x', 'out')), false);
  // Trailing slashes and `.` components.
  assert.equal(isInside(`${ev}/./attempts/A/`, ev), true);
  assert.equal(isInside(`${ev}/`, ev), true);
  // Case and Unicode forms, as the volume resolves them.
  const insensitive = fs.existsSync(path.join(base, 'PROJ'));
  assert.equal(isInside(path.join(base, 'PROJ', '.WF-EVIDENCE', 'attempts'), ev), insensitive, 'case folded only on a case-insensitive volume');
  assert.equal(touchesEvidence(path.join(root, '.WF-EVIDENCE', 'x')), true, 'a case variant is always treated as evidence');
  const nfd = path.join(base, 'café');
  fs.mkdirSync(path.join(nfd, '.wf-evidence'), { recursive: true });
  if (process.platform === 'darwin') assert.equal(isInside(path.join(base, 'café', '.wf-evidence', 'z'), path.join(nfd, '.wf-evidence')), true, 'NFC and NFD name the same folder on APFS');
  // The CLI and the guard hook use the same answer.
  const { root: proj } = singleRepoProject('paths-cli', {});
  fs.mkdirSync(path.join(proj, '.wf-evidence', 'attempts'), { recursive: true });
  fs.symlinkSync(path.join(proj, '.wf-evidence', 'attempts'), path.join(base, 'to-attempts'));
  assert.match(wf(proj, ['report', '--csv', `${base}/to-attempts/../x.csv`]).err, /is inside \.wf-evidence/);
  ok(wf(proj, ['report', '--csv', path.join(proj, '.wf-evidence-x.csv')]));
  assert.ok(check({ cwd: base, tool_input: { file_path: `${base}/to-attempts/../ledger.jsonl` } }), 'the hook resolves `..` after a link the same way');
  // The hook's raw-text rule stays stricter than the path answer (by design since 0.1.18): a name that mentions the
  // evidence is refused even where the OS would put it outside. Stricter, never looser.
  assert.ok(check({ cwd: base, tool_input: { file_path: path.join(proj, '.wf-evidence-x.csv') } }));
  assert.equal(touchesEvidence(path.join(proj, '.wf-evidence-x.csv')), false);
});

test('identity checks: a folder another process writes into is not "replaced"; a recreated file is, even with its inode reused', () => {
  const dir = tmp('hl-ident');
  const sub = path.join(dir, 'shared');
  fs.mkdirSync(sub);
  try {
    // Another wf process changing the shared folder's mode in between (named failure, 0.3.2 CI: concurrent gates).
    linkSeams.beforeOpen = (p) => fs.chmodSync(p, 0o750);
    chmodNoFollow(sub, 0o755, { dir: true });
    // A file whose mode changes in between is refused (its change time moved).
    const f = path.join(dir, 'f');
    fs.writeFileSync(f, 'x');
    assert.throws(() => chmodNoFollow(f, 0o444), /replaced between its check and its use/);
    // A file removed and recreated in between is refused even when the inode number comes back (birth time differs).
    const g = path.join(dir, 'g');
    fs.writeFileSync(g, 'x');
    linkSeams.beforeOpen = (p) => {
      fs.rmSync(p);
      fs.writeFileSync(p, 'y');
    };
    assert.throws(() => chmodNoFollow(g, 0o444), /replaced between its check and its use/);
  } finally {
    linkSeams.beforeOpen = null;
  }
  assert.equal(fs.statSync(sub).mode & 0o777, 0o755);
});
