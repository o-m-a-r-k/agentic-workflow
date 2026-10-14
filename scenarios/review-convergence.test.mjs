// 0.7.0 (D2): review convergence. Named failures: "a fresh blind reviewer finds nothing on the whole tree" never held
// (reviewers find about two issues per hundred tool calls on every model, and one ticket ran 47 rounds, the last
// ones on older code the ticket merely touched); 512 of 595 discovered items were an implementer's own lint or fixture
// fixes and each became a verdict item for the next reviewer; an 11-finding fix round became 1,059 sweep hits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, wf } from './helpers.mjs';
import { loadState } from '../engine/ledger.mjs';
import { blockingIn, locationIn, observations, openAcrossRounds, roundMode } from '../engine/review-policy.mjs';
import { hashValue } from '../engine/util.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true' }];
const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';
const CHANGED = LINES.replace('l2', 'L2');

// One attempt with a committed change: only line 2 of src/a.txt differs from the base; src/old.txt is untouched.
function project(name, config = {}) {
  const p = singleRepoProject(name, { gate: { steps }, ...config }, { 'src/a.txt': LINES, 'src/old.txt': 'o1\no2\no3\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'RC-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  const wt = e.repos.app.worktree;
  commitIn(wt, { 'src/a.txt': CHANGED });
  return { ...p, id: e.id, wt };
}
const hand = (p, agent) => {
  const out = ok(wf(p.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', p.id])).out.trim();
  return JSON.parse(fs.readFileSync(out.match(/^Read (\S+)/)[1], 'utf8'));
};
const record = (p, closure) => wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', p.id]);
const finding = (id, extra = {}) => ({ id, severity: 'major', summary: `${id} is wrong`, status: 'open', evidence: 'src/old.txt:3', ...extra });
const classified = (p, id) => state(p.root, p.id).review.closure.findings.find((f) => f.id === id).classified;

test('round mode: the first code review is full, the rounds in between are deltas, the first evidence review is full', () => {
  const p = project('rc-modes');
  const r1 = hand(p, 'r1');
  assert.equal(r1.mode, 'full');
  assert.equal(r1.round, 'code-review');
  assert.equal(r1.budget, undefined, 'no effort budget: the delta is what bounds a review');
  assert.ok(r1.plan !== undefined && r1.rules !== undefined && r1.designSystem !== undefined && r1.outsidePlan !== undefined, 'a full bundle carries the plan and the full-round obligations');
  assert.equal(r1.criteriaAmendments, undefined, 'never the attempt\'s amendment history');
  assert.equal(r1.delta, undefined);
  ok(record(p, goodClosure('r1')));
  commitIn(p.wt, { 'src/a.txt': CHANGED.replace('l5', 'L5') });
  const r2 = hand(p, 'r2');
  assert.equal(r2.mode, 'delta');
  assert.equal(r2.round, 'code-review');
  assert.equal(r2.budget, undefined);
  assert.deepEqual(r2.delta.changed.app, ['src/a.txt'], 'the diff since the tree r1 judged');
  assert.deepEqual(r2.delta.lines.app['src/a.txt'], [[5, 5]]);
  assert.match(r2.delta.diff.app, /git -C .* diff [0-9a-f]{40} HEAD$/);
  assert.deepEqual(r2.openFindings, []);
  for (const k of ['plan', 'rules', 'skills', 'impactMap', 'lessons', 'historicalReports', 'criteriaAmendments', 'flaky']) assert.equal(r2[k], undefined, `a delta bundle carries no ${k}`);
  // The design-system hits of a delta round are those on the files changed since the last reviewed tree; this project has
  // no design system, so there are none to hand (the hits themselves: scenarios/handoff-quality.test.mjs).
  assert.equal(r2.designSystem, null);
  assert.deepEqual(r2.addedRepos, [], 'the repos added during the attempt are listed in every reviewer bundle, delta included');
  assert.ok(r2.criteria.length && 'invariants' in r2, 'the criteria and the invariants stay');
  assert.match(r2.instructions, /This is a delta review/);
  ok(record(p, goodClosure('r2', { criteria: [] })));
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  const r3 = hand(p, 'r3');
  assert.equal(r3.mode, 'full');
  assert.equal(r3.round, 'evidence-review');
  assert.ok(r3.gate.passedOnThisTree && r3.plan !== undefined);
  assert.deepEqual(state(p.root, p.id).handoffs.filter((h) => h.role === 'reviewer').map((h) => h.mode), ['full', 'delta', 'full']);
});

test('round mode: a first round that was handed but never recorded was not a full audit', () => {
  const handoff = { role: 'reviewer', bundle: 'b1', round: 'code-review', mode: 'full' };
  assert.equal(roundMode({ handoffs: [handoff], reviews: [] }, { evidence: false }), 'full');
  assert.equal(roundMode({ handoffs: [handoff], reviews: [{ handoff: 'b1' }] }, { evidence: false }), 'delta');
  assert.equal(roundMode({ handoffs: [handoff], reviews: [{ handoff: 'b1' }] }, { evidence: true }), 'full');
  // A strategist's delta-review decision makes the next code review a delta; the evidence review stays a full audit.
  const decided = { handoffs: [handoff], reviews: [{ handoff: 'b1' }], strategy: { nextRound: 'delta' } };
  assert.equal(roundMode(decided, { evidence: false }), 'delta');
  assert.equal(roundMode(decided, { evidence: true }), 'full');
  assert.equal(roundMode({ handoffs: [], reviews: [], strategy: { nextRound: 'delta' } }, { evidence: false }), 'full', 'a delta needs a reviewed tree to start from');
  // The evidence review is the second and last full audit: once one was recorded, a later one (after a fix) is a delta.
  const evidence = { role: 'reviewer', bundle: 'b2', round: 'evidence-review', mode: 'full' };
  assert.equal(roundMode({ handoffs: [handoff, evidence], reviews: [{ handoff: 'b1' }, { handoff: 'b2' }] }, { evidence: true }), 'delta', 'a second evidence review is a delta');
  assert.equal(roundMode({ handoffs: [handoff, evidence], reviews: [{ handoff: 'b1' }, { handoff: 'b2' }] }, { evidence: false }), 'delta');
  assert.equal(roundMode({ handoffs: [handoff, evidence], reviews: [{ handoff: 'b1' }] }, { evidence: true }), 'full', 'an evidence review that was handed and never recorded audited nothing');
  // A ledger from before 0.7 recorded no mode: its code review was a full round.
  assert.equal(roundMode({ handoffs: [{ role: 'reviewer', bundle: 'b1', round: 'code-review' }], reviews: [{ handoff: 'b1' }] }, { evidence: false }), 'delta');
});

test('a delta-round finding on lines unchanged since the last round is an observation and does not block the gate', () => {
  const p = project('rc-observation');
  ok(record(hand(p, 'r1') && p, goodClosure('r1')));
  commitIn(p.wt, { 'src/a.txt': CHANGED.replace('l5', 'L5') });
  hand(p, 'r2');
  // F1: a file the ticket never touched. F2: a line the ticket changed, but in a round already reviewed (not in this delta).
  ok(record(p, goodClosure('r2', { criteria: [], findings: [finding('F1', { evidence: 'src/old.txt:3 no empty-state check' }), finding('F2', { severity: 'critical', evidence: 'src/a.txt:2 label is stale' })] })));
  const f1 = classified(p, 'F1');
  const f2 = classified(p, 'F2');
  assert.equal(f1.blocks, false);
  assert.match(f1.reason, /^observation: .*no line this attempt changed/);
  assert.equal(f2.blocks, false, 'severity alone never blocks');
  assert.equal(f2.onAttemptLines, true);
  assert.equal(f2.causedByChange, false, 'caused by an earlier round, not by this delta');
  assert.match(f2.reason, /changed in an earlier round \(src\/a\.txt:2\), not in this delta/);
  ok(wf(p.root, ['gate', '--attempt', p.id]), 'observations never hold the gate');
  assert.deepEqual(observations(loadState(p.root, p.id)).map((f) => f.ref), ['r2:F1', 'r2:F2']);
  const list = ok(wf(p.root, ['scope', 'list', '--attempt', p.id, '--json'])).json();
  assert.deepEqual(list.map((r) => [r.ref, r.blocks]), [['r2:F1', false], ['r2:F2', false]]);
  // A finding on a line this delta changed is a regression on changed lines: it blocks.
  const q = project('rc-regression');
  ok(record(hand(q, 'r1') && q, goodClosure('r1')));
  commitIn(q.wt, { 'src/a.txt': CHANGED.replace('l5', 'L5') });
  hand(q, 'r2');
  ok(record(q, goodClosure('r2', { criteria: [], findings: [finding('F3', { evidence: 'src/a.txt:5 loses the label' })] })));
  assert.equal(classified(q, 'F3').blocks, true);
  assert.equal(classified(q, 'F3').causedByChange, true);
  assert.match(wf(q.root, ['gate', '--attempt', q.id]).err, /has open findings \(F3\)/);
});

test('a finding that cites a failed criterion or a critical invariant blocks wherever it points; severity and an unknown criterion do not', () => {
  const p = project('rc-criterion');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [
    finding('F1', { criterion: 'C1' }),
    finding('F2', { criterion: 'C9' }),
    finding('F3', { invariant: 'tenant isolation: another workspace sees the row' }),
    finding('F4', { severity: 'critical' }),
  ] })));
  assert.equal(classified(p, 'F1').blocks, true);
  assert.match(classified(p, 'F1').reason, /cites frozen criterion C1/);
  assert.equal(classified(p, 'F2').blocks, false, 'C9 is no criterion of this plan');
  assert.equal(classified(p, 'F3').blocks, true);
  assert.match(classified(p, 'F3').reason, /breaks a critical invariant \(tenant isolation/);
  assert.equal(classified(p, 'F4').blocks, false);
  assert.match(wf(p.root, ['gate', '--attempt', p.id]).err, /has open findings \(F1, F3\)/);
  assert.match(wf(p.root, ['accept', '--attempt', p.id]).err, /finding F1 is open and blocks: cites frozen criterion C1/);
});

test('a regression on lines this attempt changed blocks, computed from git and not declared', () => {
  const p = project('rc-caused');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [
    finding('F1', { evidence: 'src/a.txt:2 the new label is empty' }),
    finding('F2', { evidence: 'app:src/a.txt:2' }),
    finding('F3', { evidence: undefined, file: 'src/a.txt', line: 2 }),
    finding('F4', { evidence: 'src/a.txt:3 an old line of a file the ticket touched' }),
    finding('F5', { evidence: 'src/a.txt:1-3 the first lines' }),
    finding('F6', { evidence: 'no location at all', scope: { kind: 'in', causedByChange: true } }),
  ] })));
  for (const id of ['F1', 'F2', 'F3', 'F5']) {
    assert.equal(classified(p, id).blocks, true, id);
    assert.equal(classified(p, id).causedByChange, true, id);
  }
  assert.match(classified(p, 'F1').reason, /regression on a line this attempt changed \(src\/a\.txt:2\)/);
  assert.equal(classified(p, 'F4').blocks, false, 'older code in a file the ticket touched');
  // A declared causality (the old scope form) is not evidence; a full-round finding that cites nothing checkable blocks
  // until it is located or verified (security review of the A1 merge: unlocated findings must not fail open).
  assert.equal(classified(p, 'F6').causedByChange, false, 'a declared causality, or the old scope form, is not evidence');
  assert.match(classified(p, 'F6').reason, /cites no file:line, frozen criterion or critical invariant/);
  assert.match(wf(p.root, ['gate', '--attempt', p.id]).err, /has open findings \(F1, F2, F3, F5, F6\)/);
});

// 0.7.0: no discovered entry owes the reviewer a verdict any more; the bundle lists the defects still open as context.
test('bookkeeping and fixed discoveries are in no reviewer bundle; an open defect is context and owes no verdict', () => {
  const p = project('rc-bookkeeping');
  const d = (args) => wf(p.root, ['discovered', ...args, '--attempt', p.id]);
  assert.match(d(['add', '--summary', 'x', '--kind', 'cleanup']).err, /--kind is defect \(default\) or bookkeeping/);
  ok(d(['add', '--summary', 'lint: unused import in my own file', '--kind', 'bookkeeping', '--found-by', 'i']));
  ok(d(['add', '--summary', 'the pager sums only the current page', '--where', 'src/a.txt:4', '--found-by', 'i']));
  ok(d(['add', '--summary', 'a defect I fixed', '--found-by', 'i']));
  commitIn(p.wt, { 'src/a.txt': CHANGED.replace('l4', 'L4') }, 'fixes D1 and D3');
  const fixed = sh(p.wt, 'git rev-parse HEAD');
  ok(d(['close', 'D1', '--fixed', fixed]));
  ok(d(['close', 'D3', '--fixed', fixed]));
  const s = state(p.root, p.id);
  assert.deepEqual(s.discovered.map((x) => [x.id, x.kind, x.status]), [['D1', 'bookkeeping', 'fixed'], ['D2', 'defect', 'open'], ['D3', 'defect', 'fixed']]);
  const bundle = hand(p, 'r1');
  assert.deepEqual(bundle.discovered.map((x) => [x.id, x.fixedSinceReview ?? false]), [['D2', false], ['D3', true]], 'the defect still open, and the one fixed since the last round for the reviewer to verify; bookkeeping is history');
  ok(record(p, goodClosure('r1')));
  assert.deepEqual(hand(p, 'r2').discovered.map((x) => x.id), ['D2'], 'once a round has seen the fix, it is history');
  assert.equal(state(p.root, p.id).review.closure.discovered, undefined, 'the closure was recorded as given, with no verdict for D2');
});

test('a repair handoff groups the blocking findings by family; one proof answers a family sweep, and the reviewer handoff does not wait for it', () => {
  const p = project('rc-family');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [
    finding('F1', { criterion: 'C1', family: 'raw-enum-labels', work: undefined }),
    finding('F2', { criterion: 'C1', family: 'raw-enum-labels' }),
    finding('F3', { criterion: 'C1' }),
    finding('F4', { evidence: 'src/old.txt:1', family: 'raw-enum-labels' }),
  ] })));
  const sweepFile = (sweeps) => { const f = path.join(p.base, `sweep-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify({ sweeps })); return f; };
  const query = { pattern: 'l', kind: 'literal', paths: ['src/**'] };
  const fix = (extra = [], agent = 'impl-2') => wf(p.root, ['handoff', 'implementer', '--agent', agent, '--attempt', p.id, ...extra]);
  // 0.7.0 (goals, not methods): a sweep is optional. A fix handoff without one is handed the blocking findings by family and
  // finds the other instances itself; one that is given is still checked against the open findings.
  const bare = ok(fix([], 'impl-bare'));
  const bareBundle = JSON.parse(fs.readFileSync(bare.out.match(/bundle: (\S+)/)[1], 'utf8'));
  assert.equal(bareBundle.sweep, undefined);
  assert.deepEqual(bareBundle.repair.map((g) => [g.family, g.findings.map((f) => f.ref)]), [['raw-enum-labels', ['r1:F1', 'r1:F2']], [null, ['r1:F3']]]);
  // The brief says it is a fix round whether or not a sweep came with it (final review of 0.7.0: it said so only with one).
  assert.match(bareBundle.instructions, /This is a fix round: find the cause of each family in `repair` and fix it once, with one proof/);
  // One sweep names a member and covers its whole family. (A sweep file need not name every family: the sweep is
  // optional, refusal audit of 0.7.0; the bare handoff above is the case with none.)
  const handed = ok(fix(['--sweep', sweepFile([{ family: 'raw-enum-labels', why: 'a raw enum label', query }, { finding: 'r1:F3', why: 'its own pattern', query }])]));
  const bundle = JSON.parse(fs.readFileSync(handed.out.match(/bundle: (\S+)/)[1], 'utf8'));
  assert.deepEqual(bundle.repair.map((g) => [g.family, g.findings.map((f) => f.ref)]), [['raw-enum-labels', ['r1:F1', 'r1:F2']], [null, ['r1:F3']]], 'the observation F4 is not repaired here');
  assert.deepEqual(bundle.sweep.map((s) => [s.id, s.family, s.findings]), [['S1', 'raw-enum-labels', ['r1:F1', 'r1:F2']], ['S2', null, ['r1:F3']]]);
  assert.match(handed.out, /family raw-enum-labels \(r1:F1, r1:F2\)/);
  commitIn(p.wt, { 'src/a.txt': CHANGED.replace('l3', 'L3') }, 'fix the family');
  // Named failure (0.7.0): a family answered without a proof refused the reviewer handoff, and the fix implementer wrote a
  // placeholder to get through. The reviewer is handed the fix pass whatever the trailers say; each sweep shows its answer
  // as written (or none), and a proof shows its command and the result it must give.
  sh(p.wt, 'git commit -q --allow-empty -m "Sweeps" -m "Sweep S1: fixed - every label" -m "Sweep S2: clean - no other instance"');
  const plain = hand(p, 'r2');
  assert.deepEqual(plain.sweeps.map((s) => [s.id, s.answer.answer]), [['S1', 'fixed'], ['S2', 'clean']], 'a plain answer to a family is shown as it was given');
  sh(p.wt, 'git commit -q --allow-empty -m "Proof" -m "Sweep S1: proof - no command shown"');
  assert.equal(hand(p, 'r3').sweeps.find((s) => s.id === 'S1').answer.answer, 'fixed', 'a proof with no command and result is no answer, so the earlier one stands');
  sh(p.wt, 'git commit -q --allow-empty -m "Proof" -m "Sweep S1: proof - grep -rn RAW_ENUM src => no hits"');
  const next = hand(p, 'r4');
  assert.equal(next.mode, 'delta');
  const s1 = next.sweeps.find((s) => s.id === 'S1');
  assert.deepEqual([s1.family, s1.findings, s1.answer.answer, s1.answer.command, s1.answer.expected], ['raw-enum-labels', ['r1:F1', 'r1:F2'], 'proof', 'grep -rn RAW_ENUM src', 'no hits']);
  assert.deepEqual(next.openFindings.map((f) => [f.ref ?? `${f.round}:${f.id}`, f.family, f.blocks]), [['r1:F1', 'raw-enum-labels', true], ['r1:F2', 'raw-enum-labels', true], ['r1:F3', null, true], ['r1:F4', 'raw-enum-labels', false]]);
});

test('deliver refuses while a review observation is unresolved, and accepts it ticketed', () => {
  const p = project('rc-deliver');
  hand(p, 'r1');
  // A low observation may leave the delivery as a follow-up, with the person's yes (D17: a medium or high one is fixed here).
  ok(record(p, goodClosure('r1', { findings: [finding('F1', { severity: 'low', family: 'old-empty-state', summary: 'old.txt has no empty state' })] })));
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  hand(p, 'r2');
  ok(record(p, goodClosure('r2')));
  ok(wf(p.root, ['accept', '--attempt', p.id]), 'an observation does not hold acceptance');
  assert.match(state(p.root, p.id).next, /1 review observation\(s\) are unresolved and delivery waits for them: r1:F1 \[old-empty-state\]/);
  const refused = wf(p.root, ['deliver', '--attempt', p.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /not delivered: 1 review observation\(s\) are unresolved: r1:F1 \[old-empty-state\] old\.txt has no empty state/);
  assert.match(refused.err, /wf scope move[\s\S]*medium and high are fixed in this delivery[\s\S]*a low one leaves only with the person's yes[\s\S]*wf scope defer --finding <ref>/);
  // The person is asked before the follow-up ticket exists (0.7.7); with their yes, the command says to create it.
  const asked = wf(p.root, ['scope', 'ticket', '--finding', 'r1:F1', '--attempt', p.id], { ownerSilent: true });
  assert.equal(asked.code, 75, 'the person is asked before a low observation leaves, and before any ticket is created');
  assert.deepEqual(observations(loadState(p.root, p.id)).map((f) => f.ref), ['r1:F1']);
  assert.match(wf(p.root, ['scope', 'ticket', '--finding', 'r1:F1', '--attempt', p.id]).err, /create it in the tracker now, save its raw readback/);
  // A creation that left no ticket (no url) leaves the observation unresolved.
  const bad = path.join(p.base, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ issue: { identifier: 'ENG-9', title: 'follow-up' } }));
  assert.match(wf(p.root, ['scope', 'ticket', '--finding', 'r1:F1', '--capture', bad, '--attempt', p.id]).err, /failed creation leaves the finding unresolved/);
  assert.match(wf(p.root, ['deliver', '--attempt', p.id]).err, /1 review observation\(s\) are unresolved/);
  const good = path.join(p.base, 'good.json');
  fs.writeFileSync(good, JSON.stringify({ issue: { identifier: 'ENG-9', title: 'old.txt empty state', url: 'https://tracker.example.test/ENG-9' } }));
  ok(wf(p.root, ['scope', 'ticket', '--finding', 'r1:F1', '--capture', good, '--attempt', p.id]));
  assert.deepEqual(observations(loadState(p.root, p.id)), []);
  assert.deepEqual(state(p.root, p.id).decisions.filter((d) => d.kind === 'move-out-of-batch').map((d) => [d.key, d.approved?.choice]), [['ticketed:r1:F1', 'yes']]);
  assert.match(ok(wf(p.root, ['scope', 'list', '--attempt', p.id])).out, /r1:F1 {2}observation {2}low {2}\[old-empty-state\] {2}ticketed https:\/\/tracker\.example\.test\/ENG-9/);
  assert.match(ok(wf(p.root, ['deliver', '--attempt', p.id])).out, /delivered RC-1/);
});

test('an adapter that still sets review.budgetMinutes is accepted and ignored: no round carries a budget', () => {
  // Named failure: the effort budget the engine picked (60 minutes for a full audit, 25 for a delta) bounded reviews by a
  // clock; the delta bounds them now, and the reviewer states its own expected minutes in its closure.
  const p = project('rc-budget', { review: { budgetMinutes: { full: 90, delta: 0 } } });
  const r1 = hand(p, 'r1');
  assert.equal(r1.budget, undefined);
  assert.doesNotMatch(r1.instructions, /budget/);
  ok(record(p, goodClosure('r1')));
  commitIn(p.wt, { 'src/a.txt': CHANGED.replace('l5', 'L5') });
  const r2 = hand(p, 'r2');
  assert.equal(r2.mode, 'delta');
  assert.equal(r2.budget, undefined);
  assert.doesNotMatch(r2.instructions, /budget/);
  assert.match(r2.instructions, /`scope`[\s\S]*`expect: \{ minutes \}`/);
  const doctor = wf(p.root, ['doctor', '--no-steps']);
  assert.doesNotMatch(doctor.out + doctor.err, /budgetMinutes/);
});

test('a cited path names its own repo: another repo\'s file of the same name, or its worktree, never matches', () => {
  const lines = { app: { 'src/a.ts': [[10, 14]] }, web: { 'src/a.ts': [[1, 2]] } };
  const roots = { app: '/w/ATT/app', web: '/w/ATT/web' };
  assert.equal(locationIn(lines, { evidence: 'app:src/a.ts:12' }, roots), 'app:src/a.ts:12');
  assert.equal(locationIn(lines, { evidence: 'web:src/a.ts:12' }, roots), null, 'line 12 is not a changed line of web');
  assert.equal(locationIn(lines, { evidence: 'web/src/a.ts:2' }, roots), 'web/src/a.ts:2');
  assert.equal(locationIn(lines, { evidence: '/w/ATT/app/src/a.ts:11' }, roots), '/w/ATT/app/src/a.ts:11');
  assert.equal(locationIn(lines, { evidence: '/w/ATT/web/src/a.ts:11' }, roots), null, 'an absolute path into web is not app\'s line');
  assert.equal(locationIn(lines, { evidence: 'src/a.ts:12' }, roots), 'src/a.ts:12', 'a bare path matches by its tail');
  assert.equal(locationIn(lines, { evidence: 'src/a.ts:20' }, roots), null);
});

test('a finding the owner waived under the extra-scope flow before 0.7.0 stays settled (D7), and no new one can be', () => {
  const scope = { kind: 'extra', issue: 'old-warning', reason: 'predates the change', baseEvidence: 'base:x:1', currentEvidence: 'head:x:1', requiredByRequest: false, causedByChange: false, affectsChangedContract: false, requiredValidation: false };
  const key = hashValue({ issue: scope.issue, base: scope.baseEvidence, current: scope.currentEvidence, reason: scope.reason });
  const review = { reviewer: 'r1', handoff: 'b1', closure: { reviewer: 'r1', findings: [{ id: 'F1', status: 'open', criterion: 'C1', evidence: 'x', scope }, { id: 'F2', status: 'open', criterion: 'C1', evidence: 'y' }] } };
  const state = (decisions) => ({ criteria: [{ id: 'C1' }], repos: {}, reviews: [review], review, scopeDecisions: decisions, decisions: [] });
  assert.deepEqual(blockingIn(state([]), review).map((f) => f.id), ['F1', 'F2']);
  assert.deepEqual(blockingIn(state([{ choice: 'ignore', keys: [key] }]), review).map((f) => f.id), ['F2']);
  assert.deepEqual(openAcrossRounds(state([{ choice: 'ticketed', keys: [key] }])).map((f) => f.ref), ['r1:F2']);
  assert.deepEqual(blockingIn(state([{ choice: 'ignore', keys: ['some-other-key'] }]), review).map((f) => f.id), ['F1', 'F2']);
});
