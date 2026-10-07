import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, ok, OUT_OF_ORDER, sh, singleRepoProject, state, toAccepted, wf } from './helpers.mjs';
import { accepted, brokenAdapter, ledger, multiRepo, pushFix, repin, steps } from './adapter-fault-fixtures.mjs';

// I-22: adapter-fault recovery for the remaining shapes of attempt: several repos with the unchanged one recorded as
// skipped, the quick lane and a batch (the rest, and what I-20 and I-21 are, in adapter-fault.test.mjs).

test('I-22: several repos, the unchanged one recorded as skipped before the fault: abandon accepts it (nothing was pushed) and the re-pin also delivers', () => {
  const { base, root } = multiRepo('repin-skipped', brokenAdapter);
  const e = ok(wf(root, ['entry', '--item', 'ENG-95', '--owner', 'o', '--json'])).json();
  // Only web changes; api (first in the delivery order) is recorded as skipped, then web faults.
  accepted(root, base, e.id, [[e.repos.web.worktree, { 'src/w.txt': 'web\n' }]]);
  assert.match(wf(root, ['deliver', '--attempt', e.id]).err, /web: the delivery adapter reported an unknown state "merged"/);
  assert.equal(state(root, e.id).delivery.repos.api.skipped, 'no changes');
  const tip = pushFix(path.join(root, 'api'));
  const s = repin(root, e.id, tip, { delivered: 'api skipped \\(no changes\\)', left: 'web' });
  assert.ok(s.delivery.completedAt);
  assert.equal(sh(base, `git --git-dir=${path.join(root, 'web')}.origin.git show main:src/w.txt`), 'web');
  // The other recovery for this case: abandon is accepted when every recorded repo was skipped.
  const p2 = multiRepo('abandon-skipped', brokenAdapter);
  const e2 = ok(wf(p2.root, ['entry', '--item', 'ENG-96', '--owner', 'o', '--json'])).json();
  accepted(p2.root, p2.base, e2.id, [[e2.repos.web.worktree, { 'src/w.txt': 'web\n' }]]);
  assert.notEqual(wf(p2.root, ['deliver', '--attempt', e2.id]).code, 0);
  // The adapter reported an integration it may still land: the owner closes it there and acknowledges that state.
  const open = wf(p2.root, ['abandon', '--reason', 'broken adapter', '--attempt', e2.id]);
  assert.equal(open.code, 75);
  assert.match(open.err, /not abandoned: the delivery adapter last reported web merged \(https:\/\/git\.example\.test\/mr\/x\); that integration can still land[\s\S]*--acknowledge-integration web:merged/);
  assert.equal(wf(p2.root, ['abandon', '--reason', 'broken adapter', '--acknowledge-integration', 'web:awaiting-merge', '--attempt', e2.id]).code, 75, 'another state is not acknowledged');
  ok(wf(p2.root, ['abandon', '--reason', 'broken adapter', '--acknowledge-integration', 'web:merged', '--attempt', e2.id]));
  assert.equal(state(p2.root, e2.id).phase, 'abandoned');
  assert.deepEqual(ledger(p2.root, e2.id).find((x) => x.type === 'abandoned').data.skipped, ['api']);
  assert.deepEqual(ledger(p2.root, e2.id).find((x) => x.type === 'abandoned').data.integrationsClosed, ['web:merged']);
});

test('I-22: quick lane: a broken adapter refuses; the re-pin delivers', () => {
  const { base, root, remote } = singleRepoProject('repin-quick', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': brokenAdapter });
  const e = ok(wf(root, ['entry', '--owner', 'o', '--json'])).json();
  assert.equal(e.lane, 'quick');
  accepted(root, base, e.id, [[e.repos.app.worktree, { 'src/a.txt': 'quick\n' }]], { planner: false });
  assert.match(wf(root, ['deliver', '--attempt', e.id]).err, /reported an unknown state "merged"/);
  const tip = pushFix(root);
  const moved = `${remote}.moved`;
  const s = repin(root, e.id, tip, { left: 'app', failFirst: () => (fs.renameSync(remote, moved), () => fs.renameSync(moved, remote)) });
  assert.ok(s.delivery.completedAt);
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'quick');
});

test('I-22: batch: a broken adapter refuses the batch; members cannot re-pin; the batch re-pin delivers every member', () => {
  const heavy = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'true', tier: 'heavy' }];
  const { base, root, remote } = singleRepoProject('repin-batch', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps: heavy } }, { '.workflow/delivery/mr.mjs': brokenAdapter, 'src/b.txt': 'b\n' });
  const m1 = toAccepted(root, base, { item: 'ENG-97', change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] });
  const m2 = toAccepted(root, base, { item: 'ENG-98', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', b.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb', '--attempt', b.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'rb', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [] }), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id]));
  assert.match(wf(root, ['deliver', '--attempt', b.id]).err, /reported an unknown state "merged"/);
  const tip = pushFix(root);
  assert.match(wf(root, ['deliver', '--attempt', m1.id, '--repin-adapter', tip.slice(0, 12), '--reason', 'x']).err, /is a member of BATCH-1; deliver the batch instead/);
  const s = repin(root, b.id, tip, { left: 'app' });
  assert.ok(s.delivery.completedAt);
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'one');
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/b.txt`), 'two');
  for (const m of [m1.id, m2.id]) assert.equal(state(root, m).phase, 'done');
});
