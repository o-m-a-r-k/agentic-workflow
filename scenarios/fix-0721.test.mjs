import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, singleRepoProject, state, summaryFile, toAccepted, wf } from './helpers.mjs';
import { append, readLedger } from '../engine/ledger.mjs';

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

test('wf\'s own numbered item is recorded at admission: a typed QF-7 ticket is a ticket, and a numbered fix reopens under the id pattern', () => {
  // A ticket the tracker named QF-7 is the tracker's: admission reads it (the built-in pattern accepts it).
  const plain = singleRepoProject('quick-typed-qf', { tracker, gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } }, files);
  const typed = ok(wf(plain.root, ['entry', '--item', 'QF-7', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  assert.equal(state(plain.root, typed.id).autoItem, false);
  assert.ok(events(state(plain.root, typed.id)).includes('admitted'));
  // Under a pattern that admits no QF ticket, wf's own numbered fix still enters, delivers and reopens.
  const { base, root } = singleRepoProject('quick-own-item', { tracker: { ...tracker, itemPattern: '^ENG-\\d+$' }, gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } }, files);
  // An item outside the project's id pattern is refused for the quick lane as for the standard one.
  assert.match(wf(root, ['entry', '--item', 'NOPE', '--lane', 'quick', '--owner', 'o']).err, /not a ticket id/);
  // A numbered fix: no tracker steps, delivered and closed, then reopened as the same numbered fix.
  const q = ok(wf(root, ['entry', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  assert.equal(state(root, q.id).autoItem, true);
  const call = (args) => wf(root, [...args, '--attempt', q.id]);
  ok(call(['plan', '--file', criteriaFile(base)]));
  ok(call(['handoff', 'implementer', '--agent', 'i']));
  commitIn(q.repos.app.worktree, { 'src/a.txt': 'fixed\n' });
  ok(call(['handoff', 'close', '--agent', 'i']));
  ok(call(['gate', ...OUT_OF_ORDER]));
  ok(call(['handoff', 'reviewer', '--agent', 'r']));
  ok(call(['review', '--closure', closureFile(base, goodClosure('r'))]));
  ok(call(['accept']));
  ok(call(['deliver']));
  assert.equal(state(root, q.id).phase, 'done');
  const item = state(root, q.id).item;
  const reopened = ok(wf(root, ['reopen', '--item', item, '--reason', 'the fix regressed', '--owner', 'o', '--json'])).json();
  const r = state(root, reopened.id ?? reopened.state?.id);
  assert.deepEqual([r.lane, r.autoItem, events(r)], ['quick', true, []]);
});

// 0.7.23 (I-178), named failure (field): a batch has no ticket, yet it was told to do the tracker's "implementing" step for
// its own id. 0.7.20 queued the step for every lane but the quick one, and a batch ledger written then still carried it;
// 0.7.21 stopped emitting it (hasTicket), but the reducer replayed the old event and the next step kept demanding it.
test('0.7.23 (I-178): a batch owes no tracker step: none is queued at its implementer handoff, and a 0.7.20 ledger\'s queued one is not replayed', () => {
  const heavy = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'true', tier: 'heavy' }];
  const { base, root } = singleRepoProject('batch-no-ticket', { tracker, gate: { steps: heavy } }, { ...files, 'src/b.txt': 'b\n' });
  const m1 = toAccepted(root, base, { item: 'ENG-601', owner: 'o', change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] }).id;
  const m2 = toAccepted(root, base, { item: 'ENG-602', owner: 'o', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] }).id;
  const queued = state(root, m1).tracker.pending.find((a) => a.event === 'implementing');
  assert.ok(queued, 'a ticket\'s implementer handoff queues the tracker step (the shape a 0.7.20 batch ledger carries)');
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1},${m2}`, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'implementer', '--agent', 'fix-1', '--attempt', b.id, '--owner', 'o']));
  assert.deepEqual(events(state(root, b.id)), [], 'a batch has no ticket: no tracker step at its implementer handoff');
  // The ledger a 0.7.20 engine wrote: the step queued for the batch's own id.
  append(root, b.id, 'tracker.pending', { event: 'implementing', actions: [queued] }, null);
  const old = state(root, b.id);
  assert.deepEqual(events(old), [], 'the derived state of a batch never owes a tracker step');
  assert.doesNotMatch(old.next, /tracker/i, 'and the next step does not ask for one');
  assert.notEqual(old.decision.kind, 'tracker');
  assert.ok(readLedger(root, b.id).some((r) => r.type === 'tracker.pending' && r.data.event === 'implementing'), 'the event stays in the ledger and its hash chain');
  // A member (a ticket) still owes its own steps.
  assert.ok(events(state(root, m1)).includes('implementing'));
});
