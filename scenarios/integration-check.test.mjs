// 0.7.0, named failure: work items built in parallel met each other for the first time in a review round, so every round
// found a new batch of cross-cutting breakage. With more than one work item the combined tree passes `wf check` before a
// code review is handed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitIn, ok, wf } from './helpers.mjs';
import { W, planFile, project } from './strategist-fixtures.mjs';

test('several work items: the combined tree passes wf check before the first review', () => {
  const ctx = project('integration-check', {}, { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' });
  const { root, base } = ctx;
  const e = ok(wf(root, ['entry', '--item', 'ENG-950', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', planFile(base, { work: W }), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i1', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--work', 'W2', '--agent', 'i2', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'A\n', 'src/b.txt': 'B\n' });
  ok(wf(root, ['handoff', 'close', '--agent', 'i1', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'close', '--agent', 'i2', '--attempt', e.id]));
  const refused = wf(root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /combined tree of 2 work items has no passing `wf check`/);
  ok(wf(root, ['check', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
});

test('one work item, or none: no integration check is owed', () => {
  const ctx = project('integration-single', {}, { 'src/a.txt': 'a\n' });
  const { root, base } = ctx;
  const e = ok(wf(root, ['entry', '--item', 'ENG-951', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', planFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'A\n' });
  ok(wf(root, ['handoff', 'close', '--agent', 'i1', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
});
