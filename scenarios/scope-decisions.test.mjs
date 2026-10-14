// 0.7.0 (D1, D2): where a review finding goes when it is not fixed in its attempt. Named failures: the four-boolean scope
// form on every finding made agents class 97% of findings "in scope", and an owner question (`wf scope ask`/`decide`)
// stood in front of every unrelated defect. The engine now computes whether a finding blocks; an observation is ticketed
// or moved to a sibling attempt without a question, and a defect the change caused (or one on a critical boundary)
// leaves the batch only with `wf approve` (kind move-out-of-batch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, wf } from './helpers.mjs';
import { loadState } from '../engine/ledger.mjs';
import { blockingFindings } from '../engine/scope-decisions.mjs';
import { observations } from '../engine/review-policy.mjs';

async function inProcess(root, fn) {
  const cwd = process.cwd();
  const keep = { ...process.env };
  Object.assign(process.env, { WF_EVIDENCE_FLAGS: '0', WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), WF_HOME: path.join(root, '..', '.home'), WF_IMPROVEMENTS_DIR: path.join(root, '..', '.improvements') });
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
}
const terminal = () => ({ input: Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} }), output: Object.assign(new PassThrough(), { isTTY: true, columns: 80 }) });

function project(name) {
  const p = singleRepoProject(name, { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } }, { 'src/old.txt': 'o1\no2\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'SC-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base, [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }, { id: 'C2', text: 'old gets an empty state', uat: 'old shows its empty state' }]), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'changed\n' });
  // The sibling a finding moves to is delivered with this attempt: a split reserves the shared batch.
  const split = ok(wf(p.root, ['split', '--items', 'C2', '--reason', 'scenario: the old.txt work goes to a sibling', '--attempt', e.id, '--json'])).json();
  return { ...p, id: e.id, sibling: split.siblings[0] };
}
function review(p, findings) {
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r1', { findings })), '--attempt', p.id]));
}
const observation = { id: 'F1', severity: 'minor', summary: 'old.txt has no empty state', status: 'open', evidence: 'src/old.txt:2' };
const caused = { id: 'F2', severity: 'major', summary: 'the new label is empty', status: 'open', criterion: 'C1', evidence: 'src/a.txt:1' };

test('an observation moves to a sibling attempt without a question; the move is recorded and the finding stops waiting', () => {
  const p = project('sd-move');
  review(p, [observation]);
  const move = (extra = {}) => wf(p.root, ['scope', 'move', '--finding', extra.finding ?? 'r1:F1', '--sibling', extra.to ?? p.sibling, '--reason', 'belongs with the old.txt work', '--attempt', p.id]);
  assert.match(move({ to: p.id }).err, /cannot move to its own attempt/);
  assert.match(move({ to: 'NOPE-9.1' }).err, /no attempt NOPE-9\.1/);
  assert.match(move({ finding: 'r1:F9' }).err, /r1:F9 is not an open review finding of SC-1\.1 \(open: r1:F1\)/);
  assert.equal(observations(loadState(p.root, p.id)).length, 1);
  const moved = ok(move());
  assert.match(moved.out, new RegExp(`r1:F1 moved to ${p.sibling.replace('.', '\\.')}`));
  const s = state(p.root, p.id);
  assert.deepEqual(s.scopeDecisions.map((d) => [d.choice, d.keys, d.sibling, d.blocked]), [['moved', ['r1:F1'], p.sibling, false]]);
  assert.deepEqual(observations(loadState(p.root, p.id)), []);
  assert.match(ok(wf(p.root, ['scope', 'list', '--attempt', p.id])).out, new RegExp(`r1:F1 {2}observation {2}low {2}moved -> ${p.sibling.replace('.', '\\.')}`));
  assert.match(move().err, /already went elsewhere/);
});

test('a closed sibling cannot take a finding: it would be dropped', () => {
  const p = project('sd-closed');
  review(p, [observation]);
  ok(wf(p.root, ['abandon', '--reason', 'scenario: the sibling is gone', '--attempt', p.sibling]));
  assert.match(wf(p.root, ['scope', 'move', '--finding', 'r1:F1', '--sibling', p.sibling, '--attempt', p.id]).err, /is abandoned; the finding would be dropped/);
});

// Refusal audit of 0.7.0: a move within the batch asked the person although nothing left the delivery, while `wf split`
// refused the same finding. Now one rule: a defect on a line this attempt wrote is fixed here (a sibling starts from the
// base and has no such line); leaving the delivery instead (a ticket) is the person's decision for a high one (D10).
test('a defect on a line the change wrote is fixed here: it never moves to a sibling; ticketing it is the person\'s decision, which then releases the gate', async () => {
  const p = project('sd-approve');
  review(p, [observation, caused]);
  assert.deepEqual(blockingFindings(loadState(p.root, p.id)).map((f) => f.id), ['F2']);
  assert.match(wf(p.root, ['gate', '--attempt', p.id]).err, /has open findings \(F2\)/);
  const moved = wf(p.root, ['scope', 'move', '--finding', 'r1:F2', '--sibling', p.sibling, '--attempt', p.id], { ownerSilent: true });
  assert.equal(moved.code, 75);
  assert.match(moved.err, /r1:F2 is on a line this attempt changed: its fix lives in this attempt's branch/);
  const capture = path.join(p.base, 'ticket.json');
  fs.writeFileSync(capture, JSON.stringify({ issue: { identifier: 'ENG-9', title: 'label', url: 'https://tracker.example.test/ENG-9' } }));
  const ticket = () => wf(p.root, ['scope', 'ticket', '--finding', 'r1:F2', '--capture', capture, '--attempt', p.id], { ownerSilent: true });
  assert.match(ticket().err, /ticketing r1:F2 is the owner's decision \(A1: ticket instead of fixing in this delivery: r1:F2 \(major: the new label is empty\)\)/);
  assert.deepEqual(state(p.root, p.id).decisions.filter((d) => d.kind === 'move-out-of-batch').map((d) => d.key), ['ticket:r1:F2']);
  const { approveInTerminal } = await import('../engine/approve.mjs');
  await inProcess(p.root, async () => {
    const t = terminal();
    const pending = approveInTerminal(p.root, 'A1', { attempt: p.id }, { ...t, env: {} });
    setImmediate(() => t.input.write('yes\n'));
    assert.equal((await pending).choice, 'yes');
  });
  ok(ticket());
  const d = state(p.root, p.id).scopeDecisions.at(-1);
  assert.deepEqual([d.choice, d.keys, d.blocked, d.decision], ['ticketed', ['r1:F2'], true, 'A1']);
  assert.ok(state(p.root, p.id).decisions[0].spent, 'the approval is spent by the ticket');
  assert.deepEqual(blockingFindings(loadState(p.root, p.id)), [], 'the ticketed defect no longer holds this attempt');
  ok(wf(p.root, ['gate', '--attempt', p.id]));
});

test('the owner-question flow is gone: wf scope ask and decide are not commands', () => {
  const p = project('sd-gone');
  review(p, [observation]);
  for (const sub of ['ask', 'decide']) assert.match(wf(p.root, ['scope', sub, '--attempt', p.id]).err, /usage: wf scope list\|ticket\|move\|fixed/);
});

test('a finding never moves to an attempt outside the delivery batch: it would not ship with the change', () => {
  const p = project('sd-outside');
  review(p, [observation]);
  const other = ok(wf(p.root, ['entry', '--item', 'SC-3', '--owner', 'o', '--json'])).json();
  const r = wf(p.root, ['scope', 'move', '--finding', 'r1:F1', '--sibling', other.id, '--attempt', p.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /is not in SC-1\.1's delivery batch/);
});
