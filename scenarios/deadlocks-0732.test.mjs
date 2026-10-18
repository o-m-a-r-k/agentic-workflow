// 0.7.32 (I-222, D69-D72): the engine's own rules left a ticket stuck, with the person's override as the only way out.
//
// Named failures (field): an evidence review raised a layout finding (its proof is the gate's screenshots) and a missing-proof
// finding; after the fix every code review honestly kept both open (a code review is handed no gate output), and the gate order
// refused the gate after each of them until the person was asked to override the order; in one project's ledgers 25 code-review
// rounds on nine attempts kept an evidence finding open, and the gate was refused for it at four (D69). The direct route from an
// evidence review's fixes to the gate was switched off by bookkeeping: a strategist's consolidation that restated the findings as
// one fix item, an amendment that corrected an expectation, an implementer stopped and replaced (D70). A contested premise had no exit once the person answered (D71). `wf deliver` named
// `wf reopen` for a change pushed outside the workflow, which `wf reopen` refuses (D72).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { amendFile, approveAsOwner, closureFile, commitIn, criteriaFile, goodClosure, ok, planDoc, singleRepoProject, state, wf, writeReport, yaml } from './helpers.mjs';

const CRITERIA = [{ id: 'C1', text: 'a changes', uat: false }, { id: 'C2', text: 'b changes', uat: false }];
const mapped = [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log line 1' } }, { id: 'C2', evidence: { kind: 'output', ref: 'gate log line 2' } }];

function fixture(name) {
  const config = { gate: { steps: [{ id: 'unit', repo: 'app', run: 'test -f src/a.txt', inputs: ['src/**'] }] } };
  const f = singleRepoProject(name, config, { 'src/a.txt': 'l1\nl2\nl3\n' });
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-1', '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'planner', '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base, CRITERIA), '--attempt', e.id]));
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'impl', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'L1\nl2\nl3\n' });
  ok(wf(f.root, ['handoff', 'close', '--agent', 'impl', '--attempt', e.id]));
  return { ...f, e, id: e.id, wt: e.repos.app.worktree };
}
function review(f, agent, extra = {}) {
  ok(wf(f.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', f.id]));
  const validationChecked = state(f.root, f.id).validations.flatMap((v) => v.steps.map((s) => ({ id: s.id, commit: v.commit, verdict: 'complies', evidence: 'pinned definition inspected' })));
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure(agent, { criteria: mapped, validationChecked, ...extra })), '--attempt', f.id]));
}
const fixRound = (f, agent, content, extra = []) => {
  ok(wf(f.root, ['handoff', 'implementer', '--agent', agent, '--attempt', f.id, ...extra]));
  commitIn(f.wt, { 'src/a.txt': content }, `fix by ${agent}`);
  ok(wf(f.root, ['handoff', 'close', '--agent', agent, '--attempt', f.id]));
};
// The first code review is clean, the gate runs, and the full evidence review raises what only the gate's evidence shows.
function evidenceRaised(f, findings) {
  review(f, 'code-0');
  ok(wf(f.root, ['gate', '--attempt', f.id]));
  review(f, 'evidence-1', { findings });
}

// An evidence finding with no criterion: the header overlaps the first row in the gate's screenshots (a changed line, so it blocks).
const LAYOUT = { id: 'F1', severity: 'high', summary: 'The report header overlaps the first row at 1280px', status: 'open', evidence: 'src/a.txt:1 the 1280px capture shows the header over the first row' };
// An evidence finding on a criterion: the browser check C1 requires never ran in the gate.
const PROOF = { id: 'F2', severity: 'high', summary: 'The browser check C1 requires never ran in the gate', status: 'open', criterion: 'C1', evidence: 'src/a.txt:1 no gate step runs the browser check' };
const keptOpen = (round, ...ids) => ids.map((id) => ({ round, id, status: 'open', evidence: 'src/a.txt:1 the code is changed; this round was handed no screenshots and no gate output, so it cannot see whether it holds' }));
const NOT_VERIFIED = /has not verified \d earlier-round finding\(s\)/;
const reword = (f, id = 'C2') => ok(wf(f.root, ['criteria', 'amend', '--file', amendFile(f.base, [{ id, text: `${id === 'C2' ? 'b' : 'a'} changes on every page`, uat: false }]), '--reason', 'the criterion covers every page', '--attempt', f.id]));

test('0.7.32 (I-222, D69): an evidence finding the code review after its fix keeps open with evidence awaits the gate, whatever it cites and with no check registered: the gate runs with no override and no question; acceptance still waits for the evidence review', () => {
  const f = fixture('d69-layout');
  evidenceRaised(f, [LAYOUT, PROOF]);
  // A criterion re-worded since the evidence review is scope: the fix goes through a code review first.
  reword(f);
  fixRound(f, 'impl', 'L1 fixed\nl2\nl3\n');
  assert.equal(state(f.root, f.id).decision.round, 'code-review');
  review(f, 'code-2', { criteria: [], priorFindings: keptOpen('evidence-1', 'F1', 'F2') });
  const before = state(f.root, f.id);
  assert.deepEqual([before.decision.kind, before.decision.status], ['gate', 'ready'], 'the gate is next, not another code review or a repair');
  assert.match(before.next, /left open only what the gate's own run proves \(evidence-1:F1, evidence-1:F2: an evidence review raised them/);
  const run = wf(f.root, ['gate', '--attempt', f.id], { ownerSilent: true });
  assert.equal(run.code, 0, run.err);
  const s = state(f.root, f.id);
  assert.deepEqual([s.gateOverrides ?? [], s.decisions ?? []], [[], []], 'no override and no question to the person');
  assert.deepEqual([s.decision.kind, s.decision.round], ['review', 'evidence-review']);
  // Acceptance is not eased: only an evidence round written after the gate verifies them.
  const refused = wf(f.root, ['accept', '--attempt', f.id]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /earlier-round finding\(s\) not verified: evidence-1:F1, evidence-1:F2/);
  review(f, 'evidence-3', { priorFindings: [{ round: 'evidence-1', id: 'F1', status: 'fixed', evidence: 'the 1280px capture shows the header above the first row' }, { round: 'evidence-1', id: 'F2', status: 'fixed', evidence: 'the browser check ran in the gate and passed' }] });
  ok(wf(f.root, ['accept', '--attempt', f.id]));
});

test('0.7.32 (I-222, D69): a code finding kept open still holds the gate, and so does an evidence finding an evidence round found still open in the gate output', () => {
  const waits = (f, why) => {
    const refused = wf(f.root, ['gate', '--attempt', f.id], { ownerSilent: true });
    assert.equal(refused.code, 75, why);
    assert.match(refused.err, NOT_VERIFIED, why);
    assert.equal(state(f.root, f.id).decision.kind, 'repair', why);
  };
  // A code-review round raised it, and the next code review kept it open.
  const code = fixture('d69-code');
  review(code, 'code-1', { findings: [LAYOUT] });
  fixRound(code, 'impl', 'L1 fixed\nl2\nl3\n');
  review(code, 'code-2', { criteria: [], priorFindings: keptOpen('code-1', 'F1') });
  waits(code, 'a code finding kept open');
  // An evidence round raised it, and the evidence round after the next gate still found it open: the next step is the repair.
  const ev = fixture('d69-evidence-again');
  evidenceRaised(ev, [LAYOUT]);
  fixRound(ev, 'impl', 'L1 fixed\nl2\nl3\n');
  ok(wf(ev.root, ['gate', '--attempt', ev.id]));
  review(ev, 'evidence-2', { priorFindings: keptOpen('evidence-1', 'F1').map((p) => ({ ...p, evidence: 'the new 1280px capture still shows the header over the first row' })) });
  assert.equal(state(ev.root, ev.id).decision.kind, 'repair');
  assert.match(state(ev.root, ev.id).next, /must verify 1 earlier-round finding\(s\) \(evidence-1:F1\)/);
});

test('0.7.32 (I-222, D69): a check registered after the evidence review is reviewed in a code round, and the evidence findings that round cannot verify do not hold the gate, whichever criterion the check names', () => {
  const f = fixture('d69-registered');
  evidenceRaised(f, [PROOF]);
  // The check registered is for C2, not the C1 the finding cites.
  commitIn(f.wt, { '.workflow/project.yaml': yaml({ version: 1, enabled: true, name: 'fixture', repos: [{ name: 'app', path: '.', base: 'main' }], gate: { steps: [{ id: 'browser', repo: 'app', run: 'true' }] } }) }, 'register the browser check');
  ok(wf(f.root, ['validation', 'add', '--steps', 'browser', '--criteria', 'C2', '--reason', 'Required real execution', '--attempt', f.id]));
  // The review of the step's definition is still owed before the gate (it is code review's work).
  const owed = wf(f.root, ['gate', '--attempt', f.id], { ownerSilent: true });
  assert.equal(owed.code, 75);
  assert.match(owed.err, /required supplemental validation was added or corrected after the last code review/);
  review(f, 'code-2', { criteria: [], priorFindings: keptOpen('evidence-1', 'F2') });
  assert.deepEqual([state(f.root, f.id).decision.kind, state(f.root, f.id).decision.status], ['gate', 'ready']);
  const run = ok(wf(f.root, ['gate', '--attempt', f.id, '--json'], { ownerSilent: true })).json();
  assert.deepEqual(run.steps.map((x) => x.id).sort(), ['browser', 'unit']);
  assert.deepEqual(state(f.root, f.id).decisions ?? [], []);
});

const direct = (f, why) => {
  const s = state(f.root, f.id);
  assert.deepEqual([s.decision.kind, s.decision.status], ['gate', 'ready'], why);
  assert.match(s.next, /the evidence review's findings are fixed by the implementers handed after it/, why);
  const run = wf(f.root, ['gate', '--attempt', f.id], { ownerSilent: true });
  assert.equal(run.code, 0, `${why}: ${run.err}`);
  assert.deepEqual(state(f.root, f.id).decisions ?? [], [], why);
};

test('0.7.32 (I-222, D70): an amendment that changes no criterion (an expectation corrected, the findings restated) does not switch off the evidence review\'s route to the gate', () => {
  const f = fixture('d70-expect');
  evidenceRaised(f, [LAYOUT]);
  ok(wf(f.root, ['criteria', 'amend', '--file', closureFile(f.base, { expect: { minutes: 30, rounds: 1 } }), '--reason', 'bookkeeping: the re-plan counts from the amendment', '--attempt', f.id]));
  fixRound(f, 'impl', 'L1 fixed\nl2\nl3\n');
  direct(f, 'an expectation-only amendment');
});

test('0.7.32 (I-222, D70): an implementer stopped and replaced by one that finished its work does not switch off the evidence review\'s route to the gate', () => {
  const f = fixture('d70-stopped');
  evidenceRaised(f, [LAYOUT]);
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'impl-a', '--attempt', f.id]));
  commitIn(f.wt, { 'src/a.txt': 'L1 half\nl2\nl3\n' }, 'half a fix');
  ok(wf(f.root, ['handoff', 'close', '--agent', 'impl-a', '--outcome', 'stopped', '--attempt', f.id]));
  fixRound(f, 'impl-b', 'L1 fixed\nl2\nl3\n');
  direct(f, 'a stopped implementer whose work a later one finished');
});

test('0.7.32 (I-222, D70): an evidence round that raised nothing new but kept an earlier blocking finding open sends its fix to the gate as well', () => {
  const f = fixture('d70-kept');
  evidenceRaised(f, [LAYOUT]);
  fixRound(f, 'impl', 'L1 fixed\nl2\nl3\n');
  ok(wf(f.root, ['gate', '--attempt', f.id]));
  review(f, 'evidence-2', { priorFindings: keptOpen('evidence-1', 'F1').map((p) => ({ ...p, evidence: 'the new 1280px capture still shows the header over the first row' })) });
  fixRound(f, 'impl', 'L1 fixed again\nl2\nl3\n');
  direct(f, 'an evidence round that kept an earlier finding open');
});

test('0.7.32 (I-222, D70): the route still needs a code review after a criterion changed, and after an implementer stopped that no later one finished', () => {
  const codeReview = (f, why) => {
    const s = state(f.root, f.id);
    assert.deepEqual([s.decision.kind, s.decision.round], ['review', 'code-review'], why);
    assert.equal(wf(f.root, ['gate', '--attempt', f.id], { ownerSilent: true }).code, 75, why);
  };
  const changed = fixture('d70-changed');
  evidenceRaised(changed, [LAYOUT]);
  reword(changed);
  fixRound(changed, 'impl', 'L1 fixed\nl2\nl3\n');
  codeReview(changed, 'a re-worded criterion');
  const stopped = fixture('d70-stopped-only');
  evidenceRaised(stopped, [LAYOUT]);
  ok(wf(stopped.root, ['handoff', 'implementer', '--agent', 'impl-a', '--attempt', stopped.id]));
  commitIn(stopped.wt, { 'src/a.txt': 'L1 half\nl2\nl3\n' }, 'half a fix');
  ok(wf(stopped.root, ['handoff', 'close', '--agent', 'impl-a', '--outcome', 'stopped', '--attempt', stopped.id]));
  codeReview(stopped, 'a stopped implementer nobody finished');
});

// Named failure (field, two attempts): a check registered after an evidence review, then the fix: `wf resume` named the gate by the
// direct route while `wf gate` refused it for the code review the check owes.
test('0.7.32 (I-222, D70): a check registered after the evidence review, then the fix: the next step is the code review the check owes, never a gate the order refuses; after it, the gate', () => {
  const f = fixture('d70-registered-then-fixed');
  evidenceRaised(f, [PROOF]);
  commitIn(f.wt, { '.workflow/project.yaml': yaml({ version: 1, enabled: true, name: 'fixture', repos: [{ name: 'app', path: '.', base: 'main' }], gate: { steps: [{ id: 'browser', repo: 'app', run: 'true' }] } }) }, 'register the browser check');
  ok(wf(f.root, ['validation', 'add', '--steps', 'browser', '--criteria', 'C1', '--reason', 'Required real execution', '--attempt', f.id]));
  fixRound(f, 'impl', 'L1 fixed\nl2\nl3\n');
  const s = state(f.root, f.id);
  const refused = wf(f.root, ['gate', '--attempt', f.id], { ownerSilent: true });
  assert.equal(refused.code, 75);
  assert.match(refused.err, /required supplemental validation was added or corrected after the last code review/);
  assert.deepEqual([s.decision.kind, s.decision.round], ['review', 'code-review'], 'the next step and the gate agree');
  review(f, 'code-2', { criteria: [], priorFindings: keptOpen('evidence-1', 'F2') });
  assert.deepEqual([state(f.root, f.id).decision.kind, state(f.root, f.id).decision.status], ['gate', 'ready']);
  ok(wf(f.root, ['gate', '--attempt', f.id], { ownerSilent: true }));
});

// ---- D71: the person's answer settles a contested premise ----

const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';
function premiseProject(name) {
  const p = singleRepoProject(name, { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } }, { 'src/a.txt': LINES, 'src/b.txt': LINES });
  const e = ok(wf(p.root, ['entry', '--item', 'PM-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const plan = path.join(p.base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify(planDoc({ plan: { summary: 'change a', expect: { files: 10, rounds: 8, minutes: 900 }, anchors: ['src/a.txt'] }, criteria: [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }] })));
  ok(wf(p.root, ['plan', '--file', plan, '--attempt', e.id]));
  return { ...p, id: e.id, wt: e.repos.app.worktree };
}
const bundleOf = (r) => JSON.parse(fs.readFileSync((r.out.match(/^Read (\S+)/m) ?? r.out.match(/bundle: (\S+)/))[1], 'utf8'));
const resume = (p) => ok(wf(p.root, ['resume', '--attempt', p.id, '--json'])).json();
const recordP = (p, closure) => ok(wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', p.id]));
const TOTAL = { id: 'F1', severity: 'high', summary: 'F1: the export total is wrong', status: 'open', evidence: 'src/a.txt:2', criterion: 'C1' };
const reports = (p, agent, why) => {
  ok(wf(p.root, ['handoff', 'implementer', '--agent', agent, '--attempt', p.id]));
  writeReport(p.root, p.id, agent, { approach: 'traced who runs the export before changing it', expect: { minutes: 15 }, premiseFailed: [{ ref: 'r1:F1', why, evidence: ['src/a.txt:2 is reached only from a spec'] }] });
  ok(wf(p.root, ['handoff', 'close', '--agent', agent, '--attempt', p.id]));
};
// A finding whose premise a reviewer found holds and an implementer then found does not: the person decides it.
function contestedFinding(name) {
  const p = premiseProject(name);
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'implement C1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  recordP(p, goodClosure('r1', { findings: [TOTAL] }));
  reports(p, 'i2', 'the total is computed only for an export no production path runs');
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', p.id]));
  recordP(p, goodClosure('r2', { criteria: [], priorFindings: [{ round: 'r1', id: 'F1', status: 'open', evidence: 'src/a.txt:2 the nightly export calls it', premise: 'holds: the nightly export computes this total' }] }));
  reports(p, 'i3', 'the nightly export is switched off in production');
  const s = resume(p);
  assert.equal(s.decision.kind, 'premise');
  assert.match(s.next, /reviewer r2 found its premise holds and an implementer found it does not: the person decides/);
  assert.match(s.next, /`wf scope not-a-defect --finding r1:F1 --reason "<why>"/, 'a finding has a not-a-defect route of its own');
  return p;
}
const CLAUDE = 'c1aude00-0000-4000-8000-0000000d0071';
const personWrites = (p, text) => {
  const file = path.join(p.base, '.home', '.claude', 'projects', 'proj', `${CLAUDE}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const when = (ms) => new Date(Date.now() + ms).toISOString();
  fs.appendFileSync(file, [{ type: 'assistant', timestamp: when(500), message: { role: 'assistant', content: [{ type: 'text', text: 'Is the wrong export total a real problem to fix?' }] } }, { type: 'user', timestamp: when(1000), message: { role: 'user', content: text } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
};
const session = { env: { CLAUDE_CODE_SESSION_ID: CLAUDE } };
const decideArgs = (p, extra) => ['decide', '--question', 'Is the wrong export total a real problem to fix?', '--options', 'Yes, fix it | No, it is not a problem', '--recommend', 'Yes: finance runs the export by hand each month', '--basis', 'traced the export (src/a.txt:2) and the nightly job flag (src/b.txt:5)', '--not-checked', 'whether anyone runs the export outside the monthly close', ...extra, '--attempt', p.id];

test('0.7.32 (I-222, D71): the person\'s answer that a contested finding\'s premise holds, recorded with `wf decide --item`, sends it back to the fix round with their words', () => {
  const p = contestedFinding('d71-holds');
  personWrites(p, 'yes fix it, finance runs that export by hand every month');
  const fails = wf(p.root, decideArgs(p, ['--choice', 'No, it is not a problem', '--quote', 'yes fix it', '--item', 'r1:F1', '--premise', 'fails']), session);
  assert.equal(fails.code, 75);
  assert.match(fails.err, /closes it as not a defect, which is the person's decision on its own question \(D38\)/);
  assert.match(fails.err, /wf scope not-a-defect --finding r1:F1/);
  const rec = ok(wf(p.root, decideArgs(p, ['--choice', 'Yes, fix it', '--quote', 'yes fix it, finance runs that export by hand every month', '--item', 'r1:F1', '--premise', 'holds']), session));
  assert.match(rec.out, /The premise of r1:F1 holds by their answer: it goes back to the fix round/);
  const s = resume(p);
  assert.equal(s.decision.kind, 'repair', 'the item is fixed now, not held for another verdict');
  assert.doesNotMatch(s.next, /the person decides/);
  const fix = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i4', '--attempt', p.id])));
  const f1 = fix.repair.flatMap((g) => g.findings).find((f) => `${f.round}:${f.id}` === 'r1:F1');
  assert.deepEqual([f1.premiseHeld.decision, f1.premiseHeld.words], ['PD1', 'yes fix it, finance runs that export by hand every month']);
  assert.equal(f1.premiseFailed, undefined);
  assert.match(fix.instructions, /An item marked `premiseHeld` \(r1:F1\)/);
});

test('0.7.32 (I-222, D71): the person\'s answer that a contested finding is not a defect closes it as not a defect (D38\'s question for a finding); their "no" sends it back to the fix round', () => {
  const p = contestedFinding('d71-not-a-defect');
  ok(wf(p.root, ['scope', 'not-a-defect', '--finding', 'r1:F1', '--reason', 'the nightly export is switched off in production and nobody runs it by hand', '--attempt', p.id]));
  const s = resume(p);
  assert.notEqual(s.decision.kind, 'premise');
  assert.notEqual(s.decision.kind, 'repair');
  assert.deepEqual(s.scopeDecisions.filter((d) => d.choice === 'not-a-defect').map((d) => d.keys), [['r1:F1']]);
  assert.ok(!ok(wf(p.root, ['scope', 'list', '--attempt', p.id, '--json'])).json().some((r) => r.ref === 'r1:F1'), 'no longer an open finding');
  // The person's "no": it is a defect after all, and goes back to the fix round.
  const q = contestedFinding('d71-no');
  const asked = wf(q.root, ['scope', 'not-a-defect', '--finding', 'r1:F1', '--reason', 'the nightly export is switched off', '--attempt', q.id], { ownerSilent: true });
  assert.equal(asked.code, 75);
  const id = /\b(A\d+)\b/.exec(asked.err)[1];
  approveAsOwner(q.root, q.id, id, 'no');
  const after = resume(q);
  assert.equal(after.decision.kind, 'repair');
  const fix = bundleOf(ok(wf(q.root, ['handoff', 'implementer', '--agent', 'i4', '--attempt', q.id])));
  assert.equal(fix.repair.flatMap((g) => g.findings).find((f) => `${f.round}:${f.id}` === 'r1:F1').premiseHeld.decision, id);
});

test('0.7.32 (I-222, D71): a contested discovered issue the person says is a defect ("no" to the not-a-defect question) goes back to the planned pass with their answer', () => {
  const p = premiseProject('d71-discovered');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'implement C1');
  writeReport(p.root, p.id, 'i1', { left: [{ what: 'the due date shows a clock time on the invoice page', where: 'src/b.txt:3', why: 'not caused by this change', severity: 'low' }] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  recordP(p, goodClosure('r1'));
  const pass = (n) => ok(wf(p.root, ['criteria', 'amend', '--file', closureFile(p.base, { pass: [{ items: ['D1'], why: 'the due date', repos: ['app'] }], expect: { minutes: 30, rounds: 1 } }), '--reason', `pass ${n}`, '--attempt', p.id]));
  const failsIn = (agent, work, why) => {
    ok(wf(p.root, ['handoff', 'implementer', '--agent', agent, '--work', work, '--attempt', p.id]));
    writeReport(p.root, p.id, agent, { approach: 'traced who writes the due date', expect: { minutes: 10 }, premiseFailed: [{ ref: 'D1', why, evidence: ['src/b.txt:3'] }] });
    ok(wf(p.root, ['handoff', 'close', '--agent', agent, '--attempt', p.id]));
  };
  pass(1);
  failsIn('i2', 'P1', 'nothing in production writes the due date');
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', p.id]));
  recordP(p, goodClosure('r2', { discovered: [{ id: 'D1', verdict: 'open', evidence: 'src/b.txt:3 is written by the nightly import', premise: 'holds: the nightly import writes it' }] }));
  pass(2);
  failsIn('i3', 'P2', 'the nightly import is switched off in production');
  assert.match(resume(p).next, /D1 \(i3: the nightly import is switched off in production[^)]*\): reviewer r2 found its premise holds and an implementer found it does not: the person decides/);
  // The person answers "no, fix the problem" to the not-a-defect question: it is a defect, and goes back to the pass.
  const asked = wf(p.root, ['discovered', 'close', 'D1', '--not-a-defect', '--reason', 'the nightly import is switched off', '--attempt', p.id], { ownerSilent: true });
  assert.equal(asked.code, 75);
  const id = /\b(A\d+)\b/.exec(asked.err)[1];
  approveAsOwner(p.root, p.id, id, 'no');
  const s = resume(p);
  assert.equal(s.decision.kind, 'pass', 'D1 is back with the work that does not block');
  assert.deepEqual(s.decision.outstanding, ['D1']);
  assert.doesNotMatch(s.next, /the person decides/);
  pass(3);
  const b = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i4', '--work', 'P3', '--attempt', p.id])));
  const d1 = b.passItems[0].items.find((x) => x.ref === 'D1');
  assert.equal(d1.premiseHeld.decision, id);
  assert.equal(d1.premiseFailed, undefined);
});

// ---- D72: a change pushed outside the workflow ----

test('0.7.32 (I-222, D72): a commit pushed outside the workflow after the acceptance: `wf deliver` names the route that exists, `wf resume` names the review of the tree as it is, and following it delivers the pushed commit without pushing again', async () => {
  const { toAccepted, sh } = await import('./helpers.mjs');
  const { base, root } = singleRepoProject('d72-pushed', { gate: { steps: [{ id: 'u', repo: 'app', run: 'true', inputs: ['src/**'] }] } });
  const { id, wt } = toAccepted(root, base, { item: 'RF-9' });
  commitIn(wt, { 'src/a.txt': 'pushed by hand\n' });
  sh(wt, 'git push -q origin HEAD:refs/heads/main');
  const head = sh(wt, 'git rev-parse HEAD').trim();
  const refused = wf(root, ['deliver', '--attempt', id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /pushed outside wf/);
  assert.match(refused.err, /review, gate and accept it here: `wf resume --attempt RF-9\.1` names the code review/);
  assert.match(refused.err, /`wf close --shipped --reason "<why>" --attempt RF-9\.1`/);
  assert.doesNotMatch(refused.err, /new attempt \(`wf reopen`\)$/m);
  const s = state(root, id);
  assert.deepEqual([s.decision.kind, s.decision.round], ['review', 'code-review'], 'not "deliver" again');
  assert.match(s.next, /the acceptance names/);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rx', '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rx', { criteria: [] })), '--attempt', id]));
  assert.equal(state(root, id).decision.kind, 'gate');
  ok(wf(root, ['gate', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'ry', '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('ry')), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
  assert.equal(state(root, id).decision.kind, 'delivery');
  ok(wf(root, ['deliver', '--attempt', id]));
  assert.deepEqual([state(root, id).delivery.repos.app.commit, state(root, id).delivery.repos.app.recovered], [head, true]);
});
