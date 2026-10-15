import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { approveAsOwner, closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, wf, write, yaml } from './helpers.mjs';

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


// 0.7.15, named failure (audit of one project's tickets): two admission checks were corrected seven times across five
// parallel tickets, and the person was asked each time, waiting 28 to 147 minutes to answer the same question.
test('a correction of an admission check the person approved in one attempt is taken in another without asking again; a different one still asks', () => {
  const f = fixture('validation-correct-shared');
  const cfg = (run) => yaml({ version: 1, enabled: true, name: 'fixture', repos: [{ name: 'app', path: '.', base: 'main' }], gate: { steps: [{ id: 'unit', repo: 'app', run, inputs: ['src/**'] }] } });
  commitIn(f.wt, { '.workflow/project.yaml': cfg('test -f src/a.txt && echo corrected') });
  ok(correct(f, ['--steps', 'unit', '--reason', 'it read a failed request as empty data']));
  const e2 = ok(wf(f.root, ['entry', '--item', 'ENG-2', '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'planner2', '--attempt', e2.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e2.id]));
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'impl2', '--attempt', e2.id]));
  commitIn(e2.repos.app.worktree, { 'src/a.txt': 'changed too\n', '.workflow/project.yaml': cfg('test -f src/a.txt && echo corrected') });
  ok(wf(f.root, ['handoff', 'close', '--agent', 'impl2', '--attempt', e2.id]));
  const taken = wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'the same defect', '--attempt', e2.id, '--json'], { ownerSilent: true });
  assert.equal(taken.code, 0, taken.err);
  const s2 = state(f.root, e2.id);
  assert.equal(s2.validationCorrections[0].approvedIn.attempt, f.e.id, 'the person\'s earlier yes is recorded as the approval');
  assert.equal((s2.decisions ?? []).filter((d) => d.kind === 'override-gate').length, 0, 'no new question');
  commitIn(e2.repos.app.worktree, { '.workflow/project.yaml': cfg('test -f src/a.txt && echo another-correction') });
  const asked = wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'a different change', '--attempt', e2.id], { ownerSilent: true });
  assert.equal(asked.code, 75, 'a correction the person has not approved anywhere asks');
});

// Independent review of 0.7.15: an approval counts only while it stands. A correction the person later replaced because it
// was itself wrong is not taken again, and a `no` the person gave to the same correction anywhere asks again.
test('a replaced correction or one the person refused is never taken from another attempt', () => {
  const f = fixture('validation-correct-standing');
  const cfg = (run) => yaml({ version: 1, enabled: true, name: 'fixture', repos: [{ name: 'app', path: '.', base: 'main' }], gate: { steps: [{ id: 'unit', repo: 'app', run, inputs: ['src/**'] }] } });
  const X = 'test -f src/a.txt && echo x', Y = 'test -f src/a.txt && echo y', Z = 'test -f src/a.txt && echo z';
  const another = (item) => {
    const e = ok(wf(f.root, ['entry', '--item', item, '--json'])).json();
    ok(wf(f.root, ['handoff', 'planner', '--agent', `p-${item}`, '--attempt', e.id]));
    ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id]));
    ok(wf(f.root, ['handoff', 'implementer', '--agent', `i-${item}`, '--attempt', e.id]));
    commitIn(e.repos.app.worktree, { 'src/a.txt': `${item}\n` });
    ok(wf(f.root, ['handoff', 'close', '--agent', `i-${item}`, '--attempt', e.id]));
    return e;
  };
  const tryCorrect = (e, run) => {
    commitIn(e.repos.app.worktree, { '.workflow/project.yaml': cfg(run) });
    return wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'correct it', '--attempt', e.id], { ownerSilent: true });
  };
  commitIn(f.wt, { '.workflow/project.yaml': cfg(X) });
  ok(correct(f, ['--steps', 'unit', '--reason', 'first fix']));
  commitIn(f.wt, { '.workflow/project.yaml': cfg(Y) });
  ok(correct(f, ['--steps', 'unit', '--reason', 'the first fix was itself wrong']));
  assert.equal(tryCorrect(another('ENG-3'), X).code, 75, 'the correction the person replaced asks again');
  const c = another('ENG-4');
  const refused = tryCorrect(c, Z);
  assert.equal(refused.code, 75);
  approveAsOwner(f.root, c.id, refused.err.match(/wf approve (A\d+)/)[1], 'no');
  assert.equal(tryCorrect(another('ENG-5'), Z).code, 75, 'a correction the person refused elsewhere asks again');
  assert.equal(tryCorrect(another('ENG-6'), Y).code, 0, 'the standing approval is still taken');
  // An approval taken from another attempt stands only while the one it rests on does: once the person replaces Y in the
  // attempt that approved it, the attempt that took Y no longer lends it out.
  commitIn(f.wt, { '.workflow/project.yaml': cfg(Z.replace('z', 'w')) });
  ok(correct(f, ['--steps', 'unit', '--reason', 'Y was wrong too']));
  assert.equal(tryCorrect(another('ENG-7'), Y).code, 75, 'a chained approval of a replaced correction asks again');
});

// 0.7.11, named failure (one ticket, audit of 51 attempts): a correction that only scoped a step's evidence glob to the ticket
// (4,008 other tickets' screenshots had been counted) made its 25-minute e2e step look new and run again, though its result
// could not change. Which files are kept as evidence is not part of a step's identity: the gate re-uses the recorded run and
// re-selects this ticket's files from it. A change in the workflow's own folder (a lesson, the adapter) reruns nothing.
test('a correction that only narrows a step\'s evidence glob reuses the recorded run and re-selects the ticket\'s files; a lesson commit reruns nothing', () => {
  const shoot = `mkdir -p shots/ENG-1 shots/OTHER && echo run >> ../ran.txt && printf one > shots/ENG-1/a.png && printf two > shots/OTHER/b.png`;
  const step = (artifacts) => ({ id: 'ui', repo: 'app', run: shoot, inputs: ['src/**'], artifacts });
  const config = { gate: { steps: [step(['shots/**/*.png'])] } };
  const f0 = singleRepoProject('validation-correct-evidence', config, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const e = ok(wf(f0.root, ['entry', '--item', 'ENG-1', '--json'])).json();
  ok(wf(f0.root, ['handoff', 'planner', '--agent', 'planner', '--attempt', e.id]));
  ok(wf(f0.root, ['plan', '--file', criteriaFile(f0.base), '--attempt', e.id]));
  ok(wf(f0.root, ['handoff', 'implementer', '--agent', 'impl', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'changed\n' });
  ok(wf(f0.root, ['handoff', 'close', '--agent', 'impl', '--attempt', e.id]));
  const f = { ...f0, e, wt: e.repos.app.worktree, config };
  const ran = () => fs.readFileSync(`${f.wt}/../ran.txt`, 'utf8').trim().split('\n').length;
  review(f, 'code-0');
  const first = ok(wf(f.root, ['gate', '--attempt', f.e.id, '--json'])).json();
  assert.deepEqual(first.steps[0].artifacts.map((a) => a.source).sort(), ['shots/ENG-1/a.png', 'shots/OTHER/b.png']);
  assert.equal(ran(), 1);
  // The adapter on the base branch now scopes the glob to the ticket: the refusal over uninspected screenshots names the way.
  const narrowed = yaml({ version: 1, enabled: true, name: 'fixture', repos: [{ name: 'app', path: '.', base: 'main' }], gate: { steps: [step(['shots/{item}/**/*.png'])] } });
  commitIn(f.root, { '.workflow/project.yaml': narrowed });
  ok(wf(f.root, ['handoff', 'reviewer', '--agent', 'ev-0', '--attempt', f.e.id]));
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('ev-0', { anomalies: 'none seen' })), '--attempt', f.e.id]));
  const refused = wf(f.root, ['accept', '--attempt', f.e.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /the evidence globs this attempt was admitted with differ from the adapter's now: ui \(collected with shots\/\*\*\/\*\.png; the adapter now says shots\/\{item\}\/\*\*\/\*\.png\)\. To use the adapter's, commit its step definition in this attempt and run `wf validation correct --steps ui/);
  commitIn(f.wt, { '.workflow/project.yaml': narrowed });
  ok(correct(f, ['--steps', 'ui', '--reason', 'the evidence glob counted other tickets\' screenshots']));
  review(f, 'code-1');
  const second = ok(wf(f.root, ['gate', '--attempt', f.e.id, '--json'])).json();
  assert.equal(second.steps[0].status, 'reused', 'the result cannot change: nothing reruns');
  assert.match(second.steps[0].reason, /evidence re-selected by the step's current globs/);
  assert.deepEqual(second.steps[0].artifacts.map((a) => a.source), ['shots/ENG-1/a.png'], 'only this ticket\'s file');
  assert.equal(second.steps[0].artifacts[0].sha256, first.steps[0].artifacts.find((a) => a.source === 'shots/ENG-1/a.png').sha256);
  assert.equal(ran(), 1);
  // A lesson committed with the ticket is the workflow's own file, not the project's code.
  commitIn(f.wt, { '.workflow/lessons/L-1.yaml': 'id: L-1\n' });
  review(f, 'code-2');
  const third = ok(wf(f.root, ['gate', '--attempt', f.e.id, '--json'])).json();
  assert.equal(third.steps[0].status, 'reused');
  assert.equal(ran(), 1);
});

// I-138: a correction an earlier local build recorded marked the corrected step itself (`steps[].admission`) and kept the
// original in `from` unmarked; every check and correction then refused. That shape counts, with the person's decision only.
test('an admission correction in the earlier recorded shape is honoured; a replaced admission step marked nowhere is not', async () => {
  const f = fixture('validation-correct-legacy');
  commitIn(f.wt, { '.workflow/project.yaml': yaml({ version: 1, enabled: true, name: 'fixture', repos: [{ name: 'app', path: '.', base: 'main' }], gate: { steps: [{ id: 'unit', repo: 'app', run: 'test -f src/a.txt && echo legacy-shape', inputs: ['src/**'] }] } }) });
  ok(correct(f, ['--steps', 'unit', '--reason', 'it read a failed request as empty data']));
  const { loadState } = await import('../engine/ledger.mjs');
  const { gateAdapter } = await import('../engine/validation.mjs');
  const s = loadState(f.root, f.e.id);
  const legacy = (decision) => ({ ...s, validations: s.validations.map((v) => ({ ...v, steps: v.steps.map((x) => ({ ...x, admission: true })) })), validationCorrections: s.validationCorrections.map((c) => ({ ...c, steps: c.steps.map((x) => ({ ...x, admission: true })), from: c.from.map(({ admission, ...rest }) => rest), decision })) });
  assert.match(gateAdapter(f.root, legacy(undefined)).gate.steps.find((x) => x.id === 'unit').run, /legacy-shape/, 'recorded before decisions were required');
  const unmarked = { ...s, validations: s.validations, validationCorrections: s.validationCorrections.map((c) => ({ ...c, from: c.from.map(({ admission, ...rest }) => rest) })) };
  assert.throws(() => gateAdapter(f.root, unmarked), /no longer matches its recorded committed definition/, 'an admission step replaced with no mark is refused');
});
