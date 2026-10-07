import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, singleRepoProject, state, wf } from './helpers.mjs';

// 0.1.21: integrity bypasses found in 0.1.20 (each named below), and repair, release and doctor.

const ignore = { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' };
function gated(name, item, steps) {
  const { base, root } = singleRepoProject(name, { gate: { steps } }, ignore);
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'q\n' });
  const g = ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json']));
  const dir = path.join(root, '.wf-evidence', 'attempts', e.id);
  return { base, root, id: e.id, gate: JSON.parse(g.out), dir, wt: e.repos.app.worktree };
}
const open = (p) => {
  for (let d = p; d.includes('.wf-evidence'); d = path.dirname(d)) if (fs.existsSync(d) && fs.lstatSync(d).isDirectory()) fs.chmodSync(d, 0o755);
};
const plant = (file, text = 'x') => {
  open(path.dirname(path.dirname(file)));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  open(path.dirname(file));
  fs.writeFileSync(file, text);
};
const refused = (r, re) => {
  assert.ok([1, 75].includes(r.code), `${r.code}: ${r.out}${r.err}`);
  assert.match(r.code === 75 ? r.err : r.out, re);
};

test('bypasses closed: a fake gate run folder, a stray *.lock, an unreadable folder are all refused', () => {
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf a > shots/home.png', artifacts: ['shots/*.png'] }];
  const { root, id, dir } = gated('bypass-dirs', 'ENG-210', visual);
  const status = () => wf(root, ['status', '--attempt', id]);
  // 0.1.20 treated any folder under gate/ without a finished entry as an open run, and exempted its files.
  plant(path.join(dir, 'gate', 'fake-run', 'planted.txt'));
  refused(status(), /gate\/fake-run\/planted\.txt: extra file/);
  fs.rmSync(path.join(dir, 'gate', 'fake-run'), { recursive: true });
  // 0.1.20 exempted every name ending in .lock.
  plant(path.join(dir, 'gate', 'notes.lock'));
  refused(status(), /gate\/notes\.lock: extra file/);
  fs.rmSync(path.join(dir, 'gate', 'notes.lock'));
  // An unreadable folder hid its contents; now it is a problem of its own (root reads any folder, so not as root).
  const sub = path.join(dir, 'handoffs');
  open(sub);
  fs.chmodSync(sub, 0o000);
  try {
    if (process.getuid?.() !== 0) refused(status(), /handoffs: unreadable folder/);
  } finally {
    fs.chmodSync(sub, 0o755);
  }
  ok(wf(root, ['verify', '--attempt', id]));
});

test('a dead runner is recovered from the ledger, never from its progress file', async () => {
  const steps = [{ id: 'fast', repo: 'app', run: 'true', inputs: ['src/**'] }];
  const { root, id, dir } = gated('bypass-progress', 'ENG-211', steps);
  const { append } = await import('../engine/ledger.mjs');
  // A run the ledger says started, whose runner is gone, with a forged progress file claiming a step passed.
  append(root, id, 'gate.started', { runId: 'forged', kind: 'gate' }, null);
  const run = path.join(dir, 'gate', 'forged');
  plant(path.join(run, 'progress.json'), JSON.stringify({ runId: 'forged', steps: [{ id: 'fast', status: 'passed', key: 'k', runId: 'forged' }] }));
  plant(path.join(dir, 'gate', 'gate.lock'), JSON.stringify({ pid: 999999, runId: 'forged', kind: 'gate', tree: {}, children: [], plugins: [] }));
  const g = wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]);
  assert.doesNotMatch(g.out, /recovered [1-9]\d* finished step/, `${g.out}${g.err}`);
  const s = state(root, id);
  const recovered = s.gates.find((x) => x.runId === 'forged');
  assert.equal(recovered.status, 'recovered');
  assert.deepEqual(recovered.steps, [], 'the forged progress claimed nothing');
});

test('copy-in and collection never follow links; a step\'s own files never replace engine files; reuse re-hashes the earlier run', () => {
  const steps = [{
    id: 'ui', repo: 'app', inputs: ['src/**'], artifacts: ['shots/*.png'],
    run: 'mkdir -p shots && printf real > shots/home.png && ln -sf /etc/hosts shots/leak.png && ln -sf /etc/hosts "$WF_EVIDENCE/hosts" && printf forged > "$WF_EVIDENCE/output.log" && mkdir -p "$WF_EVIDENCE/artifacts/shots" && printf forged > "$WF_EVIDENCE/artifacts/shots/home.png"',
  }];
  const { root, id, gate, dir } = gated('bypass-copy', 'ENG-212', steps);
  const step = gate.steps[0];
  const stepDir = path.dirname(step.log);
  assert.deepEqual(step.artifacts.map((a) => a.source), ['shots/home.png'], 'a link in the worktree is not collected');
  assert.equal(fs.readFileSync(step.artifacts[0].path, 'utf8'), 'real', 'the step cannot pre-place a collected artifact');
  assert.doesNotMatch(fs.readFileSync(step.log, 'utf8'), /^forged$/m, 'the engine log is the engine\'s');
  assert.equal(fs.readFileSync(path.join(stepDir, 'out', 'output.log'), 'utf8'), 'forged', 'the step\'s own file sits under out/');
  assert.ok(!fs.existsSync(path.join(stepDir, 'out', 'hosts')), 'a link in the scratch folder is not copied');
  // Reuse trusts no old status: the earlier run is re-hashed before any step is reused.
  const log = step.log;
  open(path.dirname(log));
  fs.chmodSync(log, 0o644);
  const bytes = fs.readFileSync(log);
  fs.writeFileSync(log, Buffer.alloc(bytes.length, 0x41));
  fs.chmodSync(log, 0o444);
  refused(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]), /output\.log: content differs/);
  assert.ok(fs.existsSync(dir));
});

test('repair: changes are shown, accepted only with a reason, recorded and shown everywhere; links and the ledger are never re-baselined', () => {
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf a > shots/home.png && printf b > shots/menu.png', artifacts: ['shots/*.png'] }];
  const { base, root, id, gate, dir } = gated('repair', 'ENG-213', visual);
  const [home, menu] = gate.steps[0].artifacts.map((a) => a.path).sort();
  open(path.dirname(home));
  fs.chmodSync(home, 0o644);
  fs.writeFileSync(home, 'fixed by a person');
  fs.rmSync(menu, { force: true });
  refused(wf(root, ['status', '--attempt', id]), /home\.png: size/);
  const ask = wf(root, ['verify', '--accept-changes', '--attempt', id]);
  assert.notEqual(ask.code, 0);
  assert.match(ask.err, /2 change\(s\) in the evidence[\s\S]*changed\s+gate\/.*home\.png\s+[0-9a-f]{12} -> [0-9a-f]{12}[\s\S]*removed\s+gate\/.*menu\.png\s+[0-9a-f]{12} -> \(removed\)[\s\S]*--reason/);
  const ok1 = ok(wf(root, ['verify', '--accept-changes', '--reason', 'a person replaced a corrupt capture', '--attempt', id]));
  assert.match(ok1.out, /re-baselined ENG-213\.1: 2 change\(s\) accepted/);
  assert.match(ok(wf(root, ['status', '--attempt', id])).out, /EVIDENCE RE-BASELINED .*2 file\(s\) changed outside wf were accepted \("a person replaced a corrupt capture"\): changed gate\/.*home\.png, removed gate\/.*menu\.png/);
  ok(wf(root, ['verify', '--attempt', id]));
  assert.equal(ok(wf(root, ['export', '--attempt', id, '--json'])).json().rebaselined[0].changes.length, 2);
  const start = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id])).out.trim();
  assert.equal(JSON.parse(fs.readFileSync(start.match(/^Read (\S+)/)[1], 'utf8')).rebaselined[0].reason, 'a person replaced a corrupt capture', 'the reviewer is told');
  // A link, and a broken ledger, are refused.
  const log = gate.steps[0].log;
  open(path.dirname(log));
  fs.chmodSync(log, 0o644);
  fs.rmSync(log);
  fs.symlinkSync('/etc/hosts', log);
  assert.match(wf(root, ['verify', '--accept-changes', '--reason', 'x', '--attempt', id]).err, /output\.log: symlink \(replace it with a regular file or remove it first\)/);
  fs.rmSync(log);
  const ledger = path.join(dir, 'ledger.jsonl');
  const text = fs.readFileSync(ledger, 'utf8');
  fs.writeFileSync(ledger, text.replace('"lane":"standard"', '"lane":"quick"'));
  assert.match(wf(root, ['verify', '--accept-changes', '--reason', 'x', '--attempt', id]).err, /hash chain broken[\s\S]*the ledger itself is never re-baselined/);
  fs.writeFileSync(ledger, text);
  assert.ok(base);
});

test('release: only closed attempts, protection lifted by the engine, nothing half-listed, a tombstone refuses a comeback', () => {
  const steps = [{ id: 'u', repo: 'app', run: 'true', inputs: ['src/**'] }];
  const { base, root, id } = gated('release', 'ENG-214', steps);
  assert.match(wf(root, ['evidence', 'release', '--attempt', id]).err, /is gated; only closed or abandoned attempts are released/);
  ok(wf(root, ['abandon', '--reason', 'not needed', '--attempt', id]));
  assert.match(ok(wf(root, ['evidence', 'release', '--closed', '--dry-run'])).out, /would release 1 attempt\(s\): ENG-214\.1 \(nothing changed\)/);
  assert.match(ok(wf(root, ['evidence', 'release', '--older-than', '1'])).out, /nothing to release/, 'abandoned today is not older than a day');
  const dir = path.join(root, '.wf-evidence', 'attempts', id);
  const copy = path.join(base, 'ledger-copy.jsonl');
  fs.copyFileSync(path.join(dir, 'ledger.jsonl'), copy);
  const r = ok(wf(root, ['evidence', 'release', '--attempt', id, '--reason', 'pruning']));
  assert.match(r.out, /released 1 attempt\(s\): ENG-214\.1; their ids are tombstoned/);
  assert.ok(!fs.existsSync(dir));
  assert.deepEqual(fs.readdirSync(path.join(root, '.wf-evidence', 'released')), [], 'nothing left behind');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.wf-worktrees', '_anchor', `${id}.json`), 'utf8')).released, true);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(copy, path.join(dir, 'ledger.jsonl'));
  refused(wf(root, ['status', '--attempt', id]), /was released .*must not reappear/);
});

test('doctor lists the protection layers this machine provides', () => {
  const { root } = singleRepoProject('doctor-layers', { gate: { steps: [] } });
  const out = `${wf(root, ['doctor', '--no-steps']).out}`;
  assert.match(out, /protection: read-only modes \(0444 files, 0555 folders\)/);
  assert.match(out, /protection: immutable flag[\s\S]*(on \(chflags uchg\)|off: )/);
  assert.match(out, /protection: manifest verified at every use/);
  assert.ok(!fs.existsSync(path.join(root, '.wf-worktrees', '_probe')));
});
