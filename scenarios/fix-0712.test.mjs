// 0.7.12: four causes found in the audit of role launches and the refusal log, each with its named failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { commitIn, criteriaFile, ok, sh, singleRepoProject, state, WF, wf, write } from './helpers.mjs';
import { computeSignals, courseLines, pastEstimates } from '../engine/signals.mjs';
import { loadState } from '../engine/ledger.mjs';
import { transactionSeams, withEvidenceTransaction } from '../engine/evidence.mjs';

// ---- I-137: an implementer whose launch completed, left open by the owner for 269 minutes, read as "working, past its own
// estimate" and the owner was told to judge its course. ----
// A native codex that finishes its turn at once (exit 0), as a completed implementer launch.
function preparedDone() {
  const p = singleRepoProject('i137', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const { base, root } = p, dir = path.join(base, 'bin'), host = path.join(base, '.home');
  write(dir, 'codex', `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
fs.readFileSync(0,'utf8'); const sid = '01a110b4-1637-7a42-b353-d0ad25e60000';
const at = new Date().toISOString(), line=(x)=>JSON.stringify({timestamp:at,...x});
const file = path.join(${JSON.stringify(host)},'.codex','sessions','2026','10','08','rollout-test-'+sid+'.jsonl');
fs.mkdirSync(path.dirname(file),{recursive:true});
fs.writeFileSync(file, line({type:'session_meta',payload:{id:sid,timestamp:at,originator:'codex_exec',source:'exec',cwd:${JSON.stringify(root)}}})+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:sid}));
console.log(JSON.stringify({type:'turn.completed'}));
`);
  fs.chmodSync(path.join(dir, 'codex'), 0o755);
  write(dir, 'wf', '#!/bin/sh\nprintf stale-engine\n'); fs.chmodSync(path.join(dir, 'wf'), 0o755);
  const env = { PATH: dir + path.delimiter + process.env.PATH, WF_HOME: host };
  const id = ok(wf(root, ['entry', '--item', 'ENG-80', '--owner', 'o', '--json'], { env })).json().id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--runtime', 'codex', '--attempt', id], { env }));
  return { ...p, id, env, host };
}

test('I-137: a completed native implementer left open is shown as waiting on the owner, not as implementer work', () => {
  const { base, root, id, env, host } = preparedDone();
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id], { env }));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--runtime', 'codex', '--attempt', id], { env }));
  const h = state(root, id).handoffs.at(-1);
  fs.mkdirSync(path.dirname(h.reportFile), { recursive: true });
  // A report `wf handoff close` would refuse keeps it open (0.7.15 closes a completed implementer only when close would).
  fs.writeFileSync(h.reportFile, JSON.stringify([{ implementer: 'i', approach: 'edit a', expect: { minutes: 60 } }]));
  const run = wf(root, ['handoff', 'run', '--agent', 'i', '--attempt', id, '--json'], { env });
  assert.equal(run.code, 0, run.err);
  assert.match(run.err, /implementer i completed but is still open: i has not reported/);
  const s = state(root, id);
  assert.equal(s.handoffs.at(-1).launch.status, 'completed');
  assert.equal(s.implementers[0].closedAt, null, 'the owner has not closed it');
  // The owner comes back 269 minutes later.
  const nowMs = Date.parse(s.handoffs.at(-1).launch.finishedAt) + 269 * 60000;
  const sig = computeSignals(root, loadState(root, id), { nowMs, home: host });
  const lines = courseLines(sig).filter((l) => /implementer i/.test(l));
  const next = wf(root, ['resume', '--attempt', id], { env }).out.split('\n').filter((l) => /next:/.test(l)).join('\n');
  assert.doesNotMatch(lines.join('\n'), /is working: 2[0-9]{2} min/, 'finished work is not "working" for the owner\'s idle time');
  assert.deepEqual(pastEstimates(sig).filter((x) => /implementer i/.test(x)), [], 'owner idle time is not an implementer overrun');
  assert.match(lines.join('\n'), /finished after .* of observed execution.*waited for the owner to close it/);
  assert.match(next, /launch completed at .*: look at its report and commits once and close it now/);
});

// 0.7.15, named failure (lessons of one attempt): 4,381 of 11,083 implementer minutes (40%) were finished roles waiting
// for the owner to close them.
test('a launched implementer that completes with its work committed and its report written is closed by the engine', () => {
  const { base, root, id, env } = preparedDone();
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id], { env }));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--runtime', 'codex', '--attempt', id], { env }));
  const h = state(root, id).handoffs.at(-1);
  fs.mkdirSync(path.dirname(h.reportFile), { recursive: true });
  fs.writeFileSync(h.reportFile, JSON.stringify({ implementer: 'i', approach: 'edit a', expect: { minutes: 60 }, summary: 'done', ran: [], proofs: [], left: [] }));
  const run = wf(root, ['handoff', 'run', '--agent', 'i', '--attempt', id, '--json'], { env });
  assert.equal(run.code, 0, run.err);
  assert.match(run.err, /implementer i completed and the engine closed it/);
  assert.equal(state(root, id).implementers[0].closedBy, 'engine', 'the ledger says who closed it');
  const again = wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', id], { env });
  assert.notEqual(again.code, 0);
  assert.match(again.err, /i is already closed: the engine closed it when its launch completed/);
});

// ---- I-140: `wf handoff wait --minutes N` counted N from the launch, so on a role past N it returned at once; a bare wait on
// a role past its own estimate did the same. ----
// A held fake codex (never completes), as scenarios/codex-run.test.mjs mode 'held'.
function preparedHeld() {
  const p = singleRepoProject('i140', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const { base, root } = p, dir = path.join(base, 'bin'), host = path.join(base, '.home');
  write(dir, 'codex', `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const prompt = fs.readFileSync(0,'utf8'); const sid = '01a110b4-1637-7a42-b353-d0ad25e60000';
const at = new Date().toISOString(), line=(x)=>JSON.stringify({timestamp:at,...x});
const file = path.join(${JSON.stringify(host)},'.codex','sessions','2026','10','08','rollout-test-'+sid+'.jsonl');
fs.mkdirSync(path.dirname(file),{recursive:true});
fs.writeFileSync(file, line({type:'session_meta',payload:{id:sid,timestamp:at,originator:'codex_exec',source:'exec',cwd:${JSON.stringify(root)}}})+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:sid}));
await new Promise(() => setInterval(() => {}, 1000));
`);
  fs.chmodSync(path.join(dir, 'codex'), 0o755);
  write(dir, 'wf', '#!/bin/sh\nprintf stale-engine\n'); fs.chmodSync(path.join(dir, 'wf'), 0o755);
  const env = { PATH: dir + path.delimiter + process.env.PATH, WF_HOME: host };
  const id = ok(wf(root, ['entry', '--item', 'ENG-80', '--owner', 'o', '--json'], { env })).json().id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--runtime', 'codex', '--attempt', id], { env }));
  return { ...p, id, env };
}

test('I-140: `handoff wait --minutes N` on a role already past its own estimate waits N more minutes', { timeout: 60_000 }, async () => {
  const { base, root, id, env } = preparedHeld();
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id], { env }));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--runtime', 'codex', '--attempt', id, '--json'], { env }));
  const h = state(root, id).handoffs.at(-1);
  fs.mkdirSync(path.dirname(h.reportFile), { recursive: true });
  fs.writeFileSync(h.reportFile, JSON.stringify({ implementer: 'i', approach: 'edit a', expect: { minutes: 0.02 } })); // 1.2 s
  const run = wf(root, ['handoff', 'run', '--agent', 'i', '--attempt', id, '--json'], { env });
  assert.equal(run.code, 0, run.err);
  assert.match(run.err, /past its own estimate of 0\.02 min/);
  await new Promise((r) => setTimeout(r, 3000));                                // role is now ~4.5 s (0.075 min) old
  const t0 = Date.now();
  const waited = wf(root, ['handoff', 'wait', '--agent', 'i', '--minutes', '0.05', '--attempt', id, '--json'], { env }); // 3 s more
  const took = Date.now() - t0;
  try {
    assert.equal(waited.json().status, 'running');
    assert.match(waited.err, /the 0\.05 min you chose to wait/);
    assert.ok(took >= 2500, `wait --minutes 0.05 (3 s) returned after ${took} ms; the role was already ~0.075 min old`);
    // A bare wait on a role past its own estimate follows it to its end, not back at once.
    const bare = spawn(process.execPath, [WF, 'handoff', 'wait', '--agent', 'i', '--attempt', id], { cwd: root, env: { ...process.env, WF_HOME: env.WF_HOME, WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), WF_IMPROVEMENTS_DIR: path.join(root, '..', '.improvements'), PATH: env.PATH }, stdio: 'ignore' });
    const ended = new Promise((r) => bare.once('exit', r));
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(bare.exitCode, null, 'a bare wait is still following the role');
    ok(wf(root, ['handoff', 'stop', '--agent', 'i', '--reason', 'scenario', '--attempt', id], { env }));
    await ended;
  } finally {
    wf(root, ['handoff', 'stop', '--agent', 'i', '--reason', 'scenario', '--attempt', id], { env });
  }
});

// ---- I-139: an implementer repaired a bookkeeping item, then recorded it; every close with the repairing commit was refused
// as already in the tree. ----
const steps = [{ id: 'unit', repo: 'app', run: 'true' }];
const LINES = 'l1\nl2\nl3\n';
// An attempt with implementer `i` open; `pre` commits land before the handoff opened.
function project(name, { pre = false } = {}) {
  const p = singleRepoProject(name, { gate: { steps } }, { 'src/a.txt': LINES, 'tests/fixture.txt': 'f1\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'BK-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  const wt = e.repos.app.worktree;
  if (pre) commitIn(wt, { 'tests/fixture.txt': 'f1 early\n' }, 'before the handoff');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  return { ...p, id: e.id, wt };
}
const d = (p, args) => wf(p.root, ['discovered', ...args, '--attempt', p.id], { ownerSilent: true });
const late = (p, extra = []) => ok(d(p, ['add', '--summary', 'fixture bookkeeping: stale snapshot', '--kind', 'bookkeeping', '--severity', 'low', '--found-by', 'i', '--where', 'tests/fixture.txt:1', ...extra]));
const head = (p) => sh(p.wt, 'git rev-parse HEAD');

test('I-139: a bookkeeping entry recorded after its own handoff-made fix is reconciled, append-only, bound to that handoff', () => {
  const p = project('i139');
  commitIn(p.wt, { 'tests/fixture.txt': 'f1 fixed\n' }, 'the real fix');
  const fix = head(p);
  late(p);
  const before = state(p.root, p.id);
  ok(d(p, ['close', 'D1', '--fixed', fix]));
  const after = state(p.root, p.id);
  assert.equal(after.discovered[0].status, 'fixed');
  assert.equal(after.discovered[0].fixed.commit, fix);
  assert.equal(after.discovered[0].fixed.reconciled.agent, 'i');
  assert.equal(after.discovered[0].fixed.reconciled.handoff, after.implementers[0].handoff);
  assert.deepEqual(after.discovered[0].summary, before.discovered[0].summary);                                         // the record itself is untouched
  assert.match(ok(wf(p.root, ['verify', '--attempt', p.id])).out, /verified/);
  assert.match(ok(d(p, ['list'])).out, /repaired by i before it was recorded/);
});

test('I-139 guards: defects, invariants, unrated/medium, foreign commits, other handoffs and unrelated files are never reconciled; each is a claim (0.7.19)', () => {
  const p = project('i139g');
  commitIn(p.wt, { 'tests/fixture.txt': 'f1 fixed\n', 'src/a.txt': 'l1\nL2\nl3\n' }, 'the real fix');
  const fix = head(p);
  const refused = (args, re) => { const r = d(p, args); assert.notEqual(r.code, 0); assert.match(r.err, re); };
  ok(d(p, ['add', '--summary', 'a real defect', '--severity', 'low', '--found-by', 'i', '--where', 'tests/fixture.txt:1']));                       // D1 defect
  late(p, ['--invariant', 'tenant isolation']);                                                                                                    // D2 invariant
  ok(d(p, ['add', '--summary', 'unrated bookkeeping', '--kind', 'bookkeeping', '--found-by', 'i', '--where', 'tests/fixture.txt:1']));             // D3 unrated = high
  ok(d(p, ['add', '--summary', 'by a reviewer', '--kind', 'bookkeeping', '--severity', 'low', '--found-by', 'r9', '--where', 'tests/fixture.txt:1'])); // D4 foundBy not an implementer
  ok(d(p, ['add', '--summary', 'elsewhere', '--kind', 'bookkeeping', '--severity', 'low', '--found-by', 'i', '--where', 'docs/other.md:1']));       // D5 file not touched
  // A defect (0.7.19) is not refused: its claim waits for a reviewer's verification and closes nothing yet.
  assert.match(ok(d(p, ['close', 'D1', '--fixed', fix])).out, /D1: \S+ was made before D1 was recorded, so a reviewer verifies it/);
  // Not reconciled on the owner's word either (0.7.19): each is a claim a reviewer verifies, never closed here.
  for (const id of ['D2', 'D3', 'D4', 'D5']) assert.match(ok(d(p, ['close', id, '--fixed', fix])).out, new RegExp(`${id}: \\S+ was made before ${id} was recorded, so a reviewer verifies it`));
  assert.deepEqual(state(p.root, p.id).discovered.map((x) => x.status), ['open', 'open', 'open', 'open', 'open']);
});

test('I-139 guard: a commit from before the handoff opened is not reconciled; it is a claim a reviewer verifies (0.7.19)', () => {
  const p = project('i139h', { pre: true });
  const early = sh(p.wt, 'git rev-parse HEAD~0');       // made before the handoff, in the tree it started on
  commitIn(p.wt, { 'src/a.txt': 'l1\nL2\nl3\n' }, 'unrelated');
  late(p);
  assert.match(ok(d(p, ['close', 'D1', '--fixed', early])).out, /D1: \S+ was made before D1 was recorded, so a reviewer verifies it/);
  const s = state(p.root, p.id).discovered[0];
  assert.deepEqual([s.status, s.fixed, s.claim.commit], ['open', null, early]);
});

// ---- I-141: a lock released and re-taken between the collision and the read was refused as unreadable. ----
// Interleaving: owner releases after our EEXIST; our no-follow open gets ENOENT; another process creates a replacement
// regular lock before anything else looks. The replacement is released on the next collision.
test('I-141: replacement lock after ENOENT on the no-follow open is another collision, not an unreadable owner', () => {
  const p = singleRepoProject('i141', { gate: { steps: [] } });
  const control = path.join(p.root, '.wf-worktrees', '_transactions');
  fs.mkdirSync(control, { recursive: true });
  const lock = path.join(fs.realpathSync(control), 'ENG-1.1.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'owner' }));
  const realOpen = fs.openSync;
  let collisions = 0, replaced = false;
  transactionSeams.afterCollision = (file) => {
    collisions += 1;
    if (collisions === 1) fs.unlinkSync(file);                       // owner releases
    else fs.rmSync(file, { force: true });                           // replacement released on the next collision
  };
  fs.openSync = function (f, flags, ...rest) {
    const isRead = String(f) === lock && (flags & fs.constants.O_CREAT) === 0 && (flags & fs.constants.O_WRONLY) === 0;
    if (!isRead || replaced) return realOpen.call(fs, f, flags, ...rest);
    try { return realOpen.call(fs, f, flags, ...rest); }
    finally {   // runs after the ENOENT is determined, before the caller sees it
      replaced = true;
      fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, token: 'replacement' }));
    }
  };
  try { assert.equal(withEvidenceTransaction(p.root, 'ENG-1.1', () => 'acquired'), 'acquired'); }
  finally { fs.openSync = realOpen; transactionSeams.afterCollision = null; }
  assert.ok(replaced && collisions >= 2, `replacement seen (collisions ${collisions})`);
  // A link at the attempt's runner path is no obstacle to the transaction.
  fs.mkdirSync(path.join(p.root, '.wf-worktrees', 'ENG-1.1'), { recursive: true });
  fs.symlinkSync(p.base, path.join(p.root, '.wf-worktrees', 'ENG-1.1', '_runner'));
  assert.equal(withEvidenceTransaction(p.root, 'ENG-1.1', () => 'readable'), 'readable');
});

// What must keep failing closed after the fix.
test('I-141 guard: a symlink / a hard-linked / a directory at the lock path still refuses as unreadable', () => {
  const p = singleRepoProject('i141g', { gate: { steps: [] } });
  const control = path.join(p.root, '.wf-worktrees', '_transactions');
  fs.mkdirSync(control, { recursive: true });
  const lock = path.join(fs.realpathSync(control), 'ENG-1.1.lock');
  fs.symlinkSync(path.join(p.base, 'outside'), lock);
  assert.throws(() => withEvidenceTransaction(p.root, 'ENG-1.1', () => {}), /control path|unreadable/);
  assert.equal(fs.existsSync(path.join(p.base, 'outside')), false, 'nothing is written through the link');
  fs.unlinkSync(lock);
  fs.writeFileSync(path.join(p.base, 'other'), '{}'); fs.linkSync(path.join(p.base, 'other'), lock);
  assert.throws(() => withEvidenceTransaction(p.root, 'ENG-1.1', () => {}), /unreadable/);
  fs.unlinkSync(lock);
  fs.mkdirSync(lock);
  assert.throws(() => withEvidenceTransaction(p.root, 'ENG-1.1', () => {}), /unreadable/);
});

// ---- Second review of 0.7.12: a strategist's delta decision after a partial round only took the delta from the partial
// round's tree, so what it never reached went to no reviewer. ----
test('a strategist delta decision after only a partial round hands a full round', async () => {
  const { roundMode } = await import('../engine/review-policy.mjs');
  const partialOnly = { engineVersion: '0.7.12', handoffs: [{ role: 'reviewer', bundle: 'b1', mode: 'full' }], reviews: [{ handoff: 'b1', partial: true, closure: { notReached: ['the round ended before the reviewer finished (stopped)'] } }], strategy: { nextRound: 'delta' } };
  assert.equal(roundMode(partialOnly, { evidence: false }), 'full');
  const finished = { ...partialOnly, reviews: [{ handoff: 'b1', closure: {} }] };
  assert.equal(roundMode(finished, { evidence: false }), 'delta');
});
