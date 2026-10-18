import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readLedger, reduce } from '../engine/ledger.mjs';
import { OUT_OF_ORDER, closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, toAccepted, wf } from './helpers.mjs';
import { runner } from './strategist-fixtures.mjs';
import { TS, connector, deliver, dep, mergeAdapter, project, resume, routes, statusOf, statuses, steps, ticket } from './deployment-fixtures.mjs';

// 0.7.27 (I-196, D42): the deployment confirmation (deployment-fixtures.mjs says why): through a connector, with a recorded
// reason the fix could not be tested; the delivery adapter's own check; an attempt admitted before this release; a project that
// does not opt in, and doctor on a status set with no step or a step with no status.

test('0.7.27 (I-196): tested where possible: a recorded reason it could not be tested goes on the ticket, and the deployed readback is judged like every step', () => {
  const c = connector('deploy-connector');
  const a = c.run('ENG-50', ['Hotfix']);
  // The delivered readback, at the routed status: the delivery then waits for the deployment.
  ok(c.post(a, 'delivered', 'ENG-50', 'In progress', c.delivered(a.id), ['Hotfix']));
  assert.equal(state(c.root, a.id).phase, 'handoff-pending');
  ok(wf(c.root, ['deployment', 'record', '--state', 'deployed', '--observed', 'the running version is the merge commit', '--attempt', a.id]));
  // A failed test keeps it open with nothing queued, and says what is next; a later test is recorded over it.
  ok(wf(c.root, ['deployment', 'tested', '--failed', 'the totals page still shows the old total for an account with refunds', '--attempt', a.id]));
  assert.match(resume(c, a.id), /The fix failed when tested in production: "the totals page still shows the old total for an account with refunds"\. Tell the person what you saw; nothing is set\. .*`wf deployment close --reason "<why>"` asks the person to close this delivery without the confirmation, then `wf reopen --item ENG-50/);
  assert.ok(!state(c.root, a.id).tracker.pending.some((x) => x.event === 'deployed'), 'nothing is queued after a failed test');
  // The line goes on the ticket: internals are refused, in product words it is recorded.
  const internal = wf(c.root, ['deployment', 'tested', '--not-possible', 'needs data from 4f3c2a1b9e8d7c6b', '--attempt', a.id]);
  assert.equal(internal.code, 75);
  assert.match(internal.err, /the line goes on the ticket and carries internals \(commit hash\)/);
  const why = 'The fix shows only on a customer\'s own invoices, which support can open and this session cannot';
  const t = ok(wf(c.root, ['deployment', 'tested', '--not-possible', why, '--attempt', a.id]));
  const body = `ENG-50 is live in production.\n\nNot tested in production: ${why}\n`;
  assert.ok(t.out.includes(`tracker (deployed): post this comment unchanged:\n${body.trimEnd().replace(/^(?=.)/gm, '    ')}\n  then set status to "Done"`), t.out);
  const pending = state(c.root, a.id).tracker.pending.filter((x) => x.event === 'deployed');
  assert.deepEqual(pending.map((x) => [x.op, x.status ?? x.body ?? null]), [['comment', body], ['setStatus', 'Done'], ['readback', null]]);
  // 0.7.31 (I-215, D68): the Linear adapter's own words for each step come first, then the workflow's.
  assert.match(resume(c, a.id), /tracker \(deployed\): through the connector: your tracker adapter's own instructions for these steps, verbatim [^\n]*comment: "Linear save_comment with the body `wf` gives for this step [^\n]*\. The workflow's wording: post the comment `wf status --json` shows under tracker\.pending \(its `body`\) unchanged, set status to "Done"/);
  // Idempotent: the settled step is not recorded again, nor closed without, while its tracker step waits.
  assert.match(wf(c.root, ['deployment', 'tested', '--observed', 'again', '--attempt', a.id]).err, /deployment step is already settled \(confirmed, and the fix not testable there\)/);
  assert.match(wf(c.root, ['deployment', 'close', '--reason', 'x', '--attempt', a.id]).err, /already settled/);
  // The readback is judged as every step's: the status asked for, and the comment as rendered.
  const wrong = c.post(a, 'deployed', 'ENG-50', 'In UAT', body, ['Hotfix']);
  assert.equal(wrong.code, 75);
  assert.match(wrong.err, /status is `In UAT`, expected `Done`/);
  const other = c.post(a, 'deployed', 'ENG-50', 'Done', 'ENG-50 is done.\n', ['Hotfix']);
  assert.equal(other.code, 75);
  assert.match(other.err, /the comment is not the one `wf` rendered for `deployed` \(first missing line: "ENG-50 is live in production\."\)/);
  // A hold stops the end of the delivery here too.
  ok(wf(c.root, ['hold', '--reason', 'hold it', '--attempt', a.id]));
  assert.match(c.post(a, 'deployed', 'ENG-50', 'Done', body, ['Hotfix']).err, /the ticket's last delivery step waits: ENG-50\.\d+ is on hold \("hold it"\)/);
  ok(wf(c.root, ['release', '--attempt', a.id]));
  ok(c.post(a, 'deployed', 'ENG-50', 'Done', body, ['Hotfix']));
  const s = state(c.root, a.id);
  assert.equal(s.phase, 'done');
  assert.equal(s.deployment.tested.result, 'not-possible');
  assert.match(readLedger(c.root, a.id).find((e) => e.type === 'closed').data.reason, /the fix not testable there \(reason recorded\); tracker handoff verified/);
  assert.equal(readLedger(c.root, a.id).filter((e) => e.type === 'tracker.pending' && e.data.event === 'deployed').length, 1, 'the deployed step was queued once');
});

test('0.7.27 (I-196): a delivery adapter\'s own deployment check decides; the status at the new step is routed by label like any step', () => {
  const p = project('deploy-adapter', {
    delivery: { kind: './delivery/mr.mjs' },
    tracker: { statuses: { ...statuses, deployed: 'Released' }, statusByLabel: { ...routes, deployed: { 'Hotfix': 'Done' } } },
    files: { '.workflow/delivery/mr.mjs': mergeAdapter },
  });
  assert.match(ok(wf(p.root, ['doctor', '--no-steps'])).out, /deployment after the merge\n {4}the delivery of a ticket labelled "Hotfix" waits after the merge until the merged change is confirmed running in production \(the delivery adapter's own `deployment` check decides\) and the fix is tested there where possible \(or why not is recorded\); then the tracker step `deployed`: a comment, and the status "Released" \("Done" for a ticket labelled "Hotfix"\)/);
  const { id } = toAccepted(p.root, p.base, { item: 'ENG-500' });
  deliver(p, id);
  assert.equal(state(p.root, id).deployment.owed.check, 'adapter');
  assert.match(resume(p, id), /`wf deployment check` asks the delivery adapter \(read-only\) whether the merged change runs in production/);
  // The adapter's answer decides, not an observation.
  const mine = dep(p, id, ['record', '--state', 'deployed', '--observed', 'looks deployed']);
  assert.equal(mine.code, 75);
  assert.match(mine.err, /delivery adapter checks the deployment itself: its answer decides, not an observation/);
  assert.match(ok(dep(p, id, ['check'])).out, /deployment in production NOT confirmed: deploying \(the delivery adapter's check: app: deploying \(rollout: 1 of 3 replicas updated\)\)/);
  const running = path.join(p.root, '..', 'running.json');
  fs.writeFileSync(running, JSON.stringify({ commit: '0'.repeat(40) }));
  assert.match(ok(dep(p, id, ['check'])).out, /NOT confirmed: failed \(the delivery adapter's check: app: failed \(the replicas run another version\)\)/);
  assert.equal(dep(p, id, ['tested', '--observed', 'x']).code, 75);
  fs.writeFileSync(running, JSON.stringify({ commit: state(p.root, id).delivery.repos.app.commit }));
  assert.match(ok(dep(p, id, ['check'])).out, /deployment in production confirmed \(the delivery adapter's check: app: deployed \(3 of 3 replicas run the merged version\)\)/);
  ok(dep(p, id, ['tested', '--observed', 'The totals page shows the corrected total for an account with refunds']));
  assert.equal(statusOf(p.root, 'ENG-500'), 'Done', 'the ticket\'s label routes the new step');
  assert.deepEqual(readLedger(p.root, id).find((e) => e.type === 'tracker.recorded' && e.data.event === 'deployed').data.routed, [{ step: 'deployed', label: 'Hotfix', status: 'Done', default: 'Released' }]);
  assert.equal(state(p.root, id).phase, 'done');
});

test('0.7.27 (I-196): an attempt admitted before this release keeps the delivery it started with, and its ledger replays', () => {
  const p = project('deploy-old');
  // Admitted under 0.7.26 and delivered by this engine: no deployment step (D7), the attempt closes at its tracker handoff.
  const old = runner('0.7.26');
  const e = ok(old.run(p.root, ['entry', '--item', 'ENG-500', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'fix\n' });
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r')), '--attempt', e.id]));
  ok(wf(p.root, ['gate', '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', e.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r2')), '--attempt', e.id]));
  ok(wf(p.root, ['accept', '--attempt', e.id]));
  const d = deliver(p, e.id);
  assert.match(d.out, /attempt closed/);
  const s = state(p.root, e.id);
  assert.equal(s.engineVersion, '0.7.26');
  assert.equal(s.phase, 'done');
  assert.equal(s.deployment, null);
  // The ledger an older release wrote folds as it did: no deployment entry, closed at its tracker handoff.
  const folded = reduce(readLedger(p.root, e.id));
  assert.deepEqual([folded.phase, folded.deployment, folded.closedAt !== null], ['done', null, true]);
  assert.match(ok(wf(p.root, ['status', '--attempt', e.id])).out, /next: nothing: this attempt is closed/);
});

test('0.7.27 (I-196): a project that does not opt in delivers as before; doctor names a status set with no step and a step with no status', () => {
  // No `delivery.deployment` and no `deployed` status: a labelled ticket's delivery ends at its tracker handoff, as before.
  const p = project('deploy-none', { deployment: null, tracker: { statuses: { started: 'In progress', delivered: 'In UAT', done: 'Done' }, statusByLabel: {} } });
  const doctor = ok(wf(p.root, ['doctor', '--no-steps'])).out;
  assert.doesNotMatch(doctor, /deployment/);
  const { id } = toAccepted(p.root, p.base, { item: 'ENG-500' });
  deliver(p, id);
  assert.equal(statusOf(p.root, 'ENG-500'), 'In UAT');
  const s = state(p.root, id);
  assert.deepEqual([s.phase, s.deployment], ['done', null]);
  assert.equal(readLedger(p.root, id).find((e) => e.type === 'closed').data.reason, 'tracker handoff verified');
  // A status set at the end of a step that never runs, and the reverse, fail doctor.
  const failing = (name, config, re) => {
    const { root } = singleRepoProject(name, { gate: { steps }, ...config });
    const r = wf(root, ['doctor', '--no-steps']);
    assert.equal(r.code, 1, `${name}: ${r.out}`);
    assert.match(r.out, re, name);
  };
  failing('deploy-status-only', { tracker: { kind: 'files', statuses, statusByLabel: { deployed: { 'Hotfix': 'Done' } } } }, /✗ config: deployment step — a status is set when the deployment is confirmed \(`tracker\.statuses\.deployed`: "Done"; `tracker\.statusByLabel\.deployed`: "Done" for "Hotfix"\), but no delivery waits for the deployment \(`delivery\.deployment`\), so it is never set/);
  // A step with no status at its end is a valid comment-only setup: doctor says what will happen, and passes.
  const { root: commentOnly } = singleRepoProject('deploy-step-only', { gate: { steps }, tracker: { kind: 'files', statuses: { started: 'In progress', delivered: 'In UAT', done: 'Done' } }, delivery: { kind: 'push-main', deployment: TS } });
  const warned = ok(wf(commentOnly, ['doctor', '--no-steps'])).out;
  assert.match(warned, /! warning: deployment step — the delivery waits for the deployment \(`delivery\.deployment`\), and no status is set when it is confirmed \(`tracker\.statuses\.deployed`\): once it is confirmed and the fix tested, the ticket gets the comment and stays at the status its delivery set/);
  assert.match(warned, /doctor: all checks passed/);
  // A shape that would wait for the wrong tickets is refused when the adapter is read.
  const refused = (name, config, re) => {
    const { root } = singleRepoProject(name, { gate: { steps }, ...config });
    const r = wf(root, ['doctor', '--no-steps']);
    assert.notEqual(r.code, 0, name);
    assert.match(`${r.out}${r.err}`, re, name);
  };
  refused('deploy-typo', { tracker: { kind: 'files', statuses }, delivery: { kind: 'push-main', deployment: { label: 'Hotfix' } } }, /`delivery\.deployment\.label` is unknown \(known: labels, where\)/);
  refused('deploy-no-tracker', { delivery: { kind: 'push-main', deployment: TS } }, /`delivery\.deployment\.labels` needs a tracker/);
  refused('deploy-empty', { tracker: { kind: 'files', statuses }, delivery: { kind: 'push-main', deployment: { labels: [] } } }, /`delivery\.deployment\.labels` lists the ticket labels whose delivery waits for the deployment/);
  refused('deploy-shape', { tracker: { kind: 'files', statuses }, delivery: { kind: 'push-main', deployment: true } }, /`delivery\.deployment` says the delivery waits after the merge for the deployment to be confirmed/);
});

// Review of 0.7.27, named failure: a batch member's own ledger records no delivered repo (the commits are delivered and recorded
// by its batch), so the check ran over no repo and an empty list confirmed the deployment without asking the adapter. The
// member's delivered repos are resolved through its batch, as its screenshots are, and an empty set is never "deployed".
test('0.7.27 (I-196): a batch member\'s deployment is checked against the commits its batch delivered', () => {
  const heavy = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'true', tier: 'heavy' }];
  const { base, root } = singleRepoProject('deploy-batch', {
    // At the merge the hotfix shows "Merged" (a status its admission did not have, so its readback differs from the admission one).
    tracker: { kind: 'files', statuses, statusByLabel: { delivered: { Hotfix: 'Merged' } } },
    delivery: { kind: './delivery/mr.mjs', deployment: TS },
    gate: { steps: heavy },
  }, { '.workflow/delivery/mr.mjs': mergeAdapter, 'tickets/ENG-500.md': ticket('ENG-500', ['Hotfix']), 'tickets/ENG-502.md': ticket('ENG-502', ['Hotfix']), 'src/b.txt': 'b\n' });
  const m1 = toAccepted(root, base, { item: 'ENG-500', change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] });
  const m2 = toAccepted(root, base, { item: 'ENG-502', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', b.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb', '--attempt', b.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'rb', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [] }), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id]));
  ok(wf(root, ['deliver', '--attempt', b.id]));
  ok(wf(root, ['tracker', 'sync', '--attempt', m1.id]));
  const batchCommit = state(root, b.id).delivery.repos.app.commit;
  assert.deepEqual(state(root, m1.id).deployment.owed.commits, { app: batchCommit }, 'the member waits on the commit its batch delivered');
  // The adapter is asked about that commit: still rolling out, then the merged version.
  const p = { root };
  assert.match(ok(dep(p, m1.id, ['check'])).out, /NOT confirmed: deploying \(the delivery adapter's check: app: deploying \(rollout: 1 of 3 replicas updated\)\)/);
  fs.writeFileSync(path.join(root, '..', 'running.json'), JSON.stringify({ commit: batchCommit }));
  assert.match(ok(dep(p, m1.id, ['check'])).out, /deployment in production confirmed \(the delivery adapter's check: app: deployed \(3 of 3 replicas run the merged version\)\)/);
  ok(dep(p, m1.id, ['tested', '--observed', 'The totals page shows the corrected total']));
  assert.equal(statusOf(root, 'ENG-500'), 'Done');
  assert.equal(state(root, m1.id).phase, 'done');
});
