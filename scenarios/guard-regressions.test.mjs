import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { check, decide } from '../hooks/guard-evidence.mjs';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, singleRepoProject, state, tmp, wf } from './helpers.mjs';

// 0.7.0: the evidence guard judges file targets, never shell text (named failure: its Bash branch made 334 refusals, none
// a write attempt, 229 naming no evidence folder). `wf export screenshots` (the engine, never a shell) is the only way
// files leave the evidence besides the Read tool; the ledger chain, anchor, manifest and immutability flags catch a write
// that gets around the hook (scenarios/integrity*.test.mjs).

const HOOK = path.resolve(import.meta.dirname, '..', 'hooks', 'guard-evidence.mjs');
const file = (tool_input, cwd = '/p') => check({ cwd, tool_input });

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

test('file-tool shapes: every target in the input is checked, whatever else it carries', () => {
  const shapes = [
    { tool_name: 'Edit', tool_input: { command: 'wf status', file_path: '/p/.wf-evidence/a' } },
    { tool_name: 'Write', tool_input: { file_path: ['/p/.wf-evidence/a'] } },
    { tool_name: 'MultiEdit', tool_input: { file_path: '/tmp/x', edits: [{ file_path: '/p/.wf-evidence/a', old_string: 'a', new_string: 'b' }] } },
    { tool_name: 'Write', tool_input: { command: 'wf status', file_path: '~/p/.wf-evidence/a' } },
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: '/p/.wf-evidence/n.ipynb', new_source: 'x' } },
  ];
  for (const d of shapes) assert.ok(check({ cwd: '/p', ...d }), JSON.stringify(d));
});

test('a shell started inside the evidence is refused; any other shell text is not judged', () => {
  assert.ok(check({ cwd: '/p/.wf-evidence/attempts/A', tool_name: 'Bash', tool_input: { command: 'ls' } }));
  assert.ok(check({ cwd: '/p/.WF-EVIDENCE', tool_input: { unknown: true } }), 'an unknown shape inside the evidence');
  assert.equal(check({ cwd: '/p/src', tool_name: 'Bash', tool_input: { command: 'cat .wf-evidence/attempts/A/ledger.jsonl' } }), null, 'shell text is not scanned');
  assert.equal(check({ cwd: '/p', tool_name: 'Bash', tool_input: { command: 'echo "$HOME" > /tmp/wf-notes.txt # .wf-evidence' } }), null);
});

// Named failure (0.7.3, field): a shell left standing in the evidence folder could run nothing, `cd` out included (18
// refusals; the session was dead and its ticket stopped). The way out is a bare `cd` to a folder outside the evidence;
// every other command there is still refused, and the refusal says how to leave.
test('a shell standing inside the evidence can leave it with a bare cd, and nothing else runs there', () => {
  const inside = '/p/.wf-evidence/attempts/A';
  for (const command of ['cd /p', 'cd', 'cd ~', 'cd "/p/src"', 'cd ../../..']) assert.equal(check({ cwd: inside, tool_name: 'Bash', tool_input: { command } }), null, command);
  for (const command of ['ls', 'cd /p && rm x', 'cd /p; ls', 'cd /p\nls', 'cd ..', 'cd -', 'cd /p/.wf-evidence', 'cd $(pwd)', 'cd "/tmp/$(touch x)"', 'cd "/tmp/`touch x`"', 'cd "$HOME"', 'cd "/tmp/\\$x"', 'echo cd /p']) assert.ok(check({ cwd: inside, tool_name: 'Bash', tool_input: { command } }), command);
  assert.match(check({ cwd: inside, tool_name: 'Bash', tool_input: { command: 'ls' } }), /leave it first with a bare `cd <a folder outside it>`/);
});

test('the hook passes input it cannot read; file targets are still judged through the process', () => {
  assert.equal(decide('{"tool_input": {"command": "rm .wf-evidence/a"'), null, 'truncated JSON');
  assert.equal(decide('not json at all .wf-evidence'), null);
  assert.equal(decide('null'), null);
  assert.equal(check({ tool_input: null, other: '.wf-evidence/a' }), null, 'missing tool_input');
  const run = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' }).status;
  assert.equal(run('{garbage .wf-evidence'), 0);
  assert.equal(run(JSON.stringify({ cwd: '/p', tool_name: 'Bash', tool_input: { command: 'wf status; cat .wf-evidence/a' } })), 0);
  assert.equal(run(JSON.stringify({ cwd: '/p', tool_name: 'Edit', tool_input: { file_path: '/p/.wf-evidence/attempts/A/ledger.jsonl' } })), 2);
  assert.equal(run(JSON.stringify({ cwd: '/p', tool_name: 'Write', tool_input: { file_path: '/p/src/a.ts' } })), 0);
});

// ---- `wf export screenshots`: the engine's copy out, race-free where Node allows ----

function delivered(name, item) {
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf one > shots/home.png && printf two > shots/menu.png', artifacts: ['shots/*.png'] }];
  const { base, root } = singleRepoProject(name, { gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const e = ok(wf(root, ['entry', '--item', item, '--lane', 'quick', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'q\n' });
  const shots = ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json'])).json().steps[0].artifacts;
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
    // The evidence folders are 0555 between commands: an attacker would lift that first.
    const unlock = () => fs.chmodSync(path.dirname(src), 0o755);
    exportSeams.beforeSourceOpen = (p) => {
      if (p !== src) return;
      unlock();
      fs.chmodSync(src, 0o644);
      fs.rmSync(src);
      fs.symlinkSync('/etc/hosts', src);
    };
    assert.throws(() => exportScreenshots(root, s, out), /source not readable as a regular file \(ELOOP\)/);
    fs.rmSync(src);
    exportSeams.beforeSourceOpen = (p) => p === src && fs.writeFileSync(src, 'tampered', { mode: 0o444 });
    assert.throws(() => exportScreenshots(root, s, out), /bytes differ from the recorded sha256/);
    fs.chmodSync(src, 0o644);
    fs.writeFileSync(src, keep);
    fs.chmodSync(src, 0o444);
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
    const shots = ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json'])).json().steps[0].artifacts;
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
