import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, sh, singleRepoProject, state, toAccepted, wf, write, ownerSession } from './helpers.mjs';

// Adoption uses the receiving interactive session's human request, supplied by the scenario wrapper.
// Prepare its interactive session metadata; no previous-session release is required.
function prepareAdopter(root, to) {
  const home = path.join(root, '..', '.home');
  const sid = ownerSession(to).replace(/^codex:/, '');
  const f = path.join(home, '.codex', 'sessions', `rollout-scenario-${sid}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: sid, originator: 'codex_cli_rs', source: 'cli' } })}\n`);
}

const steps = [{ id: 'unit', repo: 'app', run: 'grep -q . src/a.txt', inputs: ['src/**'], tier: 'light' }];

test('standard lifecycle delivers to the remote and cleans up', () => {
  const { base, root, remote } = singleRepoProject('life', { gate: { steps } });
  const { id, wt } = toAccepted(root, base);
  const d = ok(wf(root, ['deliver', '--attempt', id, '--owner', 'owner-1']));
  assert.match(d.out, /delivered/);
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
  const s = state(root, id);
  assert.equal(s.phase, 'done', 'tracker none closes on delivery');
  assert.equal(fs.existsSync(wt), false, 'worktree removed');
});

test('reviewer must be independent and planner must not change the tree', () => {
  const { base, root } = singleRepoProject('indep', { gate: { steps } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-2', '--owner', 'owner-1', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', e.id]));
  write(e.repos.app.worktree, 'src/a.txt', 'planner touched this\n');
  const p = wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]);
  assert.equal(p.code, 75);
  assert.match(p.err, /planner changed the worktree/);
  sh(e.repos.app.worktree, 'git checkout -- src/a.txt');
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'c\n' });
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  for (const who of ['impl-1', 'plan-1', ownerSession('owner-1')]) {
    const r = wf(root, ['handoff', 'reviewer', '--agent', who, '--attempt', e.id]);
    assert.equal(r.code, 75, `${who} must not review`);
  }
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id]));
  const wrong = wf(root, ['review', '--closure', closureFile(base, goodClosure('someone-else')), '--attempt', e.id]);
  assert.equal(wrong.code, 75);
});

test('criteria: frozen before code, every criterion mapped, n/a needs a reason, amendments recorded', () => {
  const { base, root } = singleRepoProject('crit', { gate: { steps } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-3', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  assert.equal(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]).code, 75, 'no implementer before criteria');
  ok(wf(root, ['plan', '--file', criteriaFile(base, [{ id: 'C1', text: 'one' }, { id: 'C2', text: 'two' }]), '--attempt', e.id]));
  assert.equal(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]).code, 75, 'criteria freeze once');
  ok(wf(root, ['criteria', 'amend', '--file', criteriaFile(base, [{ id: 'C1', text: 'one' }, { id: 'C2', text: 'two, narrowed' }]), '--reason', 'C2 scope narrowed with the user', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'z\n' });
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]));
  const unmapped = wf(root, ['accept', '--attempt', e.id]);
  assert.equal(unmapped.code, 75);
  assert.match(unmapped.err, /criterion C2 is not mapped/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'log' } }, { id: 'C2', evidence: { kind: 'not-applicable' } }] })), '--attempt', e.id]));
  assert.match(wf(root, ['accept', '--attempt', e.id]).err, /not-applicable needs a reason/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'log' } }, { id: 'C2', evidence: { kind: 'not-applicable', reason: 'covered by C1 output after narrowing' } }] })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  assert.equal(state(root, e.id).criteriaAmendments.length, 1);
});

test('open findings block acceptance; changes after review need a new review', () => {
  const { base, root } = singleRepoProject('find', { gate: { steps } });
  const { id, wt } = toAccepted(root, base, { item: 'ENG-4' });
  commitIn(wt, { 'src/a.txt': 'changed after accept\n' });
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  const d = wf(root, ['deliver', '--attempt', id]);
  assert.equal(d.code, 75);
  assert.match(d.err, /modified after acceptance/);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-2', '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-2', { findings: [{ id: 'F1', severity: 'major', summary: 'x', status: 'open', evidence: 'src/a.txt:1' }] })), '--attempt', id]));
  assert.match(wf(root, ['accept', '--attempt', id]).err, /finding F1 is open/);
});

test('analysis attempts never deliver or implement', () => {
  const { base, root } = singleRepoProject('analysis', { gate: { steps } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-5', '--intent', 'analysis', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  assert.equal(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]).code, 75);
  const d = wf(root, ['deliver', '--attempt', e.id]);
  assert.equal(d.code, 75);
  assert.match(d.err, /intent `analysis`/);
});

test('a hold vetoes delivery until released', () => {
  const { base, root } = singleRepoProject('hold', { gate: { steps } });
  const { id } = toAccepted(root, base, { item: 'ENG-6' });
  ok(wf(root, ['hold', '--reason', 'local only for now', '--attempt', id]));
  const d = wf(root, ['deliver', '--attempt', id]);
  assert.equal(d.code, 75);
  assert.match(d.err, /local only for now/);
  ok(wf(root, ['release', '--attempt', id]));
  ok(wf(root, ['deliver', '--attempt', id]));
});

test('a newer gate failure supersedes an older pass', () => {
  const { base, root } = singleRepoProject('newer', { gate: { steps: [{ id: 'unit', repo: 'app', run: '! grep -q broken src/a.txt', inputs: ['src/**'] }] } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-7', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'fine\n' });
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'broken\n' });
  assert.equal(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]).code, 1);
  assert.match(state(root, e.id).next, /gate failed: fix and commit/);
  const h = JSON.parse(ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id, '--json'])).out);
  const bundle = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  assert.equal(bundle.gate.passedOnThisTree, false, 'the older pass is not evidence for this tree');
  assert.match(bundle.gate.reason, /last gate failed/);
  assert.match(wf(root, ['accept', '--attempt', e.id]).err, /no review recorded/);
});

test('uncommitted changes are refused at the gate; one open attempt per item; adopt transfers ownership', () => {
  const { root } = singleRepoProject('dup', { gate: { steps } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-8', '--owner', 'o', '--json'])).json();
  assert.equal(wf(root, ['entry', '--item', 'ENG-8', '--owner', 'o2']).code, 75);
  write(e.repos.app.worktree, 'src/a.txt', 'dirty\n');
  assert.match(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]).err, /commit changes before the gate/);
  prepareAdopter(root, 'o2');
  ok(wf(root, ['adopt', '--attempt', e.id, '--owner', 'o2']));
  assert.equal(state(root, e.id).owner, ownerSession('o2'));
});

// Named failure (I-85): a notes-page UUID was admitted as the ticket item, worktrees were provisioned and roles ran, and
// only the admission readback refused it because the tracker names a ticket by its own identity.
test('entry refuses an item that is not the tracker\'s ticket id before creating anything', () => {
  const uuid = '3f770c4920db80638ac5ce5bde7f4687';
  const { root } = singleRepoProject('item-id', { gate: { steps }, tracker: { kind: 'linear', via: 'connector' } });
  const refused = wf(root, ['entry', '--item', uuid, '--owner', 'o']);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /not a ticket id of the `linear` tracker/);
  assert.equal(fs.existsSync(path.join(root, '.wf-worktrees')), false, 'nothing was provisioned');
  assert.equal(wf(root, ['status', '--all']).out.includes(uuid), false, 'no attempt was recorded');
  ok(wf(root, ['entry', '--item', 'ENG-7', '--owner', 'o']));
  const own = singleRepoProject('item-pattern', { gate: { steps }, tracker: { kind: 'none', itemPattern: '^PRJ-\\d+$' } });
  assert.equal(wf(own.root, ['entry', '--item', uuid, '--owner', 'o']).code, 75, 'a project states its own ticket identity');
  ok(wf(own.root, ['entry', '--item', 'PRJ-3', '--owner', 'o']));
  const bad = singleRepoProject('item-bad', { gate: { steps }, tracker: { kind: 'none', itemPattern: '(' } });
  assert.match(wf(bad.root, ['entry', '--item', 'PRJ-3', '--owner', 'o']).err, /tracker\.itemPattern/);
});

test('reopen after delivery starts a linked attempt', () => {
  const { base, root } = singleRepoProject('reopen', { gate: { steps } });
  const { id } = toAccepted(root, base, { item: 'ENG-10' });
  ok(wf(root, ['deliver', '--attempt', id]));
  const r = ok(wf(root, ['reopen', '--item', 'ENG-10', '--reason', 'UAT found a typo', '--owner', 'o', '--json'])).json();
  assert.equal(r.reopenedFrom, id);
  assert.equal(r.id, 'ENG-10.2');
});

test('quick fixes get the next QF number and close on delivery', () => {
  const { base, root } = singleRepoProject('qf', { gate: { steps } });
  const e = ok(wf(root, ['entry', '--owner', 'o', '--json'])).json();
  assert.equal(e.item, 'QF-1');
  assert.equal(e.lane, 'quick');
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'qf\n' });
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  ok(wf(root, ['deliver', '--attempt', e.id]));
  assert.equal(state(root, e.id).phase, 'done');
});

test('the reviewer handoff prints only the one-line start prompt, and the bundle carries what the reviewer needs', () => {
  const { base, root } = singleRepoProject('blind', { gate: { steps } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-60', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['criteria', 'amend', '--file', criteriaFile(base), '--reason', 'scope clarified', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'blind\n' });
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  const out = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id])).out;
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 1, out);
  const [, bundlePath] = lines[0].match(/^Read (\S+) and follow its instructions\.$/);
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  // 0.7.0: a reviewer is handed the current (amended) criteria, never the attempt's amendment history.
  assert.ok(bundle.criteria.length && bundle.criteriaAmendments === undefined && bundle.mode === 'full' && !('budget' in bundle));
  assert.ok(bundle.gate.evidence && bundle.worktrees.app && bundle.bases.app && bundle.changed.app.includes('src/a.txt'));
});
