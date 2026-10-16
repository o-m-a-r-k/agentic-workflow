import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { approveAsOwner, closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, sh, singleRepoProject, state, toAccepted, wf } from './helpers.mjs';
import { knownLimits } from '../engine/tracker.mjs';
import { append, loadState, readLedger } from '../engine/ledger.mjs';
import { observations } from '../engine/review-policy.mjs';

// 0.7.7, D17, named failure (field): under D10 a medium finding was the owner agent's call and a low one left freely, so
// an owner deferred 14 of 15 findings on its own judgement, among them a behaviour the person had asked for (called "a
// product decision") and two money and customer-data defects rated low. The person's rule now: medium and high are fixed
// in the delivery; a low item leaves only with the person's answer. 0.7.8 (D18) keeps the rule and makes the question
// humane: one short question per item (`let it leave` | `fix now`), and removes the defensive gates around it.

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
  const finding = (id, severity, evidence) => ({ id, severity, summary: `${id}: ${evidence}. More detail the reviewer wrote at length about the reason and the files involved.`, status: 'open', evidence });
  const closure = goodClosure('r1', { findings: [finding('F1', 'medium', 'src/old.txt:2 the export sums one page only'), finding('F2', 'low', 'src/old.txt:3 a tooltip typo')] });
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', e.id]));
  const add = (summary, severity) => ok(wf(p.root, ['discovered', 'add', '--summary', summary, ...(severity ? ['--severity', severity] : []), '--attempt', e.id]));
  add('customer invoice reads carry admin-only fields', 'medium');
  add('a stale screenshot in the ignored folder', 'medium');
  add('a pager resets on refresh', null);
  return { ...p, id: e.id };
}
const silent = { ownerSilent: true };
// The check id of each refusal a command printed, as the refusal log recorded it.
const refusals = (p) => fs.readFileSync(path.join(p.root, '..', 'refusals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
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
    assert.equal(refusals(p).at(-1).id, 'leave:medium-high', args.join(' '));
    assert.doesNotMatch(r.err, /wf approve A\d+/, 'nothing to ask: no answer lets a medium or high item leave');
  }
  const s = state(p.root, p.id);
  assert.deepEqual(s.discovered.map((d) => d.status), ['open', 'open', 'open']);
  assert.deepEqual(s.decisions ?? [], [], 'no decision was put to the person');
});

test('low items leave only with the person\'s answer: one short question per item, review findings and discovered issues alike, showing who rated each and every re-rating', () => {
  const p = project('d17-low');
  const [, d2] = state(p.root, p.id).discovered.map((d) => d.id);
  // Lowering a discovered issue into low no longer asks the person (0.7.8): the re-rating and its reason are in the item's own
  // question instead, when it is proposed to leave.
  ok(run(p, ['discovered', 'rate', d2, '--severity', 'low', '--reason', 'an ignored folder']));
  const known = state(p.root, p.id).discovered.length;
  assert.match(run(p, ['discovered', 'add', '--summary', 'x', '--severity', 'urgent']).err, /--severity is high, medium or low/);
  assert.equal(state(p.root, p.id).discovered.length, known, 'an unknown severity records nothing');
  assert.deepEqual(state(p.root, p.id).decisions ?? [], [], 'rating an item down into low put no question to the person');
  const asked = run(p, ['scope', 'defer', '--finding', `r1:F2,${d2}`, '--reason', 'polish']);
  assert.equal(asked.code, 75);
  assert.equal(refusals(p).at(-1).id, 'leave:ask');
  const ds = state(p.root, p.id).decisions;
  assert.equal(ds.length, 2, 'one question per item, not one for both');
  const [qF2, qD2] = ['r1:F2', d2].map((ref) => ds.find((x) => x.key === `leave:${ref}`));
  for (const q of [qF2, qD2]) {
    assert.equal(q.kind, 'move-out-of-batch');
    assert.deepEqual(q.choices, ['let it leave', 'fix now']);
    assert.match(asked.err, new RegExp(`wf approve ${q.id} --from-question --attempt ${p.id.replace('.', '\\.')}`), 'the refusal lists every question to ask');
  }
  // The question is short: the reviewer's long text stays in the record, not in what the person is asked.
  assert.equal(qF2.summary, 'r1:F2: src/old.txt:3 a tooltip typo (low, rated by reviewer r1, old.txt:3). Fix it now, or let it leave this delivery as a known issue?');
  assert.match(qD2.summary, new RegExp(`^${d2}: a stale screenshot in the ignored folder \\(low, rated by [^,]+, re-rated medium to low \\(an ignored folder\\)\\)\\. Fix it now, or let it leave this delivery as a known issue\\?$`));
  // The person fixes one and lets the other go: nothing in the command leaves until the command follows the answers.
  approveAsOwner(p.root, p.id, qF2.id, 'fix now');
  approveAsOwner(p.root, p.id, qD2.id, 'let it leave');
  const refused = run(p, ['scope', 'defer', '--finding', `r1:F2,${d2}`]);
  assert.notEqual(refused.code, 0, 'a fix-now answer lets nothing in the command leave');
  assert.equal(refusals(p).at(-1).id, 'leave:person-answered');
  assert.match(refused.err, /the person chose to fix r1:F2 \(A\d+\) now/);
  assert.equal(state(p.root, p.id).discovered.find((x) => x.id === d2).status, 'open');
  ok(run(p, ['scope', 'defer', '--finding', d2]));
  const s = state(p.root, p.id);
  const closed = s.discovered.find((x) => x.id === d2);
  assert.equal(closed.status, 'deferred');
  assert.deepEqual([closed.deferred.source.provenance, closed.deferred.source.decision], ['approved-decision', qD2.id], 'the closure names the item\'s own decision');
  assert.equal(s.decisions.find((x) => x.id === qD2.id).spent !== undefined, true, 'the answer was used once');
  assert.equal(s.discovered.find((x) => x.id !== d2 && x.status !== 'open'), undefined, 'nothing else left');
});

test('a fix-now answer is changed only by withdrawing it; the item is then asked afresh and leaves on the new answer, recorded per item', () => {
  const p = project('d17-low-again');
  const asked = run(p, ['scope', 'defer', '--finding', 'r1:F2', '--reason', 'polish']);
  assert.equal(asked.code, 75);
  const q = state(p.root, p.id).decisions.find((x) => x.key === 'leave:r1:F2');
  approveAsOwner(p.root, p.id, q.id, 'fix now');
  assert.notEqual(run(p, ['scope', 'defer', '--finding', 'r1:F2']).code, 0);
  ok(run(p, ['decisions', 'withdraw', q.id, '--reason', 'the situation changed']));
  const again = run(p, ['scope', 'defer', '--finding', 'r1:F2', '--reason', 'polish']);
  assert.equal(again.code, 75, 'asked afresh');
  const q2 = state(p.root, p.id).decisions.find((x) => x.key === 'leave:r1:F2' && !x.withdrawn);
  assert.notEqual(q2.id, q.id);
  approveAsOwner(p.root, p.id, q2.id, 'let it leave');
  ok(run(p, ['scope', 'defer', '--finding', 'r1:F2', '--reason', 'polish']));
  const ev = state(p.root, p.id).scopeDecisions.at(-1);
  assert.deepEqual([ev.choice, ev.keys, ev.decisions, ev.decisionFor], ['deferred', ['r1:F2'], [q2.id], { 'r1:F2': q2.id }]);
  assert.equal(ev.decision, undefined, 'no single decision: each item has its own');
});

test('open low items are asked about together: one refusal lists one question per item, each with its approve line', () => {
  const p = project('d17-others');
  ok(run(p, ['discovered', 'add', '--summary', 'a label wraps on a phone', '--severity', 'low']));
  const alone = run(p, ['scope', 'defer', '--finding', 'r1:F2']);
  assert.equal(alone.code, 75);
  assert.deepEqual(state(p.root, p.id).decisions.map((x) => x.key), ['leave:r1:F2'], 'naming one item asks about that item only');
  const asked = run(p, ['scope', 'defer', '--finding', 'r1:F2,D4']);
  assert.equal(asked.code, 75);
  const ds = state(p.root, p.id).decisions;
  assert.deepEqual(ds.map((x) => x.key), ['leave:r1:F2', 'leave:D4'], 'the question for F2 is kept, D4 gets its own');
  for (const d of ds) assert.match(asked.err, new RegExp(`wf approve ${d.id} --from-question --attempt ${p.id.replace('.', '\\.')}`));
  assert.equal(asked.err.match(/then: wf approve A\d+ --from-question/g).length, 2, 'two questions, to ask together in one panel');
});

test('a discovered issue is closed fixed only by a commit made after it was recorded', () => {
  const p = project('d17-fixed-after');
  const wt = state(p.root, p.id).repos.app.worktree;
  const before = sh(wt, 'git rev-parse HEAD');
  const [d1] = state(p.root, p.id).discovered.map((d) => d.id);
  // 0.7.19: a commit already in the tree the defect was recorded on closes nothing on the owner's word; the claim waits for a
  // reviewer's verification.
  const r = ok(run(p, ['discovered', 'close', d1, '--fixed', before]));
  assert.match(r.out, /was made before D1 was recorded, so a reviewer verifies it/);
  assert.equal(state(p.root, p.id).discovered.find((x) => x.id === d1).status, 'open');
  commitIn(wt, { 'src/old.txt': 'o1\no2 fixed\no3\n' }, 'fix D1');
  ok(run(p, ['discovered', 'close', d1, '--fixed', sh(wt, 'git rev-parse HEAD')]));
});

test('the strategist cannot queue a medium or high item for a ticket', async () => {
  const { strategistClosure } = await import('./strategist-fixtures.mjs');
  const p = project('d17-strategist');
  const [d1] = state(p.root, p.id).discovered.map((d) => d.id);
  const h = ok(wf(p.root, ['handoff', 'strategist', '--agent', 'strat-1', '--attempt', p.id, '--reason', 'observations pile up', '--json'])).json();
  const closure = (items) => ({ strategist: 'strat-1', action: 'ticket', items, rationale: 'they can wait', prediction: { signal: 'observationsOpen <= 1', by: 3 } });
  for (const [items, kept] of [[['r1:F1'], 'r1:F1'], [[d1], d1], [['r1:F2', 'r1:F1'], 'r1:F1']]) {
    const r = wf(p.root, ['strategy', 'record', '--closure', strategistClosure(p.base, h.bundle, closure(items)).file, '--attempt', p.id], silent);
    assert.notEqual(r.code, 0, items.join(','));
    assert.equal(refusals(p).at(-1).id, 'strategy:ticket-not-low', items.join(','));
    assert.ok(r.err.includes(kept), `${items.join(',')}: the refusal names ${kept}`);
  }
  ok(wf(p.root, ['strategy', 'record', '--closure', strategistClosure(p.base, h.bundle, closure(['r1:F2'])).file, '--attempt', p.id]));
});

test('ejecting or abandoning the sibling that holds a moved finding no longer asks; the known limits say the sibling left and the item is still open there', () => {
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
  // Closing the moved item "fixed" in the sibling does not make it delivered if that branch leaves the batch. Since 0.7.8 (D18)
  // that is information for the tester, not a question for the person: ejecting or abandoning the holder asks nothing, and the
  // delivered known limits say where the item is.
  const sibWt = state(root, m2).repos.app.worktree;
  commitIn(sibWt, { 'src/b.txt': 'two, again\n' }, 'an unrelated change');
  ok(wf(root, ['discovered', 'close', moved.id, '--fixed', sh(sibWt, 'git rev-parse HEAD'), '--attempt', m2]));
  ok(wf(root, ['batch', 'eject', '--batch', b.id, '--member', m2, '--reason', 'ship PR-1 alone', '--owner', 'o'], silent));
  assert.deepEqual(state(root, m2).decisions ?? [], [], 'ejecting the holder of moved work put no question to the person');
  const left = knownLimits(loadState(root, e.id), { load: (id) => loadState(root, id) });
  assert.match(left, new RegExp(`Moved to ${m2.replace('.', '\\.')}, which is not in this delivery: customer invoice reads carry admin-only fields is still open there \\(belongs with PR-2\\)`));
  assert.doesNotMatch(left, /Follow-up moved to/);
  ok(wf(root, ['abandon', '--attempt', m2, '--reason', 'not now', '--owner', 'o'], silent));
  assert.equal(state(root, m2).phase, 'abandoned', 'abandoning it asks nothing either');
  assert.deepEqual(state(root, m2).decisions ?? [], []);
  assert.match(knownLimits(loadState(root, e.id), { load: (id) => loadState(root, id) }), new RegExp(`Moved to ${m2.replace('.', '\\.')}, which is not in this delivery \\(abandoned\\): customer invoice reads carry admin-only fields is still open there`));
});

// 0.7.23 (I-177), named failure (field): the batch was assembled and accepted, then delivery listed a member's open low
// observation; the person answered "fix now". The member's HEAD is pinned by the batch and `wf scope move` took only a sibling
// of the same batch, so the batch could not be the target: no way to settle the item remained but an eject, which rebuilt
// the batch branch without the batch's own commits. A member now moves it to its own batch, which fixes it.
const batchClosure = (base, reviewer) => closureFile(base, { reviewer, findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [] });
// Two accepted members (the first with an open observation, when `finding` is given) assembled into a batch that is gated,
// reviewed and accepted: the state delivery is attempted from.
function acceptedBatch(name, { finding = null } = {}) {
  const heavy = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'true', tier: 'heavy' }];
  const { base, root } = singleRepoProject(name, { gate: { steps: heavy } }, { 'src/b.txt': 'b\n', 'src/old.txt': 'o1\no2\no3\n' });
  const e = ok(wf(root, ['entry', '--item', 'IB-1', '--owner', 'o', '--json', '--defer-heavy'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', e.id, '--owner', 'o']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id, '--owner', 'o']));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', e.id, '--owner', 'o']));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'one\n' });
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-0', '--attempt', e.id, '--owner', 'o']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-0', { findings: finding ? [finding] : [] })), '--attempt', e.id]));
  ok(wf(root, ['gate', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id, '--owner', 'o']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1')), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id, '--owner', 'o']));
  const m2 = toAccepted(root, base, { item: 'IB-2', owner: 'o', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] }).id;
  const b = ok(wf(root, ['batch', 'create', '--members', `${e.id},${m2}`, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', b.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb', '--attempt', b.id, '--owner', 'o']));
  ok(wf(root, ['review', '--closure', batchClosure(base, 'rb'), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id, '--owner', 'o']));
  return { base, root, e, m2, b };
}

test('0.7.23 (I-177): a member observation the person answered "fix now" after the batch was assembled moves into the batch, which fixes it; the member stays as accepted', () => {
  const obs = { id: 'F1', severity: 'low', summary: 'the export button label is cut off on a narrow screen', status: 'open', evidence: 'src/old.txt:2 the label overflows' };
  const { base, root, e, b } = acceptedBatch('i177-move-to-batch', { finding: obs });
  // Delivery lists the member's observation; the person is asked and answers "fix now".
  assert.match(wf(root, ['deliver', '--attempt', b.id, '--owner', 'o'], silent).err, /review observation\(s\) are unresolved in .*rev-0:F1/);
  const asked = wf(root, ['scope', 'defer', '--finding', 'rev-0:F1', '--attempt', e.id], silent);
  assert.equal(asked.code, 75);
  const q = state(root, e.id).decisions.find((x) => x.key === 'leave:rev-0:F1');
  approveAsOwner(root, e.id, q.id, 'fix now');
  assert.notEqual(wf(root, ['scope', 'defer', '--finding', 'rev-0:F1', '--attempt', e.id], silent).code, 0);
  // The batch is a place the item can go (it contains the member's lines, so the own-line rule does not apply), and it asks nobody.
  const memberWt = state(root, e.id).repos.app.worktree;
  const memberHead = sh(memberWt, 'git rev-parse HEAD');
  ok(wf(root, ['scope', 'move', '--finding', 'rev-0:F1', '--sibling', b.id, '--reason', 'the batch fixes it', '--attempt', e.id], silent));
  const issue = state(root, b.id).discovered.at(-1);
  assert.deepEqual(issue.movedFrom, { attempt: e.id, ref: 'rev-0:F1' }, 'the batch owes the item and keeps where it came from');
  assert.equal(issue.status, 'open');
  assert.deepEqual(observations(loadState(root, e.id)), [], 'the member has no open observation: it moved');
  assert.equal(sh(memberWt, 'git rev-parse HEAD'), memberHead, 'the member is untouched');
  assert.doesNotMatch(knownLimits(loadState(root, e.id), { load: (id) => loadState(root, id) }), /not in this delivery|Follow-up moved to BATCH/, 'the batch is this delivery');
  assert.match(knownLimits(loadState(root, e.id), { load: (id) => loadState(root, id) }), /Fixed in the combined delivery: /);
  // The batch's delivery waits for the item: it is the batch's open discovered issue.
  const waits = wf(root, ['deliver', '--attempt', b.id, '--owner', 'o'], silent);
  assert.notEqual(waits.code, 0);
  assert.match(waits.err, new RegExp(`discovered issue\\(s\\) are open: ${issue.id} moved from ${e.id.replace('.', '\\.')} rev-0:F1`));
  // The batch's own commit fixes it and closes it; no member changed, so the pins hold.
  const batchWt = state(root, b.id).repos.app.worktree;
  commitIn(batchWt, { 'src/b.txt': 'two, label fixed\n' }, 'fix the label');
  ok(wf(root, ['discovered', 'close', issue.id, '--fixed', sh(batchWt, 'git rev-parse HEAD'), '--attempt', b.id]));
  assert.equal(state(root, b.id).discovered.at(-1).status, 'fixed');
  // The change on the batch needs its gate and a fresh review, as any change after acceptance; the member takes no part in that.
  assert.match(wf(root, ['deliver', '--attempt', b.id, '--owner', 'o'], silent).err, /modified after acceptance/);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb-2', '--attempt', b.id, '--owner', 'o']));
  ok(wf(root, ['review', '--closure', batchClosure(base, 'rb-2'), '--attempt', b.id]));
  ok(wf(root, ['gate', '--attempt', b.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb-3', '--attempt', b.id, '--owner', 'o']));
  ok(wf(root, ['review', '--closure', batchClosure(base, 'rb-3'), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id, '--owner', 'o']));
  ok(wf(root, ['deliver', '--attempt', b.id, '--owner', 'o'], silent));
  assert.equal(state(root, b.id).phase, 'done');
  assert.equal(state(root, e.id).accepted.heads.app, memberHead, 'the member was delivered as it was accepted, its HEAD untouched');
  assert.match(knownLimits(loadState(root, e.id), { load: (id) => loadState(root, id) }), /Fixed in the combined delivery: the export button label is cut off/);
});

test('0.7.23 (I-177): an eject that would drop the batch\'s own commits is refused, and the delivery refusal for a member changed after it joined no longer advises it', () => {
  const { root, e, m2, b } = acceptedBatch('i177-eject-own');
  const memberWt = state(root, e.id).repos.app.worktree;
  const batchWt = state(root, b.id).repos.app.worktree;
  // A member that changed after it joined: with nothing of the batch's own to lose, ejecting it is the advice.
  commitIn(memberWt, { 'src/a.txt': 'one, again\n' }, 'a later change of the member');
  const plain = wf(root, ['deliver', '--attempt', b.id, '--owner', 'o'], silent);
  assert.equal(plain.code, 75);
  assert.equal(refusals({ root }).at(-1).id, 'batch:member-changed');
  assert.match(plain.err, new RegExp(`batch member ${e.id.replace('.', '\\.')} changed in app after it joined ${b.id}`));
  assert.match(plain.err, new RegExp(`wf batch eject --batch ${b.id} --member ${e.id.replace('.', '\\.')}`));
  assert.doesNotMatch(plain.err, /re-add/);
  // The batch then makes a commit of its own: ejecting would rebuild the branch without it.
  commitIn(batchWt, { 'src/b.txt': 'two, integration fix\n' }, 'an integration fix');
  const ownCommit = sh(batchWt, 'git rev-parse HEAD');
  const own = wf(root, ['deliver', '--attempt', b.id, '--owner', 'o'], silent);
  assert.equal(own.code, 75);
  assert.match(own.err, /holds commits of its own \(app@/);
  assert.doesNotMatch(own.err, /re-add/);
  const refused = wf(root, ['batch', 'eject', '--batch', b.id, '--member', m2, '--owner', 'o'], silent);
  assert.equal(refused.code, 75);
  assert.equal(refusals({ root }).at(-1).id, 'batch:eject-own-commits');
  assert.match(refused.err, new RegExp(`${b.id} holds 1 commit of its own \\(app@${ownCommit.slice(0, 10)}\\)`));
  assert.match(refused.err, /wf scope move --finding <ref> --sibling BATCH-1/);
  assert.deepEqual(state(root, b.id).batch.members, [e.id, m2], 'nothing was ejected');
  assert.equal(state(root, m2).batchOf, b.id);
  assert.equal(sh(batchWt, 'git rev-parse HEAD'), ownCommit, 'the batch branch was not rebuilt');
  // Dropping them is possible, knowingly, and the ledger keeps what was dropped.
  ok(wf(root, ['batch', 'eject', '--batch', b.id, '--member', m2, '--drop-own-commits', '--owner', 'o'], silent));
  assert.deepEqual(state(root, b.id).batch.members, [e.id]);
  assert.notEqual(sh(batchWt, 'git rev-parse HEAD'), ownCommit);
  assert.deepEqual(readLedger(root, b.id).filter((r) => r.type === 'batch.members').at(-1).data.droppedCommits, [{ repo: 'app', commit: ownCommit }]);
});

test('a medium discovered issue closed fixed after the last review is delivered, and the known limits say no reviewer verified it', () => {
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
  // Since 0.7.8 (D18) delivery does not wait for a round that sees the fix (any level): the tester is told instead.
  ok(wf(root, ['deliver', '--attempt', e.id], silent));
  const done = loadState(root, e.id);
  assert.equal(done.phase, 'done');
  assert.equal(done.discovered.find((d) => d.id === 'D1').status, 'fixed');
  assert.match(knownLimits(done), /Fixed after the last review, not verified by a reviewer: the export sums one page only\./);
});

test('when the holder of a moved finding leaves the batch, the rest of the batch still delivers, and the known limits say the sibling still owes the item', () => {
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
  // Ejecting the holder asks nothing (D18, 0.7.8); the eject, and the delivery that follows, are the point of this scenario.
  ok(wf(root, ['batch', 'eject', '--batch', b.id, '--member', m2, '--reason', 'PM-2 waits', '--owner', 'o'], silent));
  assert.deepEqual(state(root, m2).decisions ?? [], [], 'nothing was put to the person');
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', b.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb', '--attempt', b.id, '--owner', 'o']));
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'rb', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [] }), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id, '--owner', 'o']));
  // The batch delivers (the sibling, standalone, still owes the moved item), and the delivered known limits say so.
  ok(wf(root, ['deliver', '--attempt', b.id, '--owner', 'o'], silent));
  assert.equal(state(root, b.id).phase, 'done');
  assert.equal(state(root, m2).discovered.at(-1).status, 'open');
  assert.match(knownLimits(loadState(root, e.id), { load: (id) => loadState(root, id) }), new RegExp(`Moved to ${m2.replace('.', '\\.')}, which is not in this delivery: credit note never exported to accounting is still open there \\(belongs with PM-2\\)`));
});

test('a low item closed fixed after the last review is a known limit: no reviewer verified it', () => {
  const p = project('d17-limits');
  ok(run(p, ['discovered', 'add', '--summary', 'a label wraps on a phone', '--severity', 'low']));
  const wt = state(p.root, p.id).repos.app.worktree;
  commitIn(wt, { 'src/old.txt': 'o1\no2\no3 wrapped\n' }, 'fix the label');
  ok(run(p, ['discovered', 'close', 'D4', '--fixed', sh(wt, 'git rev-parse HEAD')]));
  assert.match(knownLimits(loadState(p.root, p.id)), /Fixed after the last review, not verified by a reviewer: a label wraps on a phone\./);
});

// 0.7.24 (I-181), named failure (found fixing I-177): an abandoned batch left each member pointing at it, so a member could be
// neither delivered alone, ejected (the batch's worktree was gone) nor batched again.
test('0.7.24 (I-181): abandoning an assembled batch releases its members; a member left behind by an earlier abandon is ejected from it', () => {
  const { root, e, m2, b } = acceptedBatch('i181-release');
  ok(wf(root, ['abandon', '--reason', 'deliver them one by one', '--attempt', b.id, '--owner', 'o'], silent));
  for (const id of [e.id, m2]) assert.equal(state(root, id).batchOf, null, `${id} is free again`);
  assert.equal((state(root, b.id).decisions ?? []).filter((x) => x.kind === 'move-out-of-batch').length, 0, 'members no split put together leave without a question');
  assert.deepEqual(readLedger(root, b.id).find((x) => x.type === 'abandoned').data.released, [e.id, m2]);
  ok(wf(root, ['batch', 'create', '--members', `${e.id},${m2}`, '--owner', 'o']));

  // A batch abandoned before 0.7.24 kept its members; its worktree is gone. Each member leaves it with `wf batch eject`.
  const old = acceptedBatch('i181-stranded');
  append(old.root, old.b.id, 'abandoned', { reason: 'abandoned by an earlier engine' }, 'human:scenario');
  fs.rmSync(path.dirname(state(old.root, old.b.id).repos.app.worktree), { recursive: true, force: true });
  assert.equal(state(old.root, old.e.id).batchOf, old.b.id, 'stranded');
  ok(wf(old.root, ['batch', 'eject', '--batch', old.b.id, '--member', old.e.id, '--owner', 'o'], silent));
  assert.equal(state(old.root, old.e.id).batchOf, null);
  assert.match(wf(old.root, ['batch', 'eject', '--batch', old.b.id, '--member', old.e.id, '--owner', 'o'], silent).err, /is not in .* any more/);
});
