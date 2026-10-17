// 0.7.27 (I-191), named failure (field): a ticket ran ten and more review rounds where each round found the next place one wrong
// assumption lived (a state only an invoice has, treated as true of a pending rate, built into six places). Every role worked
// one finding at a time. The fix round was handed the findings open now, grouped by the reviewer's symptom labels, and told to
// find the cause of each family and fix it once, so it fixed that path's cause and never the shared assumption; the delta
// reviewer's goal was whether the change fixed what it set out to fix, so a fix that held at its one place was `fixed` while the
// cause lived elsewhere; and nothing told the owner that findings across rounds shared a cause. Now the fix round's goal is that
// no review finds the problem again anywhere (the bundle carries the finding history), a reviewer judges the cause and links
// the findings that share it (`sameCauseAs`), and `wf resume` and `wf signals` say when a cause came back after a fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, wf, write } from './helpers.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true' }];
const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';
const CHANGED = LINES.replace('l2', 'L2').replace('l5', 'L5');

function project(name) {
  const p = singleRepoProject(name, { gate: { steps } }, { 'src/a.txt': LINES, 'src/old.txt': 'o1\no2\no3\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'RC-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': CHANGED }, 'implement C1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  return { ...p, id: e.id, wt: e.repos.app.worktree };
}
const bundleOf = (r) => JSON.parse(fs.readFileSync(r.out.match(/^Read (\S+)/m)[1], 'utf8'));
const hand = (p, agent) => bundleOf(ok(wf(p.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', p.id])));
const record = (p, closure) => wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', p.id]);
const finding = (id, evidence, extra = {}) => ({ id, severity: 'major', summary: `${id} is wrong`, status: 'open', evidence, criterion: 'C1', ...extra });
// A fix round: an implementer is handed the open findings, commits, and is closed. Returns its bundle.
let fixes = 0;
const fixRound = (p, files, subject, trailer = null) => {
  const agent = `fix-${++fixes}`;
  const bundle = JSON.parse(fs.readFileSync(ok(wf(p.root, ['handoff', 'implementer', '--agent', agent, '--attempt', p.id, '--json'])).json().bundle, 'utf8'));
  if (trailer) {
    for (const [rel, content] of Object.entries(files)) write(p.wt, rel, content);
    sh(p.wt, `git add -A && git commit -q -m ${JSON.stringify(subject)} -m ${JSON.stringify(trailer)}`);
  } else commitIn(p.wt, files, subject);
  ok(wf(p.root, ['handoff', 'close', '--agent', agent, '--attempt', p.id]));
  return bundle;
};
const signals = (p) => ok(wf(p.root, ['signals', '--attempt', p.id, '--json'])).json();
const resume = (p) => ok(wf(p.root, ['resume', '--attempt', p.id, '--json'])).json();

test('a finding that shares its cause with a finding already marked fixed is a recurring cause: resume and signals say so and point to a root-cause pass, and the next fix round is handed the history with the cause marked', () => {
  const p = project('rc-recurring');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [finding('F1', 'src/a.txt:2 treats a pending rate as one only an invoice has', { family: 'pending-rate-label' })] })));
  // The first fix round: its goal is that no review finds the problem again anywhere, and it is handed the history so far.
  const first = fixRound(p, { 'src/a.txt': CHANGED.replace('L2', 'L2 fixed') }, 'fix the label', 'Fixes-finding: r1:F1');
  assert.match(first.instructions, /Your goal: no review finds this problem again, anywhere, and the criteria you were handed hold on the whole combined tree/);
  assert.match(first.instructions, /for each finding name the assumption or rule behind it, find every place that relies on it, fix them all and prove the class/);
  assert.deepEqual(first.findingHistory.map((h) => [h.ref, h.status]), [['r1:F1', 'open']]);
  assert.equal(first.recurringCauses, undefined, 'nothing has come back yet');
  // The delta reviewer judges the cause, not the place: the fix holds where it showed up (F1 fixed), and the same cause lives in
  // another place (a new finding, linked to F1).
  const delta = hand(p, 'r2');
  assert.equal(delta.mode, 'delta');
  assert.match(delta.instructions, /Judge the cause, not the place: a finding fixed where it showed up while the same cause remains elsewhere is not fixed/);
  assert.match(delta.instructions, /`sameCauseAs: \["<round>:<id>"\]`/);
  ok(record(p, goodClosure('r2', {
    criteria: [],
    findings: [finding('F1', 'src/a.txt:5 the same assumption, in the export', { family: 'pending-rate-export', sameCauseAs: ['r1:F1'] })],
    priorFindings: [{ round: 'r1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:2 keeps the label' }],
  })));
  // The owner is told, plainly, in every place it looks.
  const line = /the cause of r1:F1 came back in r2:F1: the last fix covered one place; find the root cause before the next fix round \(an analysis of the assumption behind them and every place that relies on it, or the strategist's `cluster`\)/;
  const sig = signals(p);
  assert.deepEqual(sig.recurringCauses.map((x) => [x.cause, x.again, x.fixed]), [['cause-1', 'r2:F1', ['r1:F1']]]);
  assert.match(ok(wf(p.root, ['signals', '--attempt', p.id])).out, line);
  const state = resume(p);
  assert.equal(state.decision.kind, 'repair');
  assert.match(state.decision.guidance, line, 'the next step starts with it');
  assert.match(ok(wf(p.root, ['resume', '--attempt', p.id])).out, line);
  assert.match(ok(wf(p.root, ['status', '--attempt', p.id])).out, line);
  // The next fix round: the whole history, the shared cause marked on both findings, and the recurrence.
  const second = fixRound(p, { 'src/a.txt': CHANGED.replace('L2', 'L2 fixed').replace('L5', 'L5 fixed') }, 'fix the export', 'Fixes-finding: r2:F1');
  const [one, two] = second.findingHistory;
  assert.deepEqual([one.ref, one.status, one.cause, one.verifiedBy], ['r1:F1', 'fixed', 'cause-1', 'r2']);
  assert.match(one.fix.commit, /^[0-9a-f]{10}$/, 'the fix recorded for it');
  assert.equal(one.family, 'pending-rate-label');
  assert.deepEqual([two.ref, two.status, two.cause, two.sameCauseAs], ['r2:F1', 'open', 'cause-1', ['r1:F1']]);
  assert.deepEqual(second.repair.flatMap((g) => g.findings.map((f) => [f.ref, f.cause])), [['r2:F1', 'cause-1']], 'the findings to fix say which cause they share');
  assert.deepEqual(second.recurringCauses.map((x) => [x.again, x.fixed]), [['r2:F1', ['r1:F1']]]);
  assert.deepEqual(second.recurringCauses[0].fixes.map((x) => [x.finding, x.repo]), [['r1:F1', 'app']], 'with the fix recorded for the earlier finding');
  // A reviewer who verifies the cause fixed everywhere ends the recurrence.
  hand(p, 'r3');
  ok(record(p, goodClosure('r3', { criteria: [], priorFindings: [{ round: 'r2', id: 'F1', status: 'fixed', evidence: 'src/a.txt:5 keeps the label' }] })));
  assert.deepEqual(signals(p).recurringCauses, []);
  assert.doesNotMatch(ok(wf(p.root, ['resume', '--attempt', p.id])).out, /came back in/);
});

test('findings that share a cause but have not come back after a fix are marked as one cause and are no recurrence', () => {
  const p = project('rc-shared');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [finding('F1', 'src/a.txt:2 wrong'), finding('F2', 'src/a.txt:5 wrong', { sameCauseAs: ['r1:F1'] })] })));
  const bundle = fixRound(p, { 'src/a.txt': CHANGED.replace('L2', 'L2 fixed') }, 'fix');
  assert.deepEqual(bundle.findingHistory.map((h) => [h.ref, h.cause]), [['r1:F1', 'cause-1'], ['r1:F2', 'cause-1']]);
  assert.deepEqual(bundle.repair.flatMap((g) => g.findings.map((f) => [f.ref, f.cause])), [['r1:F1', 'cause-1'], ['r1:F2', 'cause-1']]);
  assert.equal(bundle.recurringCauses, undefined);
  assert.deepEqual(signals(p).recurringCauses, []);
  // A delta reviewer is handed the open findings with the cause marked as well.
  const delta = hand(p, 'r2');
  assert.deepEqual(delta.openFindings.map((f) => [f.id, f.cause]), [['F1', 'cause-1'], ['F2', 'cause-1']]);
});

test('a closure whose sameCauseAs names a finding no round raised is refused with a hint; a finding of the same closure and an earlier round are named alike', () => {
  const p = project('rc-unknown');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [finding('F1', 'src/a.txt:2 wrong')] })));
  fixRound(p, { 'src/a.txt': CHANGED.replace('L2', 'L2 fixed') }, 'fix');
  hand(p, 'r2');
  const prior = [{ round: 'r1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:2 fine' }];
  const unknown = record(p, goodClosure('r2', { criteria: [], priorFindings: prior, findings: [finding('F1', 'src/a.txt:5 wrong', { sameCauseAs: ['r9:F9'] })] }));
  assert.equal(unknown.code, 75);
  assert.match(unknown.err, /F1: `sameCauseAs` names r9:F9, which no round of this attempt \(nor this closure\) raised/);
  assert.match(unknown.err, /name a finding as "<round>:<id>"/);
  const log = path.join(p.root, '..', 'refusals.jsonl');
  assert.equal(JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1)).id, 'review:same-cause-unknown');
  for (const bad of ['r1:F1', ['no-colon'], ['r2:F1']]) {
    const refused = record(p, goodClosure('r2', { criteria: [], priorFindings: prior, findings: [finding('F1', 'src/a.txt:5 wrong', { sameCauseAs: bad })] }));
    if (JSON.stringify(bad) === JSON.stringify(['r2:F1'])) assert.match(refused.err, /names the finding itself/);
    else assert.match(refused.err, /is a list of "<round>:<id>"/);
    assert.equal(refused.code, 75);
  }
  assert.equal(signals(p).rounds.length, 1, 'none of them was recorded');
  // Named right, the same closure records: one finding names an earlier round's, another names a sibling in this closure.
  ok(record(p, goodClosure('r2', { criteria: [], priorFindings: prior, findings: [finding('F1', 'src/a.txt:5 wrong', { sameCauseAs: ['r1:F1'] }), finding('F2', 'src/a.txt:6 wrong', { sameCauseAs: ['r2:F1'] })] })));
  assert.deepEqual(signals(p).recurringCauses.map((x) => [x.again, x.fixed]), [['r2:F1', ['r1:F1']]]);
});

test('a blind evidence closure takes its sameCauseAs in the second record, with the earlier findings it can then see; its findings are otherwise as recorded', () => {
  const p = project('rc-reveal');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [finding('F1', 'src/a.txt:2 wrong')] })));
  fixRound(p, { 'src/a.txt': CHANGED.replace('L2', 'L2 fixed') }, 'fix');
  hand(p, 'r2');
  ok(record(p, goodClosure('r2', { criteria: [], priorFindings: [{ round: 'r1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:2 fine' }] })));
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  const evidence = hand(p, 'r3');
  assert.deepEqual([evidence.mode, evidence.round], ['full', 'evidence-review']);
  assert.match(evidence.instructions, /Judge the cause, not the place/);
  const blind = goodClosure('r3', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log' } }], findings: [finding('F7', 'src/a.txt:5 the same assumption again')] });
  ok(record(p, blind));
  // After the blind record the earlier findings are visible; the link is added with the verdicts, nothing else changes.
  const linked = { ...blind, findings: [{ ...blind.findings[0], sameCauseAs: ['r1:F1'] }], priorFindings: [{ round: 'r1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:2 fine' }] };
  ok(record(p, linked));
  assert.deepEqual(signals(p).recurringCauses.map((x) => [x.again, x.fixed]), [['r3:F7', ['r1:F1']]]);
  const changed = record(p, { ...linked, findings: [{ ...linked.findings[0], summary: 'F7 is something else now' }] });
  assert.equal(changed.code, 75);
  assert.match(changed.err, /your own findings were recorded blind and cannot change once `priorFindings` are added/);
});

// 0.7.27 (I-191, the family half). Named failure (field): the same ticket's reviewers raised `tax-currency-unstored-facts` in one
// round, saw it marked fixed, and raised it again in the next round (twice) without writing `sameCauseAs`, so the recurrence
// was visible only to someone who compared the labels. A finding still open that has the family of an earlier finding marked
// fixed is shown as a possible recurrence: information worded for what the engine knows (a label matched), distinct from a
// reviewer-confirmed link.
test('a finding open with the family of an earlier finding marked fixed is shown as a possible recurring cause, apart from a confirmed one', () => {
  const p = project('rc-family');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [finding('F1', 'src/a.txt:2 wrong', { family: 'tax-facts' }), finding('F2', 'src/old.txt:1 wrong', { family: 'other-family' })] })));
  const first = fixRound(p, { 'src/a.txt': CHANGED.replace('L2', 'L2 fixed') }, 'fix', 'Fixes-finding: r1:F1');
  assert.equal(first.possibleRecurrences, undefined, 'nothing has come back');
  hand(p, 'r2');
  // F1 is verified fixed where it showed up; F2 stays open (a different family); the same family comes back as F1 and F2 of r2,
  // and F3 has a family no earlier finding had.
  ok(record(p, goodClosure('r2', {
    criteria: [],
    findings: [finding('F1', 'src/a.txt:5 wrong again', { family: 'tax-facts' }), finding('F2', 'src/a.txt:6 wrong again', { family: 'tax-facts' }), finding('F3', 'src/a.txt:3 new', { family: 'new-family' })],
    priorFindings: [{ round: 'r1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:2 fine' }, { round: 'r1', id: 'F2', status: 'open', evidence: 'src/old.txt:1 still wrong' }],
  })));
  const line = (again) => new RegExp(`${again} has the family of r1:F1 \\(tax-facts\\), which was marked fixed: the last fix may have covered one place; check whether they share a cause`);
  const sig = signals(p);
  assert.deepEqual(sig.familyRecurrences.map((x) => [x.again, x.fixed, x.family]), [['r2:F1', ['r1:F1'], 'tax-facts'], ['r2:F2', ['r1:F1'], 'tax-facts']]);
  assert.deepEqual(sig.recurringCauses, [], 'no reviewer confirmed a shared cause');
  const text = ok(wf(p.root, ['signals', '--attempt', p.id])).out;
  for (const again of ['r2:F1', 'r2:F2']) assert.match(text, line(again));
  assert.doesNotMatch(text, /r2:F3 has the family|r1:F2 has the family/);
  assert.doesNotMatch(text, /the cause of .* came back in/, 'not claimed as a confirmed recurrence');
  for (const cmd of ['resume', 'status']) assert.match(ok(wf(p.root, [cmd, '--attempt', p.id])).out, line('r2:F1'), cmd);
  assert.match(resume(p).decision.guidance, /^possible recurring cause: r2:F1 has the family of r1:F1/, 'the next step starts with it');
  const strategist = JSON.parse(fs.readFileSync(ok(wf(p.root, ['handoff', 'strategist', '--agent', 'strat-f', '--attempt', p.id, '--reason', 'the family came back', '--json'])).json().bundle, 'utf8'));
  assert.ok(strategist.course.some((l) => line('r2:F1').test(l)), 'the strategist reads the same course');
  // The next fix round's history marks the possible shared cause, apart from a confirmed `cause`.
  const second = fixRound(p, { 'src/a.txt': CHANGED.replace('L2', 'L2 fixed').replace('L5', 'L5 fixed') }, 'fix again', 'Fixes-finding: r2:F1');
  const byRef = Object.fromEntries(second.findingHistory.map((h) => [h.ref, h]));
  assert.deepEqual(byRef['r2:F1'].possibleSameCauseAs, ['r1:F1']);
  assert.deepEqual(byRef['r2:F2'].possibleSameCauseAs, ['r1:F1']);
  assert.equal(byRef['r2:F1'].cause, undefined, 'a label match is not a confirmed cause');
  assert.equal(byRef['r2:F3'].possibleSameCauseAs, undefined);
  assert.equal(byRef['r1:F2'].possibleSameCauseAs, undefined);
  assert.deepEqual(second.possibleRecurrences.map((x) => x.again), ['r2:F1', 'r2:F2']);
  assert.match(second.instructions, /`possibleRecurrences` a family that came back after a fix/);
  // A reviewer who confirms the shared cause turns the pair into a recurring cause, and the family line for that pair goes.
  hand(p, 'r3');
  ok(record(p, goodClosure('r3', {
    criteria: [],
    findings: [finding('F1', 'src/a.txt:6 the same assumption', { family: 'tax-facts', sameCauseAs: ['r1:F1'] })],
    priorFindings: [{ round: 'r2', id: 'F1', status: 'fixed', evidence: 'src/a.txt:5 fine' }, { round: 'r2', id: 'F2', status: 'fixed', evidence: 'src/a.txt:6 fine' }, { round: 'r2', id: 'F3', status: 'fixed', evidence: 'src/a.txt:3 fine' }, { round: 'r1', id: 'F2', status: 'fixed', evidence: 'src/old.txt:1 fine' }],
  })));
  const after = signals(p);
  assert.deepEqual(after.recurringCauses.map((x) => [x.again, x.fixed]), [['r3:F1', ['r1:F1']]]);
  assert.deepEqual(after.familyRecurrences.map((x) => [x.again, x.fixed]), [['r3:F1', ['r2:F1', 'r2:F2']]], 'the other fixed findings of the family are still only a label match');
});
