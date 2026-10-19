// 0.7.35 (D90). Named failure (CI, one macOS shard, scenarios/fix-074-txn.test.mjs): a `wf status` queued behind the evidence lock
// while `wf deliver` wrote its summary ran on after `wf shown` had closed the attempt and removed its worktree. It had opened the
// attempt while it was open, so it hashed the worktree's tree (`treeHash`, `git rev-parse HEAD`) in a folder that was gone, and
// failed with "worktree missing" for an attempt that was simply closed. A read that finds a worktree gone under it now opens the
// attempt again and reports what it is: closed, or orphaned.
//
// Deterministic: the reader runs in a process whose `spawnSync` is wrapped; at its first git call from `treeHash` into the attempt's
// worktree (from a given call path, when one is named) it runs the concurrent command to its end (the real `wf shown`, or the folder removed by hand), then lets the git call go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from '../engine/util.mjs';
import { followAdapter } from '../engine/adapter-follow.mjs';
import { loadState, readLedger } from '../engine/ledger.mjs';
import { WF, closureFile, sh, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, singleRepoProject, summaryFile, wf, yaml } from './helpers.mjs';

const ENGINE = path.resolve(import.meta.dirname, '..', 'engine');
const READER = `import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [,, root, id, reader, sentinel, concurrent, frame] = process.argv;
const original = cp.spawnSync;
// 'phantom': every tree hash git call into the worktree fails as if its folder were gone, while the folder stays (so it is never
// seen orphaned): a worktree that stays missing. Each one the next step of \`wf status\` makes (one per try) is counted.
const phantom = new Set();
const exists = fs.existsSync;
fs.existsSync = function (p) { return phantom.has(String(p)) && /\\bat run \\(/.test(new Error().stack) ? false : exists.call(this, p); };
cp.spawnSync = function (cmd, args, opts = {}) {
  if (concurrent === 'phantom' && cmd === 'git' && String(opts.cwd ?? '').includes('/.wf-worktrees/' + id + '/') && /\\btreeHash \\(/.test(new Error().stack)) {
    if (/\\bat nextAction \\(/.test(new Error().stack) && /\\bat summary \\(/.test(new Error().stack)) fs.appendFileSync(sentinel, 'x');
    phantom.add(String(opts.cwd));
    return { error: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }), status: null, stdout: '', stderr: '' };
  }
  if (cmd === 'git' && !fs.existsSync(sentinel) && String(opts.cwd ?? '').includes('/.wf-worktrees/' + id + '/') && /\\btreeHash \\(/.test(new Error().stack) && new RegExp(frame).test(new Error().stack)) {
    fs.writeFileSync(sentinel, '');
    if (concurrent === 'remove') fs.rmSync(opts.cwd, { recursive: true, force: true });
    else {
      const r = original(process.execPath, [${JSON.stringify(WF)}, ...JSON.parse(concurrent)], { cwd: root, encoding: 'utf8', env: process.env });
      fs.writeFileSync(sentinel, JSON.stringify({ status: r.status, out: r.stdout, err: r.stderr }));
    }
  }
  return original.call(this, cmd, args, opts);
};
syncBuiltinESMExports();
const { main } = await import(${JSON.stringify(path.join(ENGINE, 'cli.mjs'))});
process.chdir(root);
process.exitCode = await main([reader, '--attempt', id]);
`;

const statuses = { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' };
const ticketFile = (id) => `---\n${yaml({ id, title: 'Show the new text', status: 'Todo', labels: ['ui'] }).trim()}\n---\nThe home screen shows the new text.\n`;

function delivered(name) {
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf png > shots/home.png', artifacts: ['shots/*.png'] }];
  const f = singleRepoProject(name, { tracker: { kind: 'files', statuses, deliveredComment: 'uat.md' }, gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n', '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n', 'tickets/ENG-400.md': ticketFile('ENG-400') });
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-400', '--owner', 'o', '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id]));
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'ui\n' });
  const g = ok(wf(f.root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json'])).json();
  ok(wf(f.root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('r', { screenshotsInspected: [g.steps[0].artifacts[0].sha256] })), '--attempt', e.id]));
  ok(wf(f.root, ['accept', '--attempt', e.id]));
  ok(wf(f.root, ['deliver', '--attempt', e.id, '--summary-file', summaryFile(f.base)]));
  const shown = path.join(f.base, 'shown.json');
  fs.writeFileSync(shown, JSON.stringify({ screenshots: [{ sha256: g.steps[0].artifacts[0].sha256, caption: 'Home screen with the new text' }], anomalies: 'none seen' }));
  const reader = path.join(f.base, 'reader.mjs');
  fs.writeFileSync(reader, READER);
  let n = 0;
  // `frame`: the call path the git call must come from (the default, any: the first one).
  const read = (cmd, concurrent, frame = '') => {
    const sentinel = path.join(f.base, `concurrent-${++n}`);
    const r = spawnSync(process.execPath, [reader, f.root, e.id, cmd, sentinel, concurrent, frame], { encoding: 'utf8' });
    assert.ok(fs.existsSync(sentinel), `${cmd}: the reader reached a git call into the worktree`);
    const text = fs.readFileSync(sentinel, 'utf8');
    if (concurrent === 'phantom') return { code: r.status, out: r.stdout, err: r.stderr, tries: text.length };
    return { code: r.status, out: r.stdout, err: r.stderr, concurrent: text ? JSON.parse(text) : null };
  };
  return { f, e, shown, read };
}

test('0.7.35 (D90): a read whose attempt is closed and its worktree removed by a concurrent command reports it closed, never "worktree missing"', () => {
  const { e, shown, read } = delivered('race-closed');
  // At the call the field run failed on: the tree hash of the next step `wf status` prints, outside any try.
  const r = read('status', JSON.stringify(['shown', '--file', shown, '--attempt', e.id]), '\\bat nextAction \\(');
  assert.equal(r.concurrent.status, 0, `the concurrent \`wf shown\` ran to its end:\n${r.concurrent.err}`);
  assert.match(r.concurrent.out, /attempt closed/);
  assert.ok(!fs.existsSync(e.repos.app.worktree), 'its worktree was removed under the reader');
  assert.doesNotMatch(r.err, /worktree missing/);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ENG-400\.1 {2}ENG-400 .*phase=done/m);
});

test('0.7.35 (D90): a read whose worktree is removed under it while the attempt is open reports it orphaned; a write still refuses', () => {
  const { f, e, read } = delivered('race-orphan');
  for (const cmd of ['status', 'resume']) {
    if (!fs.existsSync(e.repos.app.worktree)) spawnSync('git', ['-C', f.root, 'worktree', 'add', '-f', e.repos.app.worktree, `wf/${e.id}`], { encoding: 'utf8' });
    const r = read(cmd, 'remove');
    assert.ok(!fs.existsSync(e.repos.app.worktree));
    assert.equal(r.code, 0, `${cmd}: ${r.err}`);
    assert.doesNotMatch(r.err, /worktree missing/);
    assert.match(r.out, /ORPHANED: worktree missing: \S+\/\.wf-worktrees\/ENG-400\.1\/app; the evidence and the branch are intact/, cmd);
  }
  // A write is not read again: the missing folder still stops it.
  assert.notEqual(wf(f.root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]).code, 0);
});

// Review of 0.7.35 (D90): no cap on the restarts, a progress condition. A worktree that stays missing restarts the read once (the
// first time it is seen missing), never again; the error is then reported as it is.
test('0.7.35 (D90): a worktree that stays missing restarts a read once, then the read reports the error', () => {
  const { read } = delivered('race-phantom');
  const r = read('status', 'phantom');
  assert.equal(r.tries, 2, 'one try, then one restart for the newly missing worktree, then no more');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /worktree missing: \S+\/\.wf-worktrees\/ENG-400\.1\/app \(git was not run there\)/);
});

test('0.7.35 (D90): only a folder under .wf-worktrees/ is a missing worktree; any other missing folder is named for what it is', () => {
  const at = (dir) => { try { run('git', ['status'], { cwd: dir }); } catch (error) { return error; } return null; };
  const gone = path.join(path.sep, 'nonexistent-wf-d90', 'repo');
  const repo = at(gone);
  assert.equal(repo.message, `repo folder missing: ${gone} (git was not run there)`);
  assert.equal(repo.worktreeMissing, undefined, 'a missing repo folder never restarts a read');
  const worktree = path.join(path.sep, 'nonexistent-wf-d90', '.wf-worktrees', 'ENG-1.1', 'app');
  const w = at(worktree);
  assert.equal(w.message, `worktree missing: ${worktree} (git was not run there)`);
  assert.deepEqual(w.worktreeMissing, [worktree]);
});

// Review of 0.7.35 (D90), pre-existing: `followAdapter` re-read the attempt inside its transaction but not its phase, so a read that
// opened the attempt while it was open (a `wf status` racing the `wf shown` that closes it) appended `adapter.followed` to it closed.
test('0.7.35 (D90): an adapter follow planned on an open attempt records nothing once the attempt has closed', () => {
  const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
  const f = singleRepoProject('follow-closed', { gate: { steps } });
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-1', '--owner', 'o', '--json'])).json();
  const stale = loadState(f.root, e.id);
  ok(wf(f.root, ['abandon', '--reason', 'superseded', '--attempt', e.id]));
  const before = readLedger(f.root, e.id).length;
  fs.writeFileSync(path.join(f.root, '.workflow', 'project.yaml'), yaml({ version: 1, enabled: true, name: 'follow-closed', repos: [{ name: 'app', path: '.', base: 'main' }], lanes: ['quick', 'standard', 'batch'], gate: { steps: [{ ...steps[0], run: 'true # stricter' }] } }));
  sh(f.root, 'git commit -qam "unit: stricter" && git push -q origin main');
  followAdapter(f.root, stale);
  const after = readLedger(f.root, e.id);
  assert.deepEqual(after.slice(before).map((x) => x.type), [], 'nothing is appended to the closed attempt');
});
