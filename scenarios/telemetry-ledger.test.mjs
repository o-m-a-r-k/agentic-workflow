// Stream 5: the schema 2 ledger. Appends are checked against the event catalogue and hash-chained; a 0.7 ledger stays
// readable and takes migration's attempt.closed; attemptState folds both schemas.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeProject, writeLegacyLedgers, ledgerLines, EXPECTED } from './helpers/index.mjs';
import { append, readEvents, attemptState, listAttempts, ledgerFile, EVENTS } from '../engine/contract.mjs';
import { append as ledgerAppend } from '../engine/ledger.mjs';

const actor = { runtime: 'claude', id: 's-owner' };
const started = (item, n) => ({ item, n, repos: { server: { branch: `wf/${item}.${n}`, base: 'trunk', baseSha: 'a'.repeat(40), worktree: '/x' } }, stages: [{ do: 'land' }], adapter: 'h', engine: '0.8.0' });

test('append: catalogue, required fields, first event, chain', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  await assert.rejects(append(p.root, 'TK-1.1', 'review.recorded', {}, actor), /missing required field/);
  await assert.rejects(append(p.root, 'TK-1.1', 'gate.finished', {}, actor), /unknown ledger event `gate.finished`/);
  await assert.rejects(append(p.root, 'TK-1.1', 'hold', { reason: 'r', quote: 'q' }, actor), /first event must be attempt.started/);
  await assert.rejects(append(p.root, '../x', 'attempt.started', started('TK-1', 1), actor), /not an attempt id/);
  const first = await append(p.root, 'TK-1.1', 'attempt.started', started('TK-1', 1), actor);
  assert.equal(first.schema, 2);
  assert.equal(first.prev, null);
  await assert.rejects(append(p.root, 'TK-1.1', 'attempt.started', started('TK-1', 1), actor), /already started/);
  const second = await append(p.root, 'TK-1.1', 'hold', { reason: 'wait', quote: 'hold it' }, actor);
  assert.equal(second.prev, first.hash);
  assert.equal(second.seq, 2);
  assert.equal(Object.keys(EVENTS).length, 15);
  const lines = ledgerLines(p.root, 'TK-1.1');
  assert.deepEqual(lines.map((l) => l.type), ['attempt.started', 'hold']);
  await append(p.root, 'TK-1.1', 'attempt.closed', { outcome: 'abandoned', reason: 'x' }, actor);
  await assert.rejects(append(p.root, 'TK-1.1', 'attempt.closed', { outcome: 'abandoned', reason: 'x' }, actor), /already closed/);
  // L3: nothing follows the close, whatever the event.
  for (const [type, data] of [['hold', { reason: 'late', quote: 'late' }], ['stage', { index: 0, do: 'land', state: 'done' }], ['decision.answered', { id: 'D1', choice: 'x', quote: 'x', via: 'turn', session: null }]]) {
    await assert.rejects(append(p.root, 'TK-1.1', type, data, actor), new RegExp(`TK-1.1 is already closed \\(abandoned at .+\\); its ledger takes no ${type.replace('.', '\\.')} after attempt.closed`));
  }
  assert.deepEqual(ledgerLines(p.root, 'TK-1.1').map((l) => l.type), ['attempt.started', 'hold', 'attempt.closed']);
});

test('readEvents: a hand edit breaks the chain; unknown attempts are named', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  await append(p.root, 'TK-2.1', 'attempt.started', started('TK-2', 1), actor);
  await append(p.root, 'TK-2.1', 'hold', { reason: 'a', quote: 'b' }, actor);
  assert.equal((await readEvents(p.root, 'TK-2.1')).length, 2);
  const file = ledgerFile(p.root, 'TK-2.1');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"reason":"a"', '"reason":"z"'));
  await assert.rejects(readEvents(p.root, 'TK-2.1'), /hash chain broken at entry 2/);
  await assert.rejects(readEvents(p.root, 'TK-9.1'), /unknown attempt TK-9.1/);
});

test('WF_DOUBLES outside a test is refused by the ledger', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const saved = { d: process.env.WF_DOUBLES, t: process.env.WF_TEST };
  process.env.WF_DOUBLES = '/nonexistent.mjs';
  delete process.env.WF_TEST;
  try {
    await assert.rejects(ledgerAppend(p.root, 'TK-3.1', 'attempt.started', started('TK-3', 1), actor), /WF_TEST=1 is not set/);
  } finally {
    if (saved.d === undefined) delete process.env.WF_DOUBLES; else process.env.WF_DOUBLES = saved.d;
    if (saved.t !== undefined) process.env.WF_TEST = saved.t;
  }
});

test('0.7 ledgers stay readable, list in number order, fold, and take migration\'s attempt.closed', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  writeLegacyLedgers(p.root);
  await append(p.root, 'TK-1.2', 'attempt.started', started('TK-1', 2), actor);
  await append(p.root, 'TK-1.10', 'attempt.started', started('TK-1', 10), actor);
  assert.deepEqual(await listAttempts(p.root, { item: 'TK-1' }), ['TK-1.1', 'TK-1.2', 'TK-1.10']);
  assert.deepEqual(await listAttempts(p.root), ['BATCH-1', 'TK-1.1', 'TK-1.2', 'TK-1.10', 'TK-2.1', 'TK-4.1', 'TK-5.1']);
  assert.equal((await readEvents(p.root, 'TK-1.1')).length, 9);
  const s1 = await attemptState(p.root, 'TK-1.1');
  assert.deepEqual({ schema: s1.schema, open: s1.open, outcome: s1.outcome, item: s1.item }, { schema: 1, open: false, outcome: 'shipped', item: 'TK-1' });
  for (const id of EXPECTED.open) assert.equal((await attemptState(p.root, id)).open, true);
  assert.equal((await attemptState(p.root, 'TK-4.1')).hold.reason, 'stop everything');
  await append(p.root, 'TK-5.1', 'attempt.closed', { outcome: 'superseded', reason: 'migrated to 0.8' }, actor);
  const s5 = await attemptState(p.root, 'TK-5.1');
  assert.deepEqual({ open: s5.open, outcome: s5.outcome, schema: s5.schema }, { open: false, outcome: 'superseded', schema: 1 });
  assert.equal((await readEvents(p.root, 'TK-5.1')).length, 3);
});

test('attemptState: the schema 2 fold', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const id = 'TK-7.1';
  const a = (type, data) => append(p.root, id, type, data, actor);
  await a('attempt.started', started('TK-7', 1));
  await a('criteria.set', { criteria: [{ id: 'C1', text: 'one' }], areas: ['server'], hash: 'h1', previous: null });
  await a('test.run', { repo: 'server', kind: 'fast', tree: 't1', pass: true, exitCode: 0, ms: 1000, source: 'attempt' });
  await a('handoff', { role: 'reviewer', session: { runtime: 'claude', id: 'r1' }, launchedBy: 'wf' });
  await a('review.recorded', { review: 1, round: 1, seat: 'whole', tree: 't1', session: { runtime: 'claude', id: 'r1' }, coverage: 'complete', findings: [{ id: 'F1', location: 'server/src/core/sum.mjs:1', class: 'goal', severity: 'low', what: 'w', why: 'y' }, { id: 'F2', location: 'server/README.md:1', class: 'other', severity: 'low', what: 'w', why: 'y' }], verified: [], blockers: 1 });
  await a('finding.filed', { finding: 'F2', mode: 'file', state: 'done', marker: 'wf:TK-7.1:finding:F2', ticket: 'TK-99' });
  await a('review.recorded', { review: 2, round: 2, seat: 'whole', tree: 't2', session: { runtime: 'claude', id: 'r2' }, coverage: 'complete', findings: [], verified: [{ id: 'F1', status: 'fixed' }], blockers: 0 });
  await a('review.recorded', { review: 3, round: 3, seat: 'whole', tree: 't3', session: { runtime: 'claude', id: 'r3' }, coverage: 'complete', findings: [], verified: [{ id: 'F1', status: 'open' }], blockers: 1 });
  await a('decision.asked', { id: 'D1', kind: 'no-progress', question: 'Go on?', options: ['continue', 'stop'], refs: ['F1'], blocking: true });
  await a('decision.answered', { id: 'D1', choice: 'continue', quote: 'continue', via: 'turn', session: { runtime: 'claude', id: 'o' } });
  await a('hold', { reason: 'wait', quote: 'hold' });
  await a('release', { decision: 'D2' });
  await a('stage', { index: 0, do: 'land', state: 'waiting' });
  await a('landing', { batch: 'L1', repo: 'server', attempts: [id], result: 'landed', sha: 'b'.repeat(40) });
  await a('stage', { index: 0, do: 'land', state: 'done' });
  await a('attempt.closed', { outcome: 'shipped', reason: 'landed', outsideStages: true });
  const s = await attemptState(p.root, id);
  assert.equal(s.outsideStages, true, 'a close by patch-id with the stages not done is recorded (D16)');
  assert.equal(s.schema, 2);
  assert.equal(s.owner.id, 's-owner');
  assert.equal(s.criteria.hash, 'h1');
  assert.equal(s.tests.length, 1);
  assert.equal(s.findings.F1.status, 'reopened');
  assert.deepEqual(s.findings.F1.history.map((h) => h.status), ['open', 'fixed', 'reopened']);
  assert.equal(s.findings.F2.status, 'filed');
  assert.equal(s.decisions.D1.answer.choice, 'continue');
  assert.equal(s.hold, null);
  assert.equal(s.stageResults[0].state, 'done');
  assert.equal(s.landings.length, 1);
  assert.deepEqual({ open: s.open, outcome: s.outcome }, { open: false, outcome: 'shipped' });
});
