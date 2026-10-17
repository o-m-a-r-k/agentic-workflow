import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ok, sh, singleRepoProject, state, toAccepted, wf } from './helpers.mjs';
import { ledger, steps } from './adapter-fault-fixtures.mjs';
import { headOf, integrations, mrAdapter, reconcile } from './base-merge-in-flight-fixtures.mjs';

// 0.7.26 (I-183). Named failure (field): a merge request awaited its merge (the adapter's `observe` said
// `awaiting-merge`) while the base branch moved on by dozens of commits. `wf base merge` refused ("already being
// delivered; `wf deliver` merges the base itself"), but a delivery with an adapter never merges the base (only the
// built-in push-main does), so every later `wf deliver` asked the adapter again and the branch stayed behind: the merge
// request could not be merged as reviewed. The base now comes in while an integration waits; the acceptance is withdrawn,
// because it names the commit the merge request was opened for, so the combined tree is gated and reviewed again, and the
// next `wf deliver` asks the adapter to integrate the reconciled branch.

test('I-183: the base moved while the merge request awaits its merge: wf base merge brings it in, review, gate and accept run again, and wf deliver integrates the reconciled branch', () => {
  const { base, root, remote } = singleRepoProject('mr-base', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': mrAdapter, 'src/other.txt': 'o\n' });
  const { id, wt } = toAccepted(root, base, { item: 'ENG-183' });
  const reviewed = headOf(wt);
  const d1 = ok(wf(root, ['deliver', '--attempt', id]));
  assert.match(d1.out, /app: awaiting-merge \(https:\/\/git\.example\.test\/mr\/183\)/);
  assert.deepEqual(integrations(root), [`app ${reviewed}`], 'the merge request was opened for the reviewed commit');
  assert.equal(state(root, id).delivery.integrating.app.observed.state, 'awaiting-merge');

  // The base branch moves on while the request waits.
  sh(root, "printf 'o2\\n' > src/other.txt && git commit -qam 'unrelated base change' && git push -q origin main");
  assert.match(ok(wf(root, ['status', '--attempt', id])).out, /base app: origin\/main moved 1 commit\(s\)/);
  // Waiting for the merge, the owner is told where the way in is (the report: `wf deliver` only observed, and said nothing).
  const again = ok(wf(root, ['deliver', '--attempt', id]));
  assert.match(again.out, /app: awaiting-merge[\s\S]*the base moved meanwhile \(app: origin\/main \+1 commit\(s\)\): `wf base merge` brings it into the branch, the merged tree is gated, reviewed and accepted again/);
  assert.match(state(root, id).next, /app is awaiting-merge \(https:\/\/git\.example\.test\/mr\/183\): `wf deliver` asks the adapter again; if the base branch moved meanwhile, `wf base merge` brings it in/);

  // The base comes in. Nothing is delivered, so nothing is touched; the evidence only gains a `base.merged` event.
  const m = ok(wf(root, ['base', 'merge', '--attempt', id]));
  assert.match(m.out, /app: merged origin\/main \(1 commit\(s\), 1 file\(s\)\)/);
  assert.match(m.out, /the acceptance is withdrawn, because it names the commit the pending integration .* was opened for/);
  const merged = headOf(wt);
  assert.notEqual(merged, reviewed);
  const ev = ledger(root, id).filter((e) => e.type === 'base.merged');
  assert.equal(ev.at(-1).data.withdrewAcceptance, true);
  assert.equal(ev.at(-1).data.headAfter, merged);
  let s = state(root, id);
  assert.equal(s.accepted, null, 'the acceptance named the commit the request was opened for');
  assert.equal(s.delivery.integrating.app.observed.state, 'awaiting-merge', 'the recorded integration stays');
  assert.deepEqual(s.delivery.repos, {}, 'nothing is recorded as delivered');
  assert.equal(sh(base, `git --git-dir=${remote} rev-parse refs/heads/wf/${id}`), reviewed, 'the request still holds the reviewed commit');

  // The acceptance does not carry to a tree nobody reviewed or gated: deliver refuses, and the owner is told the way.
  const early = wf(root, ['deliver', '--attempt', id]);
  assert.equal(early.code, 75);
  assert.match(early.err, /review not accepted/);
  assert.ok(integrations(root).every((x) => x === `app ${reviewed}`), 'the adapter was not asked to integrate the unreviewed tree');
  assert.match(s.next, /wf gate/);
  assert.equal(s.decision.kind, 'gate');

  // The ticket's own change is untouched, so the code review still covers it: the gate, then the evidence review, then accept.
  // 0.7.26 (I-183): after the gate on the moved tree the text, like the decision, names the evidence review (it said "code review:
  // hand to a fresh reviewer ... no gate until a code-review round comes back clean" while the decision named the evidence review).
  const afterGate = [];
  assert.deepEqual(reconcile(root, base, id, 'rev-again', (step, s2) => { if (step === 'gate') afterGate.push(s2); }), ['gate', 'evidence-review']);
  assert.equal(afterGate.length, 1);
  assert.equal(afterGate[0].decision.round, 'evidence-review');
  assert.match(afterGate[0].next, /^evidence review: the gate passed on this tree/);
  assert.doesNotMatch(afterGate[0].next, /code review: hand to|no gate until/);
  s = state(root, id);
  assert.equal(s.accepted.heads.app, merged, 'the acceptance now names the reconciled commit');

  // The adapter is asked to integrate again, with the reconciled branch, and still waits for the merge.
  const d2 = ok(wf(root, ['deliver', '--attempt', id]));
  assert.match(d2.out, /app: awaiting-merge/);
  assert.equal(integrations(root).at(-1), `app ${merged}`, 'integrate ran again, on the merged tree');
  assert.equal(sh(base, `git --git-dir=${remote} rev-parse refs/heads/wf/${id}`), merged, 'the merge request holds the reconciled branch');

  // Merged by the person: the delivery completes on the reconciled commit.
  sh(wt, 'git push -q origin HEAD:refs/heads/main');
  ok(wf(root, ['deliver', '--attempt', id]));
  s = state(root, id);
  assert.ok(s.delivery.completedAt, 'delivered');
  assert.equal(s.delivery.repos.app.commit, merged);
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/other.txt`), 'o2');
});

test('I-183: a base merge that changes the lines around the ticket\'s own change needs a code review again, not only the gate', () => {
  const lines = (n) => Array.from({ length: 7 }, (_, i) => `l${i + 1}`).map((l, i) => (i + 1 === n ? `${l}-changed` : l)).join('\n') + '\n';
  const { base, root } = singleRepoProject('mr-base-touch', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': mrAdapter, 'src/m.txt': lines(0) });
  const { id } = toAccepted(root, base, { item: 'ENG-184', change: { 'src/m.txt': lines(2) } });
  assert.match(ok(wf(root, ['deliver', '--attempt', id])).out, /awaiting-merge/);
  // The base changes a line inside the context of the ticket's hunk (two lines away: no conflict, but another hunk).
  sh(root, `printf '${lines(5).replace(/\n/g, '\\n')}' > src/m.txt && git commit -qam 'base change near the hunk' && git push -q origin main`);
  const m = ok(wf(root, ['base', 'merge', '--attempt', id]));
  assert.match(m.out, /the acceptance is withdrawn/);
  const s = state(root, id);
  assert.equal(s.accepted, null);
  assert.equal(s.decision.kind, 'review');
  assert.equal(s.decision.round, 'code-review', 'the reviewed change is not the change the merge request would carry now');
});

test('I-183: the merge request was merged and the base moved on: wf base merge leaves the landed branch alone and wf deliver records the delivery', () => {
  const { base, root, remote } = singleRepoProject('mr-base-landed', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': mrAdapter, 'src/other.txt': 'o\n' });
  const { id, wt } = toAccepted(root, base, { item: 'ENG-186' });
  const reviewed = headOf(wt);
  assert.match(ok(wf(root, ['deliver', '--attempt', id])).out, /awaiting-merge/);
  // A person merges the request; the base branch then moves on past it.
  sh(wt, 'git push -q origin HEAD:refs/heads/main');
  sh(root, "git pull -q --ff-only origin main && printf 'o2\\n' > src/other.txt && git commit -qam 'later base change' && git push -q origin main");
  assert.match(ok(wf(root, ['status', '--attempt', id])).out, /base app: origin\/main moved 1 commit\(s\) and already holds this attempt's commits \(nothing to merge in\)/);
  const m = ok(wf(root, ['base', 'merge', '--attempt', id]));
  assert.match(m.out, /app: left as it is \(its change is already on origin\/main; `wf deliver` records it\)/);
  assert.doesNotMatch(m.out, /withdrawn/);
  assert.equal(headOf(wt), reviewed, 'the branch the delivery recognises was not moved');
  assert.deepEqual(ledger(root, id).filter((e) => e.type === 'base.merged'), []);
  assert.equal(state(root, id).accepted.heads.app, reviewed, 'the acceptance stands');
  ok(wf(root, ['deliver', '--attempt', id]));
  const s = state(root, id);
  assert.ok(s.delivery.completedAt);
  assert.equal(s.delivery.repos.app.commit, reviewed);
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
});

// 0.7.26 (I-183), one rule: with a delivery adapter the acceptance names the commit the adapter will be asked to integrate and the
// person's merge will be recognised by, whether or not a delivery has started. Named failure (reproduced): an accepted attempt
// base-merged before its first `wf deliver`, was gated again and delivered; the request opened, the person merged it, and
// `wf deliver` refused the merged commit as "not the accepted, gated commit; it was pushed outside wf".
test('I-183: an accepted attempt that base-merges before any deliver, through a delivery adapter: the acceptance is withdrawn, and the person\'s merge of the reconciled branch is recognised', () => {
  const { base, root, remote } = singleRepoProject('mr-base-early', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': mrAdapter, 'src/other.txt': 'o\n' });
  const { id, wt } = toAccepted(root, base, { item: 'ENG-187' });
  const reviewed = headOf(wt);
  assert.deepEqual(state(root, id).delivery.integrating, {}, 'nothing was delivered yet');
  sh(root, "printf 'o2\\n' > src/other.txt && git commit -qam 'unrelated base change' && git push -q origin main");
  const m = ok(wf(root, ['base', 'merge', '--attempt', id]));
  assert.match(m.out, /the acceptance is withdrawn, because it names the commit the delivery adapter will integrate/);
  const merged = headOf(wt);
  assert.equal(ledger(root, id).filter((e) => e.type === 'base.merged').at(-1).data.withdrewAcceptance, true);
  let s = state(root, id);
  assert.equal(s.accepted, null);
  assert.equal(s.decision.kind, 'gate', 'the ticket\'s own lines are untouched: the gate, then the evidence review');
  const early = wf(root, ['deliver', '--attempt', id]);
  assert.equal(early.code, 75);
  assert.match(early.err, /review not accepted/);
  assert.deepEqual(reconcile(root, base, id, 'rev-early'), ['gate', 'evidence-review']);
  assert.equal(state(root, id).accepted.heads.app, merged);
  assert.match(ok(wf(root, ['deliver', '--attempt', id])).out, /app: awaiting-merge/);
  assert.deepEqual(integrations(root), [`app ${merged}`], 'the request was opened for the reviewed, reconciled commit only');
  assert.notEqual(merged, reviewed);
  // The person merges the request; the next deliver recognises exactly that commit.
  sh(wt, 'git push -q origin HEAD:refs/heads/main');
  ok(wf(root, ['deliver', '--attempt', id]));
  s = state(root, id);
  assert.ok(s.delivery.completedAt);
  assert.equal(s.delivery.repos.app.commit, merged);
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/other.txt`), 'o2');
});

// The built-in push-main merges the base itself at delivery and carries the gate, so a base merge before it keeps its own
// behaviour: the acceptance stands (the gate runs again), and no delivery adapter is involved.
test('I-183: with the built-in push-main a base merge on an accepted attempt keeps the acceptance, as before', () => {
  const { base, root, remote } = singleRepoProject('pm-base', { gate: { steps } }, { 'src/other.txt': 'o\n' });
  const { id } = toAccepted(root, base, { item: 'ENG-188' });
  sh(root, "printf 'o2\\n' > src/other.txt && git commit -qam 'unrelated base change' && git push -q origin main");
  const m = ok(wf(root, ['base', 'merge', '--attempt', id]));
  assert.doesNotMatch(m.out, /withdrawn/);
  assert.match(m.out, /the gate and the review are bound to the tree/);
  assert.equal(ledger(root, id).filter((e) => e.type === 'base.merged').at(-1).data.withdrewAcceptance, undefined);
  assert.ok(state(root, id).accepted, 'the acceptance stands');
  ok(wf(root, ['gate', '--attempt', id]));
  ok(wf(root, ['deliver', '--attempt', id]));
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/other.txt`), 'o2');
});
