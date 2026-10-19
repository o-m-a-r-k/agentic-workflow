// 0.7.28 (I-210, I-208), named failure (field, a three-ticket batch: 35 hours, 47 review rounds against 11 planned): the owner
// agent judged the course at every round boundary and wrote "converging, not calling the strategist" six times; no strategist was
// handed in 47 rounds while the changed files ran two to four times the plan (119 against 62, 206 against 48) and the criteria were
// amended upward four times. One fix whose reviewer had stated a narrow change became a 240-minute redesign that caused the batch's
// only high finding and four new ones; nine of one ticket's thirty findings were regressions of the fix round before. Now the engine
// names those signals, the strategist's handoff is the next step until a recorded decision answers them (an agent's handoff,
// never a question to the person), and its decision (consolidate, split, continue with a new expectation) drives the step after.
// And a round escalation that needs a product or legal answer has an option for it: it stayed open 390 minutes overnight when
// the person's answer was a question no option fitted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { closureFile, commitIn, goodClosure, ok, planDoc, singleRepoProject, wf, writeReport } from './helpers.mjs';
import { inProcess } from './strategist-fixtures.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true' }];
const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';

function project(name, expect, config = {}) {
  const p = singleRepoProject(name, { gate: { steps }, ...config }, { 'src/a.txt': LINES, 'src/b.txt': LINES, 'src/c.txt': LINES });
  const e = ok(wf(p.root, ['entry', '--item', 'CS-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const plan = path.join(p.base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify(planDoc({ plan: { summary: 'change a', expect, anchors: ['src/a.txt'] }, criteria: [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }] })));
  ok(wf(p.root, ['plan', '--file', plan, '--attempt', e.id]));
  return { ...p, id: e.id, wt: e.repos.app.worktree };
}
const resume = (p) => ok(wf(p.root, ['resume', '--attempt', p.id, '--json'])).json();
const record = (p, closure) => ok(wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', p.id]));
const blocking = (id, evidence, extra = {}) => ({ id, severity: 'major', summary: `${id}: the total is wrong`, status: 'open', evidence, criterion: 'C1', ...extra });
const implement = (p, agent, files, report = {}) => {
  ok(wf(p.root, ['handoff', 'implementer', '--agent', agent, '--attempt', p.id]));
  commitIn(p.wt, files, `${agent} work`);
  writeReport(p.root, p.id, agent, report);
  ok(wf(p.root, ['handoff', 'close', '--agent', agent, '--attempt', p.id]));
};
const strategist = (p, agent, closure) => {
  const h = ok(wf(p.root, ['handoff', 'strategist', '--agent', agent, '--attempt', p.id, '--json'])).json();
  const bundle = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  const f = path.join(p.base, `${agent}.json`);
  fs.writeFileSync(f, JSON.stringify({ strategist: agent, rationale: 'the numbers are explained', prediction: { signal: 'blockingLatest <= 1', by: 9 }, ...closure }));
  return { bundle, record: () => wf(p.root, ['strategy', 'record', '--closure', f, '--attempt', p.id]) };
};

test('files past twice the plan and criteria amended upward make the strategist the next step; its decision answers them and a new expectation is what the course is compared with', () => {
  const p = project('cs-files', { files: 1, rounds: 6, minutes: 600 });
  implement(p, 'i1', { 'src/a.txt': 'x\n', 'src/b.txt': 'x\n', 'src/c.txt': 'x\n' });
  ok(wf(p.root, ['criteria', 'amend', '--file', closureFile(p.base, { criteria: [{ id: 'C2', text: 'b changes too', uat: 'b shows it' }], impact: { unchanged: 'b reads the same data' } }), '--reason', 'b needs it as well', '--attempt', p.id]));
  let s = resume(p);
  assert.equal(s.decision.kind, 'strategy', 'the strategist is the next step, not the owner\'s judgement');
  assert.deepEqual(s.decision.courseSignals.map((x) => x.id), ['files', 'amended']);
  assert.match(s.next, /the course needs the strategist \(the engine's next step, not a judgement call\): 3 files changed, more than twice the 1 the plan expected; amendment 1 added C2 after implementation started/);
  assert.match(s.next, /Hand it now: `wf handoff strategist --agent <new id>` \[wf-strategist\]/);
  // No "continue" is offered beside it on the line the owner acts on.
  assert.doesNotMatch(ok(wf(p.root, ['resume', '--attempt', p.id])).out, /next: past its own estimate/);
  // A round handed past it is said to the owner.
  const handed = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  assert.match(handed.err, /note: handed while course signals stand that no strategist has answered \(files, amended\)/);
  record(p, goodClosure('r1', { findings: [blocking('F1', 'src/a.txt:1')], criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'log 1' } }, { id: 'C2', evidence: { kind: 'output', ref: 'log 2' } }] }));
  assert.equal(resume(p).decision.kind, 'strategy', 'the fix round waits for the strategist too');
  const st = strategist(p, 's1', { action: 'continue', expect: { files: 6, rounds: 3 } });
  assert.deepEqual(st.bundle.courseSignals.map((x) => x.id), ['files', 'amended']);
  assert.match(st.bundle.instructions, /`courseSignals` is what the engine saw that no strategist has answered/);
  ok(st.record());
  s = resume(p);
  assert.equal(s.decision.kind, 'repair', 'the decision answers the signals it saw: the fix round is next');
  assert.deepEqual(s.expectations.at(-1), { ...s.expectations.at(-1), source: 'strategy', decision: 'S1', expect: { files: 6, rounds: 3 } });
  assert.equal(s.expect.files, 6, 'the course is compared with the new expectation');
});

test('rounds past the plan, a cause that came back and a fix whose own lines were where the next defects were found each make the strategist the next step', () => {
  const p = project('cs-rounds', { files: 10, rounds: 1, minutes: 600 });
  implement(p, 'i1', { 'src/a.txt': LINES.replace('l2', 'L2') });
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { findings: [blocking('F1', 'src/a.txt:2', { family: 'totals' })] }));
  assert.equal(resume(p).decision.kind, 'repair', 'one round, as planned: no signal yet');
  // The fix round writes line 5; the next round finds the same family there, on the fix's own line.
  implement(p, 'i1', { 'src/a.txt': LINES.replace('l2', 'L2 fixed').replace('l5', 'L5 new') });
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', p.id]));
  record(p, goodClosure('r2', { criteria: [], priorFindings: [{ round: 'r1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:2 is right' }], findings: [blocking('F1', 'src/a.txt:5', { family: 'totals' })] }));
  const s = resume(p);
  assert.equal(s.decision.kind, 'strategy');
  assert.deepEqual(s.decision.courseSignals.map((x) => x.id), ['rounds', 'recurring', 'regression']);
  assert.match(s.next, /2 review rounds handed, past the 1 the plan expected/);
  assert.match(s.next, /r2:F1 has the family of r1:F1 \(totals\), which was marked fixed/);
  assert.match(s.next, /round 2 raised 1 finding\(s\) on lines the fix round after round 1 wrote \(r2:F1\): the last fix made new defects/);
  // The strategist consolidates: its decision drives the next step, the one amendment that restates the remaining work.
  ok(strategist(p, 's1', { action: 'consolidate', rationale: 'one assumption about totals lives in several places', expect: { rounds: 1, minutes: 60 } }).record());
  let next = resume(p);
  assert.equal(next.decision.kind, 'strategy');
  assert.match(next.next, /the strategist decided to consolidate \(S1\): record its one amendment first, restating all remaining work as one planned pass with an expectation/);
  ok(wf(p.root, ['criteria', 'amend', '--file', closureFile(p.base, { expect: { rounds: 1, minutes: 60 }, plan: { summary: 'derive every total from one place' } }), '--reason', 'S1: one assumption about totals, every place it lives', '--attempt', p.id]));
  next = resume(p);
  assert.equal(next.decision.kind, 'repair', 'recorded: the fix round for the whole cause is next');
});

test('an implementer whose expectation is far above the fix the reviewer stated, or that asks for a re-plan, makes the strategist the next step', () => {
  const p = project('cs-diverge', { files: 10, rounds: 6, minutes: 600 });
  implement(p, 'i1', { 'src/a.txt': LINES.replace('l2', 'L2') });
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { findings: [blocking('F1', 'src/a.txt:2', { fix: { what: 'compute the fingerprint before the provider call', minutes: 20 } })] }));
  // The fix round's bundle carries the reviewer's stated fix, and the rule that a redesign is a re-plan request.
  const h = ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id, '--json'])).json();
  const b = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  assert.deepEqual(b.repair[0].findings[0].fix, { what: 'compute the fingerprint before the provider call', minutes: 20 });
  assert.match(b.instructions, /Fix with the smallest change that removes the assumption, wherever it lives/);
  assert.match(b.instructions, /A fix that needs a migration, a new state, a new endpoint, a contract change \(a DTO, a route, an error code\) or a new failure path is not yours to build in a fix round or a planned pass: it is a re-plan request/);
  // Review of 0.7.28 (L4a): past twice the stated fix but within one round of the plan (600 min over 6 rounds) is two estimates'
  // noise, not a redesign: no signal.
  writeReport(p.root, p.id, 'i1', { approach: 'move the fingerprint up', expect: { minutes: 41 } });
  assert.notEqual(resume(p).decision.kind, 'strategy');
  // While it works, it states 240 minutes: the strategist is the next step at once.
  writeReport(p.root, p.id, 'i1', { approach: 'a reservation and reconciliation model', expect: { minutes: 240 } });
  let s = resume(p);
  assert.equal(s.decision.kind, 'strategy');
  // Review of 0.7.28 (L5): the step says what to do with the implementer still building.
  assert.match(s.next, /Implementer i1 is still open: the strategist decides alongside; when its decision changes the approach \(a consolidation, a split, a re-plan\), stop it before the next handoff/);
  assert.match(s.next, /implementer i1 expects 240 min for findings whose reviewers stated a fix of 20 min in all \(r1:F1: compute the fingerprint before the provider call\): an approach far larger than the fix asked for/);
  // It asks for a re-plan instead and builds none of it.
  writeReport(p.root, p.id, 'i1', { approach: 'the fix needs a new state', expect: { minutes: 15 }, replan: { why: 'the fingerprint needs a stored reservation', needs: ['migration', 'new state'] } });
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2 note') }, 'note only');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  s = resume(p);
  assert.equal(s.decision.kind, 'strategy');
  assert.deepEqual(s.decision.courseSignals.map((x) => x.id), ['replan']);
  assert.match(s.next, /implementer i1 asks for a re-plan: the fingerprint needs a stored reservation \(it needs migration, new state\)/);
  // The re-plan it asked for answers it, and adds a criterion without that being a new signal (review of 0.7.28, L4b): the
  // amendment is the course correction that was asked for.
  ok(wf(p.root, ['criteria', 'amend', '--file', closureFile(p.base, { criteria: [{ id: 'C2', text: 'a reservation is stored before the provider call', uat: 'a retried request reuses it' }], impact: { unchanged: 'the same module' }, expect: { minutes: 120, rounds: 2 }, plan: { summary: 'store a reservation before the provider call' } }), '--reason', 'the re-plan the implementer asked for', '--attempt', p.id]));
  assert.notEqual(resume(p).decision.kind, 'strategy');
});

test('a project that switched the strategist off gets no course step', () => {
  const p = project('cs-off', { files: 1, rounds: 6, minutes: 600 }, { strategy: { enabled: false } });
  implement(p, 'i1', { 'src/a.txt': 'x\n', 'src/b.txt': 'x\n', 'src/c.txt': 'x\n' });
  assert.equal(resume(p).decision.kind, 'review');
});

// Since 0.7.33 (I-229, D84) the engine asks no round question (the strategist decides at the count); one an earlier release asked
// keeps its choices, and its `hold` still holds the ticket in those words.
test('a round question an earlier release asked offers to hold for a product or legal answer, and choosing it holds the ticket in those words', async () => {
  const p = project('cs-hold', { files: 10, rounds: 6, minutes: 600 }, { strategy: { reviewRoundsEscalate: 1 } });
  implement(p, 'i1', { 'src/a.txt': LINES.replace('l2', 'L2') });
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { findings: [blocking('F1', 'src/a.txt:2')] }));
  const { append } = await import('../engine/ledger.mjs');
  append(p.root, p.id, 'decision.created', { id: 'A1', kind: 'escalation', key: 'tripwire:rounds-escalation:rounds:1', summary: '1 review rounds handed; the owner decides how to continue: continue | split | deliver-core | hold | stop', choices: ['continue', 'split', 'deliver-core', 'hold', 'stop'], labels: { continue: 'Keep going as now', split: 'Split off the rest as its own ticket', 'deliver-core': 'Ship what the criteria need now', hold: 'It needs a product or legal answer first: hold', stop: 'Stop this ticket' } }, 'human:scenario');
  const asked = wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id], { ownerSilent: true });
  assert.equal(asked.code, 75);
  assert.match(asked.err, /\(A1\); no implementer starts until the person answers it or the strategist decides/);
  const d = resume(p).decisions.find((x) => x.kind === 'escalation');
  const { approveInTerminal } = await import('../engine/approve.mjs');
  await inProcess(p.root, async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const pending = approveInTerminal(p.root, d.id, { attempt: p.id }, { input, output, env: {} });
    setImmediate(() => input.write('It needs a product or legal answer first: hold\n'));
    assert.equal((await pending).choice, 'hold');
  });
  const held = wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id], { ownerSilent: true });
  assert.equal(held.code, 75);
  assert.match(held.err, /the person chose to hold .* until they give a product or legal answer/);
  assert.match(resume(p).activeHold.reason, /the person needs to give a product or legal answer first \(escalation A1/);
});
