import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { check } from '../hooks/guard-evidence.mjs';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, tmp, wf } from './helpers.mjs';

// 0.1.17: a security review of 0.1.16. The evidence guard's new "copies out of evidence are reads" parser let writes
// into evidence through (a parser differential: what the guard parsed as a read copy was a write), and dropped checks
// 0.1.15 had (a regression). `wf export screenshots` checked its destination as text only.

const c = (command, cwd = '/p') => check({ cwd, tool_input: { command } });

test('guard: the 0.1.16 bypasses are blocked', () => {
  for (const cmd of [
    "python3 -c \"import shutil as s; s.rmtree('.wf-evidence')\"",
    "python3 -c \"import shutil; shutil.copy('.wf-evidence/a', '/tmp/x' if 0 else '.wf-evidence/b')\"",
    "node -e \"require('fs').copyFileSync('/tmp/x', `${'.wf-evidence'}/a`)\"",
    "node -e \"require('fs').copyFileSync('/tmp/x', '/tmp/' + '../p/.wf-evidence/a')\"",
    "node -e \"process.chdir('.wf-evidence'); require('fs').copyFileSync('/tmp/x', 'a')\"",
    "python3 -c \"import os, shutil; os.chdir('.wf-evidence'); shutil.copy('/tmp/x', 'a')\"",
    "python3 -c \"import shutil; shutil.copy('/tmp/x', '.wf-evidence/a'); shutil.copy('.wf-evidence/a', '/tmp/y')\"",
    "python3 -c \"import shutil; shutil.copy('.wf-evidence/a', '/tmp/y'); shutil.copy('/tmp/x', '.wf-evidence/a')\"",
    'install --directory .wf-evidence/x',
    'install -dm755 .wf-evidence/x',
    'install -Dd .wf-evidence/x',
    'install -d -m 755 .wf-evidence/x',
  ]) assert.ok(c(cmd), cmd);
});

test('guard: every write 0.1.15 refused is still refused', () => {
  for (const cmd of [
    'echo x > .wf-evidence/a', 'echo x >> .wf-evidence/a', 'ls &> .wf-evidence/a', 'tee .wf-evidence/a', 'rm -rf .wf-evidence',
    'mv /tmp/x .wf-evidence/a', 'truncate -s 0 .wf-evidence/a', 'dd if=/tmp/x of=.wf-evidence/a', 'touch .wf-evidence/a',
    'ln -s /tmp/x .wf-evidence/a', 'ln .wf-evidence/a /tmp/hard', 'chmod 644 .wf-evidence/a', 'rmdir .wf-evidence/x', 'mkdir -p .wf-evidence/x',
    'shred .wf-evidence/a', 'unlink .wf-evidence/a', "sed -i '' s/a/b/ .wf-evidence/a", 'sed --in-place s/a/b/ .wf-evidence/a',
    'cp /tmp/x .wf-evidence/a', 'cp -R /tmp/x .wf-evidence/', 'rsync -a /tmp/x .wf-evidence/', 'install /tmp/x .wf-evidence/a',
    'install -m 644 /tmp/x .wf-evidence/a', "perl -pi -e 's/a/b/' .wf-evidence/a", "ruby -i -pe 'x' .wf-evidence/a",
    "python3 -c \"open('.wf-evidence/a', 'w').write('x')\"", "node -e \"require('fs').writeFileSync('.wf-evidence/a', 'x')\"",
    "node -e \"require('fs').rmSync('.wf-evidence', { recursive: true })\"", "python3 -c \"import shutil; shutil.rmtree('.wf-evidence')\"",
    "python3 -c \"import subprocess; subprocess.run(['rm', '.wf-evidence/a'])\"", "node -e \"require('fs').copyFileSync('/tmp/x', '.wf-evidence/a')\"",
    'cd .wf-evidence && rm a', 'cd .wf-evidence/a && cp x ../b', 'pushd .wf-evidence && touch a',
  ]) assert.ok(c(cmd), cmd);
});

test('guard: writes hidden by wrappers, shells, globs, expansion, option values and redirections are refused', () => {
  for (const cmd of [
    'cp -t.wf-evidence /tmp/x', 'cp -rt.wf-evidence /tmp/x', 'cp --target-directory=.wf-evidence /tmp/x', 'cp -t .wf-evidence /tmp/x',
    'rsync --log-file .wf-evidence/log /tmp/a /tmp/b', 'rsync --log-file=.wf-evidence/log /tmp/a /tmp/b', 'rsync -T .wf-evidence /tmp/a /tmp/b',
    'rsync --backup-dir .wf-evidence /tmp/a /tmp/b', 'rsync -a /tmp/a .wf-evidence/ --exclude foo', 'rsync -a /tmp/a .wf-evidence/ --unknown foo',
    'cp /tmp/x .wf-ev*/a', 'cp /tmp/x .[w]f-evidence/a', 'cp /tmp/x $(echo .wf-evidence)/a', 'cp /tmp/x `echo .wf-evidence`/a',
    'D=.wf-evidence; cp /tmp/x $D/a', 'echo x > $(echo .wf-evidence)/a', "bash -c 'cp /tmp/x .wf-evidence/a'", "sh -lc 'rm -rf .wf-evidence'",
    "eval 'touch .wf-evidence/a'", 'for f in /tmp/*; do cp $f .wf-evidence/; done', 'if true; then rm .wf-evidence/a; fi',
    'find /tmp -name x -exec cp {} .wf-evidence/ \\;', 'find /tmp -exec rm -rf .wf-evidence +', 'sudo cp /tmp/x .wf-evidence/a',
    'sudo -u root rm .wf-evidence/a', 'FOO=1 cp /tmp/x .wf-evidence/a', 'env A=1 cp /tmp/x .wf-evidence/a', 'nohup rm .wf-evidence/a',
    'timeout 5 cp /tmp/x .wf-evidence/a', 'xargs -I{} cp {} .wf-evidence/ < list', 'xargs rm < .wf-evidence/list -- .wf-evidence/a',
    'nice -n 5 touch .wf-evidence/a', '(cd .wf-evidence && rm a)', '(cd .wf-evidence; touch a)',
  ]) assert.ok(c(cmd), cmd);
});

test('guard: reading and copying out of evidence stays allowed', () => {
  for (const cmd of [
    'cat .wf-evidence/attempts/X/ledger.jsonl', 'ls -la .wf-evidence/attempts', 'grep -r foo .wf-evidence', 'cat .wf-evidence/a > /tmp/x',
    'cp .wf-evidence/attempts/X/a.png /tmp/out/', 'cp -R .wf-evidence/attempts/X/artifacts ~/Desktop/shots', 'cp -t /tmp/out .wf-evidence/a.png .wf-evidence/b.png',
    'install -m 644 .wf-evidence/a.png /tmp/x.png', 'rsync -a .wf-evidence/a/ /tmp/s/', 'rsync -a --exclude tmp .wf-evidence/a/ /tmp/s/', 'ditto .wf-evidence/a /tmp/s',
    'cd .wf-evidence/attempts/X && cp a.png /tmp/', 'for f in .wf-evidence/a/*.png; do cp "$f" /tmp/s/; done', 'find .wf-evidence -name "*.png" -exec cp {} /tmp/s/ \\;',
    "python3 -c \"import shutil; shutil.copy('.wf-evidence/a.png', '/tmp/x.png')\"", "node -e \"require('fs').copyFileSync('.wf-evidence/a.png', '/tmp/x.png')\"",
    "python3 -c \"import json; print(json.load(open('.wf-evidence/a.json')))\"", 'cp .wf-evidence/a.png /tmp/x.png 2>&1', 'cp /tmp/a $OUT/b', 'echo x > $HOME/out.txt',
  ]) assert.equal(c(cmd), null, cmd);
});

test('guard: a symlink that points into the evidence is judged by where it points', () => {
  const base = tmp('guard-link');
  fs.mkdirSync(path.join(base, '.wf-evidence', 'attempts'), { recursive: true });
  fs.symlinkSync(path.join(base, '.wf-evidence', 'attempts'), path.join(base, 'innocent'));
  assert.ok(c('cp /tmp/x innocent/a', base));
  assert.ok(c('echo x > innocent/a', base));
  assert.ok(c('touch innocent/new/a', base));
  assert.ok(check({ cwd: base, tool_input: { file_path: path.join(base, 'innocent', 'a') } }), 'Write through the link');
  assert.equal(c('cp innocent/a /tmp/x', base), null, 'reading through it is fine');
});

test('export screenshots: a --to symlink into evidence, a planted symlink at a file name, and unusable or colliding titles are refused', async () => {
  const { append } = await import('../engine/ledger.mjs');
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf one > shots/home.png', artifacts: ['shots/*.png'] }];
  const { base, root } = singleRepoProject('export-paths', { gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const e = ok(wf(root, ['entry', '--item', 'ENG-170', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'q\n' });
  const shots = ok(wf(root, ['gate', '--attempt', e.id, '--json'])).json().steps[0].artifacts;
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: shots.map((a) => a.sha256) })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  ok(wf(root, ['deliver', '--attempt', e.id]));
  const ledger = path.join(root, '.wf-evidence', 'attempts', e.id, 'ledger.jsonl');
  const before = fs.readFileSync(ledger, 'utf8');

  // --to a symlink whose target is inside the evidence.
  const link = path.join(base, 'shots-link');
  fs.symlinkSync(path.join(root, '.wf-evidence', 'attempts', e.id), link);
  assert.match(wf(root, ['export', 'screenshots', '--attempt', e.id, '--to', link]).err, /outside \.wf-evidence\/ \(checked where the folder really points\)/);
  assert.match(wf(root, ['export', 'screenshots', '--attempt', e.id, '--to', path.join(link, 'sub')]).err, /outside \.wf-evidence/);

  // A symlink planted under the destination file name is never followed.
  const out = path.join(base, 'out');
  fs.mkdirSync(out);
  fs.symlinkSync(ledger, path.join(out, 'home.png'));
  assert.match(wf(root, ['export', 'screenshots', '--attempt', e.id, '--to', out]).err, /home\.png: exists and is a symlink; not followed or replaced/);
  assert.equal(fs.readFileSync(ledger, 'utf8').slice(0, before.length), before, 'the ledger was not overwritten');
  fs.unlinkSync(path.join(out, 'home.png'));
  fs.writeFileSync(path.join(out, 'home.png'), 'stale');
  ok(wf(root, ['export', 'screenshots', '--attempt', e.id, '--to', out]));
  assert.equal(fs.readFileSync(path.join(out, 'home.png'), 'utf8'), 'one', 'a regular file is replaced');

  // Titles are file names: a path is cut to its last part, `..` is refused, two files never share a name.
  const legacy = toLegacy(root, base, 'ENG-171', append);
  const f = { path: shots[0].path, sha256: shots[0].sha256, source: 'x' };
  append(root, legacy, 'tracker.pending', { event: 'delivered', actions: [{ op: 'attach', files: [{ ...f, title: '../../../escape.png' }] }] }, null);
  const esc = path.join(base, 'esc');
  ok(wf(root, ['export', 'screenshots', '--attempt', legacy, '--to', esc]));
  assert.deepEqual(fs.readdirSync(esc), ['escape.png']);
  assert.ok(!fs.existsSync(path.join(base, 'escape.png')) && !fs.existsSync(path.join(root, 'escape.png')), 'nothing written outside the folder');
  const bad = toLegacy(root, base, 'ENG-172', append);
  append(root, bad, 'tracker.pending', { event: 'delivered', actions: [{ op: 'attach', files: [{ ...f, title: '..' }, { ...f, title: 'a/home.png' }, { ...f, title: 'b/home.png' }] }] }, null);
  const r = wf(root, ['export', 'screenshots', '--attempt', bad, '--to', path.join(base, 'bad')]);
  assert.match(r.err, /"\.\.": not a usable file name/);
  assert.match(r.err, /b\/home\.png and a\/home\.png would both be written as home\.png/);
  assert.equal(state(root, bad).delivery.exported, undefined);
});

// An attempt delivered before 0.1.11: no recorded set, only a pending attach list (its titles come from the ledger).
function toLegacy(root, base, item, append) {
  const e = ok(wf(root, ['entry', '--item', item, '--lane', 'quick', '--owner', 'o', '--json'])).json();
  append(root, e.id, 'delivered', { order: [] }, 'o');
  return e.id;
}
