import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, sh, singleRepoProject, state, toAccepted, wf } from './helpers.mjs';
import { accepted, brokenAdapter, fixedAdapter, followFix, multiRepo, observedCalls, pushFix, repin, scriptedAdapter, steps } from './adapter-fault-fixtures.mjs';
import { yaml } from './helpers.mjs';

// I-20, I-21, I-22: what `wf deliver` does when a delivery adapter faults, for every shape of attempt.
// - I-20: an adapter that pushed straight to the target branch and then reports anything but `integrated` is asked again
//   on the next `wf deliver`; a non-integrated state after the merge is shown and counts only once the owner acknowledges
//   that repo and that state; the state is recorded with the delivery and printed in its output.
// - I-21: the fixed adapter, committed and pushed on the base branch, reaches the attempt: since 0.7.30 (I-151, D60) the attempt
//   follows its base branch's adapter by itself (never the working tree or an unpushed commit). `wf deliver --repin-adapter
//   <commit> --reason` stays for a delivery that started under one adapter kind while the base branch now names another,
//   after the owner saw what changes; recorded with the old and new pin.
// - I-22: the recovery is proven for a single repo, a merged base, several repos with one delivered or skipped, the quick
//   lane and a batch; `wf abandon` names the case.
// The skipped repo, the quick lane and the batch are in adapter-fault-shapes.test.mjs; fixtures in adapter-fault-fixtures.mjs.

test('I-20: an adapter that merged and then reports ci-failed is asked again on retry; the owner acknowledges that repo and state; it is recorded and shown', () => {
  const { base, root, remote } = singleRepoProject('post-merge', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': scriptedAdapter });
  fs.writeFileSync(path.join(base, 'observe.state'), 'ci-failed');
  const { id } = toAccepted(root, base, { item: 'ENG-90' });
  const r1 = wf(root, ['deliver', '--attempt', id]);
  assert.equal(r1.code, 75, r1.err);
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b', 'the adapter pushed to the target branch');
  assert.match(r1.err, /not delivered: app: [0-9a-f]{10} is already on origin\/main, but the delivery adapter reports ci-failed after the merge \(https:\/\/git\.example\.test\/mr\/app\): pipeline 9; being on the target branch alone does not count as a clean delivery/);
  assert.match(r1.err, /`wf deliver --acknowledge-adapter-state app:ci-failed`/);
  assert.equal(state(root, id).delivery.integrating.app.observed.state, 'ci-failed', 'the last adapter-reported state is recorded');
  // The retry no longer counts git ancestry alone: the adapter is asked again, and the same refusal stands.
  const calls = observedCalls(root);
  const r2 = wf(root, ['deliver', '--attempt', id]);
  assert.equal(r2.code, 75);
  assert.match(r2.err, /reports ci-failed after the merge/);
  assert.equal(observedCalls(root), calls + 1, 'observe was called again on the retry');
  assert.deepEqual(state(root, id).delivery.repos, {}, 'nothing recorded as delivered');
  // An acknowledgement of another state does not count.
  assert.match(wf(root, ['deliver', '--attempt', id, '--acknowledge-adapter-state', 'app:rejected']).err, /reports ci-failed after the merge/);
  const d = ok(wf(root, ['deliver', '--attempt', id, '--acknowledge-adapter-state', 'app:ci-failed']));
  assert.match(d.out, /app@[0-9a-f]{10} \[adapter: ci-failed\]/);
  assert.match(d.out, /not a clean adapter delivery \(show this to the owner\):\n  app: on origin\/main while the delivery adapter reported ci-failed \(pipeline 9\); acknowledged by the owner as app:ci-failed/);
  const rec = state(root, id).delivery.repos.app;
  assert.equal(rec.recovered, true);
  assert.equal(rec.adapterState, 'ci-failed');
  assert.equal(rec.acknowledged, 'app:ci-failed');
});

test('I-20: a pending state after the merge waits and says the change is on the target; once the adapter reports integrated it delivers with no acknowledgement', () => {
  const { base, root } = singleRepoProject('post-merge-pending', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': scriptedAdapter });
  fs.writeFileSync(path.join(base, 'observe.state'), 'ci-running');
  const { id } = toAccepted(root, base, { item: 'ENG-91' });
  assert.match(ok(wf(root, ['deliver', '--attempt', id])).out, /app: ci-running \(https:\/\/git\.example\.test\/mr\/app\)\. Run `wf deliver` again/);
  const w = ok(wf(root, ['deliver', '--attempt', id]));
  assert.match(w.out, /app: ci-running \(https:\/\/git\.example\.test\/mr\/app\); the change is already on origin\/main\. Run `wf deliver` again once it is merged\./);
  fs.writeFileSync(path.join(base, 'observe.state'), 'integrated');
  const d = ok(wf(root, ['deliver', '--attempt', id]));
  assert.doesNotMatch(d.out, /not a clean adapter delivery/);
  const rec = state(root, id).delivery.repos.app;
  assert.equal(rec.adapterState, 'integrated');
  assert.equal(rec.recovered, true);
  assert.equal(rec.acknowledged, undefined);
});

test('I-22: an adapter fault after the change merged into the base (no state, or an undocumented one): the owner acknowledges it', () => {
  const { base, root, remote } = singleRepoProject('post-merge-fault', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': scriptedAdapter });
  fs.writeFileSync(path.join(base, 'observe.state'), '(none)');
  const { id } = toAccepted(root, base, { item: 'ENG-92' });
  const r = wf(root, ['deliver', '--attempt', id]);
  assert.match(r.err, /is already on origin\/main, but the delivery adapter reports no state after the merge/);
  assert.match(r.err, /`wf deliver --acknowledge-adapter-state app:none`/);
  assert.match(r.err, /An adapter that reports a wrong state is fixed, committed and pushed on the base branch; the attempt follows its base branch's adapter, so the next `wf deliver` asks the fixed one/);
  fs.writeFileSync(path.join(base, 'observe.state'), 'merged');
  assert.match(wf(root, ['deliver', '--attempt', id, '--acknowledge-adapter-state', 'app:none']).err, /reports an unknown state "merged" after the merge/);
  ok(wf(root, ['deliver', '--attempt', id, '--acknowledge-adapter-state', 'app:merged']));
  assert.equal(state(root, id).delivery.repos.app.adapterState, 'merged');
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
});

test('I-21/I-22: a broken adapter, single repo after `wf base merge`: a fix only in the working tree, only committed locally or on a rewritten base does not count; the pushed fix is taken by the next deliver', () => {
  const { base, root, remote } = singleRepoProject('repin-single', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': brokenAdapter, 'src/other.txt': 'o\n' });
  const e = ok(wf(root, ['entry', '--item', 'ENG-93', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  sh(root, "printf 'o2\\n' > src/other.txt && git commit -qam 'unrelated base change' && git push -q origin main");
  ok(wf(root, ['base', 'merge', '--attempt', e.id]));
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  assert.match(wf(root, ['deliver', '--attempt', e.id]).err, /reported an unknown state "merged"[\s\S]*commit and push the fixed adapter on the base branch, then `wf deliver` again asks the fixed one/);
  // The trust rule: the working tree's adapter, a commit not on the remote base branch and a rewritten base are never read.
  fs.writeFileSync(path.join(root, '.workflow', 'delivery', 'mr.mjs'), fixedAdapter);
  assert.match(wf(root, ['deliver', '--attempt', e.id]).err, /reported an unknown state "merged"/);
  sh(root, 'git add -A && git commit -qm "fix, not pushed"');
  assert.match(wf(root, ['deliver', '--attempt', e.id]).err, /reported an unknown state "merged"/);
  assert.equal(state(root, e.id).adapterPin, null);
  sh(root, 'git checkout -q --orphan rewritten && git commit -qm rewritten && git push -q -f origin rewritten:main && git checkout -q main');
  assert.match(ok(wf(root, ['status', '--attempt', e.id])).out, /adapter: origin\/main \([0-9a-f]{10}\) is not taken: origin\/main \([0-9a-f]{10}\) does not contain the pin [0-9a-f]{10}: the adapter is followed only forward along the base branch/);
  assert.equal(state(root, e.id).adapterPin, null);
  sh(root, 'git push -q -f origin main');
  const tip = sh(root, 'git rev-parse HEAD');
  const s = followFix(root, e.id, tip);
  assert.ok(s.delivery.completedAt);
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/other.txt`), 'o2');
});
test('I-21/I-22: several repos, one delivered, then the adapter faults: abandon names the case; when the base branch now names another delivery kind the delivery keeps its own, and the re-pin delivers the rest', () => {
  const { base, root } = multiRepo('repin-multi', scriptedAdapter);
  // api (delivered first) is pushed and integrated; web is not pushed and the adapter reports an undocumented state.
  fs.writeFileSync(path.join(base, 'push.web'), 'no');
  fs.writeFileSync(path.join(base, 'observe.web.state'), 'merged');
  const e = ok(wf(root, ['entry', '--item', 'ENG-94', '--owner', 'o', '--json'])).json();
  accepted(root, base, e.id, [[e.repos.api.worktree, { 'src/a.txt': 'api\n' }], [e.repos.web.worktree, { 'src/w.txt': 'web\n' }]]);
  const r = wf(root, ['deliver', '--attempt', e.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /not delivered: web: the delivery adapter reported an unknown state "merged"/);
  assert.equal(state(root, e.id).delivery.repos.api.adapterState, 'integrated');
  const a = wf(root, ['abandon', '--reason', 'x', '--attempt', e.id]);
  assert.equal(a.code, 75);
  assert.match(a.err, /ENG-94\.1 is partly delivered: api delivered \([0-9a-f]{10} on origin\/main\); a delivered repo cannot be taken back/);
  assert.match(a.err, /commit and push the fixed adapter on the base branch: the attempt follows it, and the next `wf deliver` delivers the rest/);
  // The project moves its delivery to push-main meanwhile: the attempt takes the rest of the adapter, and its delivery, started
  // under the merge-request adapter, keeps that one (a different module would not know the integration in flight).
  const api = path.join(root, 'api');
  sh(api, 'git checkout -q main && git pull -q --ff-only origin main');
  const cfg = JSON.parse(fs.readFileSync(path.join(api, '.workflow', 'project.yaml'), 'utf8'));
  fs.writeFileSync(path.join(api, '.workflow', 'project.yaml'), yaml({ ...cfg, delivery: { kind: 'push-main' } }));
  sh(api, 'git commit -qam "deliver by push" && git push -q origin main');
  const tip = sh(api, 'git rev-parse HEAD');
  const kept = wf(root, ['deliver', '--attempt', e.id]);
  assert.match(kept.err, /web: the delivery adapter reported an unknown state "merged"[\s\S]*this delivery started under the adapter committed at [0-9a-f]{10} and keeps it, because the base branch now names another delivery adapter kind; `wf deliver --repin-adapter --reason "<why>"`/);
  assert.equal(state(root, e.id).adapterPin, tip);
  const s = repin(root, e.id, tip, { delivered: 'api delivered [0-9a-f]{10}', left: 'web', kinds: ['./delivery/mr.mjs', 'push-main'], files: '\\.workflow/project\\.yaml' });
  assert.ok(s.delivery.completedAt);
  assert.equal(sh(base, `git --git-dir=${path.join(root, 'web')}.origin.git show main:src/w.txt`), 'web');
  assert.equal(s.delivery.repos.api.adapterState, 'integrated', 'the repo delivered before the re-pin keeps its record');
});
