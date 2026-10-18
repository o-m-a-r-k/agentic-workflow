// 0.7.30 (I-163, D56): a step that needs another step's output says so (`needs`), and the gate never starts it first.
//
// Named failure (field): a full gate started browser-only proof steps while the Docker-leased steps that prepare their
// isolated dependencies waited for shared capacity; one consumer failed its dependency precondition in 0.2 seconds just after
// its producer started, and the producer later passed and prepared exactly what it needed. The scheduler took the first
// startable step (`queue.findIndex(canStart)`), so a blocked lease let a later step start first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commitIn, criteriaFile, ok, OUT_OF_ORDER, singleRepoProject, wf } from './helpers.mjs';

const admitted = (root, base, item) => {
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  return e;
};
// Another live process holds the machine's only docker slot for a few seconds, as another attempt's gate would. Not a child of
// this test process (which is blocked while `wf` runs and could not reap it: a zombie still counts as alive).
function holdDocker(root, seconds) {
  const dir = path.join(root, '..', '.wfhome', 'leases');
  fs.mkdirSync(dir, { recursive: true });
  const pid = Number(spawnSync('sh', ['-c', `sleep ${seconds} >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).stdout.trim());
  fs.writeFileSync(path.join(dir, 'docker.1'), String(pid));
  return { kill: () => { try { process.kill(pid); } catch {} } };
}
const producer = (run = 'sleep 1 && mkdir -p .prepared && touch .prepared/deps') => ({ id: 'producer', repo: 'app', lease: 'docker', run });
const consumer = (extra = {}) => ({ id: 'consumer', repo: 'app', run: 'test -f .prepared/deps', ...extra });
const project = (name, steps) => singleRepoProject(name, { gate: { maxParallelSteps: 2, leases: { docker: 1 }, steps } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\n.prepared/\n' });

test('I-163: a consumer that needs a producer waits for it, though the producer waits for a lease and the consumer needs none', () => {
  const { base, root } = project('step-order-wait', [producer(), consumer({ needs: ['producer'] })]);
  const e = admitted(root, base, 'ENG-163');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const held = holdDocker(root, 3);
  const r = wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json']);
  held.kill();
  assert.equal(r.code, 0, r.err);
  const g = JSON.parse(r.out);
  const by = (id) => g.steps.find((x) => x.id === id);
  assert.equal(by('producer').status, 'passed');
  assert.equal(by('consumer').status, 'passed');
  assert.ok(Date.parse(by('consumer').startedAt) >= Date.parse(by('producer').startedAt) + by('producer').durationMs, 'the consumer started after its producer finished');
  assert.match(r.err, /wf gate: after    consumer  waits for producer \(it needs its output\)/);
});

test('I-163: a consumer whose producer failed does not start, and says why', () => {
  const { base, root } = project('step-order-failed', [producer('exit 3'), consumer({ needs: ['producer'] })]);
  const e = admitted(root, base, 'ENG-164');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const r = wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json']);
  assert.equal(r.code, 1);
  const c = JSON.parse(r.out).steps.find((x) => x.id === 'consumer');
  assert.equal(c.status, 'not-started');
  assert.equal(c.reason, 'needs producer, which failed: it was not started');
});

test('I-163: `needs` names steps of the gate, never itself, and no cycle', () => {
  for (const [steps, msg] of [
    [[producer(), consumer({ needs: ['nope'] })], /step `consumer`: needs names unknown step `nope`/],
    [[producer(), consumer({ needs: ['consumer'] })], /step `consumer`: needs names the step itself/],
    [[{ ...producer(), needs: ['consumer'] }, consumer({ needs: ['producer'] })], /gate steps need each other in a cycle: (producer → consumer → producer|consumer → producer → consumer)/],
    [[producer(), consumer({ needs: 'producer' })], /step `consumer`: needs must be a list of step ids/],
  ]) {
    const { root } = project('step-order-config', steps);
    const r = wf(root, ['entry', '--item', 'ENG-165', '--owner', 'o']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, msg);
  }
});

// Review of 0.7.30: a producer passed in another attempt of the project (same key) was reused here, so it never ran in this
// worktree, and the consumer that needs its output failed its precondition. A step another step needs is never taken from
// another attempt; within this attempt its earlier run left its output in this worktree.
test('I-163: a step another step needs is not reused from another attempt: it runs here, and its consumer finds its output', () => {
  const steps = [{ id: 'producer', repo: 'app', run: 'mkdir -p .prepared && touch .prepared/deps', inputs: ['**'] }, consumer({ needs: ['producer'] })];
  const { base, root } = project('step-order-across', steps);
  const a = admitted(root, base, 'ENG-2');
  commitIn(a.repos.app.worktree, { 'src/a.txt': 'same change\n' });
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', a.id]));
  const b = admitted(root, base, 'ENG-3');
  commitIn(b.repos.app.worktree, { 'src/a.txt': 'same change\n' });
  const r = wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', b.id, '--json']);
  assert.equal(r.code, 0, r.err);
  const run = r.json();
  assert.equal(run.steps.find((s) => s.id === 'producer').status, 'passed', 'it ran in this worktree');
  assert.equal(run.steps.find((s) => s.id === 'producer').reusedFromAttempt, undefined);
  assert.equal(run.steps.find((s) => s.id === 'consumer').status, 'passed');
});
