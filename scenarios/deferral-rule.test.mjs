import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { approveAsOwner, closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, sh, singleRepoProject, state, toAccepted, wf } from './helpers.mjs';
import { knownLimits } from '../engine/tracker.mjs';
import { loadState } from '../engine/ledger.mjs';

// 0.7.7, D17, named failure (field): under D10 a medium finding was the owner agent's call and a low one left freely, so
// an owner deferred 14 of 15 findings on its own judgement, among them a behaviour the person had asked for (called "a
// product decision") and two money and customer-data defects rated low. The person's rule now: medium and high are fixed
// in the delivery; a low item leaves only with the person's yes, every low item in one question.

const steps = [{ id: 'unit', repo: 'app', run: 'true' }];
const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';

function project(name) {
  const p = singleRepoProject(name, { gate: { steps } }, { 'src/a.txt': LINES, 'src/old.txt': 'o1\no2\no3\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'DR-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': LINES.replace('l2', 'L2') });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
  const finding = (id, severity, evidence) => ({ id, severity, summary: `${id}: ${evidence}`, status: 'open', evidence });
  const closure = goodClosure('r1', { findings: [finding('F1', 'medium', 'src/old.txt:2 the export sums one page only'), finding('F2', 'low', 'src/old.txt:3 a tooltip typo')] });
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', e.id]));
  const add = (summary, severity) => ok(wf(p.root, ['discovered', 'add', '--summary', summary, ...(severity ? ['--severity', severity] : []), '--attempt', e.id]));
  add('customer invoice reads carry admin-only fields', 'medium');
  add('a stale screenshot in the ignored folder', 'medium');
  add('a pager resets on refresh', null);
  return { ...p, id: e.id };
}
const silent = { ownerSilent: true };
const run = (p, args) => wf(p.root, [...args, '--attempt', p.id], silent);
const capture = (p) => {
  const f = path.join(p.base, 'ticket.json');
  fs.writeFileSync(f, JSON.stringify({ issue: { identifier: 'ENG-9', title: 'follow-up', url: 'https://tracker.example.test/ENG-9' } }));
  return f;
};

test('medium and high stay in the delivery: no command defers or tickets them, with a reason or without', () => {
  const p = project('d17-kept');
  const [d1, , d3] = state(p.root, p.id).discovered.map((d) => d.id);
  for (const args of [
    ['scope', 'defer', '--finding', 'r1:F1', '--reason', 'the export page is rebuilt next'],
    ['scope', 'ticket', '--finding', 'r1:F1', '--capture', capture(p), '--reason', 'later'],
    ['discovered', 'close', d1, '--deferred', '--reason', 'a product decision'],
    ['discovered', 'close', d3, '--deferred', '--reason', 'unrated'],
    ['scope', 'defer', '--finding', `r1:F2,${d1}`],
  ]) {
    const r = run(p, args);
    assert.notEqual(r.code, 0, `refused: ${args.join(' ')}`);
    assert.match(r.err, /stays? in this delivery: medium and high are fixed in this delivery/, args.join(' '));
    assert.doesNotMatch(r.err, /wf approve A\d+/, 'nothing to ask: no answer lets a medium or high item leave');
  }
  const s = state(p.root, p.id);
  assert.deepEqual(s.discovered.map((d) => d.status), ['open', 'open', 'open']);
  assert.deepEqual(s.decisions ?? [], [], 'no decision was put to the person');
});

test('low items leave only with the person\'s yes, review findings and discovered issues in one question that shows who rated each and every re-rating', () => {
  const p = project('d17-low');
  const [, d2] = state(p.root, p.id).discovered.map((d) => d.id);
  // Lowering into low is the person's decision too (D17): the agent cannot rate an item down to put it in the question.
  const rating = run(p, ['discovered', 'rate', d2, '--severity', 'low', '--reason', 'an ignored folder']);
  assert.equal(rating.code, 75);
  assert.match(rating.err, /rate DR-1\.1:D2 down from medium to low/);
  approveAsOwner(p.root, p.id, rating.err.match(/wf approve (A\d+)/)[1], 'yes');
  ok(run(p, ['discovered', 'rate', d2, '--severity', 'low', '--reason', 'an ignored folder']));
  const asked = run(p, ['scope', 'defer', '--finding', `r1:F2,${d2}`, '--reason', 'polish']);
  assert.equal(asked.code, 75);
  const id = asked.err.match(/wf approve (A\d+)/)[1];
  const d = state(p.root, p.id).decisions.find((x) => x.id === id);
  assert.match(d.summary, /r1:F2 \(low, rated by reviewer r1; at src\/old\.txt:3\): F2: src\/old\.txt:3 a tooltip typo/);
  assert.match(d.summary, new RegExp(`${d2} \\(low, rated by [^;]+; re-rated medium to low by [^ ]+ because an ignored folder\\): a stale screenshot`));
  assert.equal(state(p.root, p.id).decisions.filter((x) => x.key.startsWith('deferred:')).length, 1, 'one question for both kinds');
  approveAsOwner(p.root, p.id, id, 'no');
  assert.notEqual(run(p, ['scope', 'defer', '--finding', `r1:F2,${d2}`]).code, 0, 'a no lets nothing leave');
  assert.equal(state(p.root, p.id).discovered.find((x) => x.id === d2).status, 'open');
  const again = state(p.root, p.id).decisions.at(-1).id;
  approveAsOwner(p.root, p.id, again, 'yes');
  ok(run(p, ['scope', 'defer', '--finding', `r1:F2,${d2}`]));
  const s = state(p.root, p.id);
  const closed = s.discovered.find((x) => x.id === d2);
  assert.equal(closed.status, 'deferred');
  assert.deepEqual([closed.deferred.source.provenance, closed.deferred.source.decision], ['approved-decision', again]);
  assert.equal(s.scopeDecisions.at(-1).decision, again);
  assert.deepEqual(s.scopeDecisions.at(-1).keys, ['r1:F2']);
});

test('the question names every other open low item, so the owner puts them in one question', () => {
  const p = project('d17-others');
  ok(run(p, ['discovered', 'add', '--summary', 'a label wraps on a phone', '--severity', 'low']));
  const asked = run(p, ['scope', 'defer', '--finding', 'r1:F2']);
  assert.equal(asked.code, 75);
  assert.match(asked.err, /other open low items not in this question: D4/);
});

test('a discovered issue is closed fixed only by a commit made after it was recorded', () => {
  const p = project('d17-fixed-after');
  const wt = state(p.root, p.id).repos.app.worktree;
  const before = sh(wt, 'git rev-parse HEAD');
  const [d1] = state(p.root, p.id).discovered.map((d) => d.id);
  const r = run(p, ['discovered', 'close', d1, '--fixed', before]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /was already in the tree D1 was recorded on: it cannot be the fix/);
  commitIn(wt, { 'src/old.txt': 'o1\no2 fixed\no3\n' }, 'fix D1');
  ok(run(p, ['discovered', 'close', d1, '--fixed', sh(wt, 'git rev-parse HEAD')]));
});

test('the strategist cannot queue a medium or high item for a ticket', async () => {
  const { strategistClosure } = await import('./strategist-fixtures.mjs');
  const p = project('d17-strategist');
  const [d1] = state(p.root, p.id).discovered.map((d) => d.id);
  const h = ok(wf(p.root, ['handoff', 'strategist', '--agent', 'strat-1', '--attempt', p.id, '--reason', 'observations pile up', '--json'])).json();
  const closure = (items) => ({ strategist: 'strat-1', action: 'ticket', items, rationale: 'they can wait', prediction: { signal: 'observationsOpen <= 1', by: 3 } });
  for (const items of [['r1:F1'], [d1], ['r1:F2', 'r1:F1']]) {
    const r = wf(p.root, ['strategy', 'record', '--closure', strategistClosure(p.base, h.bundle, closure(items)).file, '--attempt', p.id], silent);
    assert.notEqual(r.code, 0, items.join(','));
    assert.match(r.err, /medium or high: medium and high are fixed in this delivery/);
  }
  ok(wf(p.root, ['strategy', 'record', '--closure', strategistClosure(p.base, h.bundle, closure(['r1:F2'])).file, '--attempt', p.id]));
});

test('a finding moved to a sibling leaves the batch only by the person: ejecting or abandoning the sibling asks', () => {
  const steps2 = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'true', tier: 'heavy' }];
  const { base, root } = singleRepoProject('d17-move-eject', { gate: { steps: steps2 } }, { 'src/b.txt': 'b\n', 'src/old.txt': 'o1\no2\no3\n' });
  const e = ok(wf(root, ['entry', '--item', 'PR-1', '--owner', 'o', '--json', '--defer-heavy'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', e.id, '--owner', 'o']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id, '--owner', 'o']));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', e.id, '--owner', 'o']));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'one\n' });
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-0', '--attempt', e.id, '--owner', 'o']));
  const obs = { id: 'F1', severity: 'medium', summary: 'customer invoice reads carry admin-only fields', status: 'open', evidence: 'src/old.txt:2 the DTO exposes them' };
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-0', { findings: [obs] })), '--attempt', e.id]));
  ok(wf(root, ['gate', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id, '--owner', 'o']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1')), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id, '--owner', 'o']));
  const m2 = toAccepted(root, base, { item: 'PR-2', owner: 'o', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] }).id;
  const b = ok(wf(root, ['batch', 'create', '--members', `${e.id},${m2}`, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['scope', 'move', '--finding', 'rev-0:F1', '--sibling', m2, '--reason', 'belongs with PR-2', '--attempt', e.id]));
  const moved = state(root, m2).discovered.at(-1);
  assert.deepEqual(moved.movedFrom, { attempt: e.id, ref: 'rev-0:F1' }, 'the sibling keeps where the item came from');
  // Closing the moved item "fixed" with any later commit of the sibling does not change that: a fix in a branch that
  // leaves the batch is not delivered (independent review of 0.7.7).
  const sibWt = state(root, m2).repos.app.worktree;
  commitIn(sibWt, { 'src/b.txt': 'two, again\n' }, 'an unrelated change');
  ok(wf(root, ['discovered', 'close', moved.id, '--fixed', sh(sibWt, 'git rev-parse HEAD'), '--attempt', m2]));
  const eject = wf(root, ['batch', 'eject', '--batch', b.id, '--member', m2, '--reason', 'ship PR-1 alone', '--owner', 'o'], silent);
  assert.equal(eject.code, 75, 'ejecting the holder of moved work is the person\'s decision');
  assert.match(eject.err, new RegExp(`with the work moved to it: ${moved.id} \\(fixed, from ${e.id.replace('.', '\\.')} rev-0:F1\\)`));
  const abandon = wf(root, ['abandon', '--attempt', m2, '--reason', 'not now', '--owner', 'o'], silent);
  assert.equal(abandon.code, 75, 'abandoning it too');
  assert.equal(state(root, m2).phase !== 'abandoned', true);
});

test('a medium discovered issue closed fixed after the last review is not delivered until a round sees the fix', () => {
  const { base, root } = singleRepoProject('d17-fixed-unreviewed', { gate: { steps } }, { 'src/a.txt': LINES, 'src/old.txt': 'o1\no2\no3\n' });
  const e = ok(wf(root, ['entry', '--item', 'DR-2', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  ok(wf(root, ['discovered', 'add', '--summary', 'the export sums one page only', '--severity', 'medium', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': LINES.replace('l2', 'L2'), 'src/old.txt': 'o1 fixed\no2\no3\n' }, 'the change and the fix');
  const fix = sh(e.repos.app.worktree, 'git rev-parse HEAD');
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r1')), '--attempt', e.id]));
  ok(wf(root, ['gate', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2')), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  ok(wf(root, ['discovered', 'close', 'D1', '--fixed', fix, '--attempt', e.id]));
  const r = wf(root, ['deliver', '--attempt', e.id], silent);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /D1 \(medium\) closed fixed after the last review: a review round sees the fix before delivery/);
});

test('when the person lets the holder of a moved finding leave, the rest of the batch still delivers', () => {
  const heavy = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'true', tier: 'heavy' }];
  const { base, root } = singleRepoProject('d17-moved-letgo', { gate: { steps: heavy } }, { 'src/b.txt': 'b\n', 'src/old.txt': 'o1\no2\no3\n' });
  const e = ok(wf(root, ['entry', '--item', 'PM-1', '--owner', 'o', '--json', '--defer-heavy'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', e.id, '--owner', 'o']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id, '--owner', 'o']));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', e.id, '--owner', 'o']));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'one\n' });
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-0', '--attempt', e.id, '--owner', 'o']));
  const obs = { id: 'F1', severity: 'medium', summary: 'credit note never exported to accounting', status: 'open', evidence: 'src/old.txt:2 no export call' };
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-0', { findings: [obs] })), '--attempt', e.id]));
  ok(wf(root, ['gate', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id, '--owner', 'o']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1')), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id, '--owner', 'o']));
  const m2 = toAccepted(root, base, { item: 'PM-2', owner: 'o', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] }).id;
  const b = ok(wf(root, ['batch', 'create', '--members', `${e.id},${m2}`, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['scope', 'move', '--finding', 'rev-0:F1', '--sibling', m2, '--reason', 'belongs with PM-2', '--attempt', e.id]));
  const asked = wf(root, ['batch', 'eject', '--batch', b.id, '--member', m2, '--reason', 'PM-2 waits', '--owner', 'o'], silent);
  assert.equal(asked.code, 75);
  approveAsOwner(root, m2, asked.err.match(/wf approve (A\d+)/)[1], 'yes');
  ok(wf(root, ['batch', 'eject', '--batch', b.id, '--member', m2, '--reason', 'PM-2 waits', '--owner', 'o'], silent));
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', b.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb', '--attempt', b.id, '--owner', 'o']));
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'rb', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [] }), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id, '--owner', 'o']));
  const del = wf(root, ['deliver', '--attempt', b.id, '--owner', 'o'], silent);
  assert.doesNotMatch(del.err, /moved to .* which is not in this delivery/, 'the person let it leave: the check passes');
});

test('a low item closed fixed after the last review is a known limit: no reviewer verified it', () => {
  const p = project('d17-limits');
  ok(run(p, ['discovered', 'add', '--summary', 'a label wraps on a phone', '--severity', 'low']));
  const wt = state(p.root, p.id).repos.app.worktree;
  commitIn(wt, { 'src/old.txt': 'o1\no2\no3 wrapped\n' }, 'fix the label');
  ok(run(p, ['discovered', 'close', 'D4', '--fixed', sh(wt, 'git rev-parse HEAD')]));
  assert.match(knownLimits(loadState(p.root, p.id)), /Closed as fixed after the last review, not verified by a reviewer: DR-1\.1:D4 \(low\): a label wraps on a phone/);
});

