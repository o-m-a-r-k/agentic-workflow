import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closureFile, commitIn, goodClosure, ok, sh, singleRepoProject, state, toAccepted, wf } from './helpers.mjs';
import { readLedger } from '../engine/ledger.mjs';

// 0.7.30 (I-201, D62): delivery to a branch other than a repo's configured base, and to more than one branch.
// Named failure (field): an accepted ticket targeted master and the person asked for it on a divergent staging branch too
// ("commit and push straight to staging and master"). The adapter knew one base per repo and `wf entry` took no target, so
// the accepted change was applied to staging by hand outside the workflow; it conflicted, its fixture verification failed,
// and it was thrown away.

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];

// A project whose `staging` branch diverged from `main`: each holds a commit the other does not.
function diverged(name, stagingFiles = { 'src/s.txt': 'staging only\n' }) {
  const p = singleRepoProject(name, { gate: { steps } });
  sh(p.root, 'git checkout -q -b staging');
  commitIn(p.root, stagingFiles, 'staging: its own change');
  sh(p.root, 'git push -q origin staging && git checkout -q main');
  commitIn(p.root, { 'src/m.txt': 'main only\n' }, 'main: its own change');
  sh(p.root, 'git push -q origin main');
  return p;
}
const show = (base, remote, ref) => sh(base, `git --git-dir=${remote} show ${ref}`);

// The rest of an attempt whose tree already holds its change: a code review, the gate, the evidence review, accept.
function reviewAndAccept(root, base, id, n) {
  ok(wf(root, ['handoff', 'reviewer', '--agent', `rc-${n}`, '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure(`rc-${n}`)), '--attempt', id]));
  ok(wf(root, ['gate', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', `re-${n}`, '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure(`re-${n}`)), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
}

test('I-201: an attempt is based on and delivered to its own branch; the same item on another branch is its own attempt', async () => {
  const { base, root, remote } = diverged('target-own');
  const { id, wt } = toAccepted(root, base, { item: 'ENG-401', extraEntry: ['--target', 'app=staging'] });
  const s = state(root, id);
  assert.equal(s.repos.app.target, 'staging');
  assert.equal(s.repos.app.baseRef, 'origin/staging');
  assert.equal(sh(wt, 'cat src/s.txt'), 'staging only', 'the worktree starts from staging');
  assert.match(ok(wf(root, ['status', '--attempt', id])).out, /delivered to: app -> staging \(its own target, not the repo's base\)/);
  const { trustedAdapter } = await import('../engine/config.mjs');
  assert.equal(trustedAdapter(root, s).repos.find((r) => r.name === 'app').base, 'staging', 'a delivery adapter is handed staging as the repo\'s base');
  // The same item on the repo's base is another attempt; a second one on staging is refused.
  ok(wf(root, ['entry', '--item', 'ENG-401', '--owner', 'o', '--json']));
  assert.match(wf(root, ['entry', '--item', 'ENG-401', '--target', 'app=staging', '--owner', 'o']).err, /ENG-401 already has an open attempt ENG-401\.1/);
  assert.match(wf(root, ['entry', '--item', 'ENG-409', '--target', 'app=nowhere', '--owner', 'o']).err, /cannot fetch origin\/nowhere|branch nowhere does not exist in app/);
  const d = ok(wf(root, ['deliver', '--attempt', id]));
  assert.match(d.out, /delivered ENG-401\.1: app@[0-9a-f]{10} -> origin\/staging/);
  assert.equal(show(base, remote, 'staging:src/a.txt'), 'b');
  assert.equal(show(base, remote, 'main:src/a.txt'), 'a', 'main is not touched');
  assert.equal(sh(base, `git --git-dir=${remote} ls-tree --name-only staging src/`).includes('src/m.txt'), false, "main's own change is not carried to staging");
});

test('I-201: an additional target recorded at admission is ported by `wf deliver`: the change, its criteria, its own review, gate and delivery; no ticket status moves', async () => {
  const { base, root, remote } = diverged('target-also');
  const { id } = toAccepted(root, base, { item: 'ENG-402', extraEntry: ['--also-target', 'app=staging'] });
  assert.match(ok(wf(root, ['status', '--attempt', id])).out, /also to deliver: app -> staging \(recorded at admission\): its port is admitted by `wf deliver` once this delivery is complete/);
  const d = ok(wf(root, ['deliver', '--attempt', id]));
  assert.match(d.out, /also to deliver app -> staging: admitted its port ENG-402\.2; it is gated, reviewed, accepted and delivered like any attempt/);
  assert.equal(show(base, remote, 'main:src/a.txt'), 'b');
  const port = state(root, 'ENG-402.2');
  assert.equal(port.portOf, id);
  assert.equal(port.repos.app.target, 'staging');
  assert.equal(port.port.repos.app.applied.length, 1, "the source's own commit, without main's");
  assert.deepEqual(port.criteria.map((c) => c.id), state(root, id).criteria.map((c) => c.id), 'judged by the criteria its source froze');
  assert.equal(readLedger(root, 'ENG-402.2').find((e) => e.type === 'criteria.frozen').data.source.port, id);
  assert.match(ok(wf(root, ['status', '--attempt', id])).out, /also to deliver: app -> staging \(recorded at admission\): ported by ENG-402\.2/);
  reviewAndAccept(root, base, port.id, 'p');
  ok(wf(root, ['deliver', '--attempt', port.id]));
  assert.equal(show(base, remote, 'staging:src/a.txt'), 'b');
  assert.equal(show(base, remote, 'staging:src/s.txt'), 'staging only');
  assert.equal(readLedger(root, port.id).filter((e) => e.type.startsWith('tracker.')).length, 0, 'a port moves no ticket status');
  const { hasTicket } = await import('../engine/tracker.mjs');
  assert.equal(hasTicket(state(root, port.id)), false, "the ticket's status and comments are its source's");
});

test('I-201: a target added after admission is recorded with its reason; a commit that does not apply to it is reported, not hidden', () => {
  const { base, root } = diverged('target-conflict', { 'src/a.txt': 'staging edits a\n' });
  const { id } = toAccepted(root, base, { item: 'ENG-403' });
  assert.match(wf(root, ['entry', '--item', 'ENG-404', '--port', id, '--target', 'app=staging', '--owner', 'o']).err, /--port: ENG-403\.1 is ENG-403, not ENG-404/);
  ok(wf(root, ['target', 'add', 'app=staging', '--reason', 'the person: "push straight to staging and master"', '--attempt', id]));
  const added = state(root, id).alsoTargets;
  assert.deepEqual(added.map((t) => [t.repo, t.branch, t.reason]), [['app', 'staging', 'the person: "push straight to staging and master"']]);
  const d = ok(wf(root, ['deliver', '--attempt', id]));
  assert.match(d.out, /admitted its port ENG-403\.2 \(a commit did not apply: `wf resume --attempt ENG-403\.2` names it\)/);
  const port = state(root, 'ENG-403.2');
  assert.deepEqual(port.port.repos.app.conflict.files, ['src/a.txt']);
  assert.equal(port.port.repos.app.applied.length, 0);
  assert.match(ok(wf(root, ['status', '--attempt', port.id])).out, /PORT CONFLICT in app: [0-9a-f]{10} "change" does not apply to staging \(src\/a\.txt\); 1 commit\(s\) left: an implementer ports them by hand against the frozen criteria \(`git cherry-pick -x [0-9a-f]{12}` and on, resolving each\)/);
  assert.equal(sh(port.repos.app.worktree, 'git status --porcelain'), '', 'the worktree is left clean, on staging');
  assert.match(wf(root, ['entry', '--port', 'ENG-404.1', '--target', 'app=staging', '--owner', 'o']).err, /--port: no attempt `ENG-404\.1`/);
});
