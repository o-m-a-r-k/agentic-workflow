import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, wf, write, yaml } from './helpers.mjs';

// Named failure (I-102): review found a defect in a supplemental validation's plugin, and registration had no remove,
// overwrite or repin. Fixing and committing the plugin left the gate running the defective plugin pinned at registration for
// ever. `wf validation correct` re-pins registered steps at the committed HEAD of the adapter repo and keeps every
// obligation registration carries.

function fixture(name) {
  const config = { gate: { steps: [{ id: 'unit', repo: 'app', run: 'test -f src/a.txt', inputs: ['src/**'] }] } };
  const f = singleRepoProject(name, config);
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-1', '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'planner', '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id]));
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'impl', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'changed\n' });
  ok(wf(f.root, ['handoff', 'close', '--agent', 'impl', '--attempt', e.id]));
  return { ...f, e, wt: e.repos.app.worktree, config };
}

const plugin = (marker) => `export default {async run(ctx){ctx.log('${marker}');return {status:'passed'}}};`;
const STEP = { id: 'http', repo: 'app', plugin: 'steps/proof.mjs', inputs: ['src/**'] };
const candidate = (f, files = {}) => commitIn(f.wt, { '.workflow/project.yaml': yaml({ version: 1, enabled: true, name: 'fixture', repos: [{ name: 'app', path: '.', base: 'main' }], gate: { steps: [...f.config.gate.steps, STEP] } }), ...files });
const add = (f) => wf(f.root, ['validation', 'add', '--steps', 'http', '--criteria', 'C1', '--reason', 'Required real execution', '--attempt', f.e.id, '--json']);
const correct = (f, args = ['--steps', 'http', '--reason', 'review found a defect in the plugin']) => wf(f.root, ['validation', 'correct', ...args, '--attempt', f.e.id, '--json']);
function review(f, agent) {
  ok(wf(f.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', f.e.id]));
  const validationChecked = state(f.root, f.e.id).validations.flatMap((v) => v.steps.map((s) => ({ id: s.id, commit: v.commit, verdict: 'complies', evidence: 'Pinned definition and plugin inspected' })));
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure(agent, { validationChecked })), '--attempt', f.e.id]));
}
const logOf = (run, id) => fs.readFileSync(run.steps.find((s) => s.id === id).log, 'utf8');

// A registered step with a defective plugin, reviewed and gated once.
function registered(name) {
  const f = fixture(name);
  candidate(f, { '.workflow/steps/proof.mjs': plugin('defective-plugin') });
  ok(add(f));
  review(f, 'code-1');
  const first = ok(wf(f.root, ['gate', '--attempt', f.e.id, '--json'])).json();
  assert.match(logOf(first, 'http'), /defective-plugin/);
  return { ...f, oldPin: state(f.root, f.e.id).validations[0].commit };
}

test('a corrected plugin is pinned again: the gate runs it only after a fresh code review, the old pin stays in the ledger', () => {
  const f = registered('validation-correct');
  commitIn(f.wt, { '.workflow/steps/proof.mjs': plugin('corrected-plugin') });
  // Without a correction the committed fix changes nothing: the gate still runs the plugin pinned at registration.
  review(f, 'code-2');
  assert.match(logOf(ok(wf(f.root, ['gate', '--attempt', f.e.id, '--json'])).json(), 'http'), /defective-plugin/, 'the failure: the defective plugin runs for ever');

  const done = ok(correct(f)).json();
  const head = sh(f.wt, 'git rev-parse HEAD');
  assert.equal(done.commit, head);
  assert.deepEqual(done.correctedFrom.map((x) => [x.id, x.commit]), [['http', f.oldPin]], 'both pins are recorded');
  const s = state(f.root, f.e.id);
  assert.deepEqual(s.validations.map((v) => [v.commit, v.steps.map((x) => x.id)]), [[head, ['http']]], 'one pin per step: the corrected one');
  assert.equal(s.validationCorrections[0].reason, 'review found a defect in the plugin');
  assert.deepEqual(s.validations[0].criteria, ['C1'], 'the criteria it was registered for are kept');
  assert.equal(s.validationCorrections[0].from[0].definition.plugin, 'steps/proof.mjs');

  // The earlier passing gate no longer counts and no gate runs before a review of the corrected pin.
  const early = wf(f.root, ['gate', '--attempt', f.e.id]);
  assert.notEqual(early.code, 0);
  assert.match(early.err, /added or corrected after the last code review: run a fresh code review/);
  const hand = ok(wf(f.root, ['handoff', 'reviewer', '--agent', 'code-3', '--attempt', f.e.id, '--json'])).json();
  const bundle = JSON.parse(fs.readFileSync(hand.bundle ?? hand.file, 'utf8'));
  assert.equal(bundle.mode, 'delta');
  assert.deepEqual(bundle.supplementalValidation.map((v) => [v.commit, v.correctedFrom[0].commit]), [[head, f.oldPin]], 'a delta reviewer is handed the re-pinned step with the pin it replaced');
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('code-3', { validationChecked: [{ id: 'http', commit: head, verdict: 'complies', evidence: 'Corrected plugin inspected' }] })), '--attempt', f.e.id]));
  const run = ok(wf(f.root, ['gate', '--attempt', f.e.id, '--json'])).json();
  assert.match(logOf(run, 'http'), /corrected-plugin/);
  assert.doesNotMatch(logOf(run, 'http'), /defective-plugin/);
  assert.deepEqual(run.steps.map((x) => x.id).sort(), ['http', 'unit']);
  assert.equal(run.steps.find((x) => x.id === 'http').status, 'passed', 'the step ran again; the old result was not reused');
});

test('a correction invalidates acceptance and keeps the admission checks as they were', () => {
  const f = registered('validation-correct-stale');
  review(f, 'evidence-1');
  ok(wf(f.root, ['accept', '--attempt', f.e.id]));
  assert.ok(state(f.root, f.e.id).accepted);
  const admission = state(f.root, f.e.id).adapterBase;
  commitIn(f.wt, { '.workflow/steps/proof.mjs': plugin('corrected-plugin') });
  ok(correct(f));
  const s = state(f.root, f.e.id);
  assert.equal(s.accepted, null);
  assert.equal(s.adapterBase, admission, 'the admission adapter is untouched');
  assert.equal(s.phase, 'implementing');
});

test('a correction keeps every registration obligation: a registered step, a new commit that descends from the pin, a committed tree, closed roles, a reason', () => {
  const f = registered('validation-correct-refusals');
  // An admission step is corrected only by the person's decision (I-125, 0.7.8); a step nobody registered is registered
  // with `add`.
  const admission = wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'r', '--attempt', f.e.id], { ownerSilent: true });
  assert.equal(admission.code, 75);
  assert.match(admission.err, /correct the admission check unit to its definition committed at/);
  assert.match(correct(f, ['--steps', 'ghost', '--reason', 'r']).err, /neither a registered supplemental validation step nor an admission step/);
  // No reason.
  assert.match(correct(f, ['--steps', 'http']).err, /needs --reason/);
  // Nothing committed since the pin: there is nothing to correct.
  assert.match(correct(f).err, /still at [0-9a-f]{10}, where http is already pinned: commit the corrected definition or plugin first/);
  // Uncommitted work.
  commitIn(f.wt, { '.workflow/steps/proof.mjs': plugin('corrected-plugin') });
  write(f.wt, 'src/a.txt', 'uncommitted');
  assert.match(correct(f).err, /commit the product tree/);
  sh(f.wt, 'git checkout -- src/a.txt');
  // Not a descendant of the pin: the adapter repo moved back to the admission commit and forward on another line.
  const keep = sh(f.wt, 'git rev-parse HEAD');
  sh(f.wt, `git reset -q --hard ${state(f.root, f.e.id).adapterBase}`);
  candidate(f, { '.workflow/steps/proof.mjs': plugin('sideways-plugin') });
  assert.match(correct(f).err, /must descend from the commit it is pinned at/);
  assert.equal(state(f.root, f.e.id).validations[0].commit, f.oldPin, 'refused: the pin did not move');
  sh(f.wt, `git reset -q --hard ${keep}`);
  // Roles still open.
  ok(wf(f.root, ['handoff', 'reviewer', '--agent', 'busy', '--attempt', f.e.id]));
  assert.match(correct(f).err, /finish and close active roles before correcting supplemental validation/);
  assert.equal(state(f.root, f.e.id).validationCorrections, undefined, 'nothing was recorded by any refusal');
});

test('a correction is limited to the criteria the attempt froze and to existing catalogued keys', () => {
  const f = registered('validation-correct-bounds');
  commitIn(f.wt, { '.workflow/steps/proof.mjs': plugin('corrected-plugin') });
  assert.match(correct(f, ['--steps', 'http', '--reason', 'r', '--criteria', 'C9']).err, /--criteria must name distinct frozen acceptance criteria/);
  commitIn(f.wt, { '.workflow/secrets.yaml': yaml({ keys: [{ key: 'NEW_KEY', usedBy: ['http'] }] }) });
  assert.match(correct(f).err, /only existing catalogued/);
  commitIn(f.wt, { '.workflow/secrets.yaml': yaml({ keys: [] }) });
  ok(correct(f));
});

test('a check frozen at admission that is itself wrong is corrected with the person\'s yes; the gate runs the correction after a fresh review (I-125)', () => {
  const f = fixture('validation-correct-admission');
  const admission = state(f.root, f.e.id).adapterBase;
  commitIn(f.wt, { '.workflow/project.yaml': yaml({ version: 1, enabled: true, name: 'fixture', repos: [{ name: 'app', path: '.', base: 'main' }], gate: { steps: [{ id: 'unit', repo: 'app', run: 'test -f src/a.txt && echo corrected-admission-check', inputs: ['src/**'] }] } }) });
  const asked = wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'it read a failed request as empty data', '--attempt', f.e.id], { ownerSilent: true });
  assert.equal(asked.code, 75, 'changing a check frozen at admission is the person\'s decision');
  ok(correct(f, ['--steps', 'unit', '--reason', 'it read a failed request as empty data']));
  const s = state(f.root, f.e.id);
  assert.equal(s.adapterBase, admission, 'the admission adapter itself is untouched');
  assert.deepEqual(s.validationCorrections[0].from.map((x) => [x.id, x.commit, x.admission]), [['unit', admission, true]], 'the original stays in the record');
  assert.equal(s.validationCorrections[0].from[0].definition.run, 'test -f src/a.txt');
  review(f, 'code-1');
  const run = ok(wf(f.root, ['gate', '--attempt', f.e.id, '--json'])).json();
  assert.match(logOf(run, 'unit'), /corrected-admission-check/);
  assert.deepEqual(run.steps.map((x) => x.id), ['unit'], 'it runs in place of the original, once');
  // The correction was itself wrong: a second one is still the person's decision, and the gate runs it (review of 0.7.8: a
  // second correction skipped the person and left the gate refusing for good).
  commitIn(f.wt, { '.workflow/project.yaml': yaml({ version: 1, enabled: true, name: 'fixture', repos: [{ name: 'app', path: '.', base: 'main' }], gate: { steps: [{ id: 'unit', repo: 'app', run: 'test -f src/a.txt && echo corrected-twice', inputs: ['src/**'] }] } }) });
  const second = wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'the first correction missed a case', '--attempt', f.e.id], { ownerSilent: true });
  assert.equal(second.code, 75, 'the second correction asks the person too');
  ok(correct(f, ['--steps', 'unit', '--reason', 'the first correction missed a case']));
  assert.deepEqual(state(f.root, f.e.id).validationCorrections.map((c) => c.from[0].admission), [true, true]);
  review(f, 'code-2');
  assert.match(logOf(ok(wf(f.root, ['gate', '--attempt', f.e.id, '--json'])).json(), 'unit'), /corrected-twice/);
});

