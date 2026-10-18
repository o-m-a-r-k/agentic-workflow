// 0.7.30 (I-158, D58): the person's one reserved decision to deliver without the full test run.
//
// Named failure (field): the person said "skip the full gate but do the review". The engine had decisions to run the gate out
// of order and to correct a frozen check, but none to deliver without the full gate, so the person's choice could not be
// recorded without working around the gate's acceptance. `wf gate light-only --reason "<why>"` asks it in one plain question
// that says what was and was not proven; once answered yes, the gate runs the light steps and leaves the heavy ones out (a
// failed one, or one the ticket froze as its own check, still runs), it counts for acceptance and delivery, the evidence
// reviewer is told what did not run, and the delivered comment says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, wf } from './helpers.mjs';

const unit = { id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] };
const e2e = (run = 'echo ran > "$WF_ROOT/../e2e-ran.txt"') => ({ id: 'e2e', repo: 'app', run, inputs: ['src/**'], tier: 'heavy' });
function reviewed(p, item, entryArgs = []) {
  const e = ok(wf(p.root, ['entry', '--item', item, '--owner', 'o', '--json', ...entryArgs])).json();
  if (!entryArgs.includes('quick')) ok(wf(p.root, ['handoff', 'planner', '--agent', `p-${item}`, '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', `i-${item}`, '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'changed\n' }, 'the change');
  ok(wf(p.root, ['handoff', 'close', '--agent', `i-${item}`, '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', `r-${item}`, '--attempt', e.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure(`r-${item}`)), '--attempt', e.id]));
  return e;
}
const resume = (p, id) => JSON.parse(ok(wf(p.root, ['resume', '--attempt', id, '--json'])).out);

test('I-158: the person decides once to deliver without the full test run, told what was and was not proven; the gate counts and the delivered comment says so', async () => {
  const p = singleRepoProject('light-only', { gate: { steps: [unit, e2e()] } });
  const e = reviewed(p, 'ENG-158');
  ok(wf(p.root, ['check', '--attempt', e.id]));
  // Asked once, in plain words (the scripted person answers yes).
  const asked = ok(wf(p.root, ['gate', 'light-only', '--reason', 'the person asked to skip the full test run and keep the review', '--attempt', e.id]));
  assert.match(asked.out, /ENG-158\.1 leaves out e2e by the person's decision \(A\d+\): the next `wf gate` runs the light steps only/);
  const d = resume(p, e.id).decisions.find((x) => x.key === `light-only:${e.id}`);
  assert.equal(d.kind, 'override-gate');
  // Review of 0.7.30: the answer is bound to the attempt, so the question says it covers the rest of the delivery, later fixes
  // included (it read "Proven on this code so far", while later commits kept skipping the heavy steps).
  assert.match(d.plain, /^Should ENG-158 be delivered without its full test run\? Your answer covers the rest of this delivery, later fixes included: e2e would not run on any of it\. Proven on the code as it is now: unit passed\. The agent's reason: the person asked to skip the full test run and keep the review\./);
  assert.deepEqual(d.labels, { yes: 'Deliver without the full tests', no: 'Run the full tests first' });
  // The gate leaves e2e out, counts, and the evidence reviewer is told what did not run.
  const g = JSON.parse(ok(wf(p.root, ['gate', '--attempt', e.id, '--json'])).out);
  assert.equal(g.status, 'passed');
  const step = g.steps.find((x) => x.id === 'e2e');
  assert.equal(step.status, 'skipped');
  assert.equal(step.skippedBy, 'person');
  assert.match(step.reason, /left out by the person's decision \(A\d+\): delivered without the full test run/);
  assert.ok(!fs.existsSync(path.join(p.root, '..', 'e2e-ran.txt')), 'e2e did not run');
  // `wf gate --full` still runs it: the decision allows leaving it out, it never forbids running it.
  const full = JSON.parse(ok(wf(p.root, ['gate', '--full', '--prepare-only', '--attempt', e.id, '--json'])).out);
  assert.equal(full.steps.find((x) => x.id === 'e2e').decision, 'run');
  const rev = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', e.id]));
  const bundle = JSON.parse(fs.readFileSync((rev.out.match(/bundle: (\S+)/) ?? rev.out.match(/^Read (\S+)/m))[1], 'utf8'));
  assert.deepEqual(bundle.gate.notRun.map((x) => x.step), ['e2e']);
  const { knownLimits } = await import('../engine/tracker.mjs');
  assert.match(knownLimits(resume(p, e.id)), /Not proven by the checks: the test step e2e did not run for this delivery, by your decision to deliver without the full test run\./);
});

test('I-158: a heavy step that failed in this attempt still runs, and the question says so; nothing to leave out is refused', () => {
  const p = singleRepoProject('light-only-failed', { gate: { steps: [unit, e2e('test -f src/fixed.txt')] } });
  const e = reviewed(p, 'ENG-159');
  assert.equal(wf(p.root, ['gate', '--attempt', e.id]).code, 1, 'e2e fails');
  const refused = wf(p.root, ['gate', 'light-only', '--reason', 'skip it', '--attempt', e.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /nothing to leave out: every heavy step of ENG-159\.1 that would run failed in this attempt \(e2e\); a known failure is never left out into a pass/);
  // With another heavy step to leave out, the failed one is named among what still runs.
  const two = singleRepoProject('light-only-two', { gate: { steps: [unit, e2e('test -f src/fixed.txt'), { ...e2e(), id: 'e2e-b' }] } });
  const t = reviewed(two, 'ENG-161');
  assert.equal(wf(two.root, ['gate', '--attempt', t.id]).code, 1, 'e2e fails, e2e-b passes');
  commitIn(t.repos.app.worktree, { 'src/b.txt': 'more\n' });
  ok(wf(two.root, ['gate', 'light-only', '--reason', 'skip the long one', '--attempt', t.id]));
  const plain = resume(two, t.id).decisions.find((x) => x.key === `light-only:${t.id}`).plain;
  assert.match(plain, /Your answer covers the rest of this delivery, later fixes included: e2e-b would not run on any of it\. Proven on the code as it is now: nothing yet\. Still run before delivery: unit, e2e \(it failed in this attempt\)\./);
  const quick = singleRepoProject('light-only-quick', { gate: { steps: [unit, e2e()] } });
  const q = ok(wf(quick.root, ['entry', '--item', 'ENG-160', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  const r = wf(quick.root, ['gate', 'light-only', '--reason', 'skip it', '--attempt', q.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /a quick fix's gate already runs the light steps only/);
  assert.match(wf(p.root, ['gate', 'light-only', '--attempt', e.id]).err, /usage: wf gate light-only --reason/);
});
