import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { check, decide, isPlainWf } from '../hooks/guard-evidence.mjs';
import { check as check015 } from './fixtures/guard-0.1.15.mjs';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, tmp, wf } from './helpers.mjs';

// 0.1.18: the evidence guard decides on the raw text and never parses shell. Named failures: 0.1.16 and 0.1.17 parsed
// commands to let copies OUT of evidence through, and six automated reviews found a new differential after each fix.
// It must never be more permissive than the 0.1.15 hook (frozen in fixtures/), and `wf export screenshots` (the engine,
// never a shell) is the only way files leave the evidence besides the Read tool.

const HOOK = path.resolve(import.meta.dirname, '..', 'hooks', 'guard-evidence.mjs');
const bash = (command, cwd = '/p') => check({ cwd, tool_input: { command } });
const file = (tool_input, cwd = '/p') => check({ cwd, tool_input });

// The corpus: writes 0.1.15 refused, writes it missed, the 0.1.16 bypasses, and the reads the 0.1.16/0.1.17 allowance
// let through (now refused: reads are the Read tool's).
const WRITES_015 = [
  'echo x > .wf-evidence/a', 'echo x >> .wf-evidence/a', 'ls &> .wf-evidence/a', 'tee .wf-evidence/a', 'rm -rf .wf-evidence',
  'mv /tmp/x .wf-evidence/a', 'truncate -s 0 .wf-evidence/a', 'dd if=/tmp/x of=.wf-evidence/a', 'touch .wf-evidence/a',
  'ln -s /tmp/x .wf-evidence/a', 'ln .wf-evidence/a /tmp/hard', 'chmod 644 .wf-evidence/a', 'rmdir .wf-evidence/x', 'mkdir -p .wf-evidence/x',
  'shred .wf-evidence/a', 'unlink .wf-evidence/a', "sed -i '' s/a/b/ .wf-evidence/a", 'sed --in-place s/a/b/ .wf-evidence/a',
  'cp /tmp/x .wf-evidence/a', 'cp -R /tmp/x .wf-evidence/', 'rsync -a /tmp/x .wf-evidence/', 'install /tmp/x .wf-evidence/a',
  'install -m 644 /tmp/x .wf-evidence/a', "perl -pi -e 's/a/b/' .wf-evidence/a", "ruby -i -pe 'x' .wf-evidence/a",
  "python3 -c \"open('.wf-evidence/a', 'w').write('x')\"", "node -e \"require('fs').writeFileSync('.wf-evidence/a', 'x')\"",
  "node -e \"require('fs').rmSync('.wf-evidence', { recursive: true })\"", "python3 -c \"import shutil; shutil.rmtree('.wf-evidence')\"",
  "python3 -c \"import subprocess; subprocess.run(['rm', '.wf-evidence/a'])\"", "node -e \"require('fs').copyFileSync('/tmp/x', '.wf-evidence/a')\"",
  'cd .wf-evidence && rm a', 'cd .wf-evidence/a && cp x ../b', 'pushd .wf-evidence && touch a', 'cd /p/.wf-evidence && echo x > ledger.jsonl',
  "cd .wf-evidence && node -e \"require('fs').writeFileSync('x','1')\"", "python3 -c \"import json; json.dump({}, open('/p/.wf-evidence/x', mode='w'))\"",
];
const MISSED_015 = [
  'cp -t.wf-evidence /tmp/x', 'cp --target-directory=.wf-evidence /tmp/x', 'rsync --log-file .wf-evidence/log /tmp/a /tmp/b', 'rsync -a /tmp/a .wf-evidence/ --exclude foo',
  'cp /tmp/x .wf-ev*/a', 'cp /tmp/x .[w]f-evidence/a', 'cp /tmp/x $(echo .wf-evidence)/a', 'cp /tmp/x `echo .wf-evidence`/a', 'D=.wf-evidence; cp /tmp/x $D/a',
  "bash -c 'cp /tmp/x .wf-evidence/a'", "eval 'touch .wf-evidence/a'", 'for f in /tmp/*; do cp $f .wf-evidence/; done', 'find /tmp -exec rm -rf .wf-evidence +',
  'sudo cp /tmp/x .wf-evidence/a', 'FOO=1 cp /tmp/x .wf-evidence/a', 'xargs -I{} cp {} .wf-evidence/ < list', '(cd .wf-evidence && rm a)',
  "python3 -c \"import shutil as s; s.rmtree('.wf-evidence')\"", "node -e \"process.chdir('.wf-evidence'); require('fs').copyFileSync('/tmp/x', 'a')\"",
  'install --directory .wf-evidence/x', 'install -dm755 .wf-evidence/x', 'cp /tmp/x .WF-EVIDENCE/a',
];
const READS = [
  'cat .wf-evidence/attempts/X/ledger.jsonl', 'ls -la .wf-evidence/attempts', 'grep -r foo .wf-evidence', 'cp .wf-evidence/a.png /tmp/out/',
  'cp -t /tmp/out .wf-evidence/a.png', 'install -m 644 .wf-evidence/a.png /tmp/x.png', 'rsync -a .wf-evidence/a/ /tmp/s/', 'ditto .wf-evidence/a /tmp/s',
  "python3 -c \"import shutil; shutil.copy('.wf-evidence/a.png', '/tmp/x.png')\"", "python3 -c \"print(open('/p/.wf-evidence/x.json', 'r').read())\"",
  'find .wf-evidence -name "*.png" -exec cp {} /tmp/s/ \\;', 'cd .wf-evidence/attempts/X && cp a.png /tmp/',
];
const CWDS = ['/p', '/p/.wf-evidence/attempts/A', '/p/src'];
const variants = (c) => [c, `cd /p && ${c}`, `${c} 2>&1`, `true; ${c}`, `${c}\necho done`, `(${c})`, `wf status; ${c}`, `wf status && ${c}`];
const corpus = [...WRITES_015, ...MISSED_015, ...READS, 'ls', 'git status', 'echo x > /tmp/y', `python3 -c "open('x','w')"`, 'cat a', 'rm a'].flatMap(variants);

test('guard is never more permissive than the 0.1.15 hook, on Bash and on file tools', () => {
  let compared = 0;
  for (const cwd of CWDS) {
    for (const command of corpus) {
      const input = { cwd, tool_input: { command } };
      if (check015(input)) assert.ok(check(input), `0.1.15 refused, now allowed: [${cwd}] ${command}`);
      compared += 1;
    }
    for (const fp of ['.wf-evidence/a', '/p/.wf-evidence/a', '/p/src/../.wf-evidence/a', 'ledger.jsonl', '/tmp/x', 'src/a.ts']) {
      for (const tool_input of [{ file_path: fp }, { file_path: fp, edits: [] }, { notebook_path: fp }]) {
        const input = { cwd, tool_input };
        if (check015(input)) assert.ok(check(input), `0.1.15 refused, now allowed: [${cwd}] ${JSON.stringify(tool_input)}`);
        compared += 1;
      }
    }
  }
  assert.ok(compared > 1000, `corpus too small: ${compared}`);
  for (const c of [...WRITES_015, ...MISSED_015, ...READS]) assert.ok(bash(c), `refused: ${c}`);
});

test('only one plain `wf` invocation may name the evidence: no chaining, substitution, redirection, quoting or other path', () => {
  for (const ok of ['wf status', 'wf status --attempt ENG-1.1', 'wf export screenshots --gate --to /tmp/shots', 'wf shown --file /p/.wf-worktrees/_exports/A/shown-draft.json', 'wf tracker record --event delivered --capture /tmp/cap.json', '  wf resume  ']) {
    assert.equal(bash(ok), null, ok);
    assert.equal(bash(ok, '/p/.wf-evidence/attempts/A'), null, `${ok} (inside the evidence)`);
  }
  for (const bad of [
    'echo wf .wf-evidence/a', 'x=wf; cat .wf-evidence/a', 'wf status; cat .wf-evidence/x', 'wf status\ncat .wf-evidence/x', 'wf status\r\ncat .wf-evidence/x',
    'wf status && rm -rf .wf-evidence', 'wf status || rm -rf .wf-evidence', 'wf status | tee .wf-evidence/x', 'wf status & rm .wf-evidence/a',
    'wf export $(rm -rf .wf-evidence)', 'wf export `touch .wf-evidence/a`', 'wf export <(cat .wf-evidence/a)', 'wf status > .wf-evidence/a', 'wf status < .wf-evidence/a',
    './wf export --to .wf-evidence', '/usr/local/bin/wf status .wf-evidence', 'WF=wf; $WF export .wf-evidence', 'WF=wf $WF status .wf-evidence', 'wfx status .wf-evidence',
    'wf "status" .wf-evidence', "wf 'status' .wf-evidence", 'wf sta\\tus .wf-evidence', 'wf\tstatus .wf-evidence', 'command wf status .wf-evidence', 'sudo wf status .wf-evidence',
    'wf .wf-evidence', 'wf Status .wf-evidence', 'wf ${X} .wf-evidence',
  ]) assert.ok(bash(bad), JSON.stringify(bad));
  assert.equal(isPlainWf('wf status; rm x'), false);
  assert.equal(isPlainWf('wf status'), true);
});

test('obfuscated, split, glob, brace, variable, case and unicode spellings of the evidence are refused', () => {
  for (const bad of [
    "cat .wf-evid''ence/a", 'cat .wf-evid""ence/a', 'cat .wf-evid\\ence/a', "cat $'.wf-evidence'/a", 'cat .wf-e"v"idence/a', 'cat .WF-EVIDENCE/a', 'cat .Wf-Evidence/a',
    'cat .wf-*/a', 'cat .w?-evidence/a', 'cat .[w]f-evidence/a', 'cat .*/attempts/a', 'cat {.wf-,}evidence/a', 'cat .wf-{evidence,x}/a', 'cat .wf-ev${X}idence/a',
    'cat .wf-ev$(echo)idence/a', 'cat *evidence/a', 'cat .wf-​evidence/a', 'cat .wf­-evidence/a', 'cat ．ｗｆ－ｅｖｉｄｅｎｃｅ/a',
    'cat ~/p/.wf-evidence/a', 'cat $HOME/p/.wf-evidence/a', 'cd ~/p && cat .wf-evidence/a', 'cat /p/src/../.wf-evidence/a',
  ]) assert.ok(bash(bad), JSON.stringify(bad));
  for (const fine of ['git commit -m "gate evidence for the review"', 'grep -r evidence docs/', 'ls .wf-worktrees/_exports', 'echo "the evidence pass"']) assert.equal(bash(fine), null, fine);
});

test('file tools: evidence targets by any spelling, relative inside it, `..`, symlink aliases; content is not inspected', () => {
  const base = tmp('guard-files');
  const ev = path.join(base, '.wf-evidence', 'attempts');
  fs.mkdirSync(ev, { recursive: true });
  fs.symlinkSync(ev, path.join(base, 'innocent'));
  for (const t of [
    { file_path: '/p/.wf-evidence/a' }, { file_path: '.wf-evidence/a' }, { file_path: '/p/src/../.wf-evidence/a' }, { file_path: '/p/.WF-EVIDENCE/a' },
    { file_path: '/p/.wf-​evidence/a' }, { file_path: '~/p/.wf-evidence/a' }, { file_path: '/p/.wf-evidence/a', edits: [{ old_string: 'a', new_string: 'b' }] },
    { notebook_path: '/p/.wf-evidence/n.ipynb' }, { path: '/p/.wf-evidence/a' },
  ]) assert.ok(file(t), JSON.stringify(t));
  assert.ok(file({ file_path: 'ledger.jsonl' }, '/p/.wf-evidence/attempts/A'), 'relative inside the evidence');
  assert.ok(file({ file_path: path.join(base, 'innocent', 'A', 'ledger.jsonl') }, base), 'a symlink alias');
  assert.ok(file({ file_path: 'innocent/x' }, base), 'a relative symlink alias');
  assert.equal(file({ file_path: '/p/.wf-worktrees/A/_review/closure-1.json', content: '{"ref": "/p/.wf-evidence/attempts/A/gate/unit.log:12"}' }), null, 'a closure may cite evidence paths');
  assert.equal(file({ file_path: '/tmp/x' }), null);
});

test('the hook fails closed on input it cannot read, when that input mentions the evidence', () => {
  assert.ok(decide('{"tool_input": {"command": "rm .wf-evidence/a"'), 'truncated JSON');
  assert.equal(decide('{"tool_input": '), null, 'unreadable input that names no evidence passes');
  assert.ok(decide('not json at all .wf-evidence'));
  assert.ok(decide('null') === null && decide('"rm .wf-evidence"'), 'a bare string');
  assert.ok(check({ tool_input: null, other: '.wf-evidence/a' }), 'missing tool_input');
  assert.ok(check({ tool_input: { edits: [{ file_path: '/p/.wf-evidence/a' }] } }), 'an unknown shape');
  assert.ok(check({ tool_input: { command: ['rm', '.wf-evidence/a'] } }), 'a command that is not a string');
  assert.ok(check({ cwd: '/p/.wf-evidence', tool_input: { unknown: true } }), 'an unknown shape inside the evidence');
  assert.equal(check({ tool_input: { unknown: true } }), null);
  const run = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' }).status;
  assert.equal(run('{garbage .wf-evidence'), 2);
  assert.equal(run('{garbage'), 0);
  assert.equal(run(JSON.stringify({ cwd: '/p', tool_input: { command: 'wf status; cat .wf-evidence/a' } })), 2);
  assert.equal(run(JSON.stringify({ cwd: '/p', tool_input: { command: 'wf status --attempt A' } })), 0);
});

// ---- `wf export screenshots`: the engine's copy out, race-free where Node allows ----

function delivered(name, item) {
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf one > shots/home.png && printf two > shots/menu.png', artifacts: ['shots/*.png'] }];
  const { base, root } = singleRepoProject(name, { gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const e = ok(wf(root, ['entry', '--item', item, '--lane', 'quick', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'q\n' });
  const shots = ok(wf(root, ['gate', '--attempt', e.id, '--json'])).json().steps[0].artifacts;
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: shots.map((a) => a.sha256) })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  ok(wf(root, ['deliver', '--attempt', e.id]));
  return { base, root, id: e.id, shots, ledger: path.join(root, '.wf-evidence', 'attempts', e.id, 'ledger.jsonl') };
}

test('export screenshots: a --to into the evidence (symlinked or not) and any wf output option into it are refused', () => {
  const { base, root, id } = delivered('export-to', 'ENG-170');
  const link = path.join(base, 'shots-link');
  fs.symlinkSync(path.join(root, '.wf-evidence', 'attempts', id), link);
  for (const to of [link, path.join(link, 'sub'), path.join(root, '.wf-evidence', 'x'), path.join(root, '.WF-EVIDENCE', 'x')]) assert.match(wf(root, ['export', 'screenshots', '--attempt', id, '--to', to]).err, /inside \.wf-evidence|outside \.wf-evidence/, to);
  // `wf` is the one command the guard lets name the evidence: none of its output options may write there.
  const ledger = path.join(root, '.wf-evidence', 'attempts', id, 'ledger.jsonl');
  const before = fs.readFileSync(ledger, 'utf8');
  assert.match(wf(root, ['export', '--attempt', id, '--out', ledger]).err, /--out .* is inside \.wf-evidence/);
  assert.match(wf(root, ['report', '--csv', path.join(link, 'x.csv')]).err, /--csv .* is inside \.wf-evidence/);
  assert.match(wf(root, ['install', '--dir', path.join(root, '.wf-evidence')]).err, /--dir .* is inside \.wf-evidence/);
  assert.equal(fs.readFileSync(ledger, 'utf8'), before);
  // A fresh folder each time, under --to; the reviewer's gate set too, unrecorded.
  const out = path.join(base, 'out');
  const a = ok(wf(root, ['export', 'screenshots', '--attempt', id, '--to', out])).out;
  const b = ok(wf(root, ['export', 'screenshots', '--attempt', id, '--to', out])).out;
  assert.notEqual(a.match(/to (\S+)/)[1], b.match(/to (\S+)/)[1]);
  const g = ok(wf(root, ['export', 'screenshots', '--gate', '--attempt', id, '--to', out])).out;
  assert.match(g, /copied 2 gate screenshot\(s\) .* to .*out\/gate-\w+/);
  assert.equal(state(root, id).delivery.exported.dir, b.match(/to (\S+)/)[1], 'a gate export is not recorded as the delivered copies');
});

test('export screenshots: a symlink or file swapped in during the copy is never followed; nothing reaches the evidence', async () => {
  const { root, id, ledger } = delivered('export-race', 'ENG-171');
  const { exportScreenshots, exportSeams } = await import('../engine/lifecycle.mjs');
  const { loadState } = await import('../engine/ledger.mjs');
  const s = loadState(root, id);
  const before = fs.readFileSync(ledger, 'utf8');
  const out = path.join(path.dirname(root), 'race');
  try {
    // A symlink planted under the destination name just before it is created: O_EXCL|O_NOFOLLOW refuses it.
    exportSeams.beforeDestOpen = (dest) => fs.symlinkSync(ledger, dest);
    assert.throws(() => exportScreenshots(root, s, out), /home\.png: not created \(EEXIST\)/);
    // The export folder swapped for a symlink into the evidence: detected before any file is created there.
    exportSeams.beforeDestOpen = (dest, dir) => {
      fs.renameSync(dir, `${dir}-moved`);
      fs.symlinkSync(path.dirname(ledger), dir);
    };
    assert.throws(() => exportScreenshots(root, s, out), /the export folder was replaced or moved during the export/);
    assert.deepEqual(fs.readdirSync(path.dirname(ledger)).filter((f) => f.endsWith('.png')), [], 'no file landed in the evidence');
    exportSeams.beforeDestOpen = null;
    // The source swapped for a symlink (O_NOFOLLOW), or its bytes changed after the check (hash of the written bytes).
    const src = s.delivery.screenshots.screenshots[0].path;
    const keep = fs.readFileSync(src);
    exportSeams.beforeSourceOpen = (p) => {
      if (p !== src) return;
      fs.chmodSync(src, 0o644);
      fs.rmSync(src);
      fs.symlinkSync('/etc/hosts', src);
    };
    assert.throws(() => exportScreenshots(root, s, out), /source not readable as a regular file \(ELOOP\)/);
    fs.rmSync(src);
    exportSeams.beforeSourceOpen = (p) => p === src && fs.writeFileSync(src, 'tampered');
    assert.throws(() => exportScreenshots(root, s, out), /bytes differ from the recorded sha256/);
    fs.writeFileSync(src, keep);
  } finally {
    exportSeams.beforeDestOpen = null;
    exportSeams.beforeSourceOpen = null;
  }
  assert.equal(fs.readFileSync(ledger, 'utf8'), before, 'the ledger is unchanged');
  const r = exportScreenshots(root, loadState(root, id), out);
  assert.deepEqual(r.files.map((f) => path.basename(f.file)).sort(), ['home.png', 'menu.png']);
});

test('export screenshots: titles are plain file names; `..` and colliding names are refused', async () => {
  const { append } = await import('../engine/ledger.mjs');
  const { base, root, shots } = delivered('export-titles', 'ENG-172');
  const legacy = (item, files) => {
    const e = ok(wf(root, ['entry', '--item', item, '--lane', 'quick', '--owner', 'o', '--json'])).json();
    append(root, e.id, 'delivered', { order: [] }, 'o');
    append(root, e.id, 'tracker.pending', { event: 'delivered', actions: [{ op: 'attach', files }] }, null);
    return e.id;
  };
  const f = { path: shots[0].path, sha256: shots[0].sha256, source: 'x' };
  const esc = legacy('ENG-173', [{ ...f, title: '../../../escape.png' }]);
  const r = ok(wf(root, ['export', 'screenshots', '--attempt', esc, '--to', path.join(base, 'esc')])).out;
  assert.deepEqual(fs.readdirSync(r.match(/to (\S+)/)[1]), ['escape.png']);
  assert.ok(!fs.existsSync(path.join(base, 'escape.png')) && !fs.existsSync(path.join(root, 'escape.png')));
  const bad = legacy('ENG-174', [{ ...f, title: '..' }, { ...f, title: 'a/home.png' }, { ...f, title: 'b/home.png' }]);
  const err = wf(root, ['export', 'screenshots', '--attempt', bad, '--to', path.join(base, 'bad')]).err;
  assert.match(err, /"\.\.": not a usable file name/);
  assert.match(err, /b\/home\.png and a\/home\.png would both be written as home\.png/);
});

test('the shown draft and every other engine write outside the evidence never follow a planted link into it', async () => {
  const { safeWrite } = await import('../engine/lifecycle.mjs');
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf one > shots/home.png', artifacts: ['shots/*.png'] }];
  const setup = (name, item, plant) => {
    const { base, root } = singleRepoProject(name, { gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
    const e = ok(wf(root, ['entry', '--item', item, '--lane', 'quick', '--owner', 'o', '--json'])).json();
    ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
    ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
    commitIn(e.repos.app.worktree, { 'src/a.txt': 'q\n' });
    const shots = ok(wf(root, ['gate', '--attempt', e.id, '--json'])).json().steps[0].artifacts;
    ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
    ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: shots.map((a) => a.sha256) })), '--attempt', e.id]));
    ok(wf(root, ['accept', '--attempt', e.id]));
    const evidence = path.join(root, '.wf-evidence', 'attempts', e.id);
    const ledger = path.join(evidence, 'ledger.jsonl');
    const exports = path.join(root, '.wf-worktrees', '_exports', e.id);
    plant({ evidence, ledger, exports });
    const before = fs.readFileSync(ledger, 'utf8');
    const d = wf(root, ['deliver', '--attempt', e.id]);
    return { root, id: e.id, d, evidence, ledger, before, exports };
  };

  // `_exports/<id>` is a symlink to the attempt's evidence folder.
  const a = setup('draft-dir-link', 'ENG-180', ({ evidence, exports }) => {
    fs.mkdirSync(path.dirname(exports), { recursive: true });
    fs.symlinkSync(evidence, exports);
  });
  assert.equal(a.d.code, 0, 'delivery itself is not undone');
  assert.match(a.d.err, /draft was not written: .*shown-draft\.json: not written; its folder really lies in \.wf-evidence/);
  assert.match(a.d.err, /delivered screenshots not exported: .*outside \.wf-evidence/);
  assert.ok(!fs.existsSync(path.join(a.evidence, 'shown-draft.json')), 'no draft inside the evidence');
  assert.deepEqual(fs.readdirSync(a.evidence).filter((f) => /^screenshots-|shown-draft/.test(f)), [], 'no export folder inside the evidence');
  assert.equal(fs.readFileSync(a.ledger, 'utf8').slice(0, a.before.length), a.before);

  // `shown-draft.json` is a symlink to the ledger.
  const b = setup('draft-file-link', 'ENG-181', ({ ledger, exports }) => {
    fs.mkdirSync(exports, { recursive: true });
    fs.symlinkSync(ledger, path.join(exports, 'shown-draft.json'));
  });
  assert.equal(b.d.code, 0);
  assert.match(b.d.err, /draft was not written: .*shown-draft\.json: exists and is a symlink; not followed or replaced/);
  assert.equal(fs.readFileSync(b.ledger, 'utf8').slice(0, b.before.length), b.before, 'the ledger was not overwritten');
  JSON.parse(fs.readFileSync(b.ledger, 'utf8').split('\n')[0]);

  // The helper itself: a regular file is replaced, a link or a folder that lies in the evidence is refused.
  const dir = path.join(path.dirname(a.root), 'safe');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'f.json'), 'old');
  safeWrite(a.root, path.join(dir, 'f.json'), 'new');
  assert.equal(fs.readFileSync(path.join(dir, 'f.json'), 'utf8'), 'new');
  fs.symlinkSync(a.ledger, path.join(dir, 'l.json'));
  assert.throws(() => safeWrite(a.root, path.join(dir, 'l.json'), 'x'), /exists and is a symlink/);
  assert.throws(() => safeWrite(a.root, path.join(a.exports, 'x.json'), 'x'), /really lies in \.wf-evidence/);
  assert.throws(() => safeWrite(a.root, path.join(a.exports, 'new', 'x.json'), 'x'), /really lies in \.wf-evidence/);
  assert.ok(!fs.existsSync(path.join(a.evidence, 'new')), 'no folder created inside the evidence');
});

// ---- 0.1.19: the last adversarial pass ----

test('guard: 30 attack inputs of new kinds are refused', () => {
  const bashCases = [
    'a=.wf-; b=evidence; rm -rf $a$b', 'a=.wf; rm -rf ${a}-evidence', 'p=evidence; cat .wf-$p/a', 'cat${IFS}.wf-evidence/a', 'IFS=/; x=".wf-evidence"; cat $x',
    "cat $'\\x2ewf-evidence/a'", "cat $'\\056wf-evidence/a'", "cat \"$(printf '\\x2ewf-evidence')\"/a", 'cat $(echo .wf-ev)idence/a', 'rm -rf "$(ls -a | grep wf-e)"',
    'cat .wf-\u0000evidence/a', 'cat .wf-\u0007evidence/a', 'cat .wf-ev"$x"idence/a', 'cat .wf-ev\u200didence/a',
    'wf export screenshots --to /p/.wf-evidence/x; true', 'env -i cat .wf-evidence/a', `cat ${'x'.repeat(200000)} .wf-evidence/a`,
    'cd ../p/.wf-evidence', 'pushd /p/.WF-EVIDENCE', 'command -p cat .wf-evidence/a',
  ];
  for (const c of bashCases) assert.ok(check({ cwd: '/p', tool_input: { command: c } }), JSON.stringify(c.slice(0, 80)));
  const shapes = [
    { tool_name: 'Edit', tool_input: { command: 'wf status', file_path: '/p/.wf-evidence/a' } },
    { tool_name: 'Write', tool_input: { file_path: ['/p/.wf-evidence/a'] } },
    { tool_name: 'MultiEdit', tool_input: { file_path: '/tmp/x', edits: [{ file_path: '/p/.wf-evidence/a', old_string: 'a', new_string: 'b' }] } },
    { tool_name: 'Write', tool_input: { command: 'wf status', file_path: '~/p/.wf-evidence/a' } },
    { tool_name: 'Edit', tool_input: { command: 'wf status' }, cwd: '/p/.wf-evidence' },
    { tool_name: 'Bash', tool_input: { command: { toString: 'rm .wf-evidence' } } },
    { tool_name: 'Bash', tool_input: { command: 'wf status', file_path: '/p/.wf-evidence/a' } },
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: '/p/.wf-evidence/n.ipynb', new_source: 'x' } },
  ];
  for (const d of shapes) assert.ok(check(d), JSON.stringify(d));
  const run = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'buffer' }).status;
  assert.equal(run(Buffer.concat([Buffer.from('{"tool_input":{"command":"cat .wf-evid'), Buffer.from([0xff, 0xfe]), Buffer.from('ence/a"}}')])), 2, 'invalid UTF-8');
  assert.equal(run(Buffer.from(JSON.stringify({ tool_input: { command: `echo ${'é'.repeat(100000)} > .wf-evidence/a` } }))), 2, 'large multi-byte input');
  assert.equal(check({ cwd: '/p', tool_input: { command: 'echo $HOME/notes.txt' } }), null, 'an expansion alone is fine');
  // One plain `wf` invocation passes the hook; the engine then refuses a path option into the evidence.
  assert.equal(check({ cwd: '/p', tool_input: { command: 'wf status --attempt ../../.wf-evidence' } }), null);
});

test('wf input files: regular files outside the evidence only; attempt ids and skill names are not paths', () => {
  const { base, root } = singleRepoProject('cli-paths', {});
  const e = ok(wf(root, ['entry', '--item', 'ENG-190', '--owner', 'o', '--json'])).json();
  const other = path.join(root, '.wf-evidence', 'attempts', e.id, 'ledger.jsonl');
  const link = path.join(base, 'innocent.json');
  fs.symlinkSync(other, link);
  for (const args of [['plan', '--file', other], ['plan', '--file', link], ['review', '--closure', link], ['tracker', 'record', '--event', 'admitted', '--capture', link], ['summary', '--file', link], ['shown', '--file', link], ['entry', '--item', 'ENG-191', '--issue-file', link]]) {
    assert.match(wf(root, [...args, '--attempt', e.id]).err, /is inside \.wf-evidence\/ \(checked where it really points\); pass a file outside it/, args.join(' '));
  }
  assert.match(wf(root, ['plan', '--file', base, '--attempt', e.id]).err, /--file .* is not a regular file/);
  assert.match(wf(root, ['init', '--root', path.join(root, '.wf-evidence', 'x')]).err, /--root .* is inside \.wf-evidence/);
  for (const id of ['../../x', '..', 'a/b', '.hidden']) assert.match(wf(root, ['resume', '--attempt', id]).err, /invalid attempt id/, id);
  assert.match(wf(root, ['skills', 'update', '../../.wf-evidence', '--from', base]).err, /invalid skill name/);
  assert.ok(fs.existsSync(other), 'nothing deleted');
  assert.match(wf(root, ['batch', 'eject', '--batch', e.id, '--member', '../x']).err, /invalid attempt id/);
});

test('cleanup at close never deletes through a link and leaves anything uncertain in place', async () => {
  const { removeReviewScratch } = await import('../engine/attempt.mjs');
  const base = tmp('cleanup');
  const root = path.join(base, 'proj');
  const evidence = path.join(root, '.wf-evidence', 'attempts', 'A-1.1');
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'ledger.jsonl'), 'keep\n');
  fs.mkdirSync(path.join(evidence, '_review'));
  fs.writeFileSync(path.join(evidence, '_review', 'closure.json'), 'keep');
  const err = [];
  const write = process.stderr.write;
  process.stderr.write = (m) => err.push(String(m));
  try {
    // .wf-worktrees itself a link to the evidence: nothing is deleted.
    fs.symlinkSync(path.join(root, '.wf-evidence', 'attempts'), path.join(root, '.wf-worktrees'));
    removeReviewScratch(root, 'A-1.1');
    assert.ok(fs.existsSync(path.join(evidence, '_review', 'closure.json')));
    fs.unlinkSync(path.join(root, '.wf-worktrees'));
    // The attempt folder, then `_review`, a link into the evidence.
    fs.mkdirSync(path.join(root, '.wf-worktrees'));
    fs.symlinkSync(evidence, path.join(root, '.wf-worktrees', 'A-1.1'));
    removeReviewScratch(root, 'A-1.1');
    fs.unlinkSync(path.join(root, '.wf-worktrees', 'A-1.1'));
    fs.mkdirSync(path.join(root, '.wf-worktrees', 'A-1.1'));
    fs.symlinkSync(path.join(evidence, '_review'), path.join(root, '.wf-worktrees', 'A-1.1', '_review'));
    removeReviewScratch(root, 'A-1.1');
    assert.ok(fs.existsSync(path.join(evidence, '_review', 'closure.json')), 'the evidence survived every link');
    fs.unlinkSync(path.join(root, '.wf-worktrees', 'A-1.1', '_review'));
    // A real _review holding a link into the evidence: the link is unlinked, its target kept.
    const rv = path.join(root, '.wf-worktrees', 'A-1.1', '_review');
    fs.mkdirSync(path.join(rv, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(rv, 'closure-1.json'), '{}');
    fs.symlinkSync(evidence, path.join(rv, 'sub', 'ev'));
    removeReviewScratch(root, 'A-1.1');
    assert.ok(!fs.existsSync(path.join(root, '.wf-worktrees', 'A-1.1')), 'a plain scratch folder is removed');
    assert.equal(fs.readFileSync(path.join(evidence, 'ledger.jsonl'), 'utf8'), 'keep\n');
    // A FIFO in _review is uncertain: everything else stays.
    fs.mkdirSync(rv, { recursive: true });
    spawnSync('mkfifo', [path.join(rv, 'pipe')]);
    removeReviewScratch(root, 'A-1.1');
    assert.ok(fs.existsSync(path.join(rv, 'pipe')));
  } finally {
    process.stderr.write = write;
  }
  assert.equal(err.filter((m) => /left .* in place/.test(m)).length, 4, err.join(''));
  assert.throws(() => removeReviewScratch(root, '../x'), /invalid attempt id/);
});
