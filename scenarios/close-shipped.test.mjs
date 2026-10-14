import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { OUT_OF_ORDER, commitIn, criteriaFile, ok, sh, singleRepoProject, state, wf } from './helpers.mjs';

// I-116, named failure (field): an attempt's change reached its target branches outside the workflow before its final
// evidence review (one repo delivered, the others merged by hand), and its worktrees and branches were then removed. `wf
// abandon` refuses an attempt with a delivered repo and `wf deliver` needs an acceptance, so it stayed ORPHANED in every
// listing after the person had decided to close it as it shipped. `wf close --shipped` checks from git that every change
// is on its target branch, and closes it under the person's decision.

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const silent = { ownerSilent: true };

// An attempt with a committed change and a passed gate, as the field attempt had.
function gated(name, item) {
  const p = singleRepoProject(name, { gate: { steps } });
  const e = ok(wf(p.root, ['entry', '--item', item, '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'shipped\n' });
  ok(wf(p.root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  return { ...p, id: e.id, wt: e.repos.app.worktree };
}

test('an orphaned attempt whose change was merged by hand is closed as shipped under the person\'s decision, over its hold', () => {
  const a = gated('close-shipped', 'ENG-700');
  ok(wf(a.root, ['hold', '--reason', 'finish it locally', '--attempt', a.id], silent));
  const head = sh(a.wt, 'git rev-parse HEAD');
  sh(a.wt, 'git push -q origin HEAD:main'); // merged by hand, outside the workflow
  fs.rmSync(a.wt, { recursive: true, force: true }); // and its worktree removed
  assert.match(ok(wf(a.root, ['status'])).out, /ORPHANED/);
  assert.match(wf(a.root, ['abandon', '--reason', 'x', '--attempt', a.id], silent).err, /is not abandoned: its change is on the target branch|partly delivered/i);

  assert.match(wf(a.root, ['close', '--shipped', '--attempt', a.id], silent).err, /--reason is required/);
  const refused = wf(a.root, ['close', '--shipped', '--reason', 'merged by hand; closed as it shipped', '--attempt', a.id], silent);
  assert.equal(refused.code, 75, 'the person decides');
  assert.match(refused.err, new RegExp(`close ${a.id.replace('.', '\\.')} as shipped without its acceptance \\(app ${head.slice(0, 10)} on origin/main\\), over its hold "finish it locally"`));

  const closed = ok(wf(a.root, ['close', '--shipped', '--reason', 'merged by hand; closed as it shipped', '--attempt', a.id]));
  assert.match(closed.out, new RegExp(`closed as shipped \\(decision A\\d+\\), without the workflow's acceptance:\\n {2}app: ${head.slice(0, 10)} on origin/main`));
  assert.match(closed.out, /the tracker is not touched/);
  const s = state(a.root, a.id);
  assert.equal(s.phase, 'done');
  assert.equal(s.activeHold, null, 'the decision covers the hold');
  assert.equal(s.shipped.repos.app.commit, head);
  assert.doesNotMatch(ok(wf(a.root, ['status'])).out, new RegExp(a.id.replace('.', '\\.')), 'no longer listed');
  assert.doesNotMatch(sh(a.root, 'git worktree list'), /ENG-700/, 'the missing worktree is pruned');
  assert.match(wf(a.root, ['close', '--shipped', '--reason', 'again', '--attempt', a.id], silent).err, /already done/);
});

test('an attempt whose change is not on its target branch is not closed as shipped, and says which repo', () => {
  const a = gated('close-not-shipped', 'ENG-701');
  const head = sh(a.wt, 'git rev-parse HEAD');
  const r = wf(a.root, ['close', '--shipped', '--reason', 'it shipped', '--attempt', a.id], silent);
  assert.equal(r.code, 75);
  assert.match(r.err, new RegExp(`is not closed as shipped: app: ${head.slice(0, 10)} is not on origin/main`));
  assert.equal(state(a.root, a.id).phase, 'gated', 'nothing recorded');
  assert.ok(!(state(a.root, a.id).decisions ?? []).some((d) => String(d.key).startsWith('close-shipped:')), 'no decision is opened for a claim git refutes');
});

test('the open discovered issues and the last review\'s findings are recorded with the close', () => {
  const a = gated('close-shipped-open', 'ENG-702');
  ok(wf(a.root, ['discovered', 'add', '--attempt', a.id, '--summary', 'captures cannot be exported', '--severity', 'low'], silent));
  sh(a.wt, 'git push -q origin HEAD:main');
  ok(wf(a.root, ['close', '--shipped', '--reason', 'merged by hand', '--attempt', a.id]));
  const s = state(a.root, a.id);
  assert.deepEqual(s.shipped.open.discovered.map((d) => [d.id, d.summary]), [['D1', 'captures cannot be exported']]);
  assert.ok(!fs.existsSync(a.wt), 'a worktree that still existed is removed');
});
