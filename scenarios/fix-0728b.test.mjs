// 0.7.28, second stream: I-209 (finding history reaches every attempt in flight), I-211 (a divided review starts only through
// `wf handoff run`), I-212 (a deferred member runs its own heavy specs; a pre-existing failing suite can be quarantined by the
// person) and I-213 (an amendment file that is not there, or a survey in the wrong place, is refused in plain words).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, stages, wf } from './helpers.mjs';
import { runner } from './strategist-fixtures.mjs';

const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';
const bundleOf = (r) => JSON.parse(fs.readFileSync((r.out.match(/^Read (\S+)/m) ?? r.out.match(/bundle: (\S+)/))[1], 'utf8'));

// 0.7.28 (I-209), named failure (field): a batch's fix rounds were handed under 0.7.27 to fix findings that did not block (in a
// batch only lines the batch itself wrote block, D2), so no handoff carried a `repair`, and the finding history 0.7.27 added
// reached none of them; its members had been admitted under 0.7.17 and 0.7.18, and D7 was taken to keep it out. The same cause
// was then found one place per round, three or four rounds for each of four causes. Information that only helps the implementer
// reaches every attempt in flight (D7 as amended), and every implementer handed after a recorded round.
test('I-209: an implementer handed after a recorded round gets the finding history whatever release admitted the attempt and whether or not a finding blocks', () => {
  const old = runner('0.7.18');
  const p = singleRepoProject('i209-history', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } }, { 'src/a.txt': LINES });
  const e = ok(old.run(p.root, ['entry', '--item', 'ENG-209', '--owner', 'o', '--json'])).json();
  assert.equal(old.state(p.root, e.id).engineVersion, '0.7.18');
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'implement C1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
  // Nothing blocks: an observation off the changed lines, the shape of a batch round's findings.
  const obs = { id: 'F1', severity: 'medium', summary: 'F1: the total ignores the filter', status: 'open', evidence: 'src/a.txt:5', family: 'filter-totals' };
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r1', { findings: [obs] })), '--attempt', e.id]));
  const b = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', e.id])));
  assert.equal(b.repair, undefined, 'no finding blocks');
  assert.deepEqual(b.findingHistory.map((h) => [h.ref, h.status, h.family]), [['r1:F1', 'open', 'filter-totals']]);
  assert.match(b.instructions, /`findingHistory` lists every finding of the attempt so far, where it stands and the fix recorded for it/);
});

// 0.7.28 (I-213), named failure (field): `wf criteria amend --file` named a path where no file was while the owner was moving a
// plan survey into the amendment, and the engine threw the reader's stack trace (lifecycle.mjs:428 under 0.7.18); the owner read
// the engine's source to find out why. The current engine still threw it (from the same reader). And the survey itself had no
// plain route: under `plan` it was told to sit "at the top level of the plan file", and at the top level that it is a field no
// amendment applies, so the owner went between two refusals. Each now says where a survey goes in an amendment.
test('I-213: an amendment file that is not there is refused in plain words, and a survey outside `impact` is told where it goes', () => {
  const p = singleRepoProject('i213-amend', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } }, { 'src/a.txt': LINES });
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-213', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  const missing = wf(p.root, ['criteria', 'amend', '--file', path.join(p.base, 'amend-survey.yaml'), '--reason', 'restate the survey', '--attempt', e.id]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /--file ".*amend-survey\.yaml": is not there \(no such file: .*amend-survey\.yaml\); write the file first, or pass the path it was written to/);
  assert.doesNotMatch(missing.err, /\n\s+at |ENOENT/, 'no stack trace');
  const survey = { ...stages([{ id: 'C1' }]).survey, queries: [{ id: 'Q-new', pattern: 'l3', kind: 'literal', repo: 'app', paths: ['src/**'], hits: 1 }] };
  const top = closureFile(p.base, { criteria: [{ id: 'C2', text: 'b changes', uat: 'b shows it' }], survey });
  const topRefused = wf(p.root, ['criteria', 'amend', '--file', top, '--reason', 'restate the survey', '--attempt', e.id]);
  assert.equal(topRefused.code, 75);
  assert.match(topRefused.err, /in an amendment a survey goes under `impact`: `impact: \{ queries: \[<new queries>\], survey: \{ components, consumers, flows, patterns \}, changes: \[\.\.\.\] \}`/);
  const under = closureFile(p.base, { criteria: [{ id: 'C2', text: 'b changes', uat: 'b shows it' }], plan: { summary: 'b too', survey } });
  const underRefused = wf(p.root, ['criteria', 'amend', '--file', under, '--reason', 'restate the survey', '--attempt', e.id]);
  assert.notEqual(underRefused.code, 0);
  assert.match(underRefused.err, /the amendment carries `survey` under `plan`: in an amendment a survey goes under `impact`/);
  assert.doesNotMatch(underRefused.err, /at the top level of the plan file/);
});

// A runner that takes spec files (Jest-like, writing JUnit), recording what it ran beside the run's scratch folder; a spec that
// holds "bad" fails, and with no files given it runs them all.
const RUNNER = `
const fs=require('fs');const sel=process.argv.slice(2);
const all=['test/a.e2e-spec.ts','test/b.e2e-spec.ts','test/c.service.e2e-spec.ts'];const run=sel.length?sel:all;
fs.appendFileSync(process.env.WF_EVIDENCE+'/../ran.txt',run.join(',')+'\\n');
const bad=(f)=>fs.readFileSync(f,'utf8').includes('bad');
fs.mkdirSync('reports',{recursive:true});
fs.writeFileSync('reports/junit.xml','<testsuites>'+run.map(f=>'<testsuite name="'+f+'" file="'+f+'" tests="1"><testcase name="works" file="'+f+'">'+(bad(f)?'<failure>no</failure>':'')+'</testcase></testsuite>').join('')+'</testsuites>');
if(run.some(bad))process.exit(1);`;
const e2e = { id: 'e2e', repo: 'app', run: 'node runner.cjs {select}', select: '{suites}', report: { junit: 'reports/junit.xml' }, inputs: ['test/**', 'src/**', 'runner.cjs'], tier: 'heavy', specs: ['test/**/*.e2e-spec.ts'] };
const unit = { id: 'unit', repo: 'app', run: 'true' };
const files = (c = 'c\n') => ({ 'runner.cjs': RUNNER, 'test/a.e2e-spec.ts': 'a\n', 'test/b.e2e-spec.ts': 'b\n', 'test/c.service.e2e-spec.ts': c, 'src/app.txt': 'app\n' });
const ranIn = (root, id, runId) => fs.readFileSync(path.join(root, '.wf-worktrees', '_gate', id, runId, 'ran.txt'), 'utf8').trim();
function reviewed(p, item, change, entryArgs = []) {
  const e = ok(wf(p.root, ['entry', '--item', item, '--owner', 'o', '--json', ...entryArgs])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', `p-${item}`, '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', `i-${item}`, '--attempt', e.id]));
  commitIn(e.repos.app.worktree, change, 'the change');
  ok(wf(p.root, ['handoff', 'close', '--agent', `i-${item}`, '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', `r-${item}`, '--attempt', e.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure(`r-${item}`)), '--attempt', e.id]));
  return e;
}
const gate = (p, id) => {
  const r = wf(p.root, ['gate', '--attempt', id, '--json']);
  return { code: r.code, data: JSON.parse(r.out), err: r.err };
};

// 0.7.28 (I-212, part 1), named failure (field): with `--defer-heavy` no heavy step ran on any member, so a ticket's own new
// end-to-end spec first ran at hour 28, in the batch gate, and no reviewer had seen its screenshots before then.
test('I-212: a member whose heavy steps are deferred runs the spec files its own change adds or edits; a member with none defers the step', () => {
  const p = singleRepoProject('i212-own-specs', { gate: { steps: [unit, e2e] } }, files());
  const own = reviewed(p, 'ENG-212', { 'test/b.e2e-spec.ts': 'b, edited by this ticket\n', 'src/app.txt': 'app 2\n' }, ['--defer-heavy']);
  const g = gate(p, own.id);
  assert.equal(g.code, 0, g.err);
  const step = g.data.steps.find((x) => x.id === 'e2e');
  assert.equal(step.status, 'passed');
  assert.deepEqual(step.ownSpecs, ['test/b.e2e-spec.ts']);
  assert.equal(ranIn(p.root, own.id, g.data.runId), 'test/b.e2e-spec.ts', 'only the ticket\'s own spec ran');
  const other = reviewed(p, 'ENG-213', { 'src/app.txt': 'app 3\n' }, ['--defer-heavy']);
  const g2 = gate(p, other.id);
  assert.equal(g2.data.steps.find((x) => x.id === 'e2e').status, 'deferred', 'no spec of its own: the step waits for the batch gate');
});

// 0.7.28 (I-212, part 2), named failure (field): the batch gate then failed five times (158 minutes) on end-to-end specs that
// were flaky before the batch and that it never touched, and each failure became a repair round. The person has one decision
// for such a suite: set it aside for this delivery, and the delivered comment says it was not proven.
test('I-212: the person sets aside a pre-existing failing suite the delivery does not touch; the gate passes on it and the delivered comment names it', async () => {
  const p = singleRepoProject('i212-quarantine', { gate: { steps: [unit, e2e] } }, files('c bad, before this ticket\n'));
  const e = reviewed(p, 'ENG-214', { 'src/app.txt': 'app 2\n' });
  const g1 = gate(p, e.id);
  assert.equal(g1.code, 1);
  assert.deepEqual(g1.data.steps.find((x) => x.id === 'e2e').suites.filter((x) => x.status === 'failed').map((x) => x.file), ['test/c.service.e2e-spec.ts']);
  const notFailing = wf(p.root, ['gate', 'quarantine', '--step', 'e2e', '--suite', 'test/a.e2e-spec.ts', '--reason', 'it is flaky', '--attempt', e.id]);
  assert.equal(notFailing.code, 75);
  assert.match(notFailing.err, /test\/a\.e2e-spec\.ts did not fail in e2e in the last gate on this tree \(failed there: test\/c\.service\.e2e-spec\.ts\)/);
  // The person is asked once (the scripted person answers yes); the next gate passes with the suite set aside.
  const set = ok(wf(p.root, ['gate', 'quarantine', '--step', 'e2e', '--suite', 'test/c.service.e2e-spec.ts', '--reason', 'it fails on the base branch too', '--attempt', e.id]));
  assert.match(set.out, /test\/c\.service\.e2e-spec\.ts of e2e is set aside for/);
  const s0 = JSON.parse(ok(wf(p.root, ['resume', '--attempt', e.id, '--json'])).out);
  const d = s0.decisions.find((x) => x.key === `quarantine:${e.id}:e2e:test/c.service.e2e-spec.ts`);
  assert.equal(d.kind, 'override-gate');
  assert.match(d.plain, /Should ENG-214 ship with the existing test suite test\/c\.service\.e2e-spec\.ts \(e2e\) set aside, instead of more repair rounds\? It failed in the gate, this change does not touch it, and it fails on the base branch too/);
  const g2 = gate(p, e.id);
  assert.equal(g2.code, 0, g2.err);
  assert.deepEqual(g2.data.steps.find((x) => x.id === 'e2e').quarantined, ['test/c.service.e2e-spec.ts']);
  const { knownLimits } = await import('../engine/tracker.mjs');
  const after = JSON.parse(ok(wf(p.root, ['resume', '--attempt', e.id, '--json'])).out);
  assert.match(knownLimits(after), /Not proven by the checks: the existing test suite test\/c\.service\.e2e-spec\.ts failed before this change and was set aside by your decision/);
});

test('I-212: a suite the delivery changes is its own to fix, never set aside', () => {
  const p = singleRepoProject('i212-touched', { gate: { steps: [unit, e2e] } }, files());
  const e = reviewed(p, 'ENG-215', { 'test/c.service.e2e-spec.ts': 'c bad, broken by this ticket\n' });
  assert.equal(gate(p, e.id).code, 1);
  const refused = wf(p.root, ['gate', 'quarantine', '--step', 'e2e', '--suite', 'test/c.service.e2e-spec.ts', '--reason', 'flaky', '--attempt', e.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /test\/c\.service\.e2e-spec\.ts is changed by this delivery \(app:test\/c\.service\.e2e-spec\.ts\): its failure is this delivery's to fix/);
});
