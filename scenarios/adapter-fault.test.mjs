import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, OUT_OF_ORDER, sh, singleRepoProject, state, tmp, toAccepted, wf, yaml } from './helpers.mjs';

// I-20, I-21, I-22: what `wf deliver` does when a delivery adapter faults, for every shape of attempt.
// - I-20: an adapter that pushed straight to the target branch and then reports anything but `integrated` is asked again
//   on the next `wf deliver`; a non-integrated state after the merge is shown and counts only once the owner acknowledges
//   that repo and that state; the state is recorded with the delivery and printed in its output.
// - I-21: `wf deliver --repin-adapter <commit> --reason` re-reads the delivery adapter from the tip of the base branch
//   (never the working tree), after the owner saw what changes; recorded with the old and new pin.
// - I-22: the recovery is proven for a single repo, a merged base, several repos with one delivered or skipped, the quick
//   lane and a batch; `wf abandon` names the case.

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];

// Pushes HEAD to main only when the repo is not named in `.../noPush`; reports the state written in `.../observe.state`
// (or, per repo, `.../observe.<repo>.state`), and counts each observe call.
const scriptedAdapter = `import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const at = (ctx, n) => ctx.root + '/../' + n;
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null);
export default {
  integrate(ctx) {
    if (read(at(ctx, 'push.' + ctx.repo.name)) !== 'no') execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: ctx.worktree });
    return { url: 'https://git.example.test/mr/' + ctx.repo.name };
  },
  observe(ctx) {
    fs.appendFileSync(at(ctx, 'observed.log'), ctx.repo.name + '\\n');
    const st = read(at(ctx, 'observe.' + ctx.repo.name + '.state')) ?? read(at(ctx, 'observe.state')) ?? 'integrated';
    return st === '(none)' ? { evidence: 'pipeline 9' } : { state: st, evidence: 'pipeline 9' };
  },
  readback() { return { ok: true }; },
};`;
// Reports a state that is not documented and pushes nothing.
const brokenAdapter = `export default { integrate() { return { url: 'https://git.example.test/mr/x' }; }, observe() { return { state: 'merged' }; }, readback() { return { ok: true }; } };`;
// The fix: pushes HEAD to main and reports `integrated`.
const fixedAdapter = `import { execFileSync } from 'node:child_process';
export default {
  integrate(ctx) {
    execFileSync('git', ['pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main'], { cwd: ctx.worktree });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: ctx.worktree });
    return { url: 'https://git.example.test/mr/y' };
  },
  observe() { return { state: 'integrated' }; },
  readback() { return { ok: true }; },
};`;

const observedCalls = (root) => (fs.existsSync(path.join(root, '..', 'observed.log')) ? fs.readFileSync(path.join(root, '..', 'observed.log'), 'utf8').split('\n').filter(Boolean).length : 0);
const ledger = (root, id) => fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', id, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Commits and pushes the fixed adapter on the base branch of the repo holding `.workflow/`.
function pushFix(dir, rel = '.workflow/delivery/mr.mjs') {
  sh(dir, 'git checkout -q main && git pull -q --ff-only origin main');
  fs.writeFileSync(path.join(dir, rel), fixedAdapter);
  sh(dir, 'git add -A && git commit -qm "fix the delivery adapter" && git push -q origin main');
  return sh(dir, 'git rev-parse HEAD');
}

// The documented recovery: the refusal without a commit shows what changes; the owner's confirmation is the tip typed
// back; it is recorded with both pins and the reason.
function repin(root, id, tip, { delivered = 'nothing yet', left, failFirst = null }) {
  const preview = wf(root, ['deliver', '--attempt', id, '--repin-adapter', '--reason', 'the delivery adapter reported an undocumented state']);
  assert.equal(preview.code, 75, preview.err);
  assert.match(preview.err, new RegExp(`from: \\S+@[0-9a-f]{10} \\(delivery kind ./delivery/mr.mjs\\)\\n  to:   \\S+@${tip.slice(0, 10)}, the tip of origin/main`));
  assert.match(preview.err, /adapter files that differ: \.workflow\/delivery\/mr\.mjs/);
  assert.match(preview.err, new RegExp(`recorded so far: ${delivered}`));
  assert.match(preview.err, new RegExp(`still to deliver: ${left}`));
  assert.match(preview.err, /the gate, the review and the tracker stay on the admission pin/);
  assert.match(preview.err, new RegExp(`\`wf deliver --repin-adapter ${tip.slice(0, 12)} --reason "<why>"\``));
  assert.match(wf(root, ['deliver', '--attempt', id, '--repin-adapter', 'deadbeef00', '--reason', 'x']).err, new RegExp(`deadbeef00 is not the tip of origin/main \\(${tip.slice(0, 10)}\\)`));
  assert.match(wf(root, ['deliver', '--attempt', id, '--repin-adapter', tip.slice(0, 12)]).err, /--reason is required/);
  assert.equal(state(root, id).deliveryAdapterBase, null, 'nothing re-pinned by a refused try');
  const before = state(root, id).adapterBase;
  const confirm = () => wf(root, ['deliver', '--attempt', id, '--repin-adapter', tip.slice(0, 12), '--reason', 'the delivery adapter reported an undocumented state']);
  if (failFirst) {
    // A later step fails after the re-pin was recorded: the same command is accepted again (not refused as "already at
    // the tip"), and the re-pin is recorded once.
    const restore = failFirst();
    assert.notEqual(confirm().code, 0);
    assert.equal(state(root, id).deliveryAdapterBase, tip);
    restore();
  }
  const d = ok(confirm());
  assert.equal(ledger(root, id).filter((e) => e.type === 'adapter.repinned').length, 1);
  const s = state(root, id);
  assert.equal(s.deliveryAdapterBase, tip, 'delivery reads the adapter at the base tip');
  assert.equal(s.adapterBase, before, 'the admission pin (gate, review, tracker) is unchanged');
  const rec = ledger(root, id).find((e) => e.type === 'adapter.repinned');
  assert.equal(rec.data.from, before);
  assert.equal(rec.data.to, tip);
  assert.equal(rec.data.reason, 'the delivery adapter reported an undocumented state');
  assert.match(d.out, new RegExp(`delivery adapter re-pinned from ${before.slice(0, 10)} to ${tip.slice(0, 10)}`));
  return s;
}

function accepted(root, base, id, wt, change, { planner = true } = {}) {
  if (planner) ok(wf(root, ['handoff', 'planner', '--agent', `p-${id}`, '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', `i-${id}`, '--attempt', id]));
  for (const [w, files] of wt) commitIn(w, files);
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', `r-${id}`, '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure(`r-${id}`)), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
}

test('I-20: an adapter that merged and then reports ci-failed is asked again on retry; the owner acknowledges that repo and state; it is recorded and shown', () => {
  const { base, root, remote } = singleRepoProject('post-merge', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': scriptedAdapter });
  fs.writeFileSync(path.join(base, 'observe.state'), 'ci-failed');
  const { id } = toAccepted(root, base, { item: 'ENG-90' });
  const r1 = wf(root, ['deliver', '--attempt', id]);
  assert.equal(r1.code, 75, r1.err);
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b', 'the adapter pushed to the target branch');
  assert.match(r1.err, /not delivered: app: [0-9a-f]{10} is already on origin\/main, but the delivery adapter reports ci-failed after the merge \(https:\/\/git\.example\.test\/mr\/app\): pipeline 9; being on the target branch alone does not count as a clean delivery/);
  assert.match(r1.err, /`wf deliver --acknowledge-adapter-state app:ci-failed`/);
  assert.equal(state(root, id).delivery.integrating.app.observed.state, 'ci-failed', 'the last adapter-reported state is recorded');
  // The retry no longer counts git ancestry alone: the adapter is asked again, and the same refusal stands.
  const calls = observedCalls(root);
  const r2 = wf(root, ['deliver', '--attempt', id]);
  assert.equal(r2.code, 75);
  assert.match(r2.err, /reports ci-failed after the merge/);
  assert.equal(observedCalls(root), calls + 1, 'observe was called again on the retry');
  assert.deepEqual(state(root, id).delivery.repos, {}, 'nothing recorded as delivered');
  // An acknowledgement of another state does not count.
  assert.match(wf(root, ['deliver', '--attempt', id, '--acknowledge-adapter-state', 'app:rejected']).err, /reports ci-failed after the merge/);
  const d = ok(wf(root, ['deliver', '--attempt', id, '--acknowledge-adapter-state', 'app:ci-failed']));
  assert.match(d.out, /app@[0-9a-f]{10} \[adapter: ci-failed\]/);
  assert.match(d.out, /not a clean adapter delivery \(show this to the owner\):\n  app: on origin\/main while the delivery adapter reported ci-failed \(pipeline 9\); acknowledged by the owner as app:ci-failed/);
  const rec = state(root, id).delivery.repos.app;
  assert.equal(rec.recovered, true);
  assert.equal(rec.adapterState, 'ci-failed');
  assert.equal(rec.acknowledged, 'app:ci-failed');
});

test('I-20: a pending state after the merge waits and says the change is on the target; once the adapter reports integrated it delivers with no acknowledgement', () => {
  const { base, root } = singleRepoProject('post-merge-pending', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': scriptedAdapter });
  fs.writeFileSync(path.join(base, 'observe.state'), 'ci-running');
  const { id } = toAccepted(root, base, { item: 'ENG-91' });
  assert.match(ok(wf(root, ['deliver', '--attempt', id])).out, /app: ci-running \(https:\/\/git\.example\.test\/mr\/app\)\. Run `wf deliver` again/);
  const w = ok(wf(root, ['deliver', '--attempt', id]));
  assert.match(w.out, /app: ci-running \(https:\/\/git\.example\.test\/mr\/app\); the change is already on origin\/main\. Run `wf deliver` again once it is merged\./);
  fs.writeFileSync(path.join(base, 'observe.state'), 'integrated');
  const d = ok(wf(root, ['deliver', '--attempt', id]));
  assert.doesNotMatch(d.out, /not a clean adapter delivery/);
  const rec = state(root, id).delivery.repos.app;
  assert.equal(rec.adapterState, 'integrated');
  assert.equal(rec.recovered, true);
  assert.equal(rec.acknowledged, undefined);
});

test('I-22: an adapter fault after the change merged into the base (no state, or an undocumented one): the owner acknowledges it', () => {
  const { base, root, remote } = singleRepoProject('post-merge-fault', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': scriptedAdapter });
  fs.writeFileSync(path.join(base, 'observe.state'), '(none)');
  const { id } = toAccepted(root, base, { item: 'ENG-92' });
  const r = wf(root, ['deliver', '--attempt', id]);
  assert.match(r.err, /is already on origin\/main, but the delivery adapter reports no state after the merge/);
  assert.match(r.err, /`wf deliver --acknowledge-adapter-state app:none`/);
  assert.match(r.err, /An adapter that reports a wrong state is fixed on the base branch, then `wf deliver --repin-adapter --reason "<why>"`/);
  fs.writeFileSync(path.join(base, 'observe.state'), 'merged');
  assert.match(wf(root, ['deliver', '--attempt', id, '--acknowledge-adapter-state', 'app:none']).err, /reports an unknown state "merged" after the merge/);
  ok(wf(root, ['deliver', '--attempt', id, '--acknowledge-adapter-state', 'app:merged']));
  assert.equal(state(root, id).delivery.repos.app.adapterState, 'merged');
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
});

test('I-21/I-22: a broken adapter, single repo after `wf base merge`: a fix only in the working tree or only committed locally does not count; the re-pin delivers', () => {
  const { base, root, remote } = singleRepoProject('repin-single', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': brokenAdapter, 'src/other.txt': 'o\n' });
  const e = ok(wf(root, ['entry', '--item', 'ENG-93', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  sh(root, "printf 'o2\\n' > src/other.txt && git commit -qam 'unrelated base change' && git push -q origin main");
  ok(wf(root, ['base', 'merge', '--attempt', e.id]));
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  assert.match(wf(root, ['deliver', '--attempt', e.id]).err, /reported an unknown state "merged"[\s\S]*wf deliver --repin-adapter --reason/);
  // The trust rule: the working tree's adapter, and a commit not on the remote base branch, are never read.
  fs.writeFileSync(path.join(root, '.workflow', 'delivery', 'mr.mjs'), fixedAdapter);
  assert.match(wf(root, ['deliver', '--attempt', e.id, '--repin-adapter', '--reason', 'x']).err, /not re-pinned: the adapter files at the tip of origin\/main \([0-9a-f]{10}\) are the same as at the current pin/);
  sh(root, 'git add -A && git commit -qm "fix, not pushed"');
  assert.match(wf(root, ['deliver', '--attempt', e.id, '--repin-adapter', '--reason', 'x']).err, /are the same as at the current pin[\s\S]*a fix only in the working tree, or committed but not pushed, is never read/);
  // A rewritten base branch (its tip does not contain the current pin) is refused.
  sh(root, 'git checkout -q --orphan rewritten && git commit -qm rewritten && git push -q -f origin rewritten:main && git checkout -q main');
  assert.match(wf(root, ['deliver', '--attempt', e.id, '--repin-adapter', '--reason', 'x']).err, /not re-pinned: origin\/main \([0-9a-f]{10}\) does not contain the current pin [0-9a-f]{10}; the adapter is re-pinned only forward along the base branch/);
  sh(root, 'git push -q -f origin main');
  const tip = sh(root, 'git rev-parse HEAD');
  const s = repin(root, e.id, tip, { left: 'app' });
  assert.ok(s.delivery.completedAt);
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/other.txt`), 'o2');
});

function multiRepo(name, adapter) {
  const base = tmp(name);
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const cfg = {
    version: 1,
    enabled: true,
    name,
    adapterRepo: 'api',
    repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }],
    lanes: ['quick', 'standard', 'batch'],
    components: [
      { id: 'api', kind: 'service', repo: 'api', provides: [{ contract: 'http', spec: 'openapi.json' }] },
      { id: 'web', kind: 'web', repo: 'web', dependsOn: [{ component: 'api', via: 'http', contract: 'api/openapi.json' }] },
    ],
    delivery: { kind: './delivery/mr.mjs' },
    gate: { steps: [{ id: 'api-unit', repo: 'api', run: 'true', inputs: ['src/**'] }, { id: 'web-unit', repo: 'web', run: 'true', inputs: ['src/**'] }] },
  };
  makeRepo(path.join(root, 'api'), { '.workflow/project.yaml': yaml(cfg), '.workflow/delivery/mr.mjs': adapter, 'openapi.json': '{}\n', 'src/a.txt': 'a\n' });
  makeRepo(path.join(root, 'web'), { 'src/w.txt': 'w\n' });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  return { base, root };
}

test('I-21/I-22: several repos, one delivered, then the adapter faults: abandon names the case; the re-pin delivers the rest', () => {
  const { base, root } = multiRepo('repin-multi', scriptedAdapter);
  // api (delivered first) is pushed and integrated; web is not pushed and the adapter reports an undocumented state.
  fs.writeFileSync(path.join(base, 'push.web'), 'no');
  fs.writeFileSync(path.join(base, 'observe.web.state'), 'merged');
  const e = ok(wf(root, ['entry', '--item', 'ENG-94', '--owner', 'o', '--json'])).json();
  accepted(root, base, e.id, [[e.repos.api.worktree, { 'src/a.txt': 'api\n' }], [e.repos.web.worktree, { 'src/w.txt': 'web\n' }]]);
  const r = wf(root, ['deliver', '--attempt', e.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /not delivered: web: the delivery adapter reported an unknown state "merged"/);
  assert.equal(state(root, e.id).delivery.repos.api.adapterState, 'integrated');
  const a = wf(root, ['abandon', '--reason', 'x', '--attempt', e.id]);
  assert.equal(a.code, 75);
  assert.match(a.err, /ENG-94\.1 is partly delivered: api delivered \([0-9a-f]{10} on origin\/main\); a delivered repo cannot be taken back/);
  assert.match(a.err, /`wf deliver --repin-adapter --reason "<why>"`/);
  const tip = pushFix(path.join(root, 'api'));
  const s = repin(root, e.id, tip, { delivered: 'api delivered [0-9a-f]{10}', left: 'web' });
  assert.ok(s.delivery.completedAt);
  assert.equal(sh(base, `git --git-dir=${path.join(root, 'web')}.origin.git show main:src/w.txt`), 'web');
  assert.equal(s.delivery.repos.api.adapterState, 'integrated', 'the repo delivered before the re-pin keeps its record');
});

test('I-22: several repos, the unchanged one recorded as skipped before the fault: abandon accepts it (nothing was pushed) and the re-pin also delivers', () => {
  const { base, root } = multiRepo('repin-skipped', brokenAdapter);
  const e = ok(wf(root, ['entry', '--item', 'ENG-95', '--owner', 'o', '--json'])).json();
  // Only web changes; api (first in the delivery order) is recorded as skipped, then web faults.
  accepted(root, base, e.id, [[e.repos.web.worktree, { 'src/w.txt': 'web\n' }]]);
  assert.match(wf(root, ['deliver', '--attempt', e.id]).err, /web: the delivery adapter reported an unknown state "merged"/);
  assert.equal(state(root, e.id).delivery.repos.api.skipped, 'no changes');
  const tip = pushFix(path.join(root, 'api'));
  const s = repin(root, e.id, tip, { delivered: 'api skipped \\(no changes\\)', left: 'web' });
  assert.ok(s.delivery.completedAt);
  assert.equal(sh(base, `git --git-dir=${path.join(root, 'web')}.origin.git show main:src/w.txt`), 'web');
  // The other recovery for this case: abandon is accepted when every recorded repo was skipped.
  const p2 = multiRepo('abandon-skipped', brokenAdapter);
  const e2 = ok(wf(p2.root, ['entry', '--item', 'ENG-96', '--owner', 'o', '--json'])).json();
  accepted(p2.root, p2.base, e2.id, [[e2.repos.web.worktree, { 'src/w.txt': 'web\n' }]]);
  assert.notEqual(wf(p2.root, ['deliver', '--attempt', e2.id]).code, 0);
  ok(wf(p2.root, ['abandon', '--reason', 'broken adapter', '--attempt', e2.id]));
  assert.equal(state(p2.root, e2.id).phase, 'abandoned');
  assert.deepEqual(ledger(p2.root, e2.id).find((x) => x.type === 'abandoned').data.skipped, ['api']);
});

test('I-22: quick lane: a broken adapter refuses; the re-pin delivers', () => {
  const { base, root, remote } = singleRepoProject('repin-quick', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': brokenAdapter });
  const e = ok(wf(root, ['entry', '--owner', 'o', '--json'])).json();
  assert.equal(e.lane, 'quick');
  accepted(root, base, e.id, [[e.repos.app.worktree, { 'src/a.txt': 'quick\n' }]], { planner: false });
  assert.match(wf(root, ['deliver', '--attempt', e.id]).err, /reported an unknown state "merged"/);
  const tip = pushFix(root);
  const moved = `${remote}.moved`;
  const s = repin(root, e.id, tip, { left: 'app', failFirst: () => (fs.renameSync(remote, moved), () => fs.renameSync(moved, remote)) });
  assert.ok(s.delivery.completedAt);
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'quick');
});

test('I-22: batch: a broken adapter refuses the batch; members cannot re-pin; the batch re-pin delivers every member', () => {
  const heavy = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'true', tier: 'heavy' }];
  const { base, root, remote } = singleRepoProject('repin-batch', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps: heavy } }, { '.workflow/delivery/mr.mjs': brokenAdapter, 'src/b.txt': 'b\n' });
  const m1 = toAccepted(root, base, { item: 'ENG-97', change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] });
  const m2 = toAccepted(root, base, { item: 'ENG-98', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', b.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb', '--attempt', b.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'rb', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [] }), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id]));
  assert.match(wf(root, ['deliver', '--attempt', b.id]).err, /reported an unknown state "merged"/);
  const tip = pushFix(root);
  assert.match(wf(root, ['deliver', '--attempt', m1.id, '--repin-adapter', tip.slice(0, 12), '--reason', 'x']).err, /is a member of BATCH-1; deliver the batch instead/);
  const s = repin(root, b.id, tip, { left: 'app' });
  assert.ok(s.delivery.completedAt);
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'one');
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/b.txt`), 'two');
  for (const m of [m1.id, m2.id]) assert.equal(state(root, m).phase, 'done');
});
