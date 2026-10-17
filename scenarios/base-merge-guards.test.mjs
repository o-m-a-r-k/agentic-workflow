import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, sh, singleRepoProject, state, toAccepted, wf } from './helpers.mjs';
import { steps } from './adapter-fault-fixtures.mjs';
import { headOf, integrations, mrAdapter, reconcile } from './base-merge-in-flight-fixtures.mjs';

// 0.7.26 (I-183), the guards around a base merge for a delivery through an adapter: see base-merge-in-flight.test.mjs for the
// named failure and the main scenarios. An independent review of 0.7.26 found the cases below.

const project = (name, files = {}) => singleRepoProject(name, { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': mrAdapter, 'src/other.txt': 'o\n', ...files });

// Named failure (review of 0.7.26, high): the base merged by hand in the worktree (the owner's implementer "for reconciliation",
// or after `wf base merge` aborted on a conflict) moves HEAD with the acceptance standing. `wf deliver` then handed the new HEAD
// to the adapter while the acceptance named the old one, and the person's merge of it was refused as "pushed outside wf".
test('I-183: a base merged by hand into an accepted attempt delivered through an adapter: deliver refuses naming the commit the acceptance names, the way is gate, review, accept, and the person\'s merge is recognised', () => {
  const { base, root, remote } = project('mr-hand');
  const { id, wt } = toAccepted(root, base, { item: 'ENG-190' });
  const reviewed = headOf(wt);
  assert.match(ok(wf(root, ['deliver', '--attempt', id])).out, /app: awaiting-merge/);
  sh(root, "printf 'o2\\n' > src/other.txt && git commit -qam 'unrelated base change' && git push -q origin main");
  sh(wt, 'git fetch -q origin main && git merge -q --no-edit origin/main');
  const merged = headOf(wt);
  assert.notEqual(merged, reviewed);

  // Nothing wf recorded: the acceptance stands, and says what it names. The adapter is not handed the unreviewed tree.
  let s = state(root, id);
  assert.equal(s.accepted.heads.app, reviewed);
  assert.equal(s.decision.kind, 'gate', 'the decision is not "deliver"');
  assert.match(s.next, new RegExp(`^the acceptance names app ${reviewed.slice(0, 10)} but its tree is ${merged.slice(0, 10)}`));
  const refused = wf(root, ['deliver', '--attempt', id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, new RegExp(`not delivered: app: the acceptance names ${reviewed.slice(0, 10)} and the tree is ${merged.slice(0, 10)}`));
  assert.match(refused.err, /review, gate and accept the tree as it is/);
  assert.ok(integrations(root).every((x) => x === `app ${reviewed}`), 'integrate was not called on the new tree');

  assert.deepEqual(reconcile(root, base, id, 'rev-hand'), ['gate', 'evidence-review']);
  assert.equal(state(root, id).accepted.heads.app, merged);
  assert.match(ok(wf(root, ['deliver', '--attempt', id])).out, /app: awaiting-merge/);
  assert.equal(integrations(root).at(-1), `app ${merged}`);
  sh(wt, 'git push -q origin HEAD:refs/heads/main');
  ok(wf(root, ['deliver', '--attempt', id]));
  s = state(root, id);
  assert.ok(s.delivery.completedAt);
  assert.equal(s.delivery.repos.app.commit, merged);
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/other.txt`), 'o2');
});

// Named failure (review of 0.7.26, low): the hint of a conflicting base merge ended at "then `wf gate` and a fresh reviewer",
// not saying that the acceptance (which the adapter delivery goes by) is stale once the owner's implementer commits the merge.
test('I-183: a conflicting base merge into an accepted attempt delivered through an adapter says the acceptance has to be redone', () => {
  const lines = (n, word) => `${Array.from({ length: 5 }, (_, i) => (i + 1 === n ? word : `l${i + 1}`)).join('\n')}\n`;
  const { base, root } = project('mr-conflict', { 'src/m.txt': lines(0, '') });
  const { id } = toAccepted(root, base, { item: 'ENG-191', change: { 'src/m.txt': lines(2, 'mine') } });
  sh(root, `printf '${lines(2, 'theirs').replace(/\n/g, '\\n')}' > src/m.txt && git commit -qam 'conflicting base change' && git push -q origin main`);
  const r = wf(root, ['base', 'merge', '--attempt', id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /conflicts in src\/m\.txt; the merge was aborted/);
  assert.match(r.err, /The acceptance names the commit the delivery adapter integrates, so it has to be redone: `wf deliver` refuses until the merged tree is gated, reviewed and accepted again/);
});
