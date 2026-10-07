// The order of work (I-27, I-23): code-review rounds run to clean with no gate, then ONE gate on the tree that passed
// review, then the evidence review (gate logs, screenshots) of the gated tree. Review and gate never run side by side.
// Every review round is a fresh reviewer.
import { afterEach, test } from 'node:test';
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

const handReviewer = (root, id, reviewer) => {
  const out = ok(wf(root, ['handoff', 'reviewer', '--agent', reviewer, '--attempt', id])).out.trim();
  assert.match(out, /^Read \S+ and follow its instructions\.$/, 'the start line is unchanged');
  return JSON.parse(fs.readFileSync(out.match(/^Read (\S+)/)[1], 'utf8'));
};
const review = (root, base, id, reviewer, extra) => {
  const bundle = handReviewer(root, id, reviewer);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure(reviewer, extra)), '--attempt', id]));
  return bundle;
};
const ledger = (root, id) => fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', id, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const spawnEnv = (root) => {
  const env = { ...process.env, WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), WF_HOME: path.join(root, '..', '.home') };
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
};
const until = async (cond) => {
  for (let i = 0; i < 150 && !cond(); i++) await new Promise((r) => setTimeout(r, 100));
  return cond();
};
// A gate that runs until the test drops the `go` file next to the project; a test that fails early still releases it.
const goFiles = [];
const go = (root) => fs.writeFileSync(path.join(root, '..', 'go'), '');
afterEach(() => {
  for (const f of goFiles.splice(0)) fs.writeFileSync(f, '');
});
const waiting = [{ id: 'slow', repo: 'app', run: 'echo report > out.txt; while [ ! -f "$WF_ROOT/../go" ]; do sleep 0.1; done' }];

test('happy path: code review to clean with no gate, then one gate, then the evidence review, then delivery', () => {
  const { base, root, remote } = singleRepoProject('order-happy', { gate: { steps } });
  const e = implemented(root, base, 'RO-1');
  assert.match(state(root, e.id).next, /^code review: hand to a fresh reviewer[\s\S]*no gate until a code-review round on this tree comes back clean/);
  ok(wf(root, ['gate', '--prepare-only', '--attempt', e.id]), 'a gate plan runs nothing and is never refused');
  const early = wf(root, ['gate', '--attempt', e.id]);
  assert.equal(early.code, 75, 'no gate before the code review');
  assert.match(early.err, /the gate runs after a clean code review[\s\S]*no review round covers the current tree[\s\S]*`wf gate --reason "<why>"`/);
  assert.equal(state(root, e.id).gates.length, 0);
  const code = handReviewer(root, e.id, 'r1');
  assert.equal(code.round, 'code-review');
  assert.equal(code.gate.passedOnThisTree, false, 'a code-review round never requires a gate');
  assert.deepEqual([code.gate.screenshots, code.gate.logs], [[], []]);
  assert.match(state(root, e.id).next, /^waiting for reviewer r1: `wf review --closure <its file>`; code review, no gate while it runs/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r1')), '--attempt', e.id]));
  assert.match(state(root, e.id).next, /^clean code review on this tree: run one `wf gate`[\s\S]*then the evidence review/);
  assert.match(wf(root, ['accept', '--attempt', e.id]).err, /gate: no gate has run; run `wf gate`/);
  ok(wf(root, ['gate', '--attempt', e.id]));
  assert.deepEqual(state(root, e.id).gateOverrides, [], 'a gate in order records no override');
  const pre = wf(root, ['accept', '--attempt', e.id]);
  assert.equal(pre.code, 75, 'the code-review closure has not seen the gate evidence');
  assert.match(pre.err, /written before a passing gate on this tree[\s\S]*wf handoff reviewer --agent <new id>/);
  assert.doesNotMatch(pre.err, /gate: /);
  assert.match(state(root, e.id).next, /^evidence review: the gate passed on the reviewed tree/);
  const evidence = handReviewer(root, e.id, 'r2');
  assert.equal(evidence.round, 'evidence-review', 'the evidence-review handoff is the one that bundles the gate evidence');
  assert.equal(evidence.gate.passedOnThisTree, true);
  assert.ok(evidence.gate.logs.length);
  assert.match(state(root, e.id).next, /^waiting for reviewer r2: [\s\S]*evidence review of the gated tree, no gate while it runs/);
  const during = wf(root, ['gate', '--attempt', e.id]);
  assert.equal(during.code, 75, 'no gate beside the evidence review either');
  assert.match(during.err, /reviewer r2 was handed this tree and has recorded no closure: review and gate never run side by side/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2')), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  ok(wf(root, ['deliver', '--attempt', e.id]));
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
});

test('a review round with open findings refuses the gate; --reason runs it and records the override in the ledger', () => {
  const { base, root } = singleRepoProject('order-open', { gate: { steps } });
  const e = implemented(root, base, 'RO-2');
  review(root, base, e.id, 'r1', { findings: [{ id: 'F1', severity: 'major', summary: 's', status: 'open', evidence: 'src/a.txt:1' }] });
  assert.match(state(root, e.id).next, /^fix the open findings \(F1\)[\s\S]*next code-review round[\s\S]*no gate until a code-review round on this tree comes back clean/);
  const r = wf(root, ['gate', '--attempt', e.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /the latest review round \(r1\) has open findings \(F1\)/);
  assert.equal(wf(root, ['gate', '--reason', '', '--attempt', e.id]).code, 75, 'an empty reason is no reason');
  ok(wf(root, ['gate', '--reason', 'owner: measure the e2e time before the fix', '--attempt', e.id]));
  const s = state(root, e.id);
  assert.equal(s.gates.length, 1);
  assert.equal(s.gateOverrides.length, 1);
  assert.equal(s.gateOverrides[0].reason, 'owner: measure the e2e time before the fix');
  assert.match(s.gateOverrides[0].problems[0], /open findings \(F1\)/);
  const event = ledger(root, e.id).find((x) => x.type === 'gate.override');
  assert.ok(event, 'the override is a ledger event');
  assert.ok(ledger(root, e.id).findIndex((x) => x.type === 'gate.override') < ledger(root, e.id).findIndex((x) => x.type === 'gate.started'), 'recorded before the gate starts');
});

test('each review round is a fresh reviewer; the gate waits until the earlier findings are verified', () => {
  const { base, root } = singleRepoProject('fresh-reviewer', { gate: { steps } });
  const e = implemented(root, base, 'RO-3');
  review(root, base, e.id, 'r1', { findings: [{ id: 'F1', severity: 'major', summary: 's', status: 'open', evidence: 'src/a.txt:1' }] });
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'fixed\n' });
  const again = wf(root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]);
  assert.equal(again.code, 75);
  assert.match(again.err, /start a fresh reviewer agent with a new id; each review round uses a new agent/);
  // r2's blind closure may not carry earlier findings; they are revealed only once it is recorded.
  handReviewer(root, e.id, 'r2');
  const peek = wf(root, ['review', '--closure', closureFile(base, goodClosure('r2', { priorFindings: [{ round: 'r1', id: 'F1', status: 'fixed', evidence: 'x' }] })), '--attempt', e.id]);
  assert.match(peek.err, /`priorFindings` are listed only after your own blind closure is recorded/);
  const blind = ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2')), '--attempt', e.id])).out;
  assert.match(blind, /1 finding\(s\) from earlier rounds to verify against the code: \S+prior-findings-\S+\.json/);
  const revealed = JSON.parse(fs.readFileSync(blind.match(/code: (\S+)/)[1], 'utf8')).findings;
  assert.deepEqual(revealed.map((f) => `${f.round}:${f.id}`), ['r1:F1']);
  assert.match(state(root, e.id).next, /reviewer r2 must verify 1 earlier-round finding[\s\S]*no gate until/);
  assert.match(wf(root, ['gate', '--attempt', e.id]).err, /the latest review round \(r2\) has not verified 1 earlier-round finding\(s\) \(r1:F1\)/);
  assert.match(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2', { findings: [{ id: 'N1', status: 'fixed', evidence: 'y' }], priorFindings: [] })), '--attempt', e.id]).err, /recorded blind and cannot change/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2', { priorFindings: [{ round: 'r1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:1 now fixed' }] })), '--attempt', e.id]));
  ok(wf(root, ['gate', '--attempt', e.id]), 'a clean round that verified F1 lets the gate run');
  assert.match(wf(root, ['accept', '--attempt', e.id]).err, /written before a passing gate on this tree/);
  review(root, base, e.id, 'r3');
  ok(wf(root, ['accept', '--attempt', e.id]), 'the evidence review needs no earlier finding verified again');
});

test('a tree change after a clean review refuses the gate until a review covers the new tree', () => {
  const { base, root } = singleRepoProject('tree-moved', { gate: { steps } });
  const e = implemented(root, base, 'RO-4');
  review(root, base, e.id, 'r1');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'unreviewed\n' });
  assert.match(wf(root, ['gate', '--attempt', e.id]).err, /no review round covers the current tree/);
  assert.match(state(root, e.id).next, /^code review: hand to a fresh reviewer/);
  ok(wf(root, ['gate', '--reason', 'owner: gate the unreviewed tree', '--attempt', e.id]));
  const r = wf(root, ['accept', '--attempt', e.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /no closure for the current tree: the code changed after the last review/);
  assert.doesNotMatch(r.err, /gate: /);
});

test('a review round refused because the tree changed during it leaves a ledger event and ends the round', () => {
  const { base, root } = singleRepoProject('refused-round', { gate: { steps } });
  const e = implemented(root, base, 'RO-5');
  handReviewer(root, e.id, 'r1');
  // An implementer still editing commits while the reviewer works.
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'still editing\n' });
  const r = wf(root, ['review', '--closure', closureFile(base, goodClosure('r1')), '--attempt', e.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /the worktree changed during the review round \(app\)/);
  const s = state(root, e.id);
  assert.equal(s.reviewsRefused.length, 1);
  assert.deepEqual([s.reviewsRefused[0].reviewer, s.reviewsRefused[0].reason, s.reviewsRefused[0].moved], ['r1', 'tree-changed', ['app']]);
  assert.equal(ledger(root, e.id).filter((x) => x.type === 'review.refused').length, 1);
  assert.match(s.next, /^code review: hand to a fresh reviewer/, 'the refused round is over: nobody is waited for');
  assert.match(wf(root, ['gate', '--attempt', e.id]).err, /no review round covers the current tree/);
  review(root, base, e.id, 'r2');
  ok(wf(root, ['gate', '--attempt', e.id]));
});

test('regression: a gate and a reviewer never start side by side, in either order', async () => {
  const { base, root } = singleRepoProject('parallel', { gate: { steps: waiting } });
  goFiles.push(path.join(root, '..', 'go'));
  const e0 = ok(wf(root, ['entry', '--item', 'RO-6', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e0.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e0.id]));
  assert.match(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e0.id]).err, /nothing to review yet/);
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e0.id]));
  fs.writeFileSync(path.join(e0.repos.app.worktree, 'src/a.txt'), 'uncommitted\n');
  assert.match(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e0.id]).err, /commit the change before the review/);
  sh(e0.repos.app.worktree, 'git commit -qam change');
  // Reviewer first: while its round is open the gate is refused, even with a reason given for skipping the review.
  handReviewer(root, e0.id, 'r1');
  // Released up front, so a regression that lets this gate start finishes instead of blocking the suite.
  go(root);
  const beside = wf(root, ['gate', '--attempt', e0.id]);
  fs.rmSync(path.join(root, '..', 'go'));
  assert.equal(beside.code, 75);
  assert.match(beside.err, /reviewer r1 was handed this tree and has recorded no closure: review and gate never run side by side/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r1')), '--attempt', e0.id]));
  // Gate first: while it runs no reviewer is handed the tree.
  const gate = spawn(process.execPath, [WF, 'gate', '--attempt', e0.id], { cwd: root, env: spawnEnv(root) });
  const done = new Promise((resolve) => gate.on('exit', resolve));
  assert.ok(await until(() => fs.existsSync(path.join(e0.repos.app.worktree, 'out.txt'))), 'the gate is running');
  const refused = wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', e0.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /a gate is running on RO-6\.1 \(run \S+, pid \d+\): review and gate never run side by side/);
  assert.match(refused.err, /wf stop --class tree-change\|major-finding\|owner-decision --reason "why"/);
  assert.equal(state(root, e0.id).handoffs.filter((h) => h.role === 'reviewer').length, 1, 'nothing recorded for the refused handoff');
  assert.match(ok(wf(root, ['status', '--attempt', e0.id])).out, /next: a gate is running: wait for it to finish[\s\S]*hand a reviewer the tree meanwhile; once it passes, the evidence review/);
  go(root);
  assert.equal(await done, 0);
  const evidence = handReviewer(root, e0.id, 'r2');
  assert.equal(evidence.round, 'evidence-review', 'untracked gate output is not an uncommitted change');
});

test('regression: a reviewer handoff holding the gate lock refuses a gate starting at that moment', async () => {
  // The lock is what makes the two checks exclusive: a handoff records its round holding the gate lock, so a gate that
  // starts in between sees it. Another live `wf` process stands in for the handoff process here.
  // Only the holder's gate waits, so a regression that lets RO-8's gate start finishes instead of blocking the suite.
  const holderOnly = [{ id: 'slow', repo: 'app', run: 'echo report > out.txt; if [ "$WF_ITEM" = RO-7 ]; then while [ ! -f "$WF_ROOT/../go" ]; do sleep 0.1; done; fi' }];
  const { base, root } = singleRepoProject('lock-race', { gate: { steps: holderOnly } });
  goFiles.push(path.join(root, '..', 'go'));
  const holder = implemented(root, base, 'RO-7');
  const e = implemented(root, base, 'RO-8');
  review(root, base, holder.id, 'rh');
  review(root, base, e.id, 'r1');
  const other = spawn(process.execPath, [WF, 'gate', '--attempt', holder.id], { cwd: root, env: spawnEnv(root) });
  const done = new Promise((resolve) => other.on('exit', resolve));
  assert.ok(await until(() => fs.existsSync(path.join(holder.repos.app.worktree, 'out.txt'))), 'a live wf process');
  const lock = path.join(root, '.wf-evidence', 'attempts', e.id, 'gate', 'gate.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: other.pid, runId: null, kind: 'review-handoff', startedAt: new Date().toISOString(), children: [], plugins: [] }));
  const r = wf(root, ['gate', '--attempt', e.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /a reviewer handoff is being recorded for RO-8\.1[\s\S]*review and gate never run side by side/);
  assert.match(wf(root, ['stop', '--class', 'owner-decision', '--reason', 'x', '--attempt', e.id]).err, /no gate is running for RO-8\.1 \(a reviewer handoff is being recorded\)/, 'wf stop never signals a handoff process');
  fs.rmSync(lock);
  go(root);
  assert.equal(await done, 0);
  ok(wf(root, ['gate', '--attempt', e.id]));
});

test('wf stop needs a reason class; the ledger records the class and the minutes of discarded gate work', async () => {
  const { base, root } = singleRepoProject('stop-class', { gate: { steps: [{ id: 'fast', repo: 'app', run: 'true', inputs: ['src/**'] }, ...waiting] } });
  goFiles.push(path.join(root, '..', 'go'));
  const e = implemented(root, base, 'RO-9');
  review(root, base, e.id, 'r1');
  const gate = spawn(process.execPath, [WF, 'gate', '--attempt', e.id], { cwd: root, env: spawnEnv(root) });
  const done = new Promise((resolve) => gate.on('exit', resolve));
  assert.ok(await until(() => fs.existsSync(path.join(e.repos.app.worktree, 'out.txt'))));
  const noClass = wf(root, ['stop', '--reason', 'a major finding came in', '--attempt', e.id]);
  assert.equal(noClass.code, 1);
  assert.match(noClass.err, /--class is required: one of major-finding, tree-change, owner-decision/);
  assert.match(wf(root, ['stop', '--class', 'bored', '--reason', 'x', '--attempt', e.id]).err, /--class is required/);
  assert.match(wf(root, ['stop', '--class', 'major-finding', '--attempt', e.id]).err, /--reason "why" is required/);
  const out = ok(wf(root, ['stop', '--class', 'major-finding', '--reason', 'the owner found F9 in the diff', '--attempt', e.id])).out;
  assert.match(out, /stopping gate \S+ \(major-finding; [\d.]+ minute\(s\) of gate work recorded as discarded\)[\s\S]*the new tree gets a code-review round before the next `wf gate`/);
  assert.equal(await done, 1);
  const s = state(root, e.id);
  assert.equal(s.lastGate.status, 'stopped');
  assert.equal(s.stops.length, 1);
  assert.equal(s.stops[0].class, 'major-finding');
  assert.equal(typeof s.stops[0].discardedMinutes, 'number');
  assert.ok(s.stops[0].discardedMinutes >= 0);
  const event = ledger(root, e.id).find((x) => x.type === 'gate.stopped').data;
  assert.deepEqual([event.class, event.reason, typeof event.discardedMinutes, event.stepsFinished], ['major-finding', 'the owner found F9 in the diff', 'number', 1]);
  assert.match(s.next, /^gate stopped \(major-finding: the owner found F9 in the diff\); fix and commit through the implementer[\s\S]*fresh reviewer[\s\S]*the gate runs once a round comes back clean/);
  assert.doesNotMatch(s.next, /run `wf gate` to continue/, 'a gate stopped for a finding is not resumed on the same tree');
});

test('batch: review before the batch gate, then the evidence review, then delivery', () => {
  const heavy = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'true', tier: 'heavy' }];
  const { base, root, remote } = singleRepoProject('batch-order', { gate: { steps: heavy } }, { 'src/b.txt': 'b\n' });
  const m1 = toAccepted(root, base, { item: 'RO-10', change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] });
  const m2 = toAccepted(root, base, { item: 'RO-11', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'ob', '--json'])).json();
  const batchClosure = (reviewer) => closureFile(base, { reviewer, findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [] });
  assert.match(wf(root, ['gate', '--attempt', b.id]).err, /no review round covers the current tree/, 'the batch tree is reviewed before its gate too');
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
