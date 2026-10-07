import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, sh, singleRepoProject, state, toAccepted, wf } from './helpers.mjs';

// Project delivery adapters (merge requests): waiting for the merge, the states that refuse or wait, and the documented
// recovery from a broken adapter. Split from delivery.test.mjs so the two run side by side (each file runs its tests
// one after the other; the suite's wall time was that file's).

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];

test('a project delivery adapter (merge requests) waits for merge, then reads back', () => {
  const adapter = `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const flag = (root) => root + '/../merged.flag';
export default {
  integrate(ctx) {
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/' + ctx.branch], { cwd: ctx.worktree });
    return { url: 'https://git.example.test/mr/1', branch: ctx.branch };
  },
  observe(ctx) {
    if (!fs.existsSync(flag(ctx.root))) return { state: 'awaiting-merge' };
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: ctx.worktree });
    return { state: 'integrated' };
  },
  readback(ctx) {
    execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: ctx.worktree });
    try { execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { cwd: ctx.worktree }); return { ok: true }; } catch { return { ok: false }; }
  },
};`;
  const { base, root, remote } = singleRepoProject('mr', {
    delivery: { kind: './delivery/mr.mjs' },
    tracker: { kind: 'linear', statuses: { started: 'In Progress', inReview: 'In Review', delivered: 'Ready for UAT' } },
    gate: { steps },
  }, { '.workflow/delivery/mr.mjs': adapter });
  const { id } = toAccepted(root, base, { item: 'ENG-70' });
  const d1 = ok(wf(root, ['deliver', '--attempt', id]));
  assert.match(d1.out, /awaiting-merge \(https:\/\/git\.example\.test\/mr\/1\)/);
  assert.ok(state(root, id).tracker.pending.some((a) => a.event === 'integrating' && a.status === 'In Review'), 'tracker asked to move the ticket to In Review');
  fs.writeFileSync(path.join(root, '..', 'merged.flag'), '');
  ok(wf(root, ['deliver', '--attempt', id]));
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
  assert.equal(state(root, id).phase, 'handoff-pending');
});

// Named failure (0.4.5, delta reviews of 40da633 and b28681a): every adapter state but `integrated` took the path of a
// pending merge, so `wf deliver` exited 0 and a rejected delivery, a failed CI, a typo or no state at all read as
// success. Only `awaiting-merge` and `ci-running` wait (exit 0); `rejected`, `ci-failed` and any other value refuse.
test('a delivery adapter that reports rejected, ci-failed or an unknown state refuses; awaiting-merge and ci-running wait with exit 0', () => {
  const adapter = `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
export default {
  integrate(ctx) {
    execFileSync('git', ['push', '-q', '-f', 'origin', 'HEAD:refs/heads/' + ctx.branch], { cwd: ctx.worktree });
    return { url: 'https://git.example.test/mr/2', branch: ctx.branch };
  },
  observe(ctx) {
    const st = fs.readFileSync(ctx.root + '/../observe.state', 'utf8').trim();
    return st === '(none)' ? { evidence: 'pipeline 7' } : { state: st, evidence: 'pipeline 7' };
  },
  readback() { return { ok: true }; },
};`;
  const { base, root } = singleRepoProject('mr-states', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': adapter });
  const { id } = toAccepted(root, base, { item: 'ENG-71' });
  const say = (st) => fs.writeFileSync(path.join(root, '..', 'observe.state'), st);
  for (const st of ['awaiting-merge', 'ci-running']) {
    say(st);
    const w = wf(root, ['deliver', '--attempt', id]);
    assert.equal(w.code, 0, w.err);
    assert.match(w.out, new RegExp(`${st} \\(https://git\\.example\\.test/mr/2\\)\\. Run \`wf deliver\` again once it is merged\\.`));
  }
  // Delta review of b28681a: only the pending states wait. An unknown state, a typo or no state at all refuses too.
  for (const st of ['failed', 'ci_failed', '(none)']) {
    say(st);
    const r = wf(root, ['deliver', '--attempt', id]);
    assert.notEqual(r.code, 0, st);
    assert.match(r.err, new RegExp(`not delivered: app: the delivery adapter reported ${st === '(none)' ? 'no state' : `an unknown state "${st}"`}; it must report one of integrated, awaiting-merge, ci-running, ci-failed, rejected`), st);
    assert.equal(state(root, id).delivery.completedAt, null, `${st}: nothing delivered`);
  }
  for (const st of ['rejected', 'ci-failed']) {
    say(st);
    const r = wf(root, ['deliver', '--attempt', id]);
    assert.notEqual(r.code, 0, st);
    assert.match(r.err, new RegExp(`not delivered: app: the delivery adapter reports ${st} \\(https://git\\.example\\.test/mr/2\\)`), st);
    assert.match(r.err, st === 'rejected' ? /the change was rejected/ : /its CI failed/);
    assert.equal(state(root, id).delivery.completedAt, null, `${st}: nothing delivered`);
  }
});

// Delta reviews of 3338382 and f250f98: the adapter is read at the attempt's base, pinned at admission, so a fixed adapter
// on the base branch does not reach the running attempt, and a shell recipe in the refusal was wrong for other lanes and
// for merged bases. The refusal states the facts and points to docs/lifecycle.md "Recovering from an adapter fault",
// whose single-repo standard-lane recipe these two scenarios follow: commit the fixed adapter, abandon, `wf entry
// --item`, `git merge --squash` the old branch and commit, then plan, gate, review and deliver. The second one runs
// `wf base merge` first.
const brokenAdapter = `export default { integrate(ctx) { return { url: 'https://git.example.test/mr/3' }; }, observe() { return { state: 'merged' }; }, readback() { return { ok: true }; } };`;
const fixedAdapter = `import { execFileSync } from 'node:child_process';
export default {
  integrate(ctx) { return { url: 'https://git.example.test/mr/3' }; },
  observe(ctx) { execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: ctx.worktree }); return { state: 'integrated' }; },
  readback() { return { ok: true }; },
};`;
function recoverFromBrokenAdapter(name, { baseMerge }) {
  const { base, root, remote } = singleRepoProject(name, { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': brokenAdapter, 'src/other.txt': 'o\n' });
  const e = ok(wf(root, ['entry', '--item', 'ENG-72', '--owner', 'owner-1', '--json'])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', 'owner-1']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', 'owner-1']));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id, '--owner', 'owner-1']));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  if (baseMerge) {
    // The base advances with an unrelated change, and the attempt merges it in.
    sh(root, "printf 'o2\\n' > src/other.txt && git commit -qam 'unrelated base change' && git push -q origin main");
    ok(wf(root, ['base', 'merge', '--attempt', id]));
  }
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', 'owner-1']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1')), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', 'owner-1']));
  const r = wf(root, ['deliver', '--attempt', id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /the delivery adapter reported an unknown state "merged"/);
  assert.match(r.err, /this attempt reads its delivery adapter as committed at [0-9a-f]{10}, so a fix committed on the base branch does not reach it by itself\. Once the fixed adapter is committed and pushed on the base branch, the owner re-pins this attempt's delivery adapter to it: `wf deliver --repin-adapter --reason "<why>"` shows what changes and asks for the owner's confirmation \(docs\/lifecycle\.md, "Recovering from an adapter fault"\)/);
  assert.doesNotMatch(r.err, /cherry-pick|abandon|wf\/ENG-72|[0-9a-f]{10}\.\./, 'no recipe, branch name or hash range in the refusal');
  // A fix committed on the base branch alone does not reach this attempt: the same refusal.
  fs.writeFileSync(path.join(root, '.workflow', 'delivery', 'mr.mjs'), fixedAdapter);
  sh(root, 'git add -A && git commit -qm "fix the delivery adapter" && git push -q origin main');
  assert.match(wf(root, ['deliver', '--attempt', id]).err, /reported an unknown state "merged"/);
  // The documented recipe. First the delivery record: `wf abandon` accepts the attempt only while no repo is recorded.
  assert.deepEqual(ok(wf(root, ['status', '--attempt', id, '--json'])).json()[0].delivery.repos, {});
  assert.match(wf(root, ['abandon', '--reason', 'the delivery adapter was broken', '--attempt', id]).err, /--acknowledge-integration app:merged/);
  ok(wf(root, ['abandon', '--reason', 'the delivery adapter was broken', '--acknowledge-integration', 'app:merged', '--attempt', id]));
  const e2 = ok(wf(root, ['entry', '--item', 'ENG-72', '--owner', 'owner-1', '--json'])).json();
  sh(e2.repos.app.worktree, `git merge --squash wf/${id} && git commit -qm "ENG-72: the change from ${id}"`);
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-2', '--attempt', e2.id, '--owner', 'owner-1']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e2.id, '--owner', 'owner-1']));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-2', '--attempt', e2.id, '--owner', 'owner-1']));
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e2.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-2', '--attempt', e2.id, '--owner', 'owner-1']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-2')), '--attempt', e2.id]));
  ok(wf(root, ['accept', '--attempt', e2.id, '--owner', 'owner-1']));
  ok(wf(root, ['deliver', '--attempt', e2.id]));
  assert.ok(state(root, e2.id).delivery.completedAt, 'delivered');
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
  if (baseMerge) assert.equal(sh(base, `git --git-dir=${remote} show main:src/other.txt`), 'o2');
}

test('a broken delivery adapter: the refusal states the facts, and the documented recovery delivers', () => {
  recoverFromBrokenAdapter('mr-broken', { baseMerge: false });
});

test('a broken delivery adapter after `wf base merge`: the documented recovery (merge --squash) still delivers', () => {
  recoverFromBrokenAdapter('mr-broken-merged', { baseMerge: true });
});
