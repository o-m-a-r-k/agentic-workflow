// 0.7.33 (I-223, I-224, I-226, I-227), from the review of 0.7.32's D78 (a correction of an admission check is judged by the reviewer).
//
// Named failures (the review's probes): a correction that dropped or narrowed the files its check declares it loads (`reads`) was
// accepted and recorded nothing, so the reviewer saw two definitions that differ in a line it is told is plumbing (I-223); a declared
// harness that imports `../support/commands.js` left that file outside every pin, and the hint listed only strings from the plugin
// (I-224); the note that another open attempt corrected the same check was recorded by the later attempt only, and named a closed
// one for good (I-226); and the declared reads ran one git process per file, about a second for 300 files on each correction and each
// reviewer handoff (I-227).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, wf, yaml } from './helpers.mjs';

const step = (extra = {}) => ({ id: 'unit', repo: 'app', plugin: 'steps/unit.mjs', inputs: ['src/**'], ...extra });
const adapter = (name, s) => yaml({ version: 1, enabled: true, name, repos: [{ name: 'app', path: '.', base: 'main' }], lanes: ['quick', 'standard', 'batch'], gate: { steps: [s] } });
// The plugin reads its harness through a template literal and a joined path.
const PLUGIN = (marker = 'v1') => "import path from 'node:path'; import fs from 'node:fs';\nexport default {async run(ctx){ const dir = `${ctx.dir}/front/fixtures`; ctx.log('" + marker + "'); ctx.log(fs.readFileSync(path.join(dir, 'harness.js'), 'utf8')); return {status:'passed'} }};";

function attempt(f, item) {
  const e = ok(wf(f.root, ['entry', '--item', item, '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', `planner-${item}`, '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id]));
  ok(wf(f.root, ['handoff', 'implementer', '--agent', `impl-${item}`, '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': `changed by ${item}\n` });
  ok(wf(f.root, ['handoff', 'close', '--agent', `impl-${item}`, '--attempt', e.id]));
  return { e, wt: e.repos.app.worktree };
}
function project(name, admissionStep, files = {}) {
  const f = singleRepoProject(name, { gate: { steps: [admissionStep] } }, { '.workflow/steps/unit.mjs': PLUGIN(), ...files });
  return { ...f, name, ...attempt(f, 'ENG-1') };
}
const correct = (f, reason, { attempt: id = f.e.id, env = {} } = {}) => wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', reason, '--attempt', id], { ownerSilent: true, env });
const handReviewer = (f, agent, env = {}) => JSON.parse(fs.readFileSync(ok(wf(f.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', f.e.id], { env })).out.match(/^Read (\S+)/m)[1], 'utf8'));
const dropped = (record) => record.readsDropped.map((x) => [x.step, x.against, x.at, x.files.map((y) => [y.path, y.why])]);

test('0.7.33 (I-223, D79): a correction that narrows or drops the files its check declares it loads records each file the earlier pins covered and the corrected one does not; the reviewer is handed it to judge as a loss', () => {
  const f = project('reads-shrink', step({ reads: ['front/fixtures/**'] }), { 'front/fixtures/harness.js': 'cy.contains("Monday")\n', 'front/fixtures/days.js': 'cy.contains("Tuesday")\n' });
  const admissionBase = state(f.root, f.e.id).repos.app.base;
  // Narrowed against the admission original: days.js leaves the declaration, and the correction is still recorded.
  commitIn(f.wt, { '.workflow/project.yaml': adapter(f.name, step({ reads: ['front/fixtures/harness.js'] })) });
  const narrowed = ok(correct(f, 'only the harness is loaded'));
  const first = state(f.root, f.e.id).validationCorrections[0];
  assert.deepEqual(dropped(first), [['unit', 'original', admissionBase, [['front/fixtures/days.js', 'no longer declared']]]]);
  assert.match(narrowed.out + narrowed.err, /the corrected `reads` of unit no longer covers front\/fixtures\/days\.js, which the admission original covered: the review that follows judges it as a coverage loss/);
  // Dropped against the previous correction too: the declaration vanishes while the plugin still loads the harness.
  commitIn(f.wt, { '.workflow/project.yaml': adapter(f.name, step()) });
  ok(correct(f, 'the harness is plumbing'));
  const second = state(f.root, f.e.id).validationCorrections[1];
  assert.deepEqual(dropped(second), [
    ['unit', 'original', admissionBase, [['front/fixtures/days.js', 'no longer declared'], ['front/fixtures/harness.js', 'no longer declared']]],
    ['unit', 'previous', first.tree.app, [['front/fixtures/harness.js', 'no longer declared']]],
  ]);
  assert.equal(second.reads, undefined, 'nothing is pinned now');
  const bundle = handReviewer(f, 'code-1');
  const [c] = bundle.admissionCorrections;
  assert.deepEqual(c.readsDropped.map((x) => [x.against, x.files.map((y) => y.path)]), [['original', ['front/fixtures/days.js', 'front/fixtures/harness.js']], ['previous', ['front/fixtures/harness.js']]]);
  assert.match(c.readsDropped[1].files[0].show, /^git -C \S+ cat-file -p [0-9a-f]{40}$/, 'the dropped file as it was pinned');
  assert.match(bundle.instructions, /`readsDropped` lists files an earlier pin of the check covered \(the admission original's declared `reads`, or the previous correction's\) that the corrected pin no longer holds/);
  assert.match(bundle.instructions, /a loss unless the decoded code shows the test code it held now in the plugin or in a declared file/);
  // A file deleted while its glob still stands is named apart from a vanished declaration.
  const g = project('reads-deleted', step({ reads: ['front/fixtures/**'] }), { 'front/fixtures/harness.js': 'cy.contains("Monday")\n', 'front/fixtures/days.js': 'cy.contains("Tuesday")\n' });
  sh(g.wt, 'git rm -q front/fixtures/days.js');
  commitIn(g.wt, { '.workflow/steps/unit.mjs': PLUGIN('v2') });
  ok(correct(g, 'days are inline now'));
  assert.deepEqual(dropped(state(g.root, g.e.id).validationCorrections[0]).map((x) => x[3]), [[['front/fixtures/days.js', 'no longer in the tree']]]);
});

test('0.7.33 (I-224, I-227, D80): what a declared file itself loads is listed to the reviewer, resolved to the repo\'s files and only outside the declaration; the instruction names a declared file\'s imports and a runner\'s spec tree', () => {
  const f = project('reads-transitive', step());
  commitIn(f.wt, {
    '.workflow/project.yaml': adapter(f.name, step({ reads: ['front/fixtures/**'] })),
    '.workflow/steps/unit.mjs': PLUGIN('v2'),
    'front/fixtures/harness.js': "import '../support/commands.js';\nimport { days } from './days';\nimport x from '@scope/pkg/x';\ncy.contains(days[0])\n",
    'front/fixtures/days.js': 'export const days = ["Monday"];\n',
    'front/support/commands.js': 'Cypress.Commands.add("login", () => {})\n',
  });
  ok(correct(f, 'the spec moved to a harness'));
  const bundle = handReviewer(f, 'code-1');
  // The plugin's folder and the harness's own `./days` are declared; the support file the harness imports is not; a package is no file.
  assert.deepEqual(bundle.admissionCorrections[0].looksLoaded, [{ path: 'front/support/commands.js', from: 'front/fixtures/harness.js' }]);
  assert.match(bundle.instructions, /what a declared file itself imports or requires \(`\.\.\/support\/commands\.js`\), and the spec tree a runner the plugin starts picks up/);
  assert.match(bundle.instructions, /the project declares a wider glob/);
  const reviewer = fs.readFileSync(path.join(import.meta.dirname, '..', 'templates', 'agents', 'reviewer.md'), 'utf8');
  assert.match(reviewer, /what a declared file itself imports or requires/);
  assert.match(reviewer, /the spec tree a runner the plugin starts picks up/);
});

// A `git` on PATH that records each call and runs the real one.
function gitShim(dir) {
  const real = sh(dir, 'command -v git');
  const bin = path.join(dir, 'shim-bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'git-calls.log');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  return { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` }, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []), reset: () => fs.rmSync(log, { force: true }) };
}

test('0.7.33 (I-227): the files a check declares are read from one tree listing, not one git process per file, at the correction and at the reviewer handoff', () => {
  const files = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`front/fixtures/f${i}.js`, `export const n = ${i};\n`]));
  const f = project('reads-cost', step());
  commitIn(f.wt, { '.workflow/project.yaml': adapter(f.name, step({ reads: ['front/fixtures/**'] })), '.workflow/steps/unit.mjs': PLUGIN('v2'), ...files });
  const shim = gitShim(f.base);
  ok(correct(f, 'the fixtures moved out of the plugin', { env: shim.env }));
  assert.equal(state(f.root, f.e.id).validationCorrections[0].reads[0].files.length, 300);
  const perFile = (calls) => calls.filter((c) => /^rev-parse .*:front\/fixtures\/f\d+\.js$/.test(c)).length;
  assert.equal(perFile(shim.calls()), 0, 'no git process per declared file at the correction');
  shim.reset();
  const bundle = handReviewer(f, 'code-1', shim.env);
  assert.equal(bundle.admissionCorrections[0].reads.files.length, 300);
  assert.equal(perFile(shim.calls()), 0, 'nor at the reviewer handoff');
});

test('0.7.33 (I-226, D82): every open attempt that corrected the same admission check names the others in its next step; one that closed drops out', () => {
  const f = project('shared-both', step());
  commitIn(f.wt, { '.workflow/steps/unit.mjs': PLUGIN('fixed-here') });
  ok(correct(f, 'it read a failed request as empty data'));
  const two = attempt(f, 'ENG-2');
  commitIn(two.wt, { '.workflow/steps/unit.mjs': PLUGIN('fixed-there') });
  ok(correct(f, 'the same defect', { attempt: two.e.id }));
  const note = (other) => new RegExp(`the admission check unit is corrected here and in ${other.replace('.', '\\.')} too`);
  assert.match(state(f.root, two.e.id).next, note(f.e.id), 'the later attempt names the earlier');
  assert.match(state(f.root, f.e.id).next, note(two.e.id), 'and the earlier names the later: the note is read from the open attempts\' corrections, not from one record');
  ok(wf(f.root, ['abandon', '--reason', 'superseded', '--attempt', two.e.id]));
  assert.doesNotMatch(state(f.root, f.e.id).next, /is corrected here and in/, 'a closed attempt drops out');
  // A third attempt that corrects it later is named at once, from what was already indexed.
  const three = attempt(f, 'ENG-3');
  commitIn(three.wt, { '.workflow/steps/unit.mjs': PLUGIN('fixed-again') });
  ok(correct(f, 'the same defect again', { attempt: three.e.id }));
  assert.match(state(f.root, f.e.id).next, note(three.e.id));
  const review = goodClosure('code-1', { validationChecked: [{ id: 'unit', commit: state(f.root, f.e.id).validationCorrections[0].commit, verdict: 'complies', evidence: 'compared' }] });
  ok(wf(f.root, ['handoff', 'reviewer', '--agent', 'code-1', '--attempt', f.e.id]));
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, review), '--attempt', f.e.id]));
  assert.match(state(f.root, f.e.id).next, note(three.e.id), 'it stays while both are open');
});
