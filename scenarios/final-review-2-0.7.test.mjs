// The second final review of 0.7.0 (two fresh reviewers, probes O1-O12 and A-D): review rounds converged, but what was
// owed did not. A reviewer's self-rated severity decided it, a nit on a changed line opened a round, every evidence review
// re-opened every screenshot, observations were scheduled only after acceptance, a post-gate fix cost two reviews and a gate,
// and four paths let a defect or the person's decision slip: an owner's "fixed" claim, a reviewer's ignored "open", an
// untagged tenant defect, and a deliver-core answer that never expired. A base merge also made the next delta a review of
// the base's changes. Each test here holds one of those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { knownLimits } from '../engine/tracker.mjs';
import { loadState } from '../engine/ledger.mjs';
import { approveAsOwner, closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, wf, writeReport } from './helpers.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true' }];
const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';
const CHANGED = LINES.replace('l2', 'L2').replace('l5', 'L5');

function project(name, config = {}) {
  const p = singleRepoProject(name, { gate: { steps }, ...config }, { 'src/a.txt': LINES, 'src/old.txt': 'o1\no2\no3\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'FR2-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  const wt = e.repos.app.worktree;
  commitIn(wt, { 'src/a.txt': CHANGED }, 'implement C1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  return { ...p, id: e.id, wt };
}
const hand = (p, agent, opts) => {
  const r = ok(wf(p.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', p.id], opts));
  return JSON.parse(fs.readFileSync(r.out.match(/^Read (\S+)/m)[1], 'utf8'));
};
const record = (p, closure) => wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', p.id]);
const finding = (id, severity, evidence, extra = {}) => ({ id, severity, summary: `${id} is wrong`, status: 'open', evidence, ...extra });
// The check id of each refusal a command printed (D17: `leave:blocks`, `leave:medium-high`), as the refusal log recorded it.
const refusals = (p) => fs.readFileSync(path.join(p.root, '..', 'refusals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const capture = (p, n) => {
  const f = path.join(p.base, `ticket-${n}.json`);
  fs.writeFileSync(f, JSON.stringify({ issue: { identifier: `ENG-${n}`, title: 'follow-up', url: `https://tracker.example.test/ENG-${n}` } }));
  return f;
};
const fixRound = (p, files, msg = 'fix') => {
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]));
  commitIn(p.wt, files, msg);
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', p.id]));
};

test('a later reviewer may re-rate a finding it verifies: re-rated low it stops blocking, but where it may go keeps the higher rating', () => {
  const p = project('fr2-rerate');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [finding('F1', 'major', 'src/a.txt:2 label'), finding('F2', 'medium', 'src/old.txt:1')] })));
  fixRound(p, { 'src/a.txt': CHANGED.replace('l3', 'L3') });
  hand(p, 'r2');
  ok(record(p, goodClosure('r2', { criteria: [], priorFindings: [{ round: 'r1', id: 'F1', status: 'open', evidence: 'src/a.txt:2 only the wording differs', severity: 'low' }, { round: 'r1', id: 'F2', status: 'open', evidence: 'src/old.txt:1 it loses data', severity: 'high' }] })));
  const rows = ok(wf(p.root, ['scope', 'list', '--attempt', p.id, '--json'])).json();
  const row = (ref) => rows.find((r) => r.ref === ref);
  assert.deepEqual([row('r1:F1').blocks, row('r1:F1').placement], [false, 'high'], 're-rated low it no longer opens a round, but it was rated major: it stays in this delivery');
  assert.equal(row('r1:F2').placement, 'high', 're-rated high: it stays in this delivery');
  for (const ref of ['r1:F1', 'r1:F2']) {
    assert.equal(wf(p.root, ['scope', 'defer', '--finding', ref, '--reason', 'later', '--attempt', p.id], { ownerSilent: true }).code, 75, ref);
    assert.equal(refusals(p).at(-1).id, 'leave:medium-high', `${ref} keeps the higher rating, so a deferral is refused, not put to the person`);
  }
  // The gate order agrees with the list: the re-rate verified F1 as no longer round-blocking (verification of the second
  // final review: the list said it no longer blocked while the gate refused it as unverified).
  assert.doesNotMatch(wf(p.root, ['gate', '--attempt', p.id]).err, /has not verified/);
  const report = ok(wf(p.root, ['report', '--attempt', p.id, '--json'])).json().attempts[0];
  assert.deepEqual(report.rerated, { down: 1, up: 1 });
  assert.ok(Object.values(report.severityByModel).length, 'severity is counted per reviewer model');
});

test('a base merge between rounds leaves the next delta to this attempt\'s own lines (Fable probe C)', () => {
  const p = project('fr2-base');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1')));
  const landed = Array.from({ length: 40 }, (_, i) => `main line ${i + 1}`).join('\n') + '\n';
  commitIn(p.root, { 'src/other.txt': landed }, 'another ticket on main');
  sh(p.root, 'git push -q origin main');
  ok(wf(p.root, ['base', 'merge', '--attempt', p.id]));
  const b = hand(p, 'r2');
  assert.equal(b.mode, 'delta');
  assert.deepEqual(b.delta.changed.app, [], 'the base\'s files are not this attempt\'s change');
  assert.equal(b.delta.lines.app['src/other.txt'], undefined);
  ok(record(p, goodClosure('r2', { criteria: [], findings: [finding('F1', 'major', 'src/other.txt:7 a defect another ticket wrote')] })));
  const c = state(p.root, p.id).review.closure.findings[0].classified;
  assert.deepEqual([c.blocks, c.onAttemptLines], [false, false]);
});

test('`wf scope fixed` needs a commit made after the finding; a reviewer\'s "open" undoes it; a high claim waits for a reviewer\'s "fixed" (O1, O2)', () => {
  const p = project('fr2-fixed');
  const before = sh(p.wt, 'git rev-parse HEAD');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [finding('F1', 'high', 'src/old.txt:3 cross-tenant total'), finding('F2', 'medium', 'src/old.txt:1 a confusing label')] })));
  assert.match(wf(p.root, ['scope', 'fixed', '--finding', 'r1:F1', '--commit', before, '--attempt', p.id]).err, /was already in the tree r1:F1 was raised on/);
  fixRound(p, { 'src/old.txt': 'o1 fixed\no2\no3 fixed\n' });
  const fix = sh(p.wt, 'git rev-parse HEAD');
  ok(wf(p.root, ['scope', 'fixed', '--finding', 'r1:F1,r1:F2', '--commit', fix, '--attempt', p.id]));
  // Only the high claim waits for a reviewer's `fixed`; a medium one is settled by the claim again (0.7.8, D18: 0.7.7 made it
  // wait as well, a stop the person did not want), and the delivered comment lists it as not verified by a reviewer.
  const watching = () => ok(wf(p.root, ['scope', 'list', '--attempt', p.id, '--json'])).json().filter((r) => !r.blocks);
  const open = () => ok(wf(p.root, ['signals', '--attempt', p.id, '--json'])).json().observationsOpen.map((o) => o.ref);
  assert.deepEqual(open(), ['r1:F1'], 'the medium claim is settled; the high one is not');
  assert.match(knownLimits(loadState(p.root, p.id)), /Fixed after the last review, not verified by a reviewer: F2 is wrong\./);
  // A delta reviewer finds F1 still open: the claim is undone.
  const b = hand(p, 'r2');
  assert.ok(b.openFindings.find((f) => f.id === 'F1').claimedFixed);
  ok(record(p, goodClosure('r2', { criteria: [], priorFindings: [{ round: 'r1', id: 'F1', status: 'open', evidence: 'src/old.txt:3 still sums the other tenant' }] })));
  assert.equal(watching().find((r) => r.ref === 'r1:F1').disposition, null, 'no longer recorded fixed');
});

test('the person\'s deliver-core answer covers only what was recorded before it (O6)', () => {
  const p = project('fr2-core');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [finding('F1', 'high', 'src/old.txt:2 an older defect')] })));
  for (let i = 0; i < 9; i++) {
    commitIn(p.wt, { 'src/a.txt': `${CHANGED}x${i}\n` });
    ok(wf(p.root, ['handoff', 'reviewer', '--agent', `dead-${i}`, '--attempt', p.id]));
  }
  // Before the answer a high observation is fixed here (D17), the one exception being the answer itself.
  assert.equal(wf(p.root, ['scope', 'ticket', '--finding', 'r1:F1', '--capture', capture(p, 1), '--attempt', p.id], { ownerSilent: true }).code, 75);
  assert.equal(refusals(p).at(-1).id, 'leave:medium-high');
  const refused = wf(p.root, ['handoff', 'reviewer', '--agent', 'r-11', '--attempt', p.id], { ownerSilent: true });
  const id = /wf approve (A\d+)/.exec(refused.err)[1];
  approveAsOwner(p.root, p.id, id, 'deliver-core');
  // Raised before the answer: it may leave under it, whatever its severity.
  ok(wf(p.root, ['scope', 'ticket', '--finding', 'r1:F1', '--capture', capture(p, 1), '--attempt', p.id], { ownerSilent: true }));
  hand(p, 'r-11');
  ok(record(p, goodClosure('r-11', { criteria: [], findings: [finding('F9', 'critical', 'src/old.txt:1 payment double-charge on retry'), finding('F8', 'nit', 'src/old.txt:2 a typo')] })));
  // Raised after it, the answer does not cover them: the high one stays in this delivery, the low one needs the person's answer.
  const after = wf(p.root, ['scope', 'ticket', '--finding', 'r-11:F9', '--capture', capture(p, 2), '--attempt', p.id], { ownerSilent: true });
  assert.equal(after.code, 75);
  assert.match(after.err, /r-11:F9 \(high, rated critical\)/);
  assert.equal(refusals(p).at(-1).id, 'leave:medium-high');
  const low = wf(p.root, ['scope', 'ticket', '--finding', 'r-11:F8', '--capture', capture(p, 3), '--attempt', p.id], { ownerSilent: true });
  assert.equal(low.code, 75);
  assert.equal(refusals(p).at(-1).id, 'leave:ask');
  assert.match(low.err, /A\d+: r-11:F8/);
  assert.deepEqual(state(p.root, p.id).scopeDecisions.map((d) => d.keys), [['r1:F1']], 'only what was recorded before the answer left');
});

test('a discovered issue on a critical invariant is high whatever its rating; ratings can be corrected; several ids each get their own decision (O5)', () => {
  const p = project('fr2-disc');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i2', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': CHANGED.replace('l1', 'L1') }, 'w');
  writeReport(p.root, p.id, 'i2', { left: [{ what: 'the invoice export reads rows of every tenant', where: 'src/old.txt:2', severity: 'medium', invariant: 'tenant isolation' }, { what: 'a tooltip typo', severity: 'low' }, { what: 'a slow list', severity: 'high' }] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i2', '--attempt', p.id], { ownerSilent: true }));
  const [tenant, typo, slow] = state(p.root, p.id).discovered.slice(-3);
  assert.equal(tenant.invariant, 'tenant isolation');
  const tenantClose = wf(p.root, ['discovered', 'close', tenant.id, '--deferred', '--reason', 'pre-existing', '--attempt', p.id], { ownerSilent: true });
  assert.equal(tenantClose.code, 75, 'an invariant issue is high, so it stays in this delivery');
  assert.match(tenantClose.err, new RegExp(`${tenant.id} \\(high, rated medium\\) stays in this delivery`));
  assert.equal(refusals(p).at(-1).id, 'leave:medium-high');
  assert.deepEqual((state(p.root, p.id).decisions ?? []).filter((d) => d.key.includes(tenant.id)), [], 'nothing about it is put to the person');
  // Lowering a rating needs a reason, and out of high the person's decision (verification of the second final review: the
  // agent that wanted to deliver could rate a defect down and defer it alone); the delivered comment shows the change.
  assert.match(wf(p.root, ['discovered', 'rate', slow.id, '--severity', 'medium', '--attempt', p.id]).err, /say why/);
  const down = wf(p.root, ['discovered', 'rate', slow.id, '--severity', 'medium', '--reason', 'only the admin list, 200 rows', '--attempt', p.id], { ownerSilent: true });
  assert.equal(down.code, 75);
  assert.match(down.err, /rate FR2-1\.1:D\d+ down from high to medium/);
  ok(wf(p.root, ['discovered', 'rate', slow.id, '--severity', 'medium', '--reason', 'only the admin list, 200 rows', '--attempt', p.id]));
  assert.deepEqual(state(p.root, p.id).discovered.find((d) => d.id === slow.id).rated.map((r) => [r.from, r.to]), [['high', 'medium']]);
  ok(wf(p.root, ['discovered', 'rate', typo.id, '--severity', 'high', '--attempt', p.id]), 'raising needs no reason');
  ok(wf(p.root, ['discovered', 'rate', typo.id, '--severity', 'low', '--reason', 'a tooltip', '--attempt', p.id]));
  // Re-rated medium, it is fixed in this delivery all the same: a reason does not move it (D17).
  const stays = wf(p.root, ['discovered', 'close', `${typo.id},${slow.id}`, '--deferred', '--reason', 'next sprint', '--attempt', p.id], { ownerSilent: true });
  assert.equal(stays.code, 75);
  assert.match(stays.err, new RegExp(`${slow.id} \\(medium\\) stays in this delivery`));
  assert.equal(refusals(p).at(-1).id, 'leave:medium-high');
  assert.deepEqual(state(p.root, p.id).discovered.filter((d) => [typo.id, slow.id].includes(d.id)).map((d) => d.status), ['open', 'open'], 'the command is refused as a whole');
  // Lowered once more (into low nobody is asked since 0.7.8: only out of high), both are low and each leaves under a question
  // of its own, the two asked together.
  const approved = () => (state(p.root, p.id).decisions ?? []).filter((d) => d.approved).length;
  const before = approved();
  ok(wf(p.root, ['discovered', 'rate', slow.id, '--severity', 'low', '--reason', 'cosmetic on the admin list', '--attempt', p.id]));
  assert.equal(approved(), before, 'rating into low asked nobody');
  const both = `${typo.id},${slow.id}`;
  const asked = wf(p.root, ['discovered', 'close', both, '--deferred', '--reason', 'next sprint', '--attempt', p.id], { ownerSilent: true });
  assert.equal(asked.code, 75);
  assert.equal(asked.err.match(/then: wf approve A\d+ --from-question/g).length, 2, 'one question per id');
  // Each question shows who rated the item and every re-rating, with its reason (what the person weighs when they answer).
  assert.match(asked.err, new RegExp(`${typo.id}: a tooltip typo \\(low, rated by its implementer i2, re-rated low to high, high to low \\(a tooltip\\)\\)\\. Fix it now, or let it leave`));
  assert.match(asked.err, new RegExp(`${slow.id}: a slow list \\(low, rated by its implementer i2, re-rated high to medium \\(only the admin list, 200 rows\\), medium to low \\(cosmetic on the admin list\\)\\)\\. Fix it now, or let it leave`));
  ok(wf(p.root, ['discovered', 'close', both, '--deferred', '--reason', 'next sprint', '--attempt', p.id]));
  const left = state(p.root, p.id).discovered.filter((d) => [typo.id, slow.id].includes(d.id));
  assert.deepEqual(left.map((d) => d.status), ['deferred', 'deferred']);
  assert.equal(approved(), 4, 'the person decided the two ratings out of high and, one per item, the two deferrals');
  const leaves = (state(p.root, p.id).decisions ?? []).filter((d) => d.key.startsWith('leave:'));
  assert.deepEqual(leaves.map((d) => [d.key, d.approved?.choice]).sort(), [[`leave:${slow.id}`, 'let it leave'], [`leave:${typo.id}`, 'let it leave']].sort(), 'one decision per id');
  assert.deepEqual(left.map((d) => d.deferred.source.decision), [typo.id, slow.id].map((id) => leaves.find((d) => d.key === `leave:${id}`).id), 'each closure names its own item\'s decision');
});

test('open observations are named before the gate, and what waits as a known issue is in every reviewer\'s followUps (O7, O8)', () => {
  const p = project('fr2-obs');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [finding('F1', 'high', 'src/old.txt:3 export sums one page'), finding('F2', 'low', 'src/old.txt:1 a confusing label')] })));
  const next = state(p.root, p.id).next;
  assert.match(next, /2 open observation\(s\) to place first: r1:F1/);
  assert.match(next, /then run one `wf gate`/);
  // Only the low one may wait (with the person's answer); the high one is fixed here.
  ok(wf(p.root, ['scope', 'defer', '--finding', 'r1:F2', '--reason', 'redesign next sprint', '--attempt', p.id]));
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  const ev = hand(p, 'r2');
  assert.deepEqual(ev.followUps.map((f) => [f.ref, f.went]), [['r1:F2', 'deferred']]);
});

test('after an evidence review\'s blocking findings are fixed by the implementer, the gate runs without another code review; the evidence delta verifies the fix', () => {
  const p = project('fr2-evfix');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1')));
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  hand(p, 'r2');
  ok(record(p, goodClosure('r2', { findings: [finding('F1', 'major', 'src/a.txt:2 wrong label')] })));
  fixRound(p, { 'src/a.txt': CHANGED.replace('L2', 'L2 fixed') });
  assert.match(state(p.root, p.id).next, /the evidence review's findings are fixed by the implementers handed after it/);
  ok(wf(p.root, ['gate', '--attempt', p.id]), 'no person decision needed');
  assert.equal((state(p.root, p.id).decisions ?? []).length, 0);
  const ev = hand(p, 'r3');
  assert.deepEqual([ev.mode, ev.round], ['delta', 'evidence-review']);
  assert.ok(ev.openFindings.some((f) => f.id === 'F1' && f.blocks), 'the fix is verified in the evidence delta');
  ok(record(p, goodClosure('r3', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log' } }], priorFindings: [{ round: 'r2', id: 'F1', status: 'fixed', evidence: 'src/a.txt:2' }] })));
  ok(wf(p.root, ['accept', '--attempt', p.id]));
});

test('an evidence review inspects only screenshots whose bytes no earlier review inspected', () => {
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf en > shots/en.png && printf "$(cat src/a.txt | head -1)" > shots/fr.png', artifacts: ['shots/*.png'] }];
  const p = project('fr2-shots', { gate: { steps: visual } });
  fs.appendFileSync(path.join(p.wt, '.gitignore'), 'shots/\n');
  commitIn(p.wt, {}, 'ignore shots');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1')));
  const shas1 = JSON.parse(ok(wf(p.root, ['gate', '--attempt', p.id, '--json'])).out).steps[0].artifacts.map((a) => a.sha256);
  hand(p, 'r2');
  ok(record(p, goodClosure('r2', { findings: [finding('F1', 'major', 'src/a.txt:2 wrong label')], screenshotsInspected: shas1, anomalies: 'none seen' })));
  fixRound(p, { 'src/a.txt': CHANGED.replace('l1', 'first line changed') });
  const shas2 = JSON.parse(ok(wf(p.root, ['gate', '--attempt', p.id, '--json'])).out).steps[0].artifacts.map((a) => a.sha256);
  const ev = hand(p, 'r3');
  const seenBefore = ev.gate.screenshots.filter((s) => s.inspectedBefore).map((s) => s.sha256);
  const fresh = shas2.filter((s) => !shas1.includes(s));
  assert.equal(fresh.length, 1, 'one capture changed');
  assert.deepEqual(seenBefore, shas2.filter((s) => shas1.includes(s)));
  ok(record(p, goodClosure('r3', { screenshotsInspected: fresh, anomalies: 'none seen', criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log' } }], priorFindings: [{ round: 'r2', id: 'F1', status: 'fixed', evidence: 'src/a.txt:2' }] })));
  ok(wf(p.root, ['accept', '--attempt', p.id]), 'the unchanged capture was inspected before');
});

test('the gate goes straight on only to fix what an evidence review raised: not after a clean one, not after new scope', () => {
  const p = project('fr2-evscope');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1')));
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  hand(p, 'r2');
  ok(record(p, goodClosure('r2')));
  // A clean evidence review, then more work: it goes through a code review first.
  fixRound(p, { 'src/old.txt': 'o1 extended\no2\no3\n' }, 'more scope');
  assert.match(state(p.root, p.id).next, /code review: hand to/);
  assert.equal(wf(p.root, ['gate', '--attempt', p.id], { ownerSilent: true }).code, 75);
});

test('a high observation claimed fixed tells the owner to hand a reviewer to verify it', async () => {
  const p = project('fr2-claimnext');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [finding('F1', 'high', 'src/old.txt:3 cross-tenant total')] })));
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  hand(p, 'r2');
  ok(record(p, goodClosure('r2', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log' } }] })));
  ok(wf(p.root, ['accept', '--attempt', p.id]));
  fixRound(p, { 'src/old.txt': 'o1\no2\no3 fixed\n' });
  ok(wf(p.root, ['scope', 'fixed', '--finding', 'r1:F1', '--commit', sh(p.wt, 'git rev-parse HEAD'), '--attempt', p.id]));
  const { observationLines } = await import('../engine/scope-decisions.mjs');
  const { loadState } = await import('../engine/ledger.mjs');
  assert.match(observationLines(loadState(p.root, p.id)).join('\n'), /r1:F1: .*claimed fixed: a fresh reviewer verifies it, `wf handoff reviewer --agent <new id>`/);
});
