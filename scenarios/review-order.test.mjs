// Review runs before the gate; acceptance needs a full gate, a clean closure on the current tree, and a closure
// written after that gate passed (the evidence pass). Every review round is a fresh reviewer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WF, closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, toAccepted, wf } from './helpers.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'grep -q . src/a.txt', inputs: ['src/**'] }];

function implemented(root, base, item, change = { 'src/a.txt': 'b\n' }) {
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, change);
  return e;
}

const review = (root, base, id, reviewer, extra) => {
  const out = ok(wf(root, ['handoff', 'reviewer', '--agent', reviewer, '--attempt', id])).out.trim();
  assert.match(out, /^Read \S+ and follow its instructions\.$/, 'the start line is unchanged');
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure(reviewer, extra)), '--attempt', id]));
  return JSON.parse(fs.readFileSync(out.match(/^Read (\S+)/)[1], 'utf8'));
};

test('review before the gate: accept needs the gate, then an evidence pass by a fresh reviewer', () => {
  const { base, root, remote } = singleRepoProject('review-first', { gate: { steps } });
  const e = implemented(root, base, 'RO-1');
  assert.match(state(root, e.id).next, /hand to a fresh reviewer[\s\S]*gate can run in parallel/);
  const bundle = review(root, base, e.id, 'r1');
  assert.equal(bundle.gate.passedOnThisTree, false);
  assert.deepEqual(bundle.gate.screenshots, []);
  const noGate = wf(root, ['accept', '--attempt', e.id]);
  assert.equal(noGate.code, 75);
  assert.match(noGate.err, /gate: no gate has run; run `wf gate`/);
  assert.match(state(root, e.id).next, /clean review on this tree: run `wf gate`/);
  ok(wf(root, ['gate', '--attempt', e.id]));
  const preGate = wf(root, ['accept', '--attempt', e.id]);
  assert.equal(preGate.code, 75, 'a closure written before the gate passed has not seen the gate evidence');
  assert.match(preGate.err, /written before a passing gate on this tree[\s\S]*wf handoff reviewer --agent <new id>/);
  assert.doesNotMatch(preGate.err, /gate: /, 'only the missing evidence pass is reported');
  assert.match(state(root, e.id).next, /evidence pass/);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', e.id]));
  assert.match(state(root, e.id).next, /^waiting for reviewer r2/);
  const evidence = review(root, base, e.id, 'r3');
  assert.equal(evidence.gate.passedOnThisTree, true);
  assert.ok(evidence.gate.logs.length);
  ok(wf(root, ['accept', '--attempt', e.id]));
  ok(wf(root, ['deliver', '--attempt', e.id]));
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
});

test('each review round is a fresh reviewer: a reviewer id from an earlier round is refused', () => {
  const { base, root } = singleRepoProject('fresh-reviewer', { gate: { steps } });
  const e = implemented(root, base, 'RO-2');
  review(root, base, e.id, 'r1', { findings: [{ id: 'F1', severity: 'major', summary: 's', status: 'open', evidence: 'src/a.txt:1' }] });
  assert.match(state(root, e.id).next, /fix the open findings \(F1\)[\s\S]*fresh reviewer/);
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'fixed\n' });
  const again = wf(root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]);
  assert.equal(again.code, 75);
  assert.match(again.err, /start a fresh reviewer agent with a new id; each review round uses a new agent/);
  ok(wf(root, ['gate', '--attempt', e.id]));
  review(root, base, e.id, 'r2');
  ok(wf(root, ['accept', '--attempt', e.id]), 'r2 was handed the tree after its gate passed');
});

test('a tree change after the review forces a new review even with a passing gate on the new tree', () => {
  const { base, root } = singleRepoProject('tree-moved', { gate: { steps } });
  const e = implemented(root, base, 'RO-3');
  review(root, base, e.id, 'r1');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'unreviewed\n' });
  ok(wf(root, ['gate', '--attempt', e.id]));
  const r = wf(root, ['accept', '--attempt', e.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /no closure for the current tree: the code changed after the last review/);
  assert.doesNotMatch(r.err, /gate: /);
  assert.match(state(root, e.id).next, /^hand to a fresh reviewer/);
});

test('the reviewer handoff needs committed implementation work, and works while a gate runs', async () => {
  const slow = [{ id: 'slow', repo: 'app', run: 'echo report > out.txt; while [ ! -f "$WF_ROOT/../go" ]; do sleep 0.1; done' }];
  const { base, root } = singleRepoProject('parallel', { gate: { steps: slow } });
  const e0 = ok(wf(root, ['entry', '--item', 'RO-4', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e0.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e0.id]));
  assert.match(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e0.id]).err, /nothing to review yet/);
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e0.id]));
  fs.writeFileSync(path.join(e0.repos.app.worktree, 'src/a.txt'), 'uncommitted\n');
  assert.match(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e0.id]).err, /commit the change before the review/);
  sh(e0.repos.app.worktree, 'git commit -qam change');
  const env = { ...process.env, WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), WF_HOME: path.join(root, '..', '.home') };
  delete env.CLAUDE_CODE_SESSION_ID;
  const gate = spawn(process.execPath, [WF, 'gate', '--attempt', e0.id], { cwd: root, env });
  const done = new Promise((resolve) => gate.on('exit', resolve));
  const outFile = path.join(e0.repos.app.worktree, 'out.txt');
  for (let i = 0; i < 100 && !fs.existsSync(outFile); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.existsSync(outFile), 'the gate wrote its untracked report');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e0.id]), 'untracked gate output is not an uncommitted change');
  fs.writeFileSync(path.join(root, '..', 'go'), '');
  assert.equal(await done, 0);
});

test('batch: review before the batch gate, then an evidence pass, then delivery', () => {
  const heavy = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'true', tier: 'heavy' }];
  const { base, root, remote } = singleRepoProject('batch-order', { gate: { steps: heavy } }, { 'src/b.txt': 'b\n' });
  const m1 = toAccepted(root, base, { item: 'RO-5', change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] });
  const m2 = toAccepted(root, base, { item: 'RO-6', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'ob', '--json'])).json();
  const batchClosure = (reviewer) => closureFile(base, { reviewer, findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [] });
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb1', '--attempt', b.id]));
  ok(wf(root, ['review', '--closure', batchClosure('rb1'), '--attempt', b.id]));
  ok(wf(root, ['gate', '--attempt', b.id]));
  assert.match(wf(root, ['accept', '--attempt', b.id]).err, /written before a passing gate/);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb2', '--attempt', b.id]));
  ok(wf(root, ['review', '--closure', batchClosure('rb2'), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id]));
  ok(wf(root, ['deliver', '--attempt', b.id]));
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/b.txt`), 'two');
  for (const m of [m1.id, m2.id]) assert.equal(state(root, m).phase, 'done');
});
