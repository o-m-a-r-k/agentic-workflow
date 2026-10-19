// Stream 5: 0.7 ledgers on the 0.8 row. The first terminal event is the end, a batch rolls up into its members, the
// fixture's EXPECTED roll-up holds, and the rows stay in the person's user folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeProject, writeLegacyLedgers, withDoubles, STORY, EXPECTED } from './helpers/index.mjs';
import { row, append, commandHandler } from '../engine/contract.mjs';
import { legacyRollup } from '../engine/legacy07.mjs';

function withUserDir(p, t) {
  const saved = process.env.WF_USER_DIR;
  process.env.WF_USER_DIR = p.env.WF_USER_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.WF_USER_DIR; else process.env.WF_USER_DIR = saved;
  });
}
const noAdapter = { loadAdapter: async () => { throw new Error('schema 1 adapter'); }, sessionActivity: async () => null };

test('legacy07: the fixture roll-up matches EXPECTED', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  withUserDir(p, t);
  writeLegacyLedgers(p.root);
  await withDoubles(noAdapter, async () => {
    const roll = await legacyRollup(p.root);
    assert.deepEqual(roll.tickets, EXPECTED.tickets);
    assert.deepEqual(roll.terminal, EXPECTED.terminal);
    assert.deepEqual(roll.deliveredVia, EXPECTED.deliveredVia);
    assert.deepEqual(roll.open, EXPECTED.open);
    assert.deepEqual(roll.held, EXPECTED.held);
    assert.deepEqual(roll.batches, ['BATCH-1']);
    for (const r of roll.rows) {
      assert.equal(r.wallMin, EXPECTED.wallMin[r.attempt]);
      assert.equal(r.reviews, EXPECTED.reviews[r.attempt]);
      assert.equal(r.blockingReviews, EXPECTED.blockingReviews[r.attempt]);
    }
    // The batch's gate and wait count in both members; the batch itself is no ticket.
    const one = await row(p.root, 'TK-1.1');
    assert.equal(one.schema, 'wf-ticket@1');
    assert.equal(one.outcome, 'shipped');
    assert.equal(one.engine, '0.7.35');
    assert.deepEqual(one.testRuns, { fast: 0, full: 1 });
    assert.equal(one.testMin, 75);
    assert.deepEqual(one.landing, { batches: 1, bisects: 0 });
    assert.deepEqual(one.stageWaitMin, { land: 90 });
    assert.equal(one.fixRounds, 1);
    assert.equal(one.emptyReviews, 1);
    for (const k of ['findings', 'refusals', 'screens', 'riskTouched', 'rework', 'diff']) assert.equal(one[k], null, `${k} was not recorded by 0.7`);
    assert.deepEqual((await row(p.root, 'TK-2.1')).testRuns, { fast: 0, full: 1 });
    await assert.rejects(row(p.root, 'BATCH-1'), /0\.7 batch, not a ticket/);
  });
});

test('legacy07: events after the first terminal event are not the ticket\'s', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  withUserDir(p, t);
  const story = { 'TK-1.1': [...STORY['TK-1.1'], ['2026-01-05T15:00:00.000Z', 'review.recorded', { tree: 'x', closure: { verdict: 'changes', findings: [{ id: 'F9', status: 'open' }] } }], ['2026-01-05T16:00:00.000Z', 'closed', { reason: 'again' }]], 'BATCH-1': STORY['BATCH-1'] };
  writeLegacyLedgers(p.root, story);
  await withDoubles(noAdapter, async () => {
    const r = await row(p.root, 'TK-1.1');
    assert.equal(r.end, EXPECTED.terminal['TK-1.1']);
    assert.equal(r.wallMin, 215);
    assert.equal(r.reviews, 2);
  });
});

test('wf report over 0.7 and 0.8 tickets: one group per engine version, rows only in the user folder', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  withUserDir(p, t);
  writeLegacyLedgers(p.root);
  await withDoubles({ ...noAdapter, changedFiles: async () => { throw new Error('no git'); } }, async () => {
    await append(p.root, 'TK-8.1', 'attempt.started', { item: 'TK-8', n: 1, repos: {}, stages: [], adapter: 'h', engine: '0.8.0' }, null);
    await append(p.root, 'TK-8.1', 'attempt.closed', { outcome: 'abandoned', reason: 'not needed' }, null);
    const out = await commandHandler('report')({ cwd: p.root, root: p.root, env: {}, actor: null, json: false }, { _: [], flags: {} });
    assert.deepEqual(out.data.groups.map((g) => [g.engine, g.n]), [['0.7', 2], ['0.8', 1]]);
    assert.equal(out.data.uncovered, null);
    const project = path.basename(p.root);
    const file = path.join(p.env.WF_USER_DIR, 'telemetry', `${project}.jsonl`);
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3);
    assert.ok(!fs.existsSync(path.join(p.root, '.workflow')), 'nothing written into the project');
  });
});
