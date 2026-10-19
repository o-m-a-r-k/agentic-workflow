// Stream 1: start from a fresh base, id normalisation, numbering, start:open, hold/release, close and abandon.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { git, ledgerLines } from './helpers/index.mjs';
import { answer, attempt, commitWt, setup, started } from './flow-fixture.mjs';
import { attemptState } from '../engine/contract.mjs';

const ctxOf = (p) => ({ cwd: p.root, root: p.root, env: { ...process.env }, actor: { runtime: 'claude', id: 'owner-1' }, json: false });
const args = (_ = [], flags = {}) => ({ _, flags });

test('start: worktrees at the fetched tip of each base, the item normalised, stages snapshotted, take run', async () => {
  const p = setup();
  try {
    const moved = p.pushElsewhere('server', { 'src/late.mjs': 'export const late = 1;\n' }, 'pushed by someone else');
    const s = await attempt.start(p.root, 'tk-1', { actor: { runtime: 'claude', id: 'o' } });
    assert.equal(s.id, 'TK-1.1');
    assert.equal(git(p.wt('TK-1.1', 'server'), ['rev-parse', 'HEAD']), moved, 'the fetched tip, not the stale local checkout');
    assert.equal(git(p.wt('TK-1.1', 'server'), ['rev-parse', '--abbrev-ref', 'HEAD']), 'wf/TK-1.1');
    assert.equal(git(p.wt('TK-1.1', 'client'), ['rev-parse', 'HEAD']), p.head('client'));
    const [started_, take] = ledgerLines(p.root, 'TK-1.1');
    assert.equal(started_.type, 'attempt.started');
    assert.deepEqual(started_.data.stages, [{ do: 'land' }, { do: 'status', to: 'Ready', comment: 'uat' }]);
    assert.equal(started_.data.repos.server.baseSha, moved);
    assert.equal(take.type, 'stage');
    assert.equal(take.data.index, -1);
  } finally {
    p.done();
  }
});

test('start: numbers continue after old ledgers and wf/<item>.<n> branches; an open or held attempt refuses start:open', async () => {
  const p = setup();
  try {
    git(p.repos.client.dir, ['branch', 'wf/TK-2.3']);
    const a = await attempt.start(p.root, 'TK-2', { actor: null });
    assert.equal(a.id, 'TK-2.4');
    await assert.rejects(attempt.start(p.root, 'TK-2', { actor: null }), (e) => e.refusalId === 'start:open' && e.code === 75 && /TK-2\.4/.test(e.message));
    await attempt.cmdHold(ctxOf(p), args([], { attempt: 'TK-2.4', reason: 'stop everything' }));
    await assert.rejects(attempt.start(p.root, 'TK-2', { actor: null }), (e) => e.refusalId === 'start:open' && /held/.test(e.message));
    // Only the person lifts it: release asks, and lifts once the answer is there.
    const r1 = await attempt.cmdRelease(ctxOf(p), args([], { attempt: 'TK-2.4' }));
    assert.equal(r1.data.released, false);
    answer(p.root, 'TK-2.4', r1.data.decision, 'lift the hold');
    const r2 = await attempt.cmdRelease(ctxOf(p), args([], { attempt: 'TK-2.4' }));
    assert.equal(r2.data.released, true);
    await attempt.cmdAbandon(ctxOf(p), args([], { attempt: 'TK-2.4', reason: 'restart' }));
    assert.equal(fs.existsSync(p.wt('TK-2.4', 'server')), false, 'worktrees removed');
    assert.ok(git(p.repos.server.dir, ['branch', '--list', 'wf/TK-2.4']), 'branch kept');
    const b = await attempt.start(p.root, 'TK-2', { actor: null });
    assert.equal(b.id, 'TK-2.5');
    assert.equal(ledgerLines(p.root, 'TK-2.5')[0].data.from, 'TK-2.4');
  } finally {
    p.done();
  }
});

test('close: refused under a hold; refused while not shipped; shipped by patch-id once the commits are on the base', async () => {
  const p = setup();
  try {
    const s = await started(p, 'TK-3');
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 0) || 0;\n' }, 'fix sum');
    await attempt.cmdHold(ctxOf(p), args([], { attempt: s.id, reason: 'local only' }));
    await assert.rejects(attempt.cmdClose(ctxOf(p), args([], { attempt: s.id })), (e) => e.refusalId === 'hold');
    await assert.rejects(attempt.cmdAbandon(ctxOf(p), args([], { attempt: s.id, reason: 'x' })), (e) => e.refusalId === 'hold');
    const r = await attempt.cmdRelease(ctxOf(p), args([], { attempt: s.id }));
    answer(p.root, s.id, r.data.decision, 'lift the hold');
    await attempt.cmdRelease(ctxOf(p), args([], { attempt: s.id }));
    await assert.rejects(attempt.cmdClose(ctxOf(p), args([], { attempt: s.id })), /not shipped/);
    // The change reaches the base another way (a cherry-pick): same patch-id.
    git(p.wt(s.id, 'server'), ['push', '--quiet', 'origin', `HEAD:${p.repos.server.base}`]);
    git(p.wt(s.id, 'server'), ['fetch', '--quiet', 'origin']);
    const c = await attempt.cmdClose(ctxOf(p), args([], { attempt: s.id }));
    assert.equal(c.data.outcome, 'shipped');
    assert.equal(c.data.patchIds.length, 1);
    assert.equal((await attemptState(p.root, s.id)).open, false);
    assert.equal(fs.existsSync(p.wt(s.id, 'server')), false);
    assert.match(c.text, /telemetry row written/);
  } finally {
    p.done();
  }
});
