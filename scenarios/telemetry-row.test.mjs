// Stream 5: the wf-ticket@1 row of a 0.8 attempt, rebuilt from a ledger, real git history and a transcript double;
// blameToAttempt; and `wf report` (medians, uncovered commits, an edited ledger).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeProject, git, withDoubles } from './helpers/index.mjs';
import { append, row, blameToAttempt, recordRefusal, commandHandler, ledgerFile } from '../engine/contract.mjs';
import { setClock } from '../engine/ledger.mjs';
import { normalisedAdapter, commitAt, futureStart, at, wt } from './telemetry-support.mjs';

const owner = { runtime: 'claude', id: 'owner-1' };
const S = (id) => ({ runtime: 'claude', id });

// One attempt from start to a landed delivery, then another person's commit that rewrites one delivered line.
async function story(p) {
  const T0 = futureStart();
  let now = T0;
  setClock(() => new Date(now));
  const when = (min) => {
    now = T0 + min * 60000;
  };
  const id = 'TK-1.1';
  const server = p.repos.server.dir;
  const tree = wt(p, id, 'server');
  const baseSha = p.head('server');
  git(server, ['worktree', 'add', '-q', '-b', `wf/${id}`, tree, 'trunk']);
  const a = (min, type, data, actor = owner) => {
    when(min);
    return append(p.root, id, type, data, actor);
  };
  await a(0, 'attempt.started', { item: 'TK-1', n: 1, repos: { server: { branch: `wf/${id}`, base: 'trunk', baseSha, worktree: tree } }, stages: [{ do: 'land' }], adapter: 'h', engine: '0.8.0' });
  await a(5, 'criteria.set', { criteria: [{ id: 'C1', text: 'sums start at one' }], areas: ['server'], hash: 'h1', previous: null });
  await a(10, 'handoff', { role: 'implementer', session: S('impl-1'), launchedBy: 'owner' });
  commitAt(tree, { 'src/core/sum.mjs': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 1);\nexport const a = 1;\nexport const b = 1;\n', 'test/sum2.spec.mjs': '// one\n// two\n' }, 'c1', at(T0, 20));
  await a(40, 'test.run', { repo: 'server', kind: 'fast', tree: 't1', pass: true, exitCode: 0, ms: 5 * 60000, source: 'attempt' });
  await a(45, 'handoff', { role: 'reviewer', session: S('r1'), launchedBy: 'wf' });
  await a(60, 'review.recorded', { review: 1, round: 1, seat: 'whole', tree: 't1', session: S('r1'), coverage: 'complete', findings: [{ id: 'F1', location: 'server/src/core/sum.mjs:1', class: 'goal', severity: 'medium', what: 'w', why: 'y' }], verified: [], blockers: 1 });
  commitAt(tree, { 'src/core/sum.mjs': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 1);\nexport const a = 2;\nexport const b = 1;\n' }, 'fix1', at(T0, 68));
  await a(70, 'handoff', { role: 'implementer', session: S('impl-2'), launchedBy: 'owner' });
  await a(80, 'handoff', { role: 'reviewer', session: S('r2'), launchedBy: 'wf' });
  // Someone else moves the base; the attempt merges it in (git's automatic merge).
  const other = path.join(p.tmp, 'other');
  git(p.tmp, ['clone', '--quiet', '--branch', 'trunk', p.repos.server.origin, other]);
  const e1 = commitAt(other, { 'README.md': '# server\nmore\n' }, 'elsewhere one', at(T0, 85));
  git(other, ['push', '--quiet', 'origin', 'HEAD:trunk']);
  git(tree, ['fetch', '--quiet', 'origin']);
  git(tree, ['merge', '--quiet', '--no-edit', 'origin/trunk'], { env: { GIT_AUTHOR_DATE: at(T0, 86), GIT_COMMITTER_DATE: at(T0, 86) } });
  await a(86, 'base.updated', { repo: 'server', from: baseSha, to: e1, merge: git(tree, ['rev-parse', 'HEAD']) });
  await a(90, 'review.recorded', { review: 2, round: 2, seat: 'whole', tree: 't2', session: S('r2'), coverage: 'complete', findings: [{ id: 'F2', location: 'server/src/core/sum.mjs:2', class: 'regression', severity: 'high', what: 'w', why: 'y' }], verified: [{ id: 'F1', status: 'fixed' }], blockers: 1 });
  commitAt(tree, { 'src/core/sum.mjs': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 1);\nexport const a = 2;\nexport const b = 2;\n' }, 'fix2', at(T0, 93));
  await a(100, 'decision.asked', { id: 'D1', kind: 'diff-read', question: 'Read the diff?', options: ['read', 'not yet'], refs: [], blocking: true });
  await a(160, 'decision.answered', { id: 'D1', choice: 'read', quote: 'read', via: 'turn', session: owner });
  await a(162, 'handoff', { role: 'reviewer', session: S('r3'), launchedBy: 'wf' });
  await a(165, 'review.recorded', { review: 3, round: 3, seat: 'whole', tree: 't3', session: S('r3'), coverage: 'complete', findings: [], verified: [{ id: 'F2', status: 'fixed' }], blockers: 0 });
  await a(258, 'test.run', { repo: 'server', kind: 'full', tree: 't3', pass: true, exitCode: 0, ms: 2 * 60000, source: 'landing', lock: { name: 'fixture-suite', count: 1, waitedMs: 3 * 60000 } });
  await a(260, 'stage', { index: 0, do: 'land', state: 'waiting' });
  git(tree, ['push', '--quiet', 'origin', 'HEAD:trunk']);
  await a(270, 'landing', { batch: 'L1', repo: 'server', attempts: [id], result: 'landed', sha: git(tree, ['rev-parse', 'HEAD']), bisects: 0 });
  await a(272, 'stage', { index: 0, do: 'land', state: 'done', waitedMin: 12 });
  await a(275, 'attempt.closed', { outcome: 'shipped', reason: 'landed' });
  git(other, ['pull', '--quiet', '--ff-only']);
  const e2 = commitAt(other, { 'src/core/sum.mjs': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 1);\nexport const a = 2;\nexport const b = 3;\n' }, 'elsewhere two', at(T0, 300));
  git(other, ['push', '--quiet', 'origin', 'HEAD:trunk']);
  git(server, ['fetch', '--quiet', 'origin']);
  return { T0, id, e1, e2, setNow: (min) => when(min) };
}

const doubles = (p) => ({
  loadAdapter: async () => normalisedAdapter(p),
  changedFiles: async () => ({ tree: 't3', files: [{ repo: 'server', path: 'src/core/sum.mjs', kind: 'product', added: 3, removed: 1, status: 'M' }, { repo: 'server', path: 'test/sum2.spec.mjs', kind: 'tests', added: 2, removed: 0, status: 'A' }] }),
  sessionActivity: async (s) => (s.id === 'owner-1' ? { turns: [{ at: new Date(Date.parse(storyT0) + 200 * 60000).toISOString(), human: true }], tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 }, cost: 0.5, model: 'm' } : null),
});
let storyT0 = null;

function withUserDir(p, t) {
  const saved = process.env.WF_USER_DIR;
  process.env.WF_USER_DIR = p.env.WF_USER_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.WF_USER_DIR; else process.env.WF_USER_DIR = saved;
    setClock(null);
  });
}

test('row: every field of a 0.8 attempt, from the ledger, git and transcripts', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  withUserDir(p, t);
  const s = await story(p);
  storyT0 = new Date(s.T0).toISOString();
  await recordRefusal(p.root, s.id, 'review:coverage');
  await recordRefusal(p.root, s.id, 'review:coverage');
  await recordRefusal(p.root, 'TK-9.1', 'merge:open');
  await withDoubles(doubles(p), async () => {
    s.setNow(275 + 47 * 60);
    const early = await row(p.root, s.id);
    assert.equal(early.rework, null, 'rework waits 48 hours after delivery');
    s.setNow(275 + 49 * 60);
    const r = await row(p.root, s.id);
    assert.equal(r.schema, 'wf-ticket@1');
    assert.deepEqual([r.project, r.item, r.attempt, r.engine, r.outcome], ['sample', 'TK-1', 'TK-1.1', '0.8.0', 'shipped']);
    assert.equal(r.wallMin, 275);
    assert.equal(r.activeMin, 122);
    assert.deepEqual(r.unexplainedGaps.map((g) => g.min), [35, 53]);
    assert.equal(r.personWaitMin, 60);
    assert.equal(r.holdMin, 0);
    assert.deepEqual(r.stageWaitMin, { land: 12, lock: 3 });
    assert.deepEqual([r.reviews, r.blockingReviews, r.emptyReviews, r.fixRounds, r.coverage], [3, 2, 1, 2, 'complete']);
    assert.deepEqual(r.testRuns, { fast: 1, full: 1 });
    assert.equal(r.testMin, 7);
    assert.deepEqual(r.landing, { batches: 1, bisects: 0 });
    assert.deepEqual(r.diff, { product: 4, tests: 2, other: 0 });
    assert.deepEqual(r.findings, { goal: 1, regression: 1, other: 0, filed: 0, digested: 0 });
    assert.equal(r.introducedByRepair, 1, 'F2 sits on a line the first fix round wrote');
    assert.deepEqual(r.refusals, { count: 2, byId: { 'review:coverage': 2 } });
    assert.equal(r.screens, 0);
    assert.equal(r.riskTouched, true);
    assert.deepEqual(r.rework, { lines: 1, share: 0.2, commits: 1 });
    assert.deepEqual(r.tokens, { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 });
    assert.equal(r.cost, 0.5);
  });
});

test('blameToAttempt: own lines, base lines merged in, untouched lines, a line that does not exist', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  withUserDir(p, t);
  const s = await story(p);
  await withDoubles({ loadAdapter: async () => normalisedAdapter(p) }, async () => {
    assert.equal((await blameToAttempt(p.root, s.id, 'server/src/core/sum.mjs:2')).own, true);
    assert.deepEqual(await blameToAttempt(p.root, s.id, 'server/README.md:2'), { own: false, commit: s.e1 });
    assert.equal((await blameToAttempt(p.root, s.id, 'server/README.md:1')).own, false);
    assert.equal((await blameToAttempt(p.root, s.id, 'server/test/sum2.spec.mjs:1')).own, true);
    await assert.rejects(blameToAttempt(p.root, s.id, 'server/src/core/sum.mjs:99'), /cannot blame/);
    await assert.rejects(blameToAttempt(p.root, s.id, 'sum.mjs'), /not a location/);
    // After close the worktree goes; the kept branch still answers.
    git(p.repos.server.dir, ['worktree', 'remove', '--force', wt(p, s.id, 'server')]);
    assert.equal((await blameToAttempt(p.root, s.id, 'server/src/core/sum.mjs:3')).own, true);
  });
});

test('wf report: medians per engine version, commits no attempt covers, an edited ledger', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  withUserDir(p, t);
  const s = await story(p);
  storyT0 = new Date(s.T0).toISOString();
  s.setNow(275 + 49 * 60);
  await withDoubles(doubles(p), async () => {
    const out = await commandHandler('report')({ cwd: p.root, root: p.root, env: {}, actor: null, json: false }, { _: [], flags: {} });
    assert.equal(out.data.groups.length, 1);
    assert.equal(out.data.groups[0].engine, '0.8');
    assert.equal(out.data.groups[0].medians.wallMin, 275);
    assert.deepEqual(out.data.uncovered.map((c) => c.sha), [s.e2, s.e1]);
    assert.match(out.text, /commits on the base that no attempt covers:/);
    const stored = fs.readFileSync(path.join(p.env.WF_USER_DIR, 'telemetry', 'sample.jsonl'), 'utf8').trim().split('\n');
    assert.equal(stored.length, 1);
    assert.equal(JSON.parse(stored[0]).attempt, s.id);
    // A hand edit is reported, not skipped silently.
    const file = ledgerFile(p.root, s.id);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('sums start at one', 'sums start at two'));
    const again = await commandHandler('report')({ cwd: p.root, root: p.root, env: {}, actor: null, json: false }, { _: [], flags: {} });
    assert.equal(again.data.problems.length, 1);
    assert.match(again.text, /hash chain broken/);
  });
});
