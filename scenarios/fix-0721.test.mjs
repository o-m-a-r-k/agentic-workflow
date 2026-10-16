import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, singleRepoProject, state, summaryFile, wf } from './helpers.mjs';

// 0.7.21, named failure (field): a project worked its tracker's tickets through the quick lane; the engine read the lane as
// "no ticket", so those tickets never moved to In progress or In UAT and never got the tester's comment.
const tracker = { kind: 'linear', statuses: { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' }, deliveredComment: 'uat.md' };
const files = { '.gitignore': '.wf-evidence/\n.wf-worktrees/\n', '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n', 'src/a.txt': 'a\n' };
const events = (s) => s.tracker.pending.map((a) => a.event);

test('a quick fix admitted with a ticket moves that ticket like any other; one with no ticket (QF-<n>) has no tracker steps', () => {
  const { base, root } = singleRepoProject('quick-ticket', { tracker, gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } }, files);
  const e = ok(wf(root, ['entry', '--item', 'ENG-500', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  assert.ok(events(state(root, e.id)).includes('admitted'), 'admission reads the ticket and moves it to In Progress');
  const call = (args) => wf(root, [...args, '--attempt', e.id]);
  ok(call(['plan', '--file', criteriaFile(base, [{ id: 'C1', text: 'the list shows the count', uat: 'The list shows how many items it has' }])]));
  ok(call(['handoff', 'implementer', '--agent', 'i']));
  assert.ok(events(state(root, e.id)).includes('implementing'));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'A\n' });
  ok(call(['handoff', 'close', '--agent', 'i']));
  ok(call(['gate', ...OUT_OF_ORDER]));
  ok(call(['handoff', 'reviewer', '--agent', 'r']));
  ok(call(['review', '--closure', closureFile(base, goodClosure('r', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log' } }] }))]));
  ok(call(['accept']));
  // A ticket's delivery needs the tester's summary, then hands off: the delivered status and comment, not a close.
  assert.match(call(['deliver']).err, /the delivered comment needs the owner's summary first/);
  ok(call(['deliver', '--summary-file', summaryFile(base, 'The list now shows how many items it has.')]));
  const s = state(root, e.id);
  assert.ok(events(s).includes('delivered'));
  assert.equal(s.phase, 'handoff-pending');
  // No ticket: `wf` numbers the quick fix itself, and no tracker step is created.
  const q = ok(wf(root, ['entry', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  assert.match(q.id, /^QF-\d+\.1$/);
  assert.deepEqual(events(state(root, q.id)), []);
});
