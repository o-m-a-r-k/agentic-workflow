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
  // An admission step defined exactly as pinned has nothing to correct (0.7.32, D78: no person screens it any more); a step
  // nobody registered is registered with `add`.
  const admission = wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'r', '--attempt', f.e.id], { ownerSilent: true });
  assert.equal(admission.code, 75);
  assert.match(admission.err, /unit is defined at [0-9a-f]{10} exactly as pinned \(the step and its plugin\): there is nothing to correct/);
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

// 0.7.32 (D78), the person's words: "why should it come to me? we have an agent designed just for that in the workflow right?" A
// correction of an admission check was the person's decision (I-125, D37): 20 questions on 10 attempts in four days, 7 on one ticket,
// while a fresh independent review and the full gate followed anyway. That review now judges it: it is handed both definitions
// (the original pin and the corrected one, the step, its plugin code, and the adapter's diff between them) and gives its verdict on
// each corrected admission step; a closure without one is refused, and no verdict means no acceptance.
const ADMISSION_CFG = (run) => yaml({ version: 1, enabled: true, name: 'fixture', repos: [{ name: 'app', path: '.', base: 'main' }], gate: { steps: [{ id: 'unit', repo: 'app', run, inputs: ['src/**'] }] } });
const verdictOn = (f, verdict, extra = {}) => { const c = state(f.root, f.e.id).validationCorrections.at(-1); return [{ id: 'unit', commit: c.commit, verdict, evidence: 'the original and corrected definitions compared: every case and assertion is kept', ...extra }]; };
const handReviewer = (f, agent) => JSON.parse(fs.readFileSync(ok(wf(f.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', f.e.id])).out.match(/^Read (\S+)/m)[1], 'utf8'));

test('0.7.32 (D78): a check frozen at admission is corrected with no question to the person; the review that follows is handed both definitions and judges it, and the gate runs the correction (I-125)', () => {
  const f = fixture('validation-correct-admission');
  const admission = state(f.root, f.e.id).adapterBase;
  commitIn(f.wt, { '.workflow/project.yaml': ADMISSION_CFG('test -f src/a.txt && echo corrected-admission-check') });
  const done = wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'it read a failed request as empty data', '--attempt', f.e.id], { ownerSilent: true });
  assert.equal(done.code, 0, done.err);
  assert.match(done.out + done.err, /no question to the person: the review that follows judges the correction/);
  const s = state(f.root, f.e.id);
  assert.deepEqual((s.decisions ?? []).filter((d) => d.kind === 'override-gate'), [], 'nothing is asked');
  assert.equal(s.adapterBase, admission, 'the admission adapter itself is untouched');
  assert.deepEqual(s.validationCorrections[0].from.map((x) => [x.id, x.commit, x.admission]), [['unit', admission, true]], 'the original stays in the record');
  assert.equal(s.validationCorrections[0].from[0].definition.run, 'test -f src/a.txt');
  assert.equal(s.validationCorrections[0].judgedBy, 'reviewer');
  // The fresh code review is handed both definitions and the adapter's diff between the pins.
  const bundle = handReviewer(f, 'code-1');
  const [c] = bundle.admissionCorrections;
  assert.deepEqual([c.id, c.original.commit, c.original.definition.run, c.corrected.commit, c.corrected.definition.run], ['unit', admission, 'test -f src/a.txt', s.validationCorrections[0].commit, 'test -f src/a.txt && echo corrected-admission-check']);
  assert.match(c.diff, new RegExp(`diff ${admission} ${s.validationCorrections[0].commit} -- \\.workflow`));
  assert.deepEqual(c.files, ['.workflow/project.yaml']);
  assert.match(bundle.instructions, /`admissionCorrections` lists checks frozen at admission that this attempt corrected \(unit\)/);
  assert.match(bundle.instructions, /coverage is kept when every test case and assertion survives and only expectations the frozen criteria deliberately change are updated; selectors, waits and paths are plumbing/);
  assert.match(bundle.instructions, /A loss against the admission original \(a case or assertion removed, skipped or loosened, an expectation weakened, a timeout raised to hide a failure\) is a blocking finding/);
  // A closure with no verdict on the correction is refused; one with it is recorded.
  const none = wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('code-1')), '--attempt', f.e.id]);
  assert.equal(none.code, 75);
  assert.match(none.err, /the admission check unit was corrected at [0-9a-f]{10} and this round gives no verdict on it/);
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('code-1', { validationChecked: verdictOn(f, 'complies') })), '--attempt', f.e.id]));
  const run = ok(wf(f.root, ['gate', '--attempt', f.e.id, '--json'])).json();
  assert.match(logOf(run, 'unit'), /corrected-admission-check/);
  assert.deepEqual(run.steps.map((x) => x.id), ['unit'], 'it runs in place of the original, once');
  // The evidence review has nothing more to judge on it, and the attempt is accepted.
  const ev = handReviewer(f, 'evidence-2');
  assert.equal(ev.admissionCorrections, undefined, 'judged once');
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('evidence-2')), '--attempt', f.e.id]));
  ok(wf(f.root, ['accept', '--attempt', f.e.id]));
  // A second correction of the same step is judged again, still with no question.
  commitIn(f.wt, { '.workflow/project.yaml': ADMISSION_CFG('test -f src/a.txt && echo corrected-twice') });
  ok(wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'the first correction missed a case', '--attempt', f.e.id], { ownerSilent: true }));
  assert.deepEqual(state(f.root, f.e.id).validationCorrections.map((x) => x.from[0].admission), [true, true]);
  const [again] = handReviewer(f, 'code-3').admissionCorrections;
  assert.deepEqual([again.original.definition.run, again.previous.definition.run, again.corrected.definition.run], ['test -f src/a.txt', 'test -f src/a.txt && echo corrected-admission-check', 'test -f src/a.txt && echo corrected-twice'], 'both baselines: the admission original and the previous correction');
});

test('0.7.32 (D78): a correction that weakens the check is a blocking finding the ticket fixes; a verdict must name a finding of the closure, and with no verdict the attempt is not accepted', async () => {
  const f = fixture('validation-correct-weakened');
  commitIn(f.wt, { '.workflow/project.yaml': ADMISSION_CFG('true') });
  ok(wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'the check failed', '--attempt', f.e.id], { ownerSilent: true }));
  handReviewer(f, 'code-1');
  const unnamed = wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('code-1', { validationChecked: verdictOn(f, 'finding', { evidence: 'the check no longer tests anything' }) })), '--attempt', f.e.id]);
  assert.equal(unnamed.code, 75);
  assert.match(unnamed.err, /the verdict on unit is a finding: name it \(`finding`: the id of a finding of this closure, which says what the correction weakened\)/);
  const weakened = { id: 'F1', severity: 'high', criterion: 'C1', summary: 'the corrected unit check runs `true`: its assertion that src/a.txt exists is gone', status: 'open', evidence: '.workflow/project.yaml:1 the run command no longer checks the file' };
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('code-1', { findings: [weakened], validationChecked: verdictOn(f, 'finding', { evidence: 'the assertion was removed', finding: 'F1' }) })), '--attempt', f.e.id]));
  assert.equal(state(f.root, f.e.id).decision.kind, 'repair', 'the ticket fixes it, like any blocking finding');
  assert.equal(wf(f.root, ['gate', '--attempt', f.e.id], { ownerSilent: true }).code, 75);
  // No verdict, no acceptance: the engine's own reading of the rounds since the correction.
  const { loadState } = await import('../engine/ledger.mjs');
  const { correctionsToJudge } = await import('../engine/lifecycle.mjs');
  const st = loadState(f.root, f.e.id);
  assert.deepEqual(correctionsToJudge(f.root, st).map((x) => x.id), [], 'judged by code-1');
  const unjudged = { ...st, reviews: st.reviews.map((r) => ({ ...r, closure: { ...r.closure, validationChecked: [] } })) };
  assert.deepEqual(correctionsToJudge(f.root, unjudged).map((x) => x.id), ['unit']);
});

// In-flight attempts (D78): a question an earlier release opened is no longer asked. It is withdrawn, with the reason, when the
// correction runs again; an answer the person already gave stays as recorded.
test('0.7.32 (D78): a pending correction question is withdrawn with its reason when the correction runs again; an approved one is recorded as the approval', async () => {
  const { append } = await import('../engine/ledger.mjs');
  const asked = (name) => {
    const g = fixture(name);
    commitIn(g.wt, { '.workflow/project.yaml': ADMISSION_CFG(FIXED) });
    const at = sh(g.wt, 'git rev-parse HEAD');
    append(g.root, g.e.id, 'decision.created', { id: 'A1', kind: 'override-gate', key: `correct-admission:unit:${at}`, summary: `correct the admission check unit to its definition committed at ${at.slice(0, 10)}: it read a failed request as empty data (the original stays in the record; a fresh review and the full gate follow)`, choices: ['yes', 'no'] }, 'human:scenario');
    return g;
  };
  const pending = asked('validation-correct-pending-withdrawn');
  assert.match(ok(wf(pending.root, ['resume', '--attempt', pending.e.id])).out, /A1 \(correcting the admission check unit\) is no longer asked: since 0\.7\.32 the reviewer judges corrections; run `wf validation correct --steps unit --reason "<why>" --attempt ENG-1\.1` again/);
  ok(wf(pending.root, ['validation', 'correct', ...REASON, '--attempt', pending.e.id], { ownerSilent: true }));
  const p = state(pending.root, pending.e.id);
  assert.match(p.decisions[0].withdrawn.reason, /the reviewer judges corrections since 0\.7\.32/);
  assert.equal(p.validationCorrections[0].decision, undefined);
  const yes = asked('validation-correct-approved-kept');
  approveAsOwner(yes.root, yes.e.id, 'A1', 'yes');
  ok(wf(yes.root, ['validation', 'correct', ...REASON, '--attempt', yes.e.id], { ownerSilent: true }));
  const y = state(yes.root, yes.e.id);
  assert.deepEqual([y.validationCorrections[0].decision, y.decisions[0].withdrawn ?? null], ['A1', null], 'the person\'s yes stays as recorded');
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

// 0.7.27 (I-187), named failure (field): the person approved correcting two admission checks to their definitions committed at
// one commit. A base merge advanced the attempt's HEAD before the command ran again, and the question key named the HEAD
// commit, so the same correction under the same definitions was asked a second time ("never ask the same question twice").
// The answer holds for what the person approved: the admission steps and the definitions they are corrected to.
const ADMISSION = (run) => yaml({ version: 1, enabled: true, name: 'fixture', repos: [{ name: 'app', path: '.', base: 'main' }], gate: { steps: [{ id: 'unit', repo: 'app', run, inputs: ['src/**'] }] } });
const FIXED = 'test -f src/a.txt && echo corrected-after-merge';
const REASON = ['--steps', 'unit', '--reason', 'it read a failed request as empty data'];
const baseMerge = (f, file = 'docs/upstream.txt') => {
  commitIn(f.root, { [file]: 'moved on the base\n' }, 'upstream');
  sh(f.wt, 'git merge -q --no-edit main');
};
const askedDecisions = (f) => (state(f.root, f.e.id).decisions ?? []).filter((d) => d.kind === 'override-gate');

// 0.7.27 (I-187), as 0.7.32 (D78) has it: nothing is asked any more, but an answer the person gave to the same correction stands.
test('0.7.27 (I-187), as 0.7.32 has it: a correction the person declined stands across a base merge; other definitions are recorded with no question', () => {
  const f = fixture('validation-correct-merge-declined');
  commitIn(f.wt, { '.workflow/project.yaml': ADMISSION(FIXED) });
  const at = sh(f.wt, 'git rev-parse HEAD');
  return import('../engine/ledger.mjs').then(({ append }) => {
    append(f.root, f.e.id, 'decision.created', { id: 'A1', kind: 'override-gate', key: `correct-admission:unit:${at}`, summary: 'correct the admission check unit', choices: ['yes', 'no'] }, 'human:scenario');
    approveAsOwner(f.root, f.e.id, 'A1', 'no');
    baseMerge(f);
    const declined = wf(f.root, ['validation', 'correct', ...REASON, '--attempt', f.e.id], { ownerSilent: true });
    assert.equal(declined.code, 75);
    assert.match(declined.err, /correcting the admission check: the person answered A1 "no"/);
    assert.equal(askedDecisions(f).length, 1, 'a no stands: it is not asked again');
    commitIn(f.wt, { '.workflow/project.yaml': ADMISSION(`${FIXED} && echo changed-since`) });
    ok(wf(f.root, ['validation', 'correct', ...REASON, '--attempt', f.e.id], { ownerSilent: true }));
    assert.equal(askedDecisions(f).length, 1, 'other definitions are no question either');
  });
});

// 0.7.32 (D78), from a classification of 25 field corrections: none removed coverage frozen at admission, but four loosened what the
// same attempt had added in an earlier correction (an Arabic "Day 1" check reduced to a bare "1", added checks removed, an exact text
// check made "page contains", a 20 s timeout raised to 60 s), the specs were JSON-escaped strings inside the plugin, so a plain diff
// was one long line, and the summaries the person approved named none of it. The reviewer compares the corrected definition with the
// admission original and with the previous correction, from decoded copies.
const specPlugin = (assertion, timeout = 20000) => `export default {async run(ctx){const spec = ${JSON.stringify(`it("shows the first day", () => {\n  cy.contains(${JSON.stringify(assertion)}, { timeout: ${timeout} })\n})`)}; ctx.log(spec); return {status:'passed'}}};`;
const PLUGGED = (file = 'steps/unit.mjs') => yaml({ version: 1, enabled: true, name: 'fixture', repos: [{ name: 'app', path: '.', base: 'main' }], gate: { steps: [{ id: 'unit', repo: 'app', plugin: file, inputs: ['src/**'] }] } });
function plugged(name) {
  const config = { gate: { steps: [{ id: 'unit', repo: 'app', plugin: 'steps/unit.mjs', inputs: ['src/**'] }] } };
  const f = singleRepoProject(name, config, { '.workflow/steps/unit.mjs': specPlugin('Monday') });
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-1', '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'planner', '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id]));
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'impl', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'changed\n' });
  ok(wf(f.root, ['handoff', 'close', '--agent', 'impl', '--attempt', e.id]));
  return { ...f, e, wt: e.repos.app.worktree, config };
}

test('0.7.32 (D78): the reviewer is handed the admission original, the previous correction and the corrected definition, each decoded, with the decoded diffs', () => {
  const f = plugged('validation-correct-baselines');
  commitIn(f.wt, { '.workflow/steps/unit.mjs': specPlugin('Day 1') });
  ok(wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'the day is labelled Day 1', '--attempt', f.e.id], { ownerSilent: true }));
  const first = handReviewer(f, 'code-1');
  assert.equal(first.admissionCorrections[0].previous, null, 'a first correction has the admission original only');
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('code-1', { validationChecked: verdictOn(f, 'complies') })), '--attempt', f.e.id]));
  // A second correction loosens what the first added.
  commitIn(f.wt, { '.workflow/steps/unit.mjs': specPlugin('1', 60000) });
  ok(wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'the label moved', '--attempt', f.e.id], { ownerSilent: true }));
  const [c] = handReviewer(f, 'code-2').admissionCorrections;
  assert.deepEqual([c.original.definition.plugin, c.previous.commit !== c.original.commit, c.corrected.commit !== c.previous.commit], ['steps/unit.mjs', true, true]);
  const decoded = (v) => fs.readFileSync(v.plugin.decoded, 'utf8');
  assert.match(decoded(c.original), /^ {2}cy\.contains\("Monday", \{ timeout: 20000 \}\)$/m, 'the embedded spec reads line by line');
  assert.match(decoded(c.previous), /^ {2}cy\.contains\("Day 1", \{ timeout: 20000 \}\)$/m);
  assert.match(decoded(c.corrected), /^ {2}cy\.contains\("1", \{ timeout: 60000 \}\)$/m);
  assert.match(c.decodedDiff.fromOriginal, /^git diff --no-index -- \S+\.decoded\.txt \S+\.decoded\.txt$/);
  assert.match(c.decodedDiff.fromPrevious, /^git diff --no-index -- \S+\.decoded\.txt \S+\.decoded\.txt$/);
  const bundle = JSON.parse(fs.readFileSync(fs.readdirSync(`${f.root}/.wf-evidence/attempts/${f.e.id}/handoffs`).filter((x) => x.endsWith('-reviewer.json')).map((x) => `${f.root}/.wf-evidence/attempts/${f.e.id}/handoffs/${x}`).sort().at(-1), 'utf8'));
  assert.match(bundle.instructions, /A loss against the previous correction \(an assertion it added loosened, a check it added removed, a timeout on a case raised\) is a blocking finding too, unless it is tied to a criterion that is still proven another way/);
  assert.match(bundle.instructions, /never from the correction's `reason`/);
});

test('0.7.32 (D78): files the corrected plugin reads outside the adapter folder are recorded with the correction, handed to the reviewer, and a later change to one asks a verdict again', () => {
  const f = plugged('validation-correct-reads');
  const harness = `export default {async run(ctx){const fs = await import('node:fs'); ctx.log(fs.readFileSync(ctx.dir + '/front/fixtures/harness.jsx', 'utf8')); return {status:'passed'}}}; // reads front/fixtures/harness.jsx`;
  commitIn(f.wt, { '.workflow/steps/unit.mjs': harness, 'front/fixtures/harness.jsx': 'cy.contains("Day 1")\n' });
  ok(wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'the spec moved to a harness', '--attempt', f.e.id], { ownerSilent: true }));
  const s = state(f.root, f.e.id);
  assert.deepEqual(s.validationCorrections[0].reads.map((x) => [x.step, x.path]), [['unit', 'front/fixtures/harness.jsx']]);
  const [c] = handReviewer(f, 'code-1').admissionCorrections;
  assert.deepEqual(c.reads.map((x) => [x.path, x.now === x.atCorrection]), [['front/fixtures/harness.jsx', true]]);
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('code-1', { validationChecked: verdictOn(f, 'complies') })), '--attempt', f.e.id]));
  assert.equal(state(f.root, f.e.id).decision.kind, 'gate', 'judged');
  // A product commit edits the harness: the check changed with no correction, and the next round judges it again.
  commitIn(f.wt, { 'front/fixtures/harness.jsx': 'cy.contains("1")\n' });
  const [again] = handReviewer(f, 'code-2').admissionCorrections;
  assert.equal(again.reads[0].now === again.reads[0].atCorrection, false);
  assert.match(again.reads[0].diff, /diff [0-9a-f]{40} HEAD -- front\/fixtures\/harness\.jsx$/);
  assert.equal(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('code-2', { criteria: [] })), '--attempt', f.e.id]).code, 75, 'no verdict on the changed harness, no closure');
});

test('0.7.32 (D78): an admission check another open attempt corrected too names fixing it once on the adapter\'s base branch, in the correction and in the next step', () => {
  const f = fixture('validation-correct-shared');
  commitIn(f.wt, { '.workflow/project.yaml': ADMISSION_CFG('test -f src/a.txt && echo corrected') });
  const first = ok(wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'it read a failed request as empty data', '--attempt', f.e.id], { ownerSilent: true }));
  assert.match(first.out + first.err, /when the defect is in the check itself, not this ticket's intended behaviour, fix it once on the base branch of the adapter's repo instead: every live attempt follows the adapter there \(D60\)/);
  const e2 = ok(wf(f.root, ['entry', '--item', 'ENG-2', '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'planner2', '--attempt', e2.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e2.id]));
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'impl2', '--attempt', e2.id]));
  commitIn(e2.repos.app.worktree, { 'src/a.txt': 'changed too\n', '.workflow/project.yaml': ADMISSION_CFG('test -f src/a.txt && echo corrected') });
  ok(wf(f.root, ['handoff', 'close', '--agent', 'impl2', '--attempt', e2.id]));
  const second = ok(wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', 'the same defect', '--attempt', e2.id], { ownerSilent: true }));
  assert.match(second.out + second.err, new RegExp(`${f.e.id.replace('.', '\\.')} has corrected unit too: when the defect is in the check itself`));
  assert.equal((state(f.root, e2.id).decisions ?? []).length, 0, 'no question in either attempt');
  assert.match(state(f.root, e2.id).next, new RegExp(`the admission check unit is corrected here and in ${f.e.id.replace('.', '\\.')} too: when the defect is in the check itself \\(not this ticket's intended behaviour\\), fix it once on the base branch of app, which every live attempt follows \\(D60\\)`));
});
