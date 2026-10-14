import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commitIn, criteriaFile, ok, OUT_OF_ORDER, singleRepoProject, wf } from './helpers.mjs';
import { rerunsOnlyFailed } from '../engine/onboard.mjs';
import { playwrightJsonSuites } from '../engine/junit.mjs';

// 0.7.6, I-118, named failure (field): after a gate failed with 55 e2e failures, the implementer handed the repair proved
// every fix by rerunning whole suites (10 to 22 minutes each, eight times: 68 of its 113 minutes were waits). The steps
// could not rerun only what failed (the suite list came from JUnit only; the Playwright step wrote a JSON report the
// engine read for failure names alone), the implementer was handed none of the facts of the failed gate, and 50 of the
// failures, in files the change never touched, came from the test environment's state. The engine now supplies the facts
// and the capability; how to use them is the implementer's decision (goals, not methods).

function admitted(root, base, item) {
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  return e;
}
const gateJson = (root, id, extra = []) => {
  const r = wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id, '--json', ...extra]);
  return { code: r.code, data: r.out ? JSON.parse(r.out) : null, err: r.err };
};

// A Playwright-like runner: takes spec files (or runs all), writes Playwright's JSON report, fails the spec marked bad; a
// spec marked broken fails to load, so Playwright names it only in the report's top-level errors.
const runner = (all) => `
const fs=require('fs');const sel=process.argv.slice(2);
const all=${JSON.stringify(all)};const run=sel.length?sel:all;
fs.appendFileSync(process.env.WF_EVIDENCE+'/../ran.txt',run.join(',')+'\\n');
const has=(f,w)=>fs.readFileSync(f,'utf8').includes(w);const bad=(f)=>has(f,'bad');const broken=(f)=>has(f,'broken');
const suites=run.filter(f=>!broken(f)).map(f=>({title:f,file:f,specs:[{title:'works',file:f,line:1,ok:!bad(f),tests:[{status:bad(f)?'unexpected':'expected',results:[{status:bad(f)?'failed':'passed',duration:1200}]}]}],suites:[]}));
const errors=run.filter(broken).map(f=>({message:'SyntaxError',location:{file:f,line:1,column:1}}));
fs.writeFileSync(process.env.WF_EVIDENCE+'/results.json',JSON.stringify({suites,errors}));
run.filter(bad).forEach((f,i)=>console.log('  '+(i+1)+') '+f+':1:1 › works'));
if(run.some(f=>bad(f)||broken(f)))process.exit(1);`;
const RUNNER = runner(['specs/a.spec.ts', 'specs/b.spec.ts', 'specs/c.spec.ts']);
const files = { 'runner.cjs': RUNNER, 'specs/a.spec.ts': 'a\n', 'specs/b.spec.ts': 'b\n', 'specs/c.spec.ts': 'c\n', 'src/app.txt': 'app\n' };
const playwrightStep = { id: 'e2e', repo: 'app', run: 'node runner.cjs {select}', select: '{suites}', report: { playwright: '{evidence}/results.json' }, inputs: ['specs/**', 'src/**', 'runner.cjs'], tier: 'heavy' };

test('a Playwright step\'s JSON report is its suite list: after a failure only the failed spec files rerun', () => {
  const { base, root } = singleRepoProject('pw-suites', { gate: { steps: [playwrightStep] } }, files);
  const e = admitted(root, base, 'ENG-60');
  commitIn(e.repos.app.worktree, { 'specs/b.spec.ts': 'bad\n' });
  const g1 = gateJson(root, e.id);
  assert.equal(g1.code, 1);
  assert.deepEqual(g1.data.steps[0].suites.map((s) => `${s.id}:${s.status}`).sort(), ['specs/a.spec.ts:passed', 'specs/b.spec.ts:failed', 'specs/c.spec.ts:passed']);
  commitIn(e.repos.app.worktree, { 'specs/b.spec.ts': 'good\n' });
  const g2 = gateJson(root, e.id);
  assert.equal(g2.code, 0);
  const ran = fs.readFileSync(path.join(root, '.wf-worktrees', '_gate', e.id, g2.data.runId, 'ran.txt'), 'utf8').trim();
  assert.equal(ran, 'specs/b.spec.ts', 'only the failed spec file reran');
  assert.ok(g2.data.steps[0].suites.find((s) => s.id === 'specs/a.spec.ts').carried, 'the passing ones are carried');
});

test('the implementer handed a repair after a failed gate is given its facts, not a method', () => {
  const wholeStep = { id: 'service-e2e', repo: 'app', run: 'node runner.cjs', inputs: ['specs/**', 'src/**', 'runner.cjs'], tier: 'heavy' };
  const { base, root } = singleRepoProject('pw-facts', { gate: { steps: [playwrightStep, wholeStep] } }, files);
  const e = admitted(root, base, 'ENG-61');
  commitIn(e.repos.app.worktree, { 'src/app.txt': 'changed\n', 'specs/c.spec.ts': 'bad\n' });
  assert.equal(gateJson(root, e.id).code, 1);
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  const h = ok(wf(root, ['handoff', 'implementer', '--agent', 'i2', '--attempt', e.id, '--json'])).json();
  const bundle = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  const steps = Object.fromEntries(bundle.failedGate.steps.map((s) => [s.id, s]));
  assert.deepEqual(steps.e2e.failedSuites, ['specs/c.spec.ts']);
  assert.equal(steps.e2e.rerunsOnlyFailed, true);
  assert.equal(steps['service-e2e'].rerunsOnlyFailed, false, 'a step without a suite report and select reruns whole');
  assert.equal(typeof steps.e2e.lastRunMinutes, 'number');
  assert.equal(steps.e2e.failedTestCount, 1);
  assert.ok(steps.e2e.failedTests.some((t) => /specs\/c\.spec\.ts/.test(t)));
  assert.deepEqual(steps.e2e.failingFilesNotChanged, [], 'the failing spec is a file this change touched');
  assert.equal(bundle.failedGate.onCurrentTree, true, 'the facts are of the tree the implementer is handed');
  assert.equal(typeof bundle.failedGate.tree, 'object');
  assert.equal(bundle.failedGate.proof, undefined, 'no prescribed method');
});

test('doctor names a heavy step that cannot rerun only its failed suites', () => {
  const whole = { id: 'web-e2e', repo: 'app', run: 'node runner.cjs', inputs: ['specs/**'], tier: 'heavy' };
  const { root } = singleRepoProject('pw-doctor', { gate: { steps: [playwrightStep, whole] } }, files);
  const out = ok(wf(root, ['doctor', '--no-steps'])).out;
  assert.match(out, /suite reruns of step web-e2e[\s\S]*reruns whole after a failure \(it has no `select`, no suite report\)/);
  assert.match(out, /Suite-level reruns/, 'the notice names where the capability is described, not a route');
  assert.doesNotMatch(out, /suite reruns of step e2e\b/, 'a step with a Playwright report and select reruns only what failed');
});

test('a step reruns only failed suites only when the gate can tell them apart', () => {
  assert.equal(rerunsOnlyFailed(playwrightStep), true);
  assert.equal(rerunsOnlyFailed({ ...playwrightStep, run: 'node runner.cjs' }), false, '`select` never reaches the runner');
  assert.equal(rerunsOnlyFailed({ ...playwrightStep, inputs: [] }), false, 'no file hashes to tell a changed suite');
  assert.equal(rerunsOnlyFailed({ ...playwrightStep, plugin: 'steps/x.mjs' }), false, 'a plugin step supplies its own suites');
  assert.equal(rerunsOnlyFailed(undefined), false);
});

test('a spec file that failed to load is a failed suite, so a rerun of the failed suites runs it again', () => {
  assert.deepEqual(playwrightJsonSuites({ suites: [null], errors: [null, { location: { file: 'specs/x.spec.ts' } }] }).map((x) => `${x.id}:${x.status}`), ['specs/x.spec.ts:failed']);
  const { base, root } = singleRepoProject('pw-load', { gate: { steps: [playwrightStep] } }, files);
  const e = admitted(root, base, 'ENG-62');
  commitIn(e.repos.app.worktree, { 'specs/a.spec.ts': 'bad\n', 'specs/c.spec.ts': 'broken\n' });
  assert.equal(gateJson(root, e.id).code, 1);
  commitIn(e.repos.app.worktree, { 'specs/a.spec.ts': 'good\n' });
  const g2 = gateJson(root, e.id);
  assert.equal(g2.code, 1, 'the spec that still fails to load fails the rerun');
  const ran = fs.readFileSync(path.join(root, '.wf-worktrees', '_gate', e.id, g2.data.runId, 'ran.txt'), 'utf8').trim();
  assert.deepEqual(ran.split(',').sort(), ['specs/a.spec.ts', 'specs/c.spec.ts']);
});

test('a suite file is matched to its own input before any suffix match', () => {
  const step = { ...playwrightStep, inputs: ['b.spec.ts', 'a/**', 'runner.cjs'] };
  const { base, root } = singleRepoProject('pw-exact', { gate: { steps: [step] } }, { 'runner.cjs': runner(['a/b.spec.ts', 'b.spec.ts']), 'a/b.spec.ts': 'ab\n', 'b.spec.ts': 'b\n' });
  const e = admitted(root, base, 'ENG-63');
  commitIn(e.repos.app.worktree, { 'b.spec.ts': 'bad\n' });
  assert.equal(gateJson(root, e.id).code, 1);
  commitIn(e.repos.app.worktree, { 'b.spec.ts': 'good\n' });
  const g2 = gateJson(root, e.id);
  assert.equal(g2.code, 0);
  const ran = fs.readFileSync(path.join(root, '.wf-worktrees', '_gate', e.id, g2.data.runId, 'ran.txt'), 'utf8').trim();
  assert.equal(ran, 'b.spec.ts', 'the top-level spec is its own file, not a/b.spec.ts, so only it reruns');
});

test('a step with both a JUnit and a Playwright report lists each suite once, by its file', () => {
  const both = `${RUNNER}
const junit=['specs/a.spec.ts','specs/b.spec.ts','specs/c.spec.ts'].filter(f=>run.includes(f)).map(f=>'<testsuite name="'+f+'" tests="1" failures="'+(bad(f)?1:0)+'"><testcase name="works"/></testsuite>').join('');
fs.writeFileSync(process.env.WF_EVIDENCE+'/junit.xml','<testsuites>'+junit+'</testsuites>');`;
  const step = { ...playwrightStep, report: { playwright: '{evidence}/results.json', junit: '{evidence}/junit.xml' } };
  const { base, root } = singleRepoProject('pw-both', { gate: { steps: [step] } }, { ...files, 'runner.cjs': both.replace("if(run.some(f=>bad(f)||broken(f)))process.exit(1);", '') + '\nif(run.some(f=>bad(f)||broken(f)))process.exit(1);' });
  const e = admitted(root, base, 'ENG-64');
  commitIn(e.repos.app.worktree, { 'specs/b.spec.ts': 'bad\n' });
  const g1 = gateJson(root, e.id);
  assert.equal(g1.code, 1);
  assert.deepEqual(g1.data.steps[0].suites.map((s) => `${s.id}:${s.file}:${s.status}`).sort(), ['specs/a.spec.ts:specs/a.spec.ts:passed', 'specs/b.spec.ts:specs/b.spec.ts:failed', 'specs/c.spec.ts:specs/c.spec.ts:passed']);
  commitIn(e.repos.app.worktree, { 'specs/b.spec.ts': 'good\n' });
  const g2 = gateJson(root, e.id);
  assert.equal(g2.code, 0);
  const ran = fs.readFileSync(path.join(root, '.wf-worktrees', '_gate', e.id, g2.data.runId, 'ran.txt'), 'utf8').trim();
  assert.equal(ran, 'specs/b.spec.ts');
});
