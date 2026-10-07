// I-23: no review round starts while an implementer handoff is open. Named failure: two review rounds were refused
// because implementers were still editing the tree the reviewer had been handed. An implementer handoff stays open until
// `wf handoff close`; `wf handoff reviewer` refuses while one is, unless the owner records why with `--reason`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, wf, write } from './helpers.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const open = { implementersOpen: true };

function planned(name, plan) {
  const { base, root } = singleRepoProject(name, { gate: { steps } });
  const e = ok(wf(root, ['entry', '--item', 'IO-1', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', plan ? closureFile(base, plan) : criteriaFile(base), '--attempt', e.id]));
  return { base, root, e };
}

test('I-23: the reviewer handoff refuses while an implementer handoff is open; wf handoff close settles it', () => {
  const { base, root, e } = planned('impl-open');
  const h = ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', e.id]));
  assert.match(h.out, /When it reports done \(and its work is committed\), close it: `wf handoff close --agent impl-1 --attempt IO-1\.1` \(`--outcome stopped` if you stop it\); `wf handoff reviewer` refuses while it is open\./);
  // Closing it `done` says the tree is settled: uncommitted work refuses (a stopped implementer may leave some).
  write(e.repos.app.worktree, 'src/a.txt', 'b\n');
  assert.match(wf(root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', e.id]).err, /impl-1 is not done: uncommitted changes in app[\s\S]*--outcome stopped/);
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  // Committed, but never closed: the implementer may still be working.
  const refused = wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id], open);
  assert.equal(refused.code, 75, refused.err);
  assert.match(refused.err, /implementer handoff\(s\) still open on IO-1\.1: impl-1: the tree may still move under the reviewer[\s\S]*`wf handoff close --agent impl-1`[\s\S]*--reason "<why>"/);
  let s = state(root, e.id);
  assert.equal(s.handoffs.filter((x) => x.role === 'reviewer').length, 0, 'nothing is recorded for a refused handoff');
  assert.match(s.next, /^close the implementer\(s\) still open, once each has reported done and committed: `wf handoff close --agent impl-1`; then code review: hand to a fresh reviewer/);
  // Closing an agent that has no open handoff is refused; closing the open one settles the tree.
  assert.match(wf(root, ['handoff', 'close', '--agent', 'nobody', '--attempt', e.id]).err, /no open implementer `nobody`/);
  assert.match(ok(wf(root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', e.id])).out, /implementer impl-1 closed \(done\)[\s\S]*every implementer is closed/);
  assert.match(wf(root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', e.id]).err, /no open implementer `impl-1`/, 'a closed handoff is not closed twice');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id], open));
  s = state(root, e.id);
  assert.deepEqual(s.handoffs.filter((x) => x.role === 'reviewer').map((x) => x.openImplementers), [[]]);
  assert.equal(s.reviewOverrides.length, 0);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1')), '--attempt', e.id]));
});

test('I-23: every implementer handed work blocks until it is closed, stopped ones too; a later implementer reopens the wait', () => {
  const work = { criteria: [{ id: 'C1', text: 'a', uat: 'a' }, { id: 'C2', text: 'b', uat: 'b' }], work: [{ id: 'W1', criteria: ['C1'], repos: ['app'], class: 'light', why: 'ui' }, { id: 'W2', criteria: ['C2'], repos: ['app'], class: 'light', why: 'ui' }] };
  const { root, e } = planned('impl-open-two', work);
  ok(wf(root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'impl-a', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--work', 'W2', '--agent', 'impl-b', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  ok(wf(root, ['handoff', 'close', '--agent', 'impl-a', '--attempt', e.id]));
  const one = wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id], open);
  assert.equal(one.code, 75);
  assert.match(one.err, /still open on IO-1\.1: impl-b \(W2\):/);
  assert.doesNotMatch(one.err, /impl-a/);
  assert.match(ok(wf(root, ['handoff', 'close', '--agent', 'impl-b', '--outcome', 'stopped', '--attempt', e.id])).out, /impl-b closed \(stopped\)/);
  // A new implementer handoff (more work on the same tree) opens the wait again.
  ok(wf(root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'impl-c', '--attempt', e.id]));
  assert.match(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id], open).err, /still open on IO-1\.1: impl-c \(W1\)/);
  ok(wf(root, ['handoff', 'close', '--agent', 'impl-c', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id], open));
  assert.deepEqual(state(root, e.id).implementers.map((x) => [x.agent, x.outcome]), [['impl-a', 'done'], ['impl-b', 'stopped'], ['impl-c', 'done']]);
});

test('I-23: --reason hands the tree anyway and records the override before the round; it is for reviewer handoffs only', () => {
  const { base, root, e } = planned('impl-open-override');
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  assert.match(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id, '--reason', '  '], open).err, /still open/, 'a blank reason is no reason');
  assert.match(wf(root, ['handoff', 'implementer', '--agent', 'impl-2', '--attempt', e.id, '--reason', 'x']).err, /--reason applies to reviewer handoffs only/);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id, '--reason', 'the owner stopped impl-1 by hand and checked the tree'], open));
  const s = state(root, e.id);
  assert.deepEqual(s.reviewOverrides.map((x) => [x.reason, x.openImplementers, x.agent]), [['the owner stopped impl-1 by hand and checked the tree', ['impl-1'], 'rev-1']]);
  const reviewer = s.handoffs.find((x) => x.role === 'reviewer');
  assert.deepEqual(reviewer.openImplementers, ['impl-1'], 'the round records that it started on an unsettled tree');
  assert.ok(Date.parse(s.reviewOverrides[0].at) <= Date.parse(reviewer.at), 'the override is recorded before the round it opens');
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1')), '--attempt', e.id]));
});
