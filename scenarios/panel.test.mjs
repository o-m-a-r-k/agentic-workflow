import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ok, planDoc, singleRepoProject, state, wf } from './helpers.mjs';

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
  assert.match(call(['plan', '--file', plan(base, 'x')]).err, /a planning panel is planning this attempt: pass `--agent/);
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
