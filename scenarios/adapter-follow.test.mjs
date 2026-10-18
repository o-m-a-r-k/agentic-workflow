import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, toAccepted, wf, yaml } from './helpers.mjs';
import { readLedger } from '../engine/ledger.mjs';

// 0.7.30 (I-151, D60): a live attempt follows the adapter as committed on its adapter repo's base branch.
// Named failure (field): an attempt admitted before its project scoped a step's evidence glob kept counting 4,008 other
// tickets' screenshots, and another project's attempt kept a leaving policy its project had changed: a fix committed on the
// base branch never reached the attempts already running, and the only route was a fault recovery that needed the person.

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'lint', repo: 'app', run: 'true', inputs: ['src/**'] }];
const config = (name, extra = {}) => ({ version: 1, enabled: true, name, repos: [{ name: 'app', path: '.', base: 'main' }], lanes: ['quick', 'standard', 'batch'], gate: { steps }, ...extra });
const project = (name, extra = {}) => singleRepoProject(name, { gate: { steps }, ...extra });
const adapterFile = (root) => path.join(root, '.workflow', 'project.yaml');
const follows = (root, id) => readLedger(root, id).filter((e) => e.type === 'adapter.followed');
const held = (root, id) => readLedger(root, id).filter((e) => e.type === 'adapter.notFollowed');

test('I-151: a live attempt takes the adapter committed on its base branch: never the working copy or an unpushed commit; a step its gate ran that changed runs again, the rest is reused, and the acceptance is taken again', () => {
  const { base, root, remote } = project('follow-gate');
  const { id } = toAccepted(root, base, { item: 'ENG-301' });
  const admitted = state(root, id).adapterBase;
  const changed = config('follow-gate', { gate: { steps: [steps[0], { ...steps[1], run: 'true # stricter' }] } });

  // The working copy and a commit not on the remote base are never read.
  fs.writeFileSync(adapterFile(root), yaml(changed));
  ok(wf(root, ['status']));
  assert.equal(state(root, id).adapterPin, null, 'a working-copy edit reaches no attempt');
  sh(root, 'git commit -qam "lint: stricter (not pushed)"');
  ok(wf(root, ['status']));
  assert.equal(follows(root, id).length, 0, 'a local commit not pushed reaches no attempt');

  // Pushed on the base branch: the next command that reads the attempt takes it, recorded with the reason.
  sh(root, 'git push -q origin main');
  const tip = sh(root, 'git rev-parse HEAD');
  const status = ok(wf(root, ['status', '--attempt', id])).out;
  assert.match(status, new RegExp(`adapter: follows origin/main; took ${tip.slice(0, 10)} \\(\\.workflow/project\\.yaml\\); steps changed: lint; the acceptance was withdrawn`));
  const [f] = follows(root, id);
  assert.equal(f.data.from, admitted);
  assert.equal(f.data.to, tip);
  assert.deepEqual(f.data.changed, ['.workflow/project.yaml']);
  assert.deepEqual(f.data.commits.map((c) => c.subject), ['lint: stricter (not pushed)']);
  assert.deepEqual(f.data.gate.rerun, ['lint']);
  assert.equal(f.data.withdrewAcceptance, true);
  assert.equal(f.actor, null, 'the engine records it; nobody was asked');
  let s = state(root, id);
  assert.equal(s.adapterPin, tip);
  assert.equal(s.adapterBase, admitted, 'the admission commit is kept');
  assert.equal(s.accepted, null);
  assert.equal(readLedger(root, id).filter((e) => e.type.startsWith('decision.')).length, 0, 'no question to the person');

  // The passed gate no longer counts: deliver says why. The next gate runs the changed step and reuses the other.
  const refused = wf(root, ['deliver', '--attempt', id]);
  assert.equal(refused.code, 75);
  ok(wf(root, ['gate', '--attempt', id]));
  s = state(root, id);
  assert.equal(s.lastGate.adapterBase, tip, 'the gate is bound to the adapter it ran under');
  assert.deepEqual(Object.fromEntries(s.lastGate.steps.map((x) => [x.id, x.status])), { unit: 'reused', lint: 'passed' });
  // The same evidence: the evidence review already recorded is taken again by `wf accept`.
  ok(wf(root, ['accept', '--attempt', id]));
  ok(wf(root, ['deliver', '--attempt', id]));
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
  assert.equal(follows(root, id).length, 1, 'followed once');
});

test('I-151: a change on the base branch that leaves what the gate ran alone keeps the gate and the acceptance; the leaving policy follows', async () => {
  const { trustedAdapter } = await import('../engine/config.mjs');
  const { base, root } = project('follow-policy');
  const { id } = toAccepted(root, base, { item: 'ENG-302' });
  // A base change outside the adapter: nothing the attempt reads changed, so nothing is recorded.
  commitIn(root, { 'src/other.txt': 'o\n' }, 'unrelated');
  sh(root, 'git push -q origin main');
  ok(wf(root, ['status']));
  assert.equal(follows(root, id).length, 0);
  // The project changes who lets a low item leave, and adds an evidence glob to a step (evidence globs change no result, D21).
  fs.writeFileSync(adapterFile(root), yaml(config('follow-policy', { leaving: { high: 'never', medium: 'never', low: 'owner' }, gate: { steps: [{ ...steps[0], artifacts: ['out/{itemLower}/**/*.png'] }, steps[1]] } })));
  sh(root, 'git commit -qam "low items: the owner decides" && git push -q origin main');
  const s = state(root, id);
  assert.equal(follows(root, id).length, 1);
  assert.deepEqual(follows(root, id)[0].data.gate, { rerun: [], applies: [], added: [], removed: [], settings: [] });
  assert.ok(s.accepted, 'the acceptance stands');
  assert.equal(trustedAdapter(root, s).leaving.low, 'owner', 'the attempt reads the policy its project has now');
  ok(wf(root, ['deliver', '--attempt', id]));
});

test('I-151: a tip that cannot be taken is recorded once with why and the attempt keeps its pin; the next good tip is taken', () => {
  const { base, root } = project('follow-held');
  const e = ok(wf(root, ['entry', '--item', 'ENG-303', '--owner', 'o', '--json'])).json();
  const before = state(root, e.id).adapterBase;
  fs.writeFileSync(adapterFile(root), yaml(config('follow-held', { engine: '>=99.0.0' })));
  sh(root, 'git commit -qam "needs a newer engine" && git push -q origin main');
  const out = ok(wf(root, ['status', '--attempt', e.id])).out;
  assert.match(out, /adapter: origin\/main \([0-9a-f]{10}\) is not taken: the adapter at origin\/main \([0-9a-f]{10}\) cannot be used: [^\n]*99\.0\.0[^\n]*; this attempt keeps [0-9a-f]{10}/);
  ok(wf(root, ['status', '--attempt', e.id]));
  assert.equal(held(root, e.id).length, 1, 'said once per tip');
  assert.equal(state(root, e.id).adapterPin, null);
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  fs.writeFileSync(adapterFile(root), yaml(config('follow-held', { gate: { steps: [steps[0]] } })));
  sh(root, 'git commit -qam "back to a supported engine; lint retired" && git push -q origin main');
  const s = state(root, e.id);
  assert.equal(s.adapterPin, sh(root, 'git rev-parse HEAD'));
  assert.equal(s.adapterHeld, null);
  assert.deepEqual(follows(root, e.id)[0].data.from, before);
  assert.deepEqual(follows(root, e.id)[0].data.gate.removed, ['lint']);
});

test('I-151: an attempt is never judged by its own change to its rules, even once the base branch holds it', () => {
  const { base, root } = project('follow-own');
  const e = ok(wf(root, ['entry', '--item', 'ENG-304', '--owner', 'o', '--json'])).json();
  const loosened = yaml(config('follow-own', { gate: { steps: [steps[0]] } }));
  commitIn(e.repos.app.worktree, { '.workflow/project.yaml': loosened, 'src/a.txt': 'b\n' }, 'drop lint');
  // The attempt's own change reaches the base branch outside its delivery.
  fs.writeFileSync(adapterFile(root), loosened);
  sh(root, 'git commit -qam "drop lint (merged by hand)" && git push -q origin main');
  const out = ok(wf(root, ['status', '--attempt', e.id])).out;
  assert.match(out, /is not taken: the base branch now holds this attempt's own change to \.workflow\/project\.yaml; an attempt is never judged by its own change to its rules/);
  assert.equal(state(root, e.id).adapterPin, null);
});

// Named failure (found building the follow): a step the attempt registered for itself (`wf validation add`) that the project
// then committed on its base branch under the same id made every gate of the attempt refuse ("no longer matches"). The
// attempt's own check keeps its pin and runs in that place.
test('I-151: a check the attempt registered keeps its pin when the base branch later defines a step of that id', () => {
  const { base, root } = project('follow-registered', {});
  const e = ok(wf(root, ['entry', '--item', 'ENG-305', '--owner', 'o', '--json'])).json();
  const wt = e.repos.app.worktree;
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(wt, { 'src/a.txt': 'b\n', '.workflow/project.yaml': yaml(config('follow-registered', { gate: { steps: [...steps, { id: 'http', repo: 'app', run: 'true', inputs: ['src/**'] }] } })) });
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  ok(wf(root, ['validation', 'add', '--steps', 'http', '--criteria', 'C1', '--reason', 'needs a real request', '--attempt', e.id]));
  // The project defines its own `http` step on the base branch, one that would fail here.
  fs.writeFileSync(adapterFile(root), yaml(config('follow-registered', { gate: { steps: [...steps, { id: 'http', repo: 'app', run: 'false', inputs: ['src/**'] }] } })));
  sh(root, 'git commit -qam "an http check of our own" && git push -q origin main');
  assert.equal(state(root, e.id).adapterPin, sh(root, 'git rev-parse HEAD'));
  assert.deepEqual(follows(root, e.id)[0].data.gate.added, [], 'the attempt\'s own check is left out of what moved');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  const validationChecked = state(root, e.id).validations.flatMap((v) => v.steps.map((x) => ({ id: x.id, commit: v.commit, verdict: 'complies', evidence: 'pinned definition read' })));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { validationChecked })), '--attempt', e.id]));
  const run = ok(wf(root, ['gate', '--attempt', e.id, '--json'])).json();
  assert.equal(run.status, 'passed', 'the registered `http` (true) runs, not the base branch\'s (false)');
  assert.ok(run.steps.some((x) => x.id === 'http' && x.status === 'passed'));
});
