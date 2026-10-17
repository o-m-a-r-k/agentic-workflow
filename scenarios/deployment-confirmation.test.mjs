import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLedger } from '../engine/ledger.mjs';
import { ok, singleRepoProject, state, toAccepted, wf } from './helpers.mjs';
import { deliver, dep, project, resume, statusOf, steps, ticketFile, types } from './deployment-fixtures.mjs';

// 0.7.27 (I-196, D42): the deployment confirmation a project's delivery waits for after the merge (deployment-fixtures.mjs says
// why): a labelled ticket waits and goes to Done once the deployment is confirmed and the fix tested, an unlabelled one goes to
// UAT and closes as before, a deployment not confirmed keeps the attempt open, and a project may make every ticket wait.

test('0.7.27 (I-196): a labelled ticket waits after the merge, the deployment and the test are recorded through wf, and only then it goes to Done', () => {
  const p = project('deploy-ts');
  const { id } = toAccepted(p.root, p.base, { item: 'ENG-500' });
  const d = deliver(p, id);
  assert.match(d.out, /tracker: delivered performed on the ticket files and read back/);
  assert.doesNotMatch(d.out, /attempt closed/);
  assert.equal(statusOf(p.root, 'ENG-500'), 'In progress', 'routed away from UAT at the merge');
  let s = state(p.root, id);
  assert.equal(s.phase, 'handoff-pending', 'the delivery waits for the deployment');
  assert.deepEqual({ ...s.deployment.owed, at: undefined }, { where: 'production', label: 'Hotfix', check: 'agent', at: undefined });
  assert.match(d.out, /next: ENG-500 carries "Hotfix": its delivery ends once the merged change runs in production and the fix is tested there\. Confirm that the merged change runs in production \(the running version against the merged commit, the rollout finished\), read-only: nothing in production is changed \(no redeploy, restart, data change or setting\) without the person's authority under the project's rules, and record what you saw/);
  assert.match(d.out, /`wf deployment record --state deployed --observed "<what you saw>"`/);
  assert.match(d.out, /`wf deployment close --reason "<why>"` asks them whether the delivery closes without it/);
  // The fix is tested where the merged change runs: not before the deployment is confirmed.
  const early = dep(p, id, ['tested', '--observed', 'Opened the totals page']);
  assert.equal(early.code, 75, early.err);
  assert.match(early.err, /the deployment in production is not confirmed yet: the fix is tested where the merged change runs/);
  // Still rolling out: recorded, nothing is set, and the next step says so.
  ok(dep(p, id, ['record', '--state', 'deploying', '--observed', 'the rollout shows 1 of 3 replicas on the new version']));
  assert.match(resume(p, id), /Not confirmed: it is still rolling out \(your observation, \S+: the rollout shows 1 of 3 replicas on the new version\): check again once the rollout is through; nothing is set until it is confirmed/);
  assert.match(ok(wf(p.root, ['status', '--attempt', id])).out, /deployment in production \(the ticket's label "Hotfix"; the agent's observation\): not confirmed: deploying/);
  assert.equal(statusOf(p.root, 'ENG-500'), 'In progress');
  // Confirmed, with what the agent saw; then the test is the next step.
  ok(dep(p, id, ['record', '--state', 'deployed', '--observed', 'the running version is the merge commit; 3 of 3 replicas ready']));
  const next = resume(p, id);
  assert.match(next, /The deployment is confirmed \(your observation: the running version is the merge commit; 3 of 3 replicas ready\)\. Test the fix in production where possible/);
  assert.match(next, /`wf deployment tested --observed "<what you tested and saw>"`; when it cannot be tested there, `wf deployment tested --not-possible "<why>"`/);
  assert.equal(statusOf(p.root, 'ENG-500'), 'In progress', 'confirmed, not yet tested: nothing is set');
  // Tested: the deployed step runs (the comment, then the status), is read back, and the attempt closes.
  const t = ok(dep(p, id, ['tested', '--observed', 'Opened the totals page for an account with refunds: the total now matches the invoices']));
  assert.match(t.out, /tracker: deployed performed on the ticket files and read back; attempt closed/);
  assert.equal(statusOf(p.root, 'ENG-500'), 'Done');
  assert.match(ticketFile(p.root, 'ENG-500'), /ENG-500 is live in production\.\n\nTested in production: Opened the totals page for an account with refunds: the total now matches the invoices/);
  s = state(p.root, id);
  assert.equal(s.phase, 'done');
  const order = types(p.root, id).filter((x) => x.startsWith('deployment.') || ['delivered', 'closed'].includes(x));
  assert.deepEqual(order, ['delivered', 'deployment.owed', 'deployment.observed', 'deployment.observed', 'deployment.tested', 'closed']);
  const log = readLedger(p.root, id);
  const at = (pred) => log.findIndex(pred);
  assert.ok(at((e) => e.type === 'deployment.tested') < at((e) => e.type === 'tracker.pending' && e.data.event === 'deployed'), 'the tracker step is queued only after the test is recorded');
  assert.ok(at((e) => e.type === 'tracker.recorded' && e.data.event === 'deployed') < at((e) => e.type === 'closed'), 'and read back before the attempt closes');
  assert.match(log.find((e) => e.type === 'closed').data.reason, /deployment confirmed in production and the fix tested there; tracker handoff verified/);
  // Idempotent: the settled step is not recorded again.
  assert.match(dep(p, id, ['tested', '--observed', 'again']).err, /is closed/);
});

test('0.7.27 (I-196): an unlabelled ticket of the same project goes to UAT at the merge and closes as before', () => {
  const p = project('deploy-plain');
  const { id } = toAccepted(p.root, p.base, { item: 'ENG-501' });
  const d = deliver(p, id);
  assert.match(d.out, /tracker: delivered performed on the ticket files and read back; attempt closed/);
  assert.equal(statusOf(p.root, 'ENG-501'), 'In UAT');
  const s = state(p.root, id);
  assert.equal(s.phase, 'done');
  assert.equal(s.deployment, null);
  assert.equal(readLedger(p.root, id).find((e) => e.type === 'closed').data.reason, 'tracker handoff verified');
  assert.ok(!types(p.root, id).some((x) => x.startsWith('deployment.')));
});

test('0.7.27 (I-196): a deployment not confirmed keeps the attempt open, says what is next and sets nothing; the person decides when it cannot be confirmed at all, and a hold stops it', () => {
  const p = project('deploy-unconfirmed');
  const { id } = toAccepted(p.root, p.base, { item: 'ENG-500' });
  deliver(p, id);
  // The person's hold stops the step.
  ok(wf(p.root, ['hold', '--reason', 'wait for the release window', '--attempt', id]));
  const held = dep(p, id, ['record', '--state', 'deployed', '--observed', 'it runs']);
  assert.equal(held.code, 75);
  assert.match(held.err, /delivery is on hold: "wait for the release window"; the deployment step waits/);
  assert.match(resume(p, id), /on hold: wait for the release window; only the owner lifts it\. Pending sequence after release: ENG-500 carries "Hotfix"/);
  ok(wf(p.root, ['release', '--attempt', id]));
  // A failed deployment: the attempt stays open, the next step says plainly what to do, the test is refused, nothing is set.
  ok(dep(p, id, ['record', '--state', 'failed', '--observed', 'the deploy job failed pulling the new image']));
  const failed = resume(p, id);
  assert.match(failed, /Not confirmed: the deployment failed \(your observation, \S+: the deploy job failed pulling the new image\): tell the person the merged change did not deploy to production: a redeploy, or a fix \(a new attempt of the ticket, once this delivery is closed\), is theirs to authorize; nothing is set until it is confirmed/);
  assert.equal(dep(p, id, ['tested', '--observed', 'x']).code, 75);
  // It cannot be seen from here.
  ok(dep(p, id, ['record', '--state', 'unknown', '--observed', 'the cluster is not reachable from this machine']));
  assert.match(resume(p, id), /tell the person it cannot be seen from here whether it runs in production: they may confirm it, give the access, or decide; nothing is set until it is confirmed/);
  assert.equal(statusOf(p.root, 'ENG-500'), 'In progress');
  assert.equal(state(p.root, id).phase, 'handoff-pending');
  // Closing without the confirmation is the person's decision: asked, and nothing closes while it is unanswered.
  const asked = dep(p, id, ['close', '--reason', 'no access to production from this machine'], { ownerSilent: true });
  assert.equal(asked.code, 75, asked.err);
  assert.match(asked.err, /closing ENG-500\.\d+'s delivery without a confirmed deployment is the owner's decision/);
  const question = state(p.root, id).decisions.at(-1);
  assert.match(question.plain, /^ENG-500's change is merged, but whether it runs in production cannot be seen from here\. Should its delivery be closed without that confirmation\? The ticket is not moved to its final status: it stays where the delivery put it\./);
  assert.equal(state(p.root, id).phase, 'handoff-pending');
  // The person says yes: the delivery closes, and the ticket is left where the delivery put it, never set to Done.
  const closed = ok(dep(p, id, ['close', '--reason', 'no access to production from this machine']));
  assert.match(closed.out, /delivery closed without a confirmed deployment \(A\d+, "no access to production from this machine"\); the ticket is not moved/);
  const s = state(p.root, id);
  assert.equal(s.phase, 'done');
  assert.equal(statusOf(p.root, 'ENG-500'), 'In progress');
  assert.match(readLedger(p.root, id).find((e) => e.type === 'closed').data.reason, /closed without a confirmed deployment \(the person's decision\)/);
  assert.ok(!s.tracker.done.some((x) => x.event === 'deployed'), 'no deployed step ran');
});

test('0.7.27 (I-196): without labels every ticket\'s delivery waits, with no tracker too', () => {
  const { base, root } = singleRepoProject('deploy-all', { delivery: { kind: 'push-main', deployment: { where: 'the staging site' } }, gate: { steps } });
  const { id } = toAccepted(root, base, { item: 'ENG-9' });
  ok(wf(root, ['deliver', '--attempt', id]));
  let s = state(root, id);
  assert.deepEqual([s.phase, s.deployment.owed.label, s.deployment.owed.where], ['handoff-pending', null, 'the staging site']);
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /this project's delivery ends once the merged change runs in the staging site and the fix is tested there/);
  ok(wf(root, ['deployment', 'record', '--state', 'deployed', '--observed', 'the site footer shows the new build', '--attempt', id]));
  const t = ok(wf(root, ['deployment', 'tested', '--observed', 'The home page shows the new text', '--attempt', id]));
  assert.match(t.out, /closed and worktrees removed/);
  s = state(root, id);
  assert.equal(s.phase, 'done');
  assert.match(readLedger(root, id).find((e) => e.type === 'closed').data.reason, /^deployment confirmed in the staging site and the fix tested there$/);
});
