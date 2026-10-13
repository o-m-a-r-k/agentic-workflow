import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { closureFile, commitIn, goodClosure, ok, OUT_OF_ORDER, sh } from './helpers.mjs';
import { C, W, inProcess, project, runner, started } from './strategist-fixtures.mjs';

// 0.7.0 (D1), named failure: a ticket that had outgrown itself could not be contracted. Agents proposed splitting it three
// times and the proposals were lost: "split" was neither a command nor a record, so the choices were to keep growing one
// attempt or abandon it. Placement is not obligation: `wf split` moves unstarted work into sibling attempts of the same
// delivery batch, and the parent cannot deliver without them.

const v7 = runner('0.7.0');
const C3 = [...C, { id: 'C3', text: 'c changes', uat: 'c shows the new text' }];
const W3 = [...W, { id: 'W3', criteria: ['C3'], repos: ['app'], class: 'full', why: 'third' }];

// Code review, one gate, evidence review, accept: the order of work, on an attempt that already has its change.
function accept(ctx, a, criteria, tag) {
  const closure = (reviewer) => goodClosure(reviewer, { criteria: criteria.map((id) => ({ id, evidence: { kind: 'output', ref: 'log line 1' } })) });
  ok(v7.run(ctx.root, ['handoff', 'reviewer', '--agent', `rev-${tag}0`, '--attempt', a.id, '--owner', a.owner]));
  ok(v7.run(ctx.root, ['review', '--closure', closureFile(ctx.base, closure(`rev-${tag}0`)), '--attempt', a.id]));
  ok(v7.run(ctx.root, ['gate', '--attempt', a.id]));
  ok(v7.run(ctx.root, ['handoff', 'reviewer', '--agent', `rev-${tag}1`, '--attempt', a.id, '--owner', a.owner]));
  ok(v7.run(ctx.root, ['review', '--closure', closureFile(ctx.base, closure(`rev-${tag}1`)), '--attempt', a.id]));
  ok(v7.run(ctx.root, ['accept', '--attempt', a.id, '--owner', a.owner]));
}

test('wf split: a sibling in the same batch carries the moved work; the batch is assembled and delivered once every member is accepted', async () => {
  const ctx = project('splitflow', {}, { 'src/b.txt': 'b\n' });
  const { root, base, remote } = ctx;
  const a = started(v7, ctx, { item: 'ENG-800', work: W });
  const r = ok(v7.run(root, ['split', '--items', 'W2', '--reason', 'the second module is independent of the first', '--attempt', a.id, '--json'])).json();
  assert.equal(r.split, 'SPLIT-1');
  assert.equal(r.batch, 'BATCH-ENG-800.1');
  assert.deepEqual(r.siblings, ['ENG-800.2']);
  assert.deepEqual(r.moved, { work: ['W2'], criteria: ['C2'], findings: [], discovered: [] });
  // What moved is recorded on both sides: the parent's ledger and the sibling's.
  const { readLedger } = await import('../engine/ledger.mjs');
  await inProcess(root, () => {
    const parent = readLedger(root, a.id).filter((e) => ['split.performed', 'batch.joined'].includes(e.type));
    assert.deepEqual(parent.map((e) => e.type), ['batch.joined', 'split.performed']);
    assert.deepEqual(parent[1].data.moved, { work: ['W2'], criteria: ['C2'], findings: [], discovered: [] });
    assert.equal(parent[1].data.reason, 'the second module is independent of the first');
    const sibling = readLedger(root, 'ENG-800.2').map((e) => e.type);
    assert.deepEqual(sibling.filter((t) => ['split.created', 'criteria.frozen', 'batch.joined'].includes(t)), ['split.created', 'criteria.frozen', 'batch.joined']);
  });
  assert.match(v7.state(root, a.id).decision.guidance, /./);
  // Both work on the same base in their own worktrees; each changes its own file.
  const sib = { id: 'ENG-800.2', wt: path.join(root, '.wf-worktrees', 'ENG-800.2', 'app'), owner: a.owner };
  ok(v7.run(root, ['handoff', 'implementer', '--agent', 'impl-sib', '--work', 'W2', '--attempt', sib.id, '--owner', a.owner]));
  commitIn(sib.wt, { 'src/b.txt': 'sibling\n' });
  accept(ctx, sib, ['C2'], 's');
  commitIn(a.wt, { 'src/a.txt': 'parent\n' });
  accept(ctx, a, ['C1'], 'p');
  // The parent is accepted but cannot deliver alone, and its next step says what assembles the batch.
  const alone = v7.run(root, ['deliver', '--attempt', a.id]);
  assert.equal(alone.code, 75);
  assert.match(alone.err, /is a member of BATCH-ENG-800\.1; deliver the batch instead/);
  assert.match(v7.state(root, a.id).next, /BATCH-ENG-800\.1 \(reserved by a split\) waits for the other members to be accepted, then `wf batch create --members/);
  // The batch reuses the reserved id and merges both branches.
  const b = ok(v7.run(root, ['batch', 'create', '--members', `${a.id},${sib.id}`, '--owner', a.owner, '--json'])).json();
  assert.equal(b.id, 'BATCH-ENG-800.1');
  assert.equal(v7.state(root, a.id).batchPending, false);
  assert.equal(v7.state(root, a.id).batchOf, b.id);
  ok(v7.run(root, ['gate', ...OUT_OF_ORDER, '--attempt', b.id]));
  ok(v7.run(root, ['handoff', 'reviewer', '--agent', 'rev-batch', '--attempt', b.id]));
  ok(v7.run(root, ['review', '--closure', closureFile(base, { reviewer: 'rev-batch', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [] }), '--attempt', b.id]));
  ok(v7.run(root, ['accept', '--attempt', b.id]));
  ok(v7.run(root, ['deliver', '--attempt', b.id]));
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'parent');
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/b.txt`), 'sibling');
  for (const id of [a.id, sib.id]) assert.equal(v7.state(root, id).phase, 'done');
});

test('wf split: every sibling of a split is a member of the one batch; a member left out is named; leaving a batch that was never assembled is the owner\'s decision', async () => {
  const ctx = project('splittwo');
  const { root } = ctx;
  const a = started(v7, ctx, { item: 'ENG-810', work: W3, criteria: C3 });
  const one = ok(v7.run(root, ['split', '--items', 'W2', '--reason', 'second module', '--attempt', a.id, '--json'])).json();
  const two = ok(v7.run(root, ['split', '--items', 'W3', '--reason', 'third module', '--attempt', a.id, '--json'])).json();
  assert.equal(two.split, 'SPLIT-2');
  assert.equal(two.batch, one.batch, 'a second split joins the batch the first one reserved');
  assert.deepEqual([one.siblings[0], two.siblings[0]], ['ENG-810.2', 'ENG-810.3']);
  const parent = v7.state(root, a.id);
  assert.deepEqual(parent.work.map((w) => w.id), ['W1']);
  assert.deepEqual(parent.criteria.map((c) => c.id), ['C1']);
  assert.equal(v7.state(root, 'ENG-810.3').batchOf, one.batch);
  // The batch must name them all; the check comes before anything is assembled.
  const missing = v7.run(root, ['batch', 'create', '--members', `${a.id},ENG-810.2`, '--owner', a.owner]);
  assert.equal(missing.code, 75);
  assert.match(missing.err, /BATCH-ENG-810\.1 also waits for ENG-810\.3: the members of a split are delivered together/);
  assert.match(missing.err, /wf batch create --members ENG-810\.1,ENG-810\.2,ENG-810\.3/);
  const wrongId = v7.run(root, ['batch', 'create', '--members', `${a.id},ENG-810.2,ENG-810.3`, '--id', 'BATCH-7', '--owner', a.owner]);
  assert.match(wrongId.err, /BATCH-ENG-810\.1 was reserved for these members by a split; use that id/);
  // A sibling leaves the reserved batch only on the owner's approval: placement is not obligation (D1).
  const leave = v7.run(root, ['batch', 'eject', '--batch', one.batch, '--member', 'ENG-810.3'], { ownerSilent: true });
  assert.equal(leave.code, 75);
  assert.match(leave.err, /ejecting ENG-810\.3 from BATCH-ENG-810\.1 is the owner's decision \(A1: ENG-810\.3 leaves BATCH-ENG-810\.1/);
  assert.equal(v7.state(root, 'ENG-810.3').batchOf, one.batch, 'nothing changed');
  const { approveInTerminal } = await import('../engine/approve.mjs');
  await inProcess(root, async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const pending = approveInTerminal(root, 'A1', { attempt: 'ENG-810.3' }, { input, output, env: {} });
    setImmediate(() => input.write('yes\n'));
    await pending;
  });
  ok(v7.run(root, ['batch', 'eject', '--batch', one.batch, '--member', 'ENG-810.3']));
  assert.equal(v7.state(root, 'ENG-810.3').batchOf, null);
  assert.equal(v7.run(root, ['batch', 'eject', '--batch', one.batch, '--member', 'ENG-810.3']).code, 75, 'not waiting for it any more');
});

test('wf split: a discovered issue moves as a criterion of the sibling, and leaves the parent open set', () => {
  const ctx = project('splitdisc');
  const { root } = ctx;
  const a = started(v7, ctx, { item: 'ENG-820', work: W });
  ok(v7.run(root, ['discovered', 'add', '--summary', 'the legacy exporter repeats the same rounding', '--where', 'src/a.txt:3', '--found-by', 'impl-x', '--attempt', a.id]));
  assert.equal(v7.state(root, a.id).discovered.length, 1);
  // A split needs a reason, and an item that exists.
  assert.match(v7.run(root, ['split', '--items', 'D1', '--attempt', a.id]).err, /--reason says why the work is split/);
  const r = ok(v7.run(root, ['split', '--items', 'D1,W2', '--reason', 'the exporter is not part of this change', '--attempt', a.id, '--json'])).json();
  assert.deepEqual(r.moved, { work: ['W2'], criteria: ['C2'], findings: [], discovered: ['D1'] });
  const parent = v7.state(root, a.id);
  assert.deepEqual(parent.discovered, [], 'the parent no longer owes it');
  const sib = v7.state(root, r.siblings[0]);
  assert.deepEqual(sib.criteria.map((c) => c.id), ['C2', 'O1']);
  assert.match(sib.criteria[1].text, /Resolve ENG-820\.1:D1: the legacy exporter repeats the same rounding \(src\/a\.txt:3\)/);
  assert.deepEqual(sib.work.map((w) => w.id), ['W2', 'W3'], 'the moved issue has a work item of its own beside W2');
  assert.deepEqual(sib.work[1].criteria, ['O1']);
});
