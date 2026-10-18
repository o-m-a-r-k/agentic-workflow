// 0.7.30 (I-134, D59): a standard attempt runs only the spec files its change can affect, when the heavy step declares its
// `specs` and an `affects` rule; whenever the rule does not account for a changed file, the whole step runs.
//
// Named failure (field): a one-line change reran the whole 1,200-test end-to-end step (27 to 40 minutes): the gate had no way
// to run only the specs related to the touched modules, so the cost did not scale with the change and unrelated flaky specs
// blocked small fixes. The person: "I want to challenge why we need a full gate rerun on this if there is no wider side effect".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, wf } from './helpers.mjs';

// A runner that takes spec files (JUnit out), recording what it ran beside the run's scratch folder; with none given it runs all.
const SPECS = ['test/auth/login.e2e-spec.ts', 'test/billing/invoice.e2e-spec.ts', 'test/billing/refund.e2e-spec.ts', 'test/home.e2e-spec.ts'];
const RUNNER = `
const fs=require('fs');const sel=process.argv.slice(2);
const all=${JSON.stringify(SPECS)};const run=sel.length?sel:all;
fs.appendFileSync(process.env.WF_EVIDENCE+'/../ran.txt',run.join(',')+'\\n');
const bad=(f)=>fs.readFileSync(f,'utf8').includes('bad');
fs.mkdirSync('reports',{recursive:true});
fs.writeFileSync('reports/junit.xml','<testsuites>'+run.map(f=>'<testsuite name="'+f+'" file="'+f+'" tests="1"><testcase name="works" file="'+f+'">'+(bad(f)?'<failure>no</failure>':'')+'</testcase></testsuite>').join('')+'</testsuites>');
if(run.some(bad))process.exit(1);`;
const affects = [{ paths: ['src/billing/**'], specs: ['test/billing/**'] }, { paths: ['src/auth/**'], specs: ['test/auth/**'] }];
const e2e = { id: 'e2e', repo: 'app', run: 'node runner.cjs {select}', select: '{suites}', report: { junit: 'reports/junit.xml' }, inputs: ['test/**', 'src/**', 'runner.cjs'], tier: 'heavy', specs: ['test/**/*.e2e-spec.ts'], affects };
const unit = { id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] };
const files = { 'runner.cjs': RUNNER, ...Object.fromEntries(SPECS.map((f) => [f, `${f}\n`])), 'src/billing/invoice.txt': 'i\n', 'src/auth/login.txt': 'l\n', 'src/shared.txt': 's\n' };
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
const gate = (p, id, extra = []) => {
  const r = wf(p.root, ['gate', '--attempt', id, '--json', ...extra]);
  return { code: r.code, data: JSON.parse(r.out), err: r.err };
};

test('I-134: a change the `affects` rule accounts for runs only the specs it can affect; the gate counts', () => {
  const p = singleRepoProject('affected-specs', { gate: { steps: [unit, e2e] } }, files);
  const e = reviewed(p, 'ENG-134', { 'src/billing/invoice.txt': 'i 2\n', 'test/auth/login.e2e-spec.ts': 'login, edited\n' });
  const g = gate(p, e.id);
  assert.equal(g.code, 0, g.err);
  const step = g.data.steps.find((x) => x.id === 'e2e');
  assert.equal(step.status, 'passed');
  assert.deepEqual(step.affectedSpecs, ['test/auth/login.e2e-spec.ts', 'test/billing/invoice.e2e-spec.ts', 'test/billing/refund.e2e-spec.ts']);
  assert.match(step.reason, /only the spec files this change can affect, by the step's `affects` rule \(3\): test\/auth\/login\.e2e-spec\.ts, test\/billing\/invoice\.e2e-spec\.ts, test\/billing\/refund\.e2e-spec\.ts; `wf gate --full` runs the whole step/);
  assert.equal(ranIn(p.root, e.id, g.data.runId), 'test/auth/login.e2e-spec.ts,test/billing/invoice.e2e-spec.ts,test/billing/refund.e2e-spec.ts');
  // The whole step is still one command away, and a scoped pass never stands for it.
  const full = gate(p, e.id, ['--full', '--prepare-only']);
  const planned = full.data.steps.find((x) => x.id === 'e2e');
  assert.equal(planned.decision, 'run', 'a scoped pass is not reused for the whole step');
  assert.equal(planned.affectedSpecs, undefined);
});

test('I-134: when the rule does not account for a changed file, the whole step runs and says why', () => {
  const p = singleRepoProject('affected-specs-unsure', { gate: { steps: [unit, e2e] } }, files);
  const e = reviewed(p, 'ENG-135', { 'src/billing/invoice.txt': 'i 2\n', 'src/shared.txt': 's 2\n' });
  const g = gate(p, e.id);
  assert.equal(g.code, 0, g.err);
  const step = g.data.steps.find((x) => x.id === 'e2e');
  assert.equal(step.affectedSpecs, undefined);
  assert.match(step.reason, /; the whole step runs: no `affects` rule covers src\/shared\.txt/);
  assert.equal(ranIn(p.root, e.id, g.data.runId), SPECS.join(','));
});

test('I-134: a suite that failed in this attempt runs with the scoped specs: a known failure is never left out into a pass', () => {
  const p = singleRepoProject('affected-specs-failed', { gate: { steps: [unit, e2e] } }, { ...files, 'test/home.e2e-spec.ts': 'home bad\n' });
  const e = reviewed(p, 'ENG-136', { 'src/billing/invoice.txt': 'i 2\n' });
  const whole = gate(p, e.id, ['--full']);
  assert.equal(whole.code, 1, 'the whole run fails on test/home, which the change does not touch');
  const g = gate(p, e.id);
  assert.equal(g.code, 1, 'the scoped run takes the failed suite with it');
  const step = g.data.steps.find((x) => x.id === 'e2e');
  assert.deepEqual(step.affectedSpecs, ['test/billing/invoice.e2e-spec.ts', 'test/billing/refund.e2e-spec.ts', 'test/home.e2e-spec.ts']);
  assert.deepEqual(step.suites.filter((x) => x.status === 'failed').map((x) => x.file), ['test/home.e2e-spec.ts']);
});

test('I-134: `affects` is a list of { paths, specs } on a step that declares its specs', () => {
  for (const [step, msg] of [
    [{ ...e2e, affects: [{ paths: ['src/**'] }] }, /step `e2e`: affects must be a list of \{ paths: \[globs\], specs: \[globs\] \}/],
    [{ ...e2e, specs: undefined }, /step `e2e`: affects needs `specs`/],
  ]) {
    const p = singleRepoProject('affected-specs-config', { gate: { steps: [unit, step] } }, files);
    const r = wf(p.root, ['entry', '--item', 'ENG-137', '--owner', 'o']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, msg);
  }
});
