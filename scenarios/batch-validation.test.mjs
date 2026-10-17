// 0.7.29, second stream: a batch keeps every check its members registered (I-204), and `wf batch create` names the way on for an
// attempt that was not admitted with --defer-heavy (I-194).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, toAccepted, wf, yaml } from './helpers.mjs';

const STEPS = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'true', tier: 'heavy' }];
const IGNORE = '.wf-evidence/\n.wf-worktrees/\ncaptures/\n';
const project = (name) => ({ ...singleRepoProject(name, { gate: { steps: STEPS } }, { 'src/b.txt': 'b\n', 'src/c.txt': 'c\n', '.gitignore': IGNORE }), name });
const bundleOf = (r) => JSON.parse(fs.readFileSync(r.json().bundle ?? r.json().file, 'utf8'));
const batchClosure = (base, reviewer) => closureFile(base, { reviewer, findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [], anomalies: 'none seen' });

// An accepted member admitted with --defer-heavy that registered `check` (committed in its adapter, with `files`) on its own tree;
// with `correct`, `check` replaces the admission step of its id (the person's decision, which the scripted owner approves).
function memberWithCheck(p, item, change, check, files = {}, { correct = false } = {}) {
  const e = ok(wf(p.root, ['entry', '--item', item, '--owner', 'o', '--json', '--defer-heavy'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  const steps = correct ? STEPS.map((x) => (x.id === check.id ? check : x)) : [...STEPS, check];
  const cfg = { version: 1, enabled: true, name: p.name, repos: [{ name: 'app', path: '.', base: 'main' }], lanes: ['quick', 'standard', 'batch'], gate: { steps } };
  commitIn(e.repos.app.worktree, { ...change, '.workflow/project.yaml': yaml(cfg), ...files });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  if (correct) ok(wf(p.root, ['validation', 'correct', '--steps', check.id, '--reason', 'it read a failed request as empty data', '--attempt', e.id]));
  else ok(wf(p.root, ['validation', 'add', '--steps', check.id, '--criteria', 'C1', '--reason', 'the flow needs a real HTTP and browser check', '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r0', '--attempt', e.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r0')), '--attempt', e.id]));
  const gate = ok(wf(p.root, ['gate', '--attempt', e.id, '--json'])).json();
  const shots = gate.steps.flatMap((s) => s.artifacts ?? []).filter((a) => a.kind === 'screenshot').map((a) => a.sha256);
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r1', { screenshotsInspected: shots })), '--attempt', e.id]));
  ok(wf(p.root, ['accept', '--attempt', e.id]));
  return { id: e.id, gate, pin: state(p.root, e.id).validations[0].commit };
}

// 0.7.29 (I-204), named failure (field): four accepted members admitted with --defer-heavy were assembled into a batch; their
// registered HTTP and browser checks stayed in the members' ledgers, the batch's bundle carried `supplementalValidation: []` and
// its gate selected none of them, so a gate on the combined tree could pass without the members' required proofs.
test('I-204: a batch carries the check a member registered: its reviewer is handed it, its gate runs it on the combined tree at the member\'s pin and collects its screenshots, and an ejected member takes it along', () => {
  const p = project('i204-carry');
  const plugin = "import fs from 'node:fs';export default {async run(ctx){fs.mkdirSync(ctx.dir+'/captures',{recursive:true});fs.writeFileSync(ctx.dir+'/captures/'+ctx.attempt+'.png','image of '+ctx.attempt);return {status:'passed'};}};";
  const http = { id: 'http', repo: 'app', plugin: 'steps/proof.mjs', inputs: ['src/**'], tier: 'heavy', artifacts: ['captures/{attempt}.png'] };
  const m1 = memberWithCheck(p, 'ENG-204', { 'src/a.txt': 'one\n' }, http, { '.workflow/steps/proof.mjs': plugin });
  assert.deepEqual(m1.gate.steps.filter((s) => ['http', 'e2e'].includes(s.id)).map((s) => [s.id, s.status]).sort(), [['e2e', 'deferred'], ['http', 'passed']], 'the member ran its own check and deferred the heavy step');
  const m2 = toAccepted(p.root, p.base, { item: 'ENG-205', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  const created = ok(wf(p.root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'o']));
  const b = state(p.root, 'BATCH-1');
  assert.deepEqual(b.validations.map((v) => [v.steps.map((x) => x.id), v.commit, v.criteria, v.carriedFrom?.map((c) => [c.attempt, c.criteria])]), [[['http'], m1.pin, ['B1'], [[m1.id, ['C1']]]]], 'the batch carries the member\'s check, pinned where the member pinned it');
  assert.match(created.out, /required on the combined tree, carried from the members: http \(from ENG-204\.1\); the batch's gate runs each at its pinned definition/);
  // The batch's first review is full and is handed the carried check with where it came from.
  const bundle = bundleOf(ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'rb0', '--attempt', b.id, '--json'])));
  assert.deepEqual(bundle.supplementalValidation.map((v) => [v.steps[0].id, v.commit, v.carriedFrom.map((c) => c.attempt)]), [['http', m1.pin, [m1.id]]]);
  ok(wf(p.root, ['review', '--closure', batchClosure(p.base, 'rb0'), '--attempt', b.id]));
  const run = ok(wf(p.root, ['gate', '--attempt', b.id, '--json'])).json();
  const ran = run.steps.find((s) => s.id === 'http');
  assert.equal(ran?.status, 'passed', 'the member\'s check ran on the combined tree');
  assert.deepEqual(ran.artifacts.map((a) => [a.kind, a.source]), [['screenshot', 'captures/BATCH-1.png']], 'with the screenshots it collects');
  assert.equal(run.steps.find((s) => s.id === 'e2e')?.status, 'passed');
  assert.match(state(p.root, b.id).next, /^evidence review: the gate passed on the reviewed tree/);
  // The member leaves, and its check with it: the combined tree no longer holds its change.
  ok(wf(p.root, ['batch', 'eject', '--batch', b.id, '--member', m1.id, '--reason', 'it ships later']));
  assert.deepEqual(state(p.root, b.id).validations, []);
});

// Two members that pinned one check id differently: the batch can run one of them under that id, so the batch is refused before
// it exists. The same check pinned alike by two members is carried once, from both.
test('I-204: members that registered one check differently are refused before the batch exists; the same check registered alike is carried once', () => {
  const p = project('i204-conflict');
  const m1 = memberWithCheck(p, 'ENG-206', { 'src/a.txt': 'one\n' }, { id: 'http', repo: 'app', run: 'true', inputs: ['src/**'] });
  const m2 = memberWithCheck(p, 'ENG-207', { 'src/b.txt': 'two\n' }, { id: 'http', repo: 'app', run: 'true', inputs: ['src/**'] });
  const m3 = memberWithCheck(p, 'ENG-208', { 'src/c.txt': 'three\n' }, { id: 'http', repo: 'app', run: 'test -f src/c.txt', inputs: ['src/**'] });
  const refused = wf(p.root, ['batch', 'create', '--members', `${m1.id},${m3.id}`, '--owner', 'o']);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /the members registered the same check differently, and the batch can run only one of them: http \(ENG-206\.1 pinned it at [0-9a-f]{10}, ENG-208\.1 at [0-9a-f]{10}, with a different definition or plugin\)/);
  assert.match(refused.err, /wf validation correct --steps <id>/);
  assert.notEqual(wf(p.root, ['resume', '--attempt', 'BATCH-1', '--json']).code, 0, 'no batch was created');
  ok(wf(p.root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'o']));
  assert.deepEqual(state(p.root, 'BATCH-1').validations.map((v) => [v.steps[0].id, v.commit, v.carriedFrom.map((c) => c.attempt)]), [['http', m1.pin, [m1.id, m2.id]]]);
});

// A member corrected a heavy admission step with the person's yes: its own gate runs the correction (it deferred it, then failed
// for it), and the batch runs the corrected definition on the combined tree, not the one the person found wrong.
test('I-204: an admission step a member corrected runs in its own gate and in the batch as corrected, on the member\'s approval', () => {
  const p = project('i204-correction');
  const fixed = { id: 'e2e', repo: 'app', run: 'echo corrected-e2e', tier: 'heavy' };
  const m1 = memberWithCheck(p, 'ENG-209', { 'src/a.txt': 'one\n' }, fixed, {}, { correct: true });
  // A corrected check runs where a registered one does: in the member's own gate, which otherwise deferred it and then failed
  // for the check it required.
  assert.equal(m1.gate.steps.find((s) => s.id === 'e2e').status, 'passed', 'the member ran its corrected check');
  const decision = state(p.root, m1.id).validationCorrections.at(-1).decision;
  assert.ok(decision, 'the person approved the correction');
  const m2 = toAccepted(p.root, p.base, { item: 'ENG-210', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  ok(wf(p.root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'o']));
  const b = state(p.root, 'BATCH-1');
  assert.deepEqual(b.validations.map((v) => [v.steps[0].id, v.commit, v.correctedFrom?.map((x) => [x.id, x.admission]), v.approvedIn]), [['e2e', m1.pin, [['e2e', true]], { attempt: m1.id, decision }]]);
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'rb0', '--attempt', b.id]));
  ok(wf(p.root, ['review', '--closure', batchClosure(p.base, 'rb0'), '--attempt', b.id]));
  const run = ok(wf(p.root, ['gate', '--attempt', b.id, '--json'])).json();
  const e2e = run.steps.find((s) => s.id === 'e2e');
  assert.equal(e2e.status, 'passed');
  assert.match(fs.readFileSync(e2e.log, 'utf8'), /corrected-e2e/, 'the corrected definition ran on the combined tree');
  assert.deepEqual(state(p.root, b.id).decisions ?? [], [], 'the batch asked the person nothing again');
});

// Review of 0.7.29: a member check the batch does not carry (its admission adapter now defines the step itself) was printed once
// by `wf batch create` and seen nowhere else; the batch's reviewer is handed it.
test('I-204: a member check the batch does not carry, because the base now defines that step itself, reaches the batch\'s reviewer', () => {
  const p = project('i204-not-carried');
  const m1 = memberWithCheck(p, 'ENG-211', { 'src/a.txt': 'one\n' }, { id: 'http', repo: 'app', run: 'true', inputs: ['src/**'] });
  const m2 = toAccepted(p.root, p.base, { item: 'ENG-212', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  // The base defines `http` itself, differently, before the batch is admitted on it.
  const cfg = { version: 1, enabled: true, name: p.name, repos: [{ name: 'app', path: '.', base: 'main' }], lanes: ['quick', 'standard', 'batch'], gate: { steps: [{ id: 'http', repo: 'app', run: 'echo base-http', inputs: ['src/**'] }, ...STEPS] } };
  commitIn(p.root, { '.workflow/project.yaml': yaml(cfg) }, 'the base defines http');
  sh(p.root, 'git push -q origin main');
  const created = ok(wf(p.root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'o']));
  assert.match(created.out, /not carried: http of ENG-211\.1: the batch's admission adapter now defines http itself, differently; the batch runs its own/);
  const b = state(p.root, 'BATCH-1');
  assert.deepEqual([b.validations, b.validationsNotCarried.map((x) => [x.id, x.member])], [[], [['http', m1.id]]]);
  const bundle = bundleOf(ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'rb0', '--attempt', b.id, '--json'])));
  assert.deepEqual(bundle.validationsNotCarried, b.validationsNotCarried, 'the batch\'s reviewer is handed what was not carried and why');
  assert.match(bundle.instructions, /`validationsNotCarried` lists checks a member registered or corrected that this batch does not carry, each with why \(http of ENG-211\.1\)/);
});

// 0.7.29 (I-194), named failure (field): `wf batch create` refused attempts not admitted with --defer-heavy and named no way on,
// and `wf entry`'s help did not say a batch member is admitted that way; three attempts not yet implemented waited for a restart
// nobody had described.
test('I-194: the refusal of a member not admitted with --defer-heavy names the way on, and the help says how a member is admitted', () => {
  const p = project('i194-route');
  const done = toAccepted(p.root, p.base, { item: 'ENG-194', change: { 'src/a.txt': 'one\n' } });
  const fresh = ok(wf(p.root, ['entry', '--item', 'ENG-195', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  const implemented = wf(p.root, ['batch', 'create', '--members', `${done.id},${fresh.id}`, '--owner', 'o']);
  assert.equal(implemented.code, 75);
  assert.match(implemented.err, /ENG-194\.1 was not admitted with --defer-heavy: its heavy steps run in its own gate, so it is delivered on its own, not in a batch/);
  assert.match(implemented.err, /deliver it on its own: `wf resume ENG-194\.1` names its next step \(`wf deliver --attempt ENG-194\.1` once accepted\)/);
  const unstarted = wf(p.root, ['batch', 'create', '--members', `${fresh.id},${done.id}`, '--owner', 'o']);
  assert.match(unstarted.err, /nothing is implemented in it yet: admit it again with --defer-heavy, `wf abandon --attempt ENG-195\.1 --reason "admitted again with --defer-heavy to join a batch"` \(its branch is kept\), then `wf entry --item ENG-195 --lane quick --defer-heavy`/);
  const help = ok(wf(p.root, ['help'])).out;
  assert.match(help, /--defer-heavy: its heavy steps run once in a batch's gate; only attempts admitted with it\s+join `wf batch create`/);
  assert.match(help, /members are accepted attempts admitted with --defer-heavy; the batch carries the checks\s+each registered/);
});
