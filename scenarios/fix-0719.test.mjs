import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, WF, wf } from './helpers.mjs';
import { knownLimits } from '../engine/tracker.mjs';

// 0.7.19, named failure (field): an implementer fixed a high privacy defect, then recorded it; every route to close it
// with that commit was refused ("already in the tree it was recorded on"), an independent review that verified the fix
// could not close it either, and the owner agent asked the person to approve changing the workflow itself.
test('a defect fixed before it was recorded closes on a reviewer\'s verification of that commit, at any level, never on the owner\'s word', () => {
  const p = singleRepoProject('predating-fix', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } }, { 'src/a.txt': 'l1\nl2\nl3\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'PF-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  const wt = e.repos.app.worktree;
  commitIn(wt, { 'src/a.txt': 'l1\nL2 covered\nl3\n' }, 'keep the privacy cover above the app');
  const fix = sh(wt, 'git rev-parse HEAD');
  const d = (args) => wf(p.root, ['discovered', ...args, '--attempt', e.id], { ownerSilent: true });
  ok(d(['add', '--summary', 'The privacy cover can sit below the app window', '--severity', 'high', '--found-by', 'i', '--where', 'src/a.txt:2']));
  // The owner names the fix: it predates the record, so it is a claim the next reviewer verifies; no question for the person.
  const claimed = ok(d(['close', 'D1', '--fixed', fix]));
  assert.match(claimed.out, /D1: \S+ was made before D1 was recorded, so a reviewer verifies it: hand a reviewer .*No question for the person\./);
  let s = state(p.root, e.id);
  assert.equal(s.discovered[0].status, 'open');
  assert.equal(s.discovered[0].claim.commit, fix);
  assert.equal((s.decisions ?? []).length, 0, 'no decision for the person');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  // The reviewer's bundle asks it to verify that commit.
  const handed = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
  const bundle = JSON.parse(fs.readFileSync(handed.out.match(/^Read (\S+)/m)[1], 'utf8'));
  const listed = bundle.discovered.find((x) => x.id === 'D1');
  assert.equal(listed.claimedFixed.commit, fix);
  assert.match(listed.claimedFixed.note, /the reviewer checks that commit and gives `discovered: \[\{ "id": "D1", "verdict": "fixed" \| "open"/);
  // A reviewer that says nothing about it leaves it open.
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r1')), '--attempt', e.id]));
  assert.equal(state(p.root, e.id).discovered[0].status, 'open');
  // Its `fixed` verdict closes it, bound to the claimed commit and the reviewer.
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', e.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r2', { discovered: [{ id: 'D1', verdict: 'fixed', evidence: 'src/a.txt:2 the cover is ordered above the app root' }] })), '--attempt', e.id]));
  s = state(p.root, e.id);
  assert.equal(s.discovered[0].status, 'fixed');
  assert.equal(s.discovered[0].fixed.commit, fix);
  assert.equal(s.discovered[0].fixed.verifiedBy.reviewer, 'r2');
  assert.equal(s.discovered[0].claim, undefined);
  assert.doesNotMatch(knownLimits(s), /not verified by a reviewer/, 'a reviewer verified it');
});

// The field order: a reviewer already verified the fix (its bundle listed the entry), then the owner names the commit.
test('a reviewer that verified a defect before the owner names its predating fix lets that close at once; a mixed close closes and claims', () => {
  const p = singleRepoProject('predating-verified', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } }, { 'src/a.txt': 'l1\nl2\nl3\n', 'src/b.txt': 'b1\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'PF-2', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  const wt = e.repos.app.worktree;
  commitIn(wt, { 'src/a.txt': 'l1\nL2 covered\nl3\n' }, 'the fix');
  const fix = sh(wt, 'git rev-parse HEAD');
  const d = (args) => wf(p.root, ['discovered', ...args, '--attempt', e.id], { ownerSilent: true });
  ok(d(['add', '--summary', 'The privacy cover can sit below the app window', '--severity', 'high', '--found-by', 'i', '--where', 'src/a.txt:2']));
  ok(d(['add', '--summary', 'A second label is cut off', '--severity', 'medium', '--found-by', 'i', '--where', 'src/b.txt:1']));
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r1', { discovered: [{ id: 'D1', verdict: 'fixed', evidence: 'src/a.txt:2 the cover is above the app' }] })), '--attempt', e.id]));
  // A verdict is no close by itself; the owner's close with the predating commit then closes D1 on that verification,
  // while D2, which no reviewer verified, is claimed.
  assert.equal(state(p.root, e.id).discovered[0].status, 'open');
  const both = ok(d(['close', 'D1,D2', '--fixed', fix]));
  assert.match(both.out, /D1 fixed in app@\S+ \(made before it was recorded; verified by reviewer r1\)/);
  assert.match(both.out, /D2: \S+ was made before D2 was recorded, so a reviewer verifies it/);
  const s = state(p.root, e.id);
  assert.deepEqual([s.discovered[0].status, s.discovered[0].fixed.verifiedBy.reviewer, s.discovered[0].fixed.beforeRecord], ['fixed', 'r1', true]);
  assert.equal(s.discovered[1].status, 'open');
  // `wf resume` and the list name the reviewer route for what is claimed, not a new fix.
  assert.match(ok(wf(p.root, ['resume', '--attempt', e.id])).out, /D2 \(claimed fixed in app@\S+, made before it was recorded\): a reviewer verifies each; hand a reviewer/);
  assert.match(ok(d(['list'])).out, /D2 {2}open {2}medium .*claimed fixed in app@\S+ \(made before it was recorded; a reviewer's `fixed` closes it\)/);
});

test('a copy of wf older than the installed release runs the installed one; the same or a newer copy, or WF_NO_FORWARD, runs as it is', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-fwd-'));
  const release = path.join(home, 'release');
  fs.mkdirSync(path.join(release, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(release, 'package.json'), JSON.stringify({ version: '99.0.0' }));
  fs.writeFileSync(path.join(release, 'bin', 'wf'), "#!/usr/bin/env node\nprocess.stdout.write(`installed ran: ${process.argv.slice(2).join(' ')} ${process.env.WF_NO_FORWARD}`);\nprocess.exit(7);\n");
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.symlinkSync(path.join(release, 'bin', 'wf'), path.join(home, '.local', 'bin', 'wf'));
  const run = (env) => spawnSync(process.execPath, [WF, '--version'], { env: { ...process.env, HOME: home, WF_NO_FORWARD: '', ...env }, encoding: 'utf8' });
  const forwarded = run({});
  assert.equal(forwarded.status, 7, 'the installed exit code');
  assert.match(forwarded.stdout, /^installed ran: --version 1$/);
  assert.match(forwarded.stderr, /wf: this copy is \S+ \(.*\); running the installed 99\.0\.0 instead\. Run `wf` from your PATH, not a copy \(WF_NO_FORWARD=1 runs this copy anyway\)\./);
  const own = run({ WF_NO_FORWARD: '1' });
  assert.equal(own.status, 0);
  assert.doesNotMatch(own.stdout, /installed ran/);
  // `wf install` always runs as it is: linking an older release is how a rollback is installed.
  const install = spawnSync(process.execPath, [WF, 'install', '--dir', path.join(home, 'bin2')], { env: { ...process.env, HOME: home, WF_NO_FORWARD: '' }, encoding: 'utf8' });
  assert.doesNotMatch(install.stdout, /installed ran/);
  assert.match(install.stdout, /linked /);
  fs.writeFileSync(path.join(release, 'package.json'), JSON.stringify({ version: '0.0.1' }));
  assert.doesNotMatch(run({}).stdout, /installed ran/, 'an older installed release is not run');
  fs.rmSync(home, { recursive: true, force: true });
});
