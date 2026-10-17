import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commitIn, ok, sh, state, wf } from './helpers.mjs';
import { accepted, multiRepo } from './adapter-fault-fixtures.mjs';
import { headOf, perRepoAdapter, reconcile } from './base-merge-in-flight-fixtures.mjs';

// 0.7.26 (I-183), several repos, what a review round covers and what a recorded repo may still change: see
// base-merge-in-flight.test.mjs for the named failure. An independent review of 0.7.26 found the cases below.

const project = (name) => {
  const { base, root } = multiRepo(name, perRepoAdapter);
  const e = ok(wf(root, ['entry', '--item', 'ENG-9', '--owner', 'o', '--json'])).json();
  return { base, root, e, wt: (n) => e.repos[n].worktree };
};
const baseMoves = (root, repo, file = 'src/x.txt') => sh(path.join(root, repo), `git pull -q --ff-only origin main && printf 'new\\n' > ${file} && git add -A && git commit -qm 'base change' && git push -q origin main`);

// Named failure (review of 0.7.26, medium): a repo whose merge request the person merged, but that `wf deliver` has not recorded
// yet, reads an empty patch (its change is on the target), so a base merge elsewhere that left the ticket's lines alone still
// forced a code review that could add nothing.
test('I-183: a repo whose request the person merged and that is not recorded yet is not compared: a base merge elsewhere owes the gate and the evidence review only', () => {
  const { base, root, e, wt } = project('landed-unrecorded');
  accepted(root, base, e.id, [[wt('web'), { 'src/w.txt': 'web\n' }], [wt('api'), { 'src/a.txt': 'api\n' }]]);
  assert.match(ok(wf(root, ['deliver', '--attempt', e.id])).out, /api: awaiting-merge/);
  const apiHead = headOf(wt('api'));
  // The person merges api's request (a merge commit on main); nothing is recorded yet.
  sh(path.join(root, 'api'), `git pull -q --ff-only origin main && git merge -q --no-ff --no-edit ${apiHead} && git push -q origin main`);
  assert.deepEqual(state(root, e.id).delivery.repos, {});
  baseMoves(root, 'web');
  const m = ok(wf(root, ['base', 'merge', '--attempt', e.id]));
  assert.match(m.out, /web: merged origin\/main/);
  assert.match(m.out, /api: left as it is \(its change is already on origin\/main/);
  assert.equal(headOf(wt('api')), apiHead);
  assert.deepEqual(reconcile(root, base, e.id, 'rev-landed'), ['gate', 'evidence-review']);
  // api is recorded from its request, then web's is integrated on the reconciled tree.
  fs.writeFileSync(path.join(root, '..', 'merged.api'), '');
  assert.match(ok(wf(root, ['deliver', '--attempt', e.id])).out, /web: awaiting-merge/);
  assert.equal(state(root, e.id).delivery.repos.api.commit, apiHead);
  fs.writeFileSync(path.join(root, '..', 'merged.web'), '');
  ok(wf(root, ['deliver', '--attempt', e.id]));
  assert.ok(state(root, e.id).delivery.completedAt);
});

// Named failure (review of 0.7.26, medium): a repo recorded as skipped or delivered was left out of what a round covers for good,
// so a commit made in it afterwards was neither reviewed nor delivered. It is left out only while its diff is empty.
test('I-183: a commit made in a repo recorded as skipped is compared again: the review no longer covers the tree and the gate waits for a code review', () => {
  const { root, base, e, wt } = project('skipped-late');
  accepted(root, base, e.id, [[wt('web'), { 'src/w.txt': 'web\n' }]]);
  assert.match(ok(wf(root, ['deliver', '--attempt', e.id])).out, /web: awaiting-merge/);
  assert.equal(state(root, e.id).delivery.repos.api.skipped, 'no changes');
  baseMoves(root, 'web');
  ok(wf(root, ['base', 'merge', '--attempt', e.id]));
  // Without a late commit the code review still covers the change: the gate is next.
  assert.equal(state(root, e.id).decision.kind, 'gate');
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i-late', '--attempt', e.id]));
  commitIn(wt('api'), { 'src/z.txt': 'late\n' }, 'late api change');
  ok(wf(root, ['handoff', 'close', '--agent', 'i-late', '--attempt', e.id]));
  const gate = wf(root, ['gate', '--attempt', e.id]);
  assert.equal(gate.code, 75);
  assert.match(gate.err, /no review round covers the current tree/);
});

// Named failure (review of 0.7.26, medium; the delivery half pre-existing): a commit made in a repo already recorded for the
// delivery (skipped for having no change, or delivered) was never delivered, and `wf deliver` finished the attempt without it.
test('I-183: a commit made in a repo recorded as skipped after a partial delivery: deliver refuses naming it, and the next step says so', () => {
  const { root, base, e, wt } = project('late-skipped');
  accepted(root, base, e.id, [[wt('web'), { 'src/w.txt': 'web\n' }]]);
  assert.match(ok(wf(root, ['deliver', '--attempt', e.id])).out, /web: awaiting-merge/);
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i-late', '--attempt', e.id]));
  commitIn(wt('api'), { 'src/z.txt': 'late\n' }, 'late api change');
  ok(wf(root, ['handoff', 'close', '--agent', 'i-late', '--attempt', e.id]));
  const s = state(root, e.id);
  assert.equal(s.decision.kind, 'repair');
  assert.match(s.next, /api was recorded as skipped \(no changes\) for this delivery and now has 1 changed file\(s\) \(src\/z\.txt\)/);
  fs.writeFileSync(path.join(root, '..', 'merged.web'), '');
  const d = wf(root, ['deliver', '--attempt', e.id]);
  assert.equal(d.code, 75);
  assert.match(d.err, /not delivered: api was recorded as skipped \(no changes\) for this delivery and now has 1 changed file\(s\) \(src\/z\.txt\)/);
  assert.match(d.err, /a repo recorded for a delivery is not delivered again/);
  assert.equal(state(root, e.id).delivery.completedAt, null, 'nothing was finished without it');
});

test('I-183: a commit made in a repo recorded as delivered after a partial delivery: deliver refuses naming the commit it was recorded at', () => {
  const { root, base, e, wt } = project('late-delivered');
  accepted(root, base, e.id, [[wt('web'), { 'src/w.txt': 'web\n' }], [wt('api'), { 'src/a.txt': 'api\n' }]]);
  fs.writeFileSync(path.join(root, '..', 'merged.api'), '');
  assert.match(ok(wf(root, ['deliver', '--attempt', e.id])).out, /web: awaiting-merge/);
  const recorded = state(root, e.id).delivery.repos.api.commit;
  assert.equal(recorded, headOf(wt('api')));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i-late', '--attempt', e.id]));
  commitIn(wt('api'), { 'src/z.txt': 'late\n' }, 'late api change');
  ok(wf(root, ['handoff', 'close', '--agent', 'i-late', '--attempt', e.id]));
  const late = headOf(wt('api'));
  assert.match(state(root, e.id).next, new RegExp(`api was recorded as delivered at ${recorded.slice(0, 10)} and its worktree is at ${late.slice(0, 10)}`));
  fs.writeFileSync(path.join(root, '..', 'merged.web'), '');
  const d = wf(root, ['deliver', '--attempt', e.id]);
  assert.equal(d.code, 75);
  assert.match(d.err, new RegExp(`not delivered: api was recorded as delivered at ${recorded.slice(0, 10)} and its worktree is at ${late.slice(0, 10)}`));
  assert.equal(state(root, e.id).delivery.completedAt, null);
});

// Named failure (review of 0.7.26, low): `--repo` naming a repo the ticket changes nothing in merged the base into it and withdrew
// the acceptance, though the same repo is left alone without `--repo`: merging there moves a tree nothing is delivered from.
test('I-183: wf base merge --repo naming a repo the ticket changes nothing in leaves it alone under an adapter and withdraws nothing', () => {
  const { root, base, e, wt } = project('idle-explicit');
  accepted(root, base, e.id, [[wt('api'), { 'src/a.txt': 'api\n' }]]);
  assert.match(ok(wf(root, ['deliver', '--attempt', e.id])).out, /api: awaiting-merge/);
  baseMoves(root, 'web');
  const web = headOf(wt('web'));
  const m = ok(wf(root, ['base', 'merge', '--repo', 'web', '--attempt', e.id]));
  assert.match(m.out, /web: left as it is \(this ticket changes nothing there, so the delivery skips it\)/);
  assert.doesNotMatch(m.out, /withdrawn/);
  assert.equal(headOf(wt('web')), web);
  assert.ok(state(root, e.id).accepted, 'the acceptance stands: nothing that is delivered moved');
  assert.equal(state(root, e.id).baseMerges.length, 0);
});
