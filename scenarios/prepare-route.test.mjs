// 0.7.30 (I-155, D59): a plugin step prepares its dependencies before the first commit through its plugin's own `prepare`,
// and `wf doctor` names a plugin step with no preparation route.
//
// Named failure (field): an admitted runtime plugin provisioned its isolated private dependencies only during a check or a
// gate. The adapter declared no `prepare` command, so `wf run --step` refused; `wf check` and `wf gate --prepare-only` refuse
// uncommitted product changes, and a check on the clean baseline skipped every step. Lint required before the first source
// commit could only run after a contrived commit. Onboarding and doctor said nothing (I-195, retired into I-155, is the same
// gap seen from a fresh implementer worktree).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { criteriaFile, ok, singleRepoProject, state, wf, write, yaml } from './helpers.mjs';

const runtime = `import fs from 'node:fs';import path from 'node:path';
export default {
  async prepare(ctx) {
    const into = path.join(ctx.dir, '.deps');
    fs.mkdirSync(into, { recursive: true });
    fs.writeFileSync(path.join(into, 'ready'), 'token=' + ctx.env.REGISTRY_TOKEN);
    ctx.log('prepared isolated dependencies with ' + ctx.env.REGISTRY_TOKEN);
    return { status: fs.existsSync(path.join(ctx.dir, 'src', 'break-prepare.txt')) ? 'failed' : 'passed' };
  },
  async run(ctx) { return { status: 'passed', suites: [] }; },
};`;
const bare = `export default { async run() { return { status: 'passed', suites: [] }; } };`;
const nothing = `export default { prepare: false, async run() { return { status: 'passed', suites: [] }; } };`;
function project(name) {
  const steps = [
    { id: 'client-unit', repo: 'app', plugin: 'steps/runtime.mjs', inputs: ['src/**'] },
    { id: 'browser', repo: 'app', plugin: 'steps/bare.mjs', inputs: ['src/**'] },
    { id: 'http', repo: 'app', plugin: 'steps/nothing.mjs', inputs: ['src/**'] },
    { id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] },
  ];
  return singleRepoProject(name, { gate: { steps } }, {
    '.gitignore': '.wf-evidence/\n.wf-worktrees/\n.deps/\n',
    '.workflow/steps/runtime.mjs': runtime,
    '.workflow/steps/bare.mjs': bare,
    '.workflow/steps/nothing.mjs': nothing,
    '.workflow/secrets.yaml': yaml({ keys: [{ key: 'REGISTRY_TOKEN', kind: 'provided', usedBy: ['client-unit'] }] }),
  });
}

test('I-155: `wf run --step` runs a plugin step\'s own `prepare` before the first commit, with the step\'s secrets masked, and records nothing', () => {
  const { base, root } = project('prepare-plugin');
  const e = ok(wf(root, ['entry', '--item', 'ENG-155', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  ok(wf(root, ['secrets', 'set', 'REGISTRY_TOKEN'], { input: 'registry-value-123456' }));
  // Uncommitted product work: the preparation runs on the worktree as it is.
  write(e.repos.app.worktree, 'src/new.txt', 'not committed yet\n');
  const r = ok(wf(root, ['run', '--step', 'client-unit', '--attempt', e.id]));
  assert.match(r.out, /prepared isolated dependencies with \[secret\]/);
  assert.doesNotMatch(`${r.out}${r.err}`, /registry-value/);
  assert.equal(fs.readFileSync(path.join(e.repos.app.worktree, '.deps', 'ready'), 'utf8'), 'token=registry-value-123456', 'the plugin received the step\'s secret');
  const s = state(root, e.id);
  assert.deepEqual([s.gates.length, s.checks.length], [0, 0], 'preparation is never gate or check evidence');
  // A plugin that says it needs no preparation, and one that offers none.
  assert.match(ok(wf(root, ['run', '--step', 'http', '--attempt', e.id])).out, /step http needs no preparation \(its plugin says `prepare: false`\)/);
  const none = wf(root, ['run', '--step', 'browser', '--attempt', e.id]);
  assert.equal(none.code, 75);
  assert.match(none.err, /step `browser` declares no `prepare` command and its plugin has no `prepare`/);
  assert.match(none.err, /`prepare\(ctx\)` on the default export of the step's plugin/);
  // A preparation that fails says so and exits non-zero.
  write(e.repos.app.worktree, 'src/break-prepare.txt', 'x\n');
  assert.equal(wf(root, ['run', '--step', 'client-unit', '--attempt', e.id]).code, 1);
});

test('I-155: `wf doctor` names a plugin step with no preparation route, and not one that has one or says it needs none', () => {
  const { root } = project('prepare-doctor');
  const r = wf(root, ['doctor', '--no-steps', '--json']);
  const report = JSON.parse(r.out);
  const warned = report.warnings.filter((w) => /^preparation of step/.test(w.check ?? ''));
  assert.deepEqual(warned.map((w) => w.check), ['preparation of step browser']);
  assert.match(warned[0].problem, /plugin step with no preparation route: `wf run --step browser` cannot prepare its dependencies before the first commit/);
  assert.match(warned[0].fix, /`prepare\(ctx\)`.*`prepare: false`/);
});

// 0.7.32 (D74). Named failure (field, I-219 and I-220): `wf run --step` was refused three times with `run:no-prepare` while
// docs/gate.md and the implementer rules named it for the runs before the first commit; the refusal told the implementer to add
// `prepare(ctx)` to the plugin, which a ticket cannot do (its own change to the adapter is never what it runs, D60). The refusal
// says what to do meanwhile and that only the project's adapter, on its base branch, adds a preparation route.
test('D74: a step with no preparation route says what to do meanwhile and that only the project adds one, on its base branch', () => {
  const { base, root } = project('prepare-meanwhile');
  const e = ok(wf(root, ['entry', '--item', 'ENG-219', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  for (const [step, how] of [['browser', /`prepare\(ctx\)` on the default export of the step's plugin \(or `prepare: "<install command>"` on the step\)/], ['unit', /`prepare: "<install command>"` on the step/]]) {
    const r = wf(root, ['run', '--step', step, '--attempt', e.id]);
    assert.equal(r.code, 75, step);
    assert.match(r.err, /meanwhile, install and test with the package's own commands \(what its manifest or README names\), or commit and run `wf check`, which runs the light steps on the committed tree with their secrets/, step);
    assert.match(r.err, /say in your report that this step has no preparation route/, step);
    assert.match(r.err, how, step);
    assert.match(r.err, /only the project's adapter adds one, committed on its base branch outside this ticket \(the attempt follows it there\); a ticket's own change to the adapter is never what it runs/, step);
  }
});
