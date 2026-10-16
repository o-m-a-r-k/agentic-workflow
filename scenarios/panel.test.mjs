import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commitIn, ok, planDoc, singleRepoProject, state, wf } from './helpers.mjs';

// 0.7.22 (D28): the person's request: "two agents do the planning; they discuss the plan between each other and come up
// with one solid plan". Two seats draft blind, seat 1 merges and names every point the drafts differ on, seat 2 agrees or
// objects until it agrees, and its agreement freezes the merged plan.
const criteria = [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }];
const file = (dir, name, doc) => {
  const f = path.join(dir, `${name}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(doc));
  return f;
};
const plan = (dir, name, extra = {}) => file(dir, name, { ...planDoc({ plan: `the ${name} plan`, criteria }), ...extra });

test('a planning panel: two blind drafts, a merge that names its disagreements, objections back to the merge, agreement freezes the plan', () => {
  const { base, root } = singleRepoProject('panel', { roles: { planner: { panel: null } } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-1', '--owner', 'claude:panel-owner', '--json'])).json();
  const call = (args, opts) => wf(root, [...args, '--attempt', e.id], opts);
  assert.match(ok(call(['resume'])).out, /planning panel \(2 planners\): hand seat 1 \[wf-planner\] and seat 2 \[wf-planner-review\]/);
  // Drafts: one seat per agent, blind; the second seat runs another class (Claude's default: Fable leads, Opus second).
  const a = ok(call(['handoff', 'planner', '--agent', 'pa', '--json'])).json();
  assert.deepEqual([a.panel.seat, a.panel.stage, a.agentType, a.class], [1, 'draft', 'wf-planner', 'planning']);
  const b = ok(call(['handoff', 'planner', '--agent', 'pb', '--json'])).json();
  assert.deepEqual([b.panel.seat, b.panel.stage, b.agentType, b.class], [2, 'draft', 'wf-planner-review', 'review']);
  const bundleB = JSON.parse(fs.readFileSync(b.bundle, 'utf8'));
  assert.equal(bundleB.panel.drafts, undefined, 'a draft is written blind');
  assert.equal(ok(call(['handoff', 'planner', '--agent', 'pa', '--json'])).json().panel.seat, 1, 'a seat\'s own agent is handed its seat again');
  // A file needs the seat it is from.
  assert.match(call(['plan', '--file', plan(base, 'x')]).err, /a planning panel is planning ENG-1\.1: record a seat's output/);
  assert.match(ok(call(['plan', '--file', plan(base, 'draft-a'), '--agent', 'pa'])).out, /seat 1's draft recorded/);
  assert.match(call(['plan', '--file', plan(base, 'draft-a2'), '--agent', 'pa']).err, /seat 1's draft is already recorded/);
  assert.match(call(['handoff', 'planner', '--agent', 'pa']).err, /pa already holds a seat of this planning panel: each draft is written blind by its own planner/);
  assert.match(ok(call(['resume'])).out, /record each draft when its planner reports: `wf plan --from-agent pb`/);
  ok(call(['plan', '--file', plan(base, 'draft-b'), '--agent', 'pb']));
  assert.equal(state(root, e.id).criteria, null, 'nothing is frozen from a draft');
  // Merge: seat 1, both drafts in its bundle; it names its disagreements.
  assert.match(ok(call(['resume'])).out, /planning panel: hand the merge to seat 1 \[wf-planner\]: continue pa/);
  const m = ok(call(['handoff', 'planner', '--agent', 'pa', '--json'])).json();
  const bundleM = JSON.parse(fs.readFileSync(m.bundle, 'utf8'));
  assert.deepEqual([bundleM.panel.stage, bundleM.panel.drafts.map((d) => d.agent)], ['merge', ['pa', 'pb']]);
  assert.match(call(['plan', '--file', plan(base, 'merge'), '--agent', 'pa']).err, /the merged plan lists no `disagreements`/);
  const disagreements = [{ point: 'where the label lives', draft1: 'in a', draft2: 'in b', chosen: 'a', why: 'a is what the user sees' }];
  assert.match(ok(call(['plan', '--file', plan(base, 'merge', { disagreements }), '--agent', 'pa'])).out, /the merged plan \(round 1, 1 disagreement\(s\) settled\)/);
  // Confirm: never by the agent that merged; an objection sends it back to the merge with the reasons.
  assert.match(call(['handoff', 'planner', '--agent', 'pa']).err, /pa wrote the merged plan: another seat confirms it/);
  const c = ok(call(['handoff', 'planner', '--agent', 'pb', '--json'])).json();
  const bundleC = JSON.parse(fs.readFileSync(c.bundle, 'utf8'));
  assert.deepEqual([bundleC.panel.stage, bundleC.panel.disagreements.length, Boolean(bundleC.panel.merged), Boolean(bundleC.panel.yourDraft)], ['confirm', 1, true, true]);
  assert.match(call(['plan', '--file', file(base, 'bad', { verdict: 'object' }), '--agent', 'pb']).err, /`verdict: object` needs `objections/);
  ok(call(['plan', '--file', file(base, 'object', { verdict: 'object', objections: [{ point: 'where the label lives', why: 'b is where the data is' }] }), '--agent', 'pb']));
  assert.match(ok(call(['resume'])).out, /hand the merge \(round 2, answering 1 objection set\(s\)\) to seat 1/);
  const m2 = ok(call(['handoff', 'planner', '--agent', 'pa', '--json'])).json();
  assert.equal(JSON.parse(fs.readFileSync(m2.bundle, 'utf8')).panel.objections[0].objections[0].why, 'b is where the data is');
  ok(call(['plan', '--file', plan(base, 'merge2', { disagreements: [{ ...disagreements[0], chosen: 'b', why: 'the data is in b' }] }), '--agent', 'pa']));
  ok(call(['handoff', 'planner', '--agent', 'pb']));
  const agreed = ok(call(['plan', '--file', file(base, 'agree', { verdict: 'agree', notes: 'b is right' }), '--agent', 'pb']));
  assert.match(agreed.out, /criteria frozen \(1\): C1/);
  const s = state(root, e.id);
  assert.equal(s.planSource.panel.rounds, 2);
  assert.deepEqual(s.planSource.panel.steps.map((x) => x.type), ['draft', 'draft', 'merged', 'objected', 'merged', 'agreed']);
  assert.equal(s.planSource.agent, 'pa', 'the merged plan is the frozen one');
});

test('on Codex the default panel is two seats of the planner\'s class (Astra twice)', () => {
  const { root } = singleRepoProject('panel-codex', { roles: { planner: { panel: null } } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-3', '--owner', 'o', '--json'])).json();
  assert.match(ok(wf(root, ['resume', '--attempt', e.id])).out, /planning panel \(2 planners\): hand seat 1 \[wf-planner\] and seat 2 \[wf-planner\]/);
  const a = ok(wf(root, ['handoff', 'planner', '--agent', 'pa', '--runtime', 'codex', '--attempt', e.id, '--json'], { preserveRuntime: true })).json();
  assert.deepEqual([a.panel.seat, a.class, a.model], [1, 'planning', 'gpt-6-astra']);
});

test('a one-seat panel is the single planner: its plan freezes as before', () => {
  const { base, root } = singleRepoProject('panel-single', { roles: { planner: { panel: ['review'] } } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-2', '--owner', 'o', '--json'])).json();
  const h = ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id, '--json'])).json();
  assert.equal(h.panel, undefined);
  assert.match(ok(wf(root, ['plan', '--file', plan(base, 'only'), '--attempt', e.id])).out, /criteria frozen/);
});

test('wf sync writes an agent per panel class, and doctor checks each seat\'s model', () => {
  const { root } = singleRepoProject('panel-sync', { roles: { planner: { panel: null } } });
  ok(wf(root, ['sync']));
  const agents = fs.readdirSync(path.join(root, '.claude', 'agents'));
  assert.ok(agents.includes('wf-planner.md') && agents.includes('wf-planner-review.md'), agents.join(', '));
  assert.match(fs.readFileSync(path.join(root, '.claude', 'agents', 'wf-planner.md'), 'utf8'), /model: fable/);
  const doctor = wf(root, ['doctor', '--runtime', 'claude']).out;
  assert.match(doctor, /planner model: fable \(class planning\)/);
  assert.match(doctor, /planner model: opus \(class review\)/);
});

// Independent review of 0.7.22.
function panelProject(name, item) {
  const p = singleRepoProject(name, { roles: { planner: { panel: null } } });
  const e = ok(wf(p.root, ['entry', '--item', item, '--owner', 'claude:panel-owner', '--json'])).json();
  const call = (args, opts) => wf(p.root, [...args, '--attempt', e.id], opts);
  return { ...p, e, call };
}
function toConfirm({ base, call }) {
  ok(call(['handoff', 'planner', '--agent', 'pa']));
  ok(call(['handoff', 'planner', '--agent', 'pb']));
  ok(call(['plan', '--file', plan(base, 'draft-a'), '--agent', 'pa']));
  ok(call(['plan', '--file', plan(base, 'draft-b'), '--agent', 'pb']));
  ok(call(['handoff', 'planner', '--agent', 'pa']));
  ok(call(['plan', '--file', plan(base, 'merge', { disagreements: [] }), '--agent', 'pa']));
  ok(call(['handoff', 'planner', '--agent', 'pb']));
}

test('a dry run records no verdict; a step recorded twice is the owner\'s mistake, not a refused plan for the next planner', () => {
  const t = panelProject('panel-dry', 'ENG-10');
  toConfirm(t);
  const before = (state(t.root, t.e.id).panel ?? []).length;
  ok(t.call(['plan', '--check', '--file', file(t.base, 'object', { verdict: 'object', objections: [{ point: 'p', why: 'w' }] }), '--agent', 'pb']));
  assert.equal((state(t.root, t.e.id).panel ?? []).length, before, 'the dry run recorded nothing');
  assert.match(t.call(['plan', '--file', plan(t.base, 'again'), '--agent', 'pa']).err, /the merge of round 1 is already recorded/);
  assert.equal((state(t.root, t.e.id).planRefusals ?? []).length, 0);
});

test('a seat whose planner is gone is replaced by name; with every seat handed, a new agent is not guessed into one', () => {
  const { call } = panelProject('panel-seat', 'ENG-11');
  ok(call(['handoff', 'planner', '--agent', 'pa']));
  ok(call(['handoff', 'planner', '--agent', 'pb']));
  assert.match(call(['handoff', 'planner', '--agent', 'pc']).err, /every seat owed a draft has its planner \(seat 1: pa, seat 2: pb\)/);
  const r = ok(call(['handoff', 'planner', '--agent', 'pc', '--seat', '2', '--json'])).json();
  assert.deepEqual([r.panel.seat, r.class], [2, 'review']);
});

test('a lane with no planner has no panel; a plan replaced after an upgrade is the panel\'s too', () => {
  const q = singleRepoProject('panel-quick', { roles: { planner: { panel: null } } });
  const qe = ok(wf(q.root, ['entry', '--item', 'ENG-12', '--lane', 'quick', '--owner', 'claude:panel-owner', '--json'])).json();
  assert.equal(ok(wf(q.root, ['handoff', 'planner', '--agent', 'q', '--attempt', qe.id, '--json'])).json().panel, undefined);
  ok(wf(q.root, ['plan', '--file', plan(q.base, 'quick'), '--attempt', qe.id]));
  // An analysis upgraded to implementation: its new plan goes through the panel, never past it.
  const p = singleRepoProject('panel-upgrade', { roles: { planner: { panel: null } } });
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-13', '--intent', 'analysis', '--owner', 'claude:panel-owner', '--json'])).json();
  const call = (args) => wf(p.root, [...args, '--attempt', e.id]);
  toConfirm({ base: p.base, call });
  ok(call(['plan', '--file', file(p.base, 'agree', { verdict: 'agree' }), '--agent', 'pb']));
  ok(call(['intent', 'implementation', '--reason', 'build it']));
  assert.match(call(['plan', '--file', plan(p.base, 'whole'), '--agent', 'pa']).err, /`pa` holds no seat of the planning panel planning/);
  assert.match(ok(call(['resume'])).out, /planning panel \(2 planners\): hand seat 1/);
});

test('a merged plan the engine refuses at the freeze goes back to the merge with the engine\'s reason', () => {
  const t = panelProject('panel-refused', 'ENG-14');
  toConfirm(t);
  // The base moves under the agreed plan: its survey query now finds a hit it said was not there.
  commitIn(t.e.repos.app.worktree, { 'src/b.txt': 'scenario-fixture-matches-nothing\n' });
  ok(t.call(['handoff', 'planner', '--agent', 'pb']));
  const refused = t.call(['plan', '--file', file(t.base, 'agree', { verdict: 'agree' }), '--agent', 'pb']);
  assert.match(refused.err, /the merged plan was agreed but refused at the freeze/);
  assert.equal(state(t.root, t.e.id).criteria, null);
  assert.match(ok(t.call(['resume'])).out, /hand the merge \(round 2, answering 1 objection set\(s\)\) to seat 1/);
  const m = ok(t.call(['handoff', 'planner', '--agent', 'pa', '--json'])).json();
  assert.equal(JSON.parse(fs.readFileSync(m.bundle, 'utf8')).panel.objections[0].agent, 'engine');
});

test('a worktree changed before the last agreement is the owner\'s to restore; the panel stays at the confirmation', () => {
  const t = panelProject('panel-dirty', 'ENG-15');
  toConfirm(t);
  fs.writeFileSync(path.join(t.e.repos.app.worktree, 'src', 'a.txt'), 'changed while planning\n');
  assert.match(t.call(['plan', '--file', file(t.base, 'agree', { verdict: 'agree' }), '--agent', 'pb']).err, /the worktree changed since this confirmation was handed/);
  const s = state(t.root, t.e.id);
  assert.deepEqual([(s.panel ?? []).some((x) => x.type === 'merge-refused'), (s.planRefusals ?? []).length], [false, 0]);
  assert.match(ok(t.call(['resume'])).out, /hand the confirmation of round 1 to seat 2/);
});

test('an attempt with no owning runtime is still planned by its panel once a seat is handed', () => {
  const { base, root } = singleRepoProject('panel-noruntime', { roles: { planner: { panel: null } } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-16', '--owner', 'plain:person', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'pa', '--runtime', 'claude', '--attempt', e.id], { preserveRuntime: true }));
  assert.match(wf(root, ['plan', '--file', plan(base, 'single'), '--attempt', e.id]).err, /a planning panel is planning ENG-16\.1/);
  assert.match(ok(wf(root, ['resume', '--attempt', e.id])).out, /planning panel \(2 planners\)/);
});
