// Stream 5: measured learning (design-0.8 section 8): the band, the minimum move from the spread, one active proposal
// per metric, the adapter budget, judging (kept, reverted, missing data), expiry, the 60-day block, incidents that
// recur, person proposals, one plugin proposal per release, and `wf learn`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeProject, withDoubles } from './helpers/index.mjs';
import { append, propose, judge, commandHandler } from '../engine/contract.mjs';
import { setClock } from '../engine/ledger.mjs';
import { learnedFile } from '../engine/learn.mjs';
import { normalisedAdapter } from './telemetry-support.mjs';

const DAY = 86400000;
const T0 = Date.parse('2026-03-02T09:00:00.000Z');

function setup(t, { rules = 1, limit = 4 } = {}) {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const saved = process.env.WF_USER_DIR;
  process.env.WF_USER_DIR = p.env.WF_USER_DIR;
  let now = T0;
  setClock(() => new Date(now));
  t.after(() => {
    if (saved === undefined) delete process.env.WF_USER_DIR; else process.env.WF_USER_DIR = saved;
    setClock(null);
  });
  let n = 0;
  const ctx = {
    p,
    now: () => now,
    set: (ms) => {
      now = ms;
    },
    // One closed ticket of `wallMin` minutes, started where the clock is; the clock moves on a day.
    async ticket(wallMin) {
      const id = `TK-${++n}.1`;
      const start = now;
      await append(p.root, id, 'attempt.started', { item: `TK-${n}`, n: 1, repos: {}, stages: [], adapter: 'h', engine: '0.8.0' }, null);
      now = start + wallMin * 60000;
      await append(p.root, id, 'attempt.closed', { outcome: 'shipped', reason: 'done' }, null);
      now = start + DAY;
    },
    doubles: {
      loadAdapter: async () => normalisedAdapter(p),
      changedFiles: async () => { throw new Error('no diff'); },
      sessionActivity: async () => null,
      adapterBudget: async () => ({ counts: { rules, risk: 1, modules: 1, operationWords: 0 }, limits: { rules: limit, risk: 3, modules: 2, operationWords: 120 }, over: [] }),
    },
  };
  return ctx;
}
const draft = (over = {}) => ({ source: 'telemetry', scope: 'project', change: 'Reviewers read the invariants first.', replaces: 'the rule on reading order', metric: 'wallMin', guard: 'reviews', expires: '2026-12-31', ...over });
const BASE = [100, 110, 90, 100, 105, 95, 100, 100];

test('drafting: only outside the band; the engine sets the minimum move; one active proposal per metric', async (t) => {
  const c = setup(t);
  await withDoubles(c.doubles, async () => {
    for (const w of BASE) await c.ticket(w);
    await assert.rejects(propose(c.p.root, draft()), /no baseline band yet/);
    await c.ticket(100);
    await assert.rejects(propose(c.p.root, draft()), /inside its band/);
    await c.ticket(200);
    await assert.rejects(propose(c.p.root, draft({ whyNotReplace: 'nothing to replace' })), /whyNotReplace` was removed/);
    await assert.rejects(propose(c.p.root, draft({ replaces: '' })), /`replaces` is required/);
    await assert.rejects(propose(c.p.root, draft({ guard: 'nonsense' })), /`guard` must be a telemetry row field/);
    await assert.rejects(propose(c.p.root, draft({ expires: undefined })), /`expires` must be a date/);
    const p1 = await propose(c.p.root, draft({ minMove: 99 }));
    assert.equal(p1.id, 'P1');
    assert.equal(p1.status, 'active');
    assert.equal(p1.direction, 'down');
    assert.deepEqual(p1.baseline, { median: 100, spread: 2.5, n: 8 });
    assert.equal(p1.minMove, 2.5, 'from the spread, never the drafter');
    assert.match(fs.readFileSync(learnedFile('sample'), 'utf8'), /Reviewers read the invariants first/);
    await assert.rejects(propose(c.p.root, draft({ source: 'person', change: 'Another change.' })), /P1 is already active on wallMin/);
  });
});

test('judging: not before 8 tickets and 21 days; kept, then expired after 90 days and judged again', async (t) => {
  const c = setup(t);
  await withDoubles(c.doubles, async () => {
    for (const w of [...BASE, 100, 200]) await c.ticket(w);
    const p1 = await propose(c.p.root, draft());
    for (let i = 0; i < 7; i++) await c.ticket(90);
    assert.equal((await judge(c.p.root, 'P1')).verdict, 'not-yet');
    await c.ticket(90);
    assert.match((await judge(c.p.root, 'P1', { now: new Date(Date.parse(p1.created) + 10 * DAY).toISOString() })).reason, /8 of 8 tickets and 10 of 21 days/);
    const v = await judge(c.p.root, 'P1', { now: new Date(Date.parse(p1.created) + 22 * DAY).toISOString() });
    assert.equal(v.verdict, 'kept', v.reason);
    assert.match(fs.readFileSync(learnedFile('sample'), 'utf8'), /P1/);
    assert.match((await judge(c.p.root, 'P1', { now: new Date(Date.parse(p1.created) + 60 * DAY).toISOString() })).reason, /kept until/);
    const late = await judge(c.p.root, 'P1', { now: new Date(Date.parse(p1.created) + 22 * DAY + 91 * DAY).toISOString() });
    assert.equal(late.verdict, 'not-yet', 'expired: judged again on tickets after its expiry');
    await assert.rejects(propose(c.p.root, draft({ source: 'person', change: 'Something else.' })), /already active on wallMin/);
  });
});

test('judging: the metric must move by the minimum; missing data reverts; reverted is blocked 60 days', async (t) => {
  const c = setup(t);
  await withDoubles(c.doubles, async () => {
    for (const w of [...BASE, 100, 200]) await c.ticket(w);
    await propose(c.p.root, draft());
    for (let i = 0; i < 8; i++) await c.ticket(99);
    const v = await judge(c.p.root, 'P1', { now: new Date(c.now() + 30 * DAY).toISOString() });
    assert.equal(v.verdict, 'reverted');
    assert.match(v.reason, /did not move by the minimum/);
    assert.equal(fs.readFileSync(learnedFile('sample'), 'utf8'), '', 'reverted: roles no longer read it');
    await c.ticket(300);
    await assert.rejects(propose(c.p.root, draft({ change: '  reviewers read the INVARIANTS first. ' })), /cannot be proposed again before/);
    // Missing data: a guard no row holds.
    const p2 = await propose(c.p.root, draft({ change: 'A different change.', guard: 'rework.share' }));
    for (let i = 0; i < 8; i++) await c.ticket(50);
    const m = await judge(c.p.root, p2.id, { now: new Date(c.now() + 30 * DAY).toISOString() });
    assert.equal(m.verdict, 'reverted');
    assert.match(m.reason, /missing data/);
  });
});

test('the adapter budget: project proposals count against it; replacing an active one frees its place', async (t) => {
  const c = setup(t, { rules: 2, limit: 3 });
  await withDoubles(c.doubles, async () => {
    for (const w of [...BASE, 100, 200]) await c.ticket(w);
    await propose(c.p.root, draft());
    await assert.rejects(propose(c.p.root, draft({ source: 'person', metric: 'testMin', change: 'Run fewer suites.' })), /over the adapter budget \(2 rule\(s\) and 1 active proposal\(s\) against 3\)/);
    const p2 = await propose(c.p.root, draft({ source: 'person', metric: 'testMin', change: 'Run fewer suites.', replaces: 'P1' }));
    assert.equal(p2.status, 'active');
    assert.doesNotMatch(fs.readFileSync(learnedFile('sample'), 'utf8'), /P1/);
    assert.match((await judge(c.p.root, 'P1')).reason, /replaced by P2/);
  });
});

test('incidents become proposals only once they recur; person proposals skip drafting; one plugin proposal per release', async (t) => {
  const c = setup(t);
  const learn = commandHandler('learn');
  const ctx = { cwd: c.p.root, root: c.p.root, env: {}, actor: null, json: false };
  await withDoubles(c.doubles, async () => {
    await learn(ctx, { _: [], flags: { incident: 'stale-tree', what: 'a review on an old tree' } });
    await assert.rejects(propose(c.p.root, draft({ source: 'incident', incident: 'stale-tree', metric: 'reviews', guard: 'wallMin' })), /only once it recurs \(1 recorded/);
    const second = await learn(ctx, { _: [], flags: { incident: 'stale-tree', what: 'again' } });
    assert.match(second.text, /2 occurrence\(s\); it recurs/);
    const listed = await learn(ctx, { _: [], flags: {} });
    assert.deepEqual(listed.data.recurring, [{ key: 'stale-tree', occurrences: 2 }]);
    const inc = await propose(c.p.root, draft({ source: 'incident', incident: 'stale-tree', metric: 'reviews', guard: 'wallMin' }));
    assert.equal(inc.occurrences, 2);
    // A person's rule: no band needed, the same fields required.
    await assert.rejects(propose(c.p.root, draft({ source: 'person', metric: 'testMin', replaces: undefined })), /`replaces` is required/);
    const person = await propose(c.p.root, draft({ source: 'person', metric: 'testMin', change: 'Keep the full suite under an hour.' }));
    assert.equal(person.baseline.n, 0);
    // Plugin proposals: one per release, never applied in the project, listed for the maintainer.
    // L4: a plugin proposal replaces something the budget counts in the plugin now, by its name; free text is refused.
    await assert.rejects(propose(c.p.root, draft({ source: 'person', scope: 'plugin', metric: 'fixRounds', change: 'Plugin change.', replaces: 'the rule on reading order' })), /`replaces` of a plugin proposal must name something the budget counts.*`the rule on reading order` is none of them/s);
    await assert.rejects(propose(c.p.root, draft({ source: 'person', scope: 'plugin', metric: 'fixRounds', change: 'Plugin change.', replaces: 'merge:not-a-refusal' })), /`merge:not-a-refusal` is none of them/);
    const g = await propose(c.p.root, draft({ source: 'person', scope: 'plugin', metric: 'fixRounds', change: 'Plugin change.', replaces: 'merge:waiver', adds: { refusals: ['x:y'] } }));
    assert.equal(g.replaces, 'merge:waiver');
    assert.equal(g.status, 'proposed');
    assert.equal(g.project, null);
    await assert.rejects(propose(c.p.root, draft({ source: 'person', scope: 'plugin', metric: 'reviews', change: 'Second plugin change.', replaces: 'templates/session-rules.md' })), /one plugin proposal per release/);
    const plugin = await learn(ctx, { _: [], flags: { plugin: true } });
    assert.match(plugin.text, /Plugin change\./);
    assert.doesNotMatch(fs.readFileSync(learnedFile('sample'), 'utf8'), /Plugin change/);
  });
});

test('wf learn: lists metrics outside their band, records a draft from a file, judges what is due', async (t) => {
  const c = setup(t);
  const learn = commandHandler('learn');
  const ctx = { cwd: c.p.root, root: c.p.root, env: {}, actor: null, json: false };
  await withDoubles(c.doubles, async () => {
    for (const w of [...BASE, 100, 200]) await c.ticket(w);
    const out = await learn(ctx, { _: [], flags: {} });
    const exit = out.data.exits.find((e) => e.metric === 'wallMin');
    assert.deepEqual([exit.value, exit.baseline.median, exit.minMove, exit.active], [200, 100, 2.5, null]);
    const file = path.join(c.p.tmp, 'draft.json');
    fs.writeFileSync(file, JSON.stringify(draft()));
    const rec = await learn(ctx, { _: [], flags: { propose: file } });
    assert.match(rec.text, /P1 active/);
    const again = await learn(ctx, { _: [], flags: {} });
    assert.equal(again.data.exits.find((e) => e.metric === 'wallMin').active, 'P1');
    assert.equal(again.data.judged[0].verdict, 'not-yet');
  });
});
