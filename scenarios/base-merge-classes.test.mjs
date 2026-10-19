import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WF, closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, spawnHome, state, toAccepted, wf } from './helpers.mjs';
import { ledger, steps } from './adapter-fault-fixtures.mjs';
import { loadState, reduce } from '../engine/ledger.mjs';
import { limitItems } from '../engine/tracker.mjs';

// 0.7.34 (I-233). Named failure (field): the work skill said "before the gate, merge a moved base", with no fixed point. On one
// attempt the base was merged seven times in three days and the owner stopped a running gate to merge again. Whether a merge
// reopened review hung on the 3-line diff context around the ticket's hunks; six merges changed files of the ticket and no
// reviewer was asked about them; a hand merge that resolved conflicts in 13 files was judged as a whole delta. A base merge is now
// classed from git facts (`none`, `context`, `changed`): only `changed` owes a review before the gate, and only of the merge.

const seven = (edits = {}) => `${Array.from({ length: 7 }, (_, i) => edits[i + 1] ?? `l${i + 1}`).join('\n')}\n`;
const project = (name, extra = {}) => singleRepoProject(name, { gate: { steps }, ...extra }, { 'src/m.txt': seven(), 'src/other.txt': 'o\n' });
const baseCommit = (root, files, msg) => {
  sh(root, 'git checkout -q main && git pull -q --ff-only origin main');
  commitIn(root, files, msg);
  sh(root, 'git push -q origin main');
};
const lastBundle = (root, id) => JSON.parse(fs.readFileSync(ledger(root, id).filter((e) => e.type === 'handoff' && e.data.role === 'reviewer').at(-1).data.bundle, 'utf8'));

// Up to a clean code review of the ticket's change (line 2 of src/m.txt), as the order of work leaves it before the gate.
function reviewed(root, base, item) {
  const e = ok(wf(root, ['entry', '--item', item, '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', `plan-${item}`, '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', `impl-${item}`, '--attempt', e.id]));
  const wt = e.repos.app.worktree;
  commitIn(wt, { 'src/m.txt': seven({ 2: 'mine' }) });
  ok(wf(root, ['handoff', 'reviewer', '--agent', `rev0-${item}`, '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure(`rev0-${item}`)), '--attempt', e.id]));
  assert.equal(state(root, e.id).decision.kind, 'gate');
  return { id: e.id, wt };
}

test('I-233: two base merges that edit the ticket\'s file near its hunk owe no review round; the evidence review answers both, and a closure that does not is refused', () => {
  const { base, root } = project('bm-context');
  const { id } = reviewed(root, base, 'ENG-2331');
  baseCommit(root, { 'src/m.txt': seven({ 4: 'theirs-4' }) }, 'base edit next to the hunk');
  const m1 = ok(wf(root, ['base', 'merge', '--attempt', id]));
  assert.match(m1.out, /owes: base:1 changed files this ticket also changes \(src\/m\.txt\) and left the ticket's own change as it was: no review round is owed/);
  assert.equal(state(root, id).decision.kind, 'gate', 'a `context` merge keeps the code review');
  baseCommit(root, { 'src/m.txt': seven({ 4: 'theirs-4', 5: 'theirs-5' }) }, 'second base edit');
  ok(wf(root, ['base', 'merge', '--attempt', id]));
  const merged = ledger(root, id).filter((e) => e.type === 'base.merged').map((e) => [e.data.class, e.data.ownSame, e.data.resolved]);
  assert.deepEqual(merged, [['context', true, []], ['context', true, []]]);
  assert.equal(state(root, id).decision.kind, 'gate');
  ok(wf(root, ['gate', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'ev-1', '--attempt', id]));
  const bundle = lastBundle(root, id);
  assert.deepEqual(bundle.baseMerge.map((x) => [x.id, x.class, x.touched]), [['base:1', 'context', ['src/m.txt']], ['base:2', 'context', ['src/m.txt']]]);
  assert.match(bundle.baseMerge[0].commands.baseEdits, /diff [0-9a-f]{40} [0-9a-f]{40} -- "src\/m\.txt"$/);
  assert.match(bundle.instructions, /`baseMerge` lists the base merges since the last recorded round/);
  const refused = wf(root, ['review', '--closure', closureFile(base, goodClosure('ev-1')), '--attempt', id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /base:1 \(app, context\) has no entry/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('ev-1', { baseMerges: [{ id: 'base:1', findings: [] }, { id: 'base:2', findings: [] }] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
  // Judged by a review, so the delivered comment does not list them as unchecked.
  assert.equal(limitItems(loadState(root, id)).filter((x) => /no reviewer looked at where the two meet/.test(x.line)).length, 0);
});

test('I-233: a hand merge that resolved a conflict is classified once and owes one merge review of just that merge, then the gate', () => {
  const { base, root } = project('bm-resolved');
  const { id, wt } = reviewed(root, base, 'ENG-2332');
  baseCommit(root, { 'src/m.txt': seven({ 2: 'theirs' }) }, 'conflicting base change');
  const r = wf(root, ['base', 'merge', '--attempt', id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /a merge commit, never a squash or a rebase onto the base/);
  // The implementer merges by hand and resolves the conflict.
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-merge', '--attempt', id]));
  sh(wt, 'git fetch -q origin main && (git merge -q --no-edit origin/main || true)');
  fs.writeFileSync(`${wt}/src/m.txt`, seven({ 2: 'mine+theirs' }));
  sh(wt, 'git add -A && git commit -q --no-edit');
  ok(wf(root, ['handoff', 'close', '--agent', 'impl-merge', '--attempt', id]));
  let s = state(root, id);
  assert.equal(s.decision.kind, 'review');
  assert.equal(s.decision.mode, 'merge');
  assert.match(s.next, /merge review: only base merges came in since the last reviewed tree/);
  state(root, id);
  const observed = ledger(root, id).filter((e) => e.type === 'base.observed');
  assert.equal(observed.length, 1, 'classified once, however often the attempt is read');
  assert.deepEqual([observed[0].data.class, observed[0].data.resolved, observed[0].data.commits], ['changed', ['src/m.txt'], 1]);
  const gate = wf(root, ['gate', '--attempt', id]);
  assert.equal(gate.code, 75, 'the resolution is code this ticket wrote: judged before the gate');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'mr-1', '--attempt', id]));
  const bundle = lastBundle(root, id);
  assert.equal(bundle.round, 'code-review');
  assert.match(bundle.instructions, /This is a merge review/);
  assert.deepEqual(bundle.baseMerge.map((x) => [x.class, x.resolved]), [['changed', ['src/m.txt']]]);
  assert.match(bundle.baseMerge[0].commands.resolution, /diff [0-9a-f]{40} [0-9a-f]{40} -- "src\/m\.txt"$/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('mr-1', { baseMerges: [{ id: bundle.baseMerge[0].id, findings: [] }] })), '--attempt', id]));
  assert.equal(ledger(root, id).filter((e) => e.type === 'review.round').at(-1).data.mode, 'merge');
  s = state(root, id);
  assert.equal(s.decision.kind, 'gate');
  ok(wf(root, ['gate', '--attempt', id]));
});

test('I-233: wf base merge waits for a reviewer at work: the merge goes right before the gate', () => {
  const { base, root } = project('bm-in-flight');
  const e = ok(wf(root, ['entry', '--item', 'ENG-2333', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/m.txt': seven({ 2: 'mine' }) });
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  baseCommit(root, { 'src/other.txt': 'o2\n' }, 'base moves');
  const m = wf(root, ['base', 'merge', '--attempt', e.id]);
  assert.equal(m.code, 75);
  assert.match(m.err, /reviewer r was handed this tree and has recorded no closure/);
  assert.match(m.err, /record its closure file \(`wf review --closure <file> --attempt [^`]+`\), or hand a fresh reviewer if it is gone \(`wf handoff reviewer --agent <new id>`\); the merge goes right before the gate/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]));
  ok(wf(root, ['base', 'merge', '--attempt', e.id]));
  assert.equal(state(root, e.id).decision.kind, 'gate');
});

test('I-233: a base merged in after the implementers of an evidence fix keeps the direct route to the gate', () => {
  const { base, root } = project('bm-direct');
  const { id, wt } = reviewed(root, base, 'ENG-2334');
  ok(wf(root, ['gate', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'ev-1', '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('ev-1', { findings: [{ id: 'F1', severity: 'high', criterion: 'C1', summary: 'line 2 reads wrong', evidence: 'src/m.txt:2' }] })), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-fix', '--attempt', id]));
  commitIn(wt, { 'src/m.txt': seven({ 2: 'mine-fixed' }) }, 'fix F1');
  ok(wf(root, ['handoff', 'close', '--agent', 'impl-fix', '--attempt', id]));
  assert.equal(state(root, id).decision.kind, 'gate', 'the direct route before the merge');
  baseCommit(root, { 'src/other.txt': 'o2\n' }, 'unrelated base change');
  ok(wf(root, ['base', 'merge', '--attempt', id]));
  assert.equal(state(root, id).decision.kind, 'gate', 'the merge does not switch the direct route off');
  ok(wf(root, ['gate', '--attempt', id]));
});

test('I-233: push-main merging a base that edits the ticket\'s file records the merge, names the base work and its ticket, and owes the gate only', () => {
  const { base, root } = project('bm-push-main');
  const a = toAccepted(root, base, { item: 'ENG-2335', change: { 'src/m.txt': seven({ 2: 'mine' }) } });
  // Another ticket delivers an edit two lines below this one's.
  const b = toAccepted(root, base, { item: 'ENG-2336', change: { 'src/m.txt': seven({ 4: 'other ticket' }) } });
  ok(wf(root, ['deliver', '--attempt', b.id]));
  const d = wf(root, ['deliver', '--attempt', a.id]);
  assert.equal(d.code, 75);
  assert.match(d.err, /It left this ticket's change as it was; other work changed these files of it, which no review judges after the acceptance, so test where they meet:/);
  assert.match(d.err, /src\/m\.txt; delivered with ENG-2336\)/);
  assert.doesNotMatch(d.err, /hand it to a fresh reviewer/);
  const ev = ledger(root, a.id).filter((e) => e.type === 'base.merged').at(-1).data;
  assert.deepEqual([ev.delivery, ev.class, ev.touched], [true, 'context', ['src/m.txt']]);
  assert.ok(state(root, a.id).accepted, 'the acceptance stands');
  ok(wf(root, ['gate', '--attempt', a.id]));
  ok(wf(root, ['deliver', '--attempt', a.id]));
  assert.equal(sh(base, `git --git-dir=${root}.origin.git show main:src/m.txt`), seven({ 2: 'mine', 4: 'other ticket' }).trim());
  // No review judged where the two met: the delivered comment says so.
  assert.equal(limitItems(loadState(root, a.id)).filter((x) => /other work merged in from the base branch also changed a file this change edits/.test(x.line)).length, 1);
});

test('I-233: a ledger from before the facts replays as it did, and a later classification joins the recorded merge', () => {
  const merged = { type: 'base.merged', at: '2026-10-01T00:00:00.000Z', data: { repo: 'app', ref: 'origin/main', from: 'a', to: 'b', headBefore: 'c', headAfter: 'd' } };
  const s1 = reduce([merged]);
  assert.deepEqual(s1.baseMerges.map((m) => [m.n, m.class, m.to]), [[1, undefined, 'b']]);
  const observed = { type: 'base.observed', at: '2026-10-02T00:00:00.000Z', data: { repo: 'app', ref: 'origin/main', from: 'x', to: 'y', merge: 'd', touched: [], resolved: [], ownSame: true, class: 'none' } };
  const hand = { type: 'base.observed', at: '2026-10-03T00:00:00.000Z', data: { repo: 'app', ref: 'origin/main', from: 'b', to: 'f', merge: 'g', touched: ['src/m.txt'], resolved: [], ownSame: true, class: 'context' } };
  const s2 = reduce([merged, observed, hand]);
  assert.deepEqual(s2.baseMerges.map((m) => [m.n, m.class, m.to]), [[1, 'none', 'b']]);
  assert.deepEqual(s2.baseObserved.map((m) => [m.n, m.class, m.to, m.repo, m.ref]), [[2, 'context', 'f', 'app', 'origin/main']]);
});

test('I-233: a gate stopped as a tree change while the base had moved names the merge, and a merge that leaves the change as it was owes no fresh review', async () => {
  const slow = [{ id: 'fast', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'slow', repo: 'app', run: 'sleep 20', inputs: ['src/**'] }];
  const { base, root } = project('bm-stop', { gate: { steps: slow } });
  const { id } = reviewed(root, base, 'ENG-2337');
  const env = { ...process.env, WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), ...spawnHome(root) };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k];
  const child = spawn(process.execPath, [WF, 'gate', '--attempt', id], { cwd: root, env, stdio: 'ignore' });
  const lock = path.join(root, '.wf-evidence', 'attempts', id, 'gate', 'gate.lock');
  const ready = () => {
    try {
      return JSON.parse(fs.readFileSync(lock, 'utf8')).children.length >= 2;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 100));
  baseCommit(root, { 'src/other.txt': 'o2\n' }, 'base moves under the gate');
  sh(path.join(root, '.wf-worktrees', id, 'app'), 'git fetch -q origin main');
  ok(wf(root, ['stop', '--class', 'tree-change', '--reason', 'the base moved', '--attempt', id]));
  await new Promise((r) => child.on('exit', r));
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /the base moved \(app: \+1 commit\(s\)\): when the stop was for that, `wf base merge`/);
  ok(wf(root, ['base', 'merge', '--attempt', id]));
  assert.equal(state(root, id).decision.kind, 'gate', 'no fresh review for a merge that left the change as it was');
});

// Review of 0.7.34 (M2): a round handed by an engine before 0.7.34 judged the whole change, a merge already in its tree included; it
// was handed no `baseMerge` list to answer. Named failure: attempts in flight (one field ledger had six context merges) would read
// "not checked by review" for merges their reviews had seen. A round handed with the list still answers by naming the merge.
test('I-233: a context merge counts as judged by a finished round handed no baseMerge list whose tree holds the merge; not by a partial round, one handed the list, or one on a tree before it', () => {
  const { base, root } = project('bm-earlier-engine');
  const { id } = reviewed(root, base, 'ENG-2339');
  const before = String(loadState(root, id).reviews.at(-1).tree.app).split('+')[0];
  baseCommit(root, { 'src/m.txt': seven({ 4: 'theirs-4' }) }, 'base edit next to the hunk');
  ok(wf(root, ['base', 'merge', '--attempt', id]));
  const st = loadState(root, id);
  const merged = st.baseMerges.at(-1);
  assert.equal(merged.class, 'context');
  const head = merged.headAfter;
  const bundle = (name, extra) => {
    const f = path.join(base, `${name}.json`);
    fs.writeFileSync(f, JSON.stringify({ role: 'reviewer', ...extra }));
    return f;
  };
  const withRound = ({ tree, partial = false, list = false }) => {
    const b = bundle(`b-${Math.random().toString(36).slice(2)}`, list ? { baseMerge: [{ id: `base:${merged.n}` }] } : {});
    return { ...st, handoffs: [...st.handoffs, { role: 'reviewer', agent: 'old-rev', bundle: b, at: '2099-01-01T00:00:00.000Z' }], reviews: [...st.reviews, { reviewer: 'old-rev', handoff: b, at: '2099-01-01T00:00:01.000Z', tree: { app: tree }, partial, closure: { reviewer: 'old-rev', findings: [] } }] };
  };
  const unchecked = (s) => limitItems(s).filter((x) => /no reviewer looked at where the two meet/.test(x.line)).length;
  assert.equal(unchecked(st), 1, 'no round has seen it yet');
  assert.equal(unchecked(withRound({ tree: head })), 0, 'an earlier engine\'s finished round on a tree holding the merge judged it');
  assert.equal(unchecked(withRound({ tree: head, partial: true })), 1, 'a partial round judged nothing whole');
  assert.equal(unchecked(withRound({ tree: head, list: true })), 1, 'a round handed the list answers by naming it');
  assert.equal(unchecked(withRound({ tree: before })), 1, 'a round on the tree before the merge never saw it');
});

// Review of 0.7.34 (L5): a changed merge while the latest round has open blocking findings owes no merge round of its own: the fix
// round comes first, and its delta round judges the merge with the fix (listed under `baseMerge`). `wf base merge` says so.
test('I-233: a changed merge on a round with open blocking findings is judged in the fix round\'s delta round, and wf base merge says so', () => {
  const { base, root } = project('bm-open-findings');
  const e = ok(wf(root, ['entry', '--item', 'ENG-2340', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-2340', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-2340', '--attempt', e.id]));
  const wt = e.repos.app.worktree;
  commitIn(wt, { 'src/m.txt': seven({ 2: 'mine' }) });
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev0-2340', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev0-2340', { findings: [{ id: 'F1', severity: 'high', summary: 'line 7 is wrong', status: 'open', evidence: 'src/m.txt:7', criterion: 'C1' }] })), '--attempt', e.id]));
  // The base makes the ticket's own edit too: the merge leaves the ticket's change different (class changed).
  baseCommit(root, { 'src/m.txt': seven({ 2: 'mine' }), 'src/other.txt': 'theirs\n' }, 'the same edit landed on the base');
  const m = ok(wf(root, ['base', 'merge', '--attempt', e.id]));
  assert.equal(ledger(root, e.id).filter((x) => x.type === 'base.merged').at(-1).data.class, 'changed');
  assert.match(m.out, /note: the latest review round has open blocking findings, so no merge review of its own is owed: the next delta round, after the fix, judges this merge with the fix/);
  const s = state(root, e.id);
  assert.notEqual(s.decision.mode, 'merge', 'the fix round comes first');
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-2340', '--attempt', e.id]));
  commitIn(wt, { 'src/m.txt': seven({ 2: 'mine', 7: 'fixed' }) });
  ok(wf(root, ['handoff', 'close', '--agent', 'impl-2340', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev1-2340', '--attempt', e.id]));
  const b = lastBundle(root, e.id);
  assert.equal(b.mode ?? ledger(root, e.id).filter((x) => x.type === 'handoff' && x.data.role === 'reviewer').at(-1).data.mode, 'delta');
  assert.deepEqual(b.baseMerge.map((x) => x.class), ['changed'], 'the delta round judges the merge with the fix');
});
