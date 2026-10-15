import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { WF, closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, spawnHome, state, tmp, wf } from './helpers.mjs';
import { handoff, nextAction, nextDecision } from '../engine/lifecycle.mjs';
import { listEvidence } from '../engine/evidence-read.mjs';
import { loadState } from '../engine/ledger.mjs';

// 0.7 stream C, robustness and dead ends. Each test names the failure it reproduces.

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const planned = (f, item) => {
  const e = ok(wf(f.root, ['entry', '--item', item, '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id]));
  return e;
};
// A changed tree with a clean code review on it: the next `wf gate` is in the order of work.
const reviewedTree = (f, e) => {
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'changed\n' });
  ok(wf(f.root, ['handoff', 'reviewer', '--agent', 'r0', '--attempt', e.id]));
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('r0')), '--attempt', e.id]));
};
const lockFileOf = (root, id) => path.join(fs.realpathSync(root), '.wf-worktrees', '_transactions', `${id}.lock`);
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const writeLock = (root, id, lock) => {
  fs.mkdirSync(path.dirname(lockFileOf(root, id)), { recursive: true });
  fs.writeFileSync(lockFileOf(root, id), JSON.stringify({ host: os.hostname(), token: 'scenario', ...lock }));
};
const registerProject = (f) => {
  const home = path.join(f.base, '.wfhome');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: [{ root: f.root }] }));
};
const refusalIds = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : []);

// Named failure: an attempt whose worktree folder was deleted made `wf status`, `wf status --all` and `wf resume` fail with
// "git failed to start: spawnSync git ENOENT" for every attempt, and the cause (a missing folder) was never named.
test('an attempt whose worktree is gone is shown as orphaned by status, status --all and resume, and can be abandoned', () => {
  const f = singleRepoProject('orphaned', { gate: { steps } });
  registerProject(f);
  const lost = planned(f, 'ENG-1');
  const other = ok(wf(f.root, ['entry', '--item', 'ENG-2', '--json'])).json();
  fs.rmSync(lost.repos.app.worktree, { recursive: true, force: true });

  const status = ok(wf(f.root, ['status']));
  assert.match(status.out, /ENG-1\.1 .*ORPHANED/);
  assert.ok(status.out.includes(`worktree missing: ${lost.repos.app.worktree}`), status.out);
  assert.match(status.out, /wf abandon --attempt ENG-1\.1/);
  assert.match(status.out, /ENG-2\.1 .*phase=admitted\n[\s\S]*next: /, 'the other attempt is listed normally');
  assert.doesNotMatch(status.out + status.err, /ENOENT/);
  const json = ok(wf(f.root, ['status', '--json'])).json();
  assert.deepEqual(json.find((s) => s.id === 'ENG-1.1').orphaned.map((o) => o.worktree), [lost.repos.app.worktree]);
  assert.equal(json.find((s) => s.id === other.id).orphaned, undefined);

  const all = ok(wf(f.root, ['status', '--all', '--json'])).json();
  assert.deepEqual(all.map((a) => a.id).sort(), ['ENG-1.1', 'ENG-2.1']);
  assert.match(all.find((a) => a.id === 'ENG-1.1').next, /ORPHANED/);
  assert.match(ok(wf(f.root, ['status', '--all'])).out, /ENG-1\.1 {2}planned {2}ORPHANED/);

  const resume = ok(wf(f.root, ['resume', '--attempt', lost.id]));
  assert.match(resume.out, /ORPHANED/);
  assert.equal(ok(wf(f.root, ['resume', '--attempt', lost.id, '--json'])).json().orphaned.length, 1);
  assert.match(ok(wf(f.root, ['resume', '--attempt', other.id])).out, /next: /);

  // A command that needs the folder says what is wrong instead of blaming git.
  const gate = wf(f.root, ['check', '--attempt', lost.id]);
  assert.notEqual(gate.code, 0);
  assert.match(gate.err, /worktree missing: .*ENG-1\.1/);
  assert.doesNotMatch(gate.err, /ENOENT|failed to start/);

  // Abandon makes no git call into the folder, keeps the branch and drops git's registration of the missing worktree.
  const abandoned = ok(wf(f.root, ['abandon', '--attempt', lost.id, '--reason', 'worktree deleted']));
  assert.match(abandoned.out, /ENG-1\.1 abandoned/);
  assert.match(sh(f.root, 'git branch --list wf/ENG-1.1'), /wf\/ENG-1\.1/);
  assert.doesNotMatch(sh(f.root, 'git worktree list'), /ENG-1\.1/);
  assert.doesNotMatch(ok(wf(f.root, ['status'])).out, /ENG-1\.1/);
  assert.equal(state(f.root, lost.id).phase, 'abandoned');
});

// Named failure (0.7.0, field): the person confirmed a reserved decision on an orphaned attempt (`wf approve` for its
// abandon) and was told "worktree missing: ... (git was not run there)": the decision was recorded, but the line naming
// what comes next ran git in the missing folder. `wf release` did the same after lifting a hold. Every next line is decided
// by nextDecision, so the orphan check is there, before any git call.
test('a decision taken on an orphaned attempt is reported done and points at abandon, not at the missing folder', () => {
  const f = singleRepoProject('orphan-next', { gate: { steps } });
  const lost = planned(f, 'ENG-5');
  ok(wf(f.root, ['hold', '--reason', 'wait for the owner', '--attempt', lost.id]));
  fs.rmSync(lost.repos.app.worktree, { recursive: true, force: true });

  const released = ok(wf(f.root, ['release', '--attempt', lost.id]));
  assert.match(released.out, /hold released on ENG-5\.1\. next: ORPHANED, worktree missing: /);
  assert.match(released.out, /wf abandon --attempt ENG-5\.1/);
  assert.doesNotMatch(released.out + released.err, /git was not run there|ENOENT/);
  assert.equal(state(f.root, lost.id).activeHold, null);

  // `wf approve` prints nextAction after recording the person's choice (the scenario owner confirms through
  // approveInTerminal, which prints nothing, so the line is checked here).
  const decision = nextDecision(f.root, loadState(f.root, lost.id));
  assert.deepEqual([decision.kind, decision.status], ['orphaned', 'blocked']);
  assert.match(nextAction(f.root, loadState(f.root, lost.id)), /^ORPHANED, worktree missing: /);
});

// Named failure: under a sandbox that forbids `ps` (49 calls under the Codex sandbox), `wf status`, `wf resume` and
// `wf stop` threw "ps failed to start" whenever a gate was running, because the gate lock's pid was checked with `ps`.
test('status, resume and stop work while a gate runs on a host where ps cannot be started', async () => {
  const slow = [{ id: 'slow', repo: 'app', run: 'sleep 20', inputs: ['src/**'] }];
  const f = singleRepoProject('no-ps', { gate: { steps: slow } });
  const e = planned(f, 'ENG-3');
  reviewedTree(f, e);
  const bin = tmp('no-ps-bin');
  fs.symlinkSync(sh(f.root, 'command -v git'), path.join(bin, 'git'));
  assert.equal(spawnSync('ps', ['-p', '1'], { env: { PATH: bin } }).error?.code, 'ENOENT', 'the narrowed PATH has no ps');
  const env = { ...process.env, WF_CONFIG_HOME: path.join(f.root, '..', '.wfhome'), ...spawnHome(f.root) };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k];
  const child = spawn(process.execPath, [WF, 'gate', '--attempt', e.id], { cwd: f.root, env, stdio: 'ignore' });
  const lock = path.join(f.root, '.wf-evidence', 'attempts', e.id, 'gate', 'gate.lock');
  const ready = () => {
    try {
      return JSON.parse(fs.readFileSync(lock, 'utf8')).children.length >= 1;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 100));
  const noPs = { env: { PATH: bin } };
  assert.match(ok(wf(f.root, ['status', '--attempt', e.id], noPs)).out, /gate running: .* \(pid \d+\)/);
  assert.match(ok(wf(f.root, ['resume', '--attempt', e.id], noPs)).out, /gate running: /);
  ok(wf(f.root, ['stop', '--class', 'owner-decision', '--reason', 'no ps here', '--attempt', e.id], noPs));
  assert.equal(await new Promise((r) => child.on('exit', r)), 1);
  assert.equal(state(f.root, e.id).lastGate.status, 'stopped');
});

// Named failure: a `wf` process killed while it held an attempt's evidence lock left it behind, and every later command
// refused with "evidence transaction is still locked; reconcile its owner before cleanup, never expire it by age" (144 to
// 188 refusals); the guard then blocked the manual cleanup the message asked for.
test('an evidence lock whose owner is gone is reclaimed by the next command; a live owner is waited for', async () => {
  const f = singleRepoProject('lock-reclaim', { gate: { steps } });
  const e = planned(f, 'ENG-4');
  writeLock(f.root, e.id, { pid: deadPid() });
  const r = ok(wf(f.root, ['status', '--attempt', e.id]));
  assert.match(r.err, /reclaimed an evidence lock left by a process that is gone/);
  assert.ok(!fs.existsSync(lockFileOf(f.root, e.id)), 'the stale lock is gone');
  assert.ok(!fs.existsSync(`${lockFileOf(f.root, e.id)}.reclaim`));

  // A live owner (this test process) is waited for, then the command proceeds once it lets go.
  writeLock(f.root, e.id, { pid: process.pid });
  const waiting = spawn(process.execPath, [WF, 'status', '--attempt', e.id], { cwd: f.root, env: { ...process.env, WF_CONFIG_HOME: path.join(f.root, '..', '.wfhome'), ...spawnHome(f.root), WF_EVIDENCE_FLAGS: '0' }, stdio: 'pipe' });
  let out = '';
  waiting.stdout.on('data', (d) => (out += d));
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(waiting.exitCode, null, 'still waiting while the live owner holds the lock');
  assert.ok(fs.existsSync(lockFileOf(f.root, e.id)), 'a live owner\'s lock is untouched');
  fs.rmSync(lockFileOf(f.root, e.id));
  assert.equal(await new Promise((r) => waiting.on('exit', r)), 0);
  assert.match(out, /ENG-4\.1/);
});

test('wf unlock removes a dead owner\'s evidence lock and refuses a live one, another host\'s and an unreadable one', () => {
  const f = singleRepoProject('lock-unlock', { gate: { steps } });
  const e = planned(f, 'ENG-5');
  assert.match(ok(wf(f.root, ['unlock', '--attempt', e.id])).out, /has no evidence lock/);
  writeLock(f.root, e.id, { pid: deadPid() });
  assert.match(ok(wf(f.root, ['unlock', '--attempt', e.id])).out, /removed the evidence lock of ENG-5\.1 \(its owner, pid \d+, is gone\)/);
  assert.ok(!fs.existsSync(lockFileOf(f.root, e.id)));

  const log = path.join(f.base, 'refusals.jsonl');
  const env = { env: { WF_REFUSALS_FILE: log } };
  writeLock(f.root, e.id, { pid: process.pid });
  const alive = wf(f.root, ['unlock', '--attempt', e.id], env);
  assert.equal(alive.code, 75);
  assert.match(alive.err, /held by (this process|pid \d+, which is still running)/);
  assert.ok(refusalIds(log).includes('lock:owner-alive'), refusalIds(log).join(', '));
  assert.ok(fs.existsSync(lockFileOf(f.root, e.id)), 'a live owner\'s lock is kept');

  writeLock(f.root, e.id, { pid: deadPid(), host: 'another-host.invalid' });
  assert.match(wf(f.root, ['unlock', '--attempt', e.id]).err, /held by a process on another host \(another-host\.invalid\)/);
  assert.ok(fs.existsSync(lockFileOf(f.root, e.id)));
  fs.writeFileSync(lockFileOf(f.root, e.id), 'not json');
  assert.match(wf(f.root, ['unlock', '--attempt', e.id]).err, /cannot be read, so its owner is unknown/);
  assert.match(wf(f.root, ['unlock']).err, /usage: wf unlock --attempt ID/);
  fs.rmSync(lockFileOf(f.root, e.id));
});

// Named failure: an analysis attempt could not become an implementation, so "the investigation is done, now implement it"
// meant abandoning it and admitting a new one (8 of 16 abandoned attempts), throwing away the plan and the tracker state.
test('wf intent implementation upgrades an analysis attempt in place and records it; closed attempts and downgrades are refused', () => {
  const tracker = { kind: 'linear', statuses: { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' } };
  const f = singleRepoProject('intent', { gate: { steps }, tracker });
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-6', '--intent', 'analysis', '--json'])).json();
  assert.equal(e.intent, 'analysis');
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id]));
  assert.match(wf(f.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]).err, /analysis attempts are read-only/);
  assert.doesNotMatch(ok(wf(f.root, ['resume', '--attempt', e.id])).out, /set status to "In Progress"/, 'an analysis attempt never moves the ticket');

  assert.match(wf(f.root, ['intent', 'implementation', '--attempt', e.id]).err, /--reason/);
  assert.match(wf(f.root, ['intent', 'analysis', '--attempt', e.id, '--reason', 'x']).err, /usage: wf intent implementation/);
  const up = ok(wf(f.root, ['intent', 'implementation', '--attempt', e.id, '--reason', 'the owner asked for the implementation']));
  assert.match(up.out, /ENG-6\.1 is now an implementation attempt/);
  const s = state(f.root, e.id);
  assert.equal(s.intent, 'implementation');
  assert.equal(s.intentChanges.length, 1);
  assert.deepEqual([s.intentChanges[0].from, s.intentChanges[0].to, s.intentChanges[0].reason], ['analysis', 'implementation', 'the owner asked for the implementation']);
  assert.match(ok(wf(f.root, ['resume', '--attempt', e.id])).out, /set status to "In Progress"/, 'the tracker admission an implementation owes is queued now');
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  assert.match(ok(wf(f.root, ['intent', 'implementation', '--attempt', e.id, '--reason', 'again'])).out, /already an implementation attempt/);
  assert.equal(state(f.root, e.id).intentChanges.length, 1, 'repeating it records nothing more');

  const g = ok(wf(f.root, ['entry', '--item', 'ENG-7', '--intent', 'analysis', '--json'])).json();
  ok(wf(f.root, ['abandon', '--attempt', g.id, '--reason', 'not needed']));
  const closed = wf(f.root, ['intent', 'implementation', '--attempt', g.id, '--reason', 'too late']);
  assert.equal(closed.code, 75);
  assert.match(closed.err, /ENG-7\.1 is abandoned; its intent is final/);
});

// Named failure (I-127): after an upgrade to implementation, fresh planners got the analysis plan with no word of the intent
// or why it changed, could only amend criteria (an amendment carries no plan), and an amendment carrying only
// `plan.summary` was accepted and dropped; the person's request reached no planner.
test('I-127: a planner after an upgrade knows why, its plan replaces the analysis one, an amendment refuses what it would drop, and the owner can carry the person\'s words', () => {
  const f = singleRepoProject('intent-replan', { gate: { steps } });
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-9', '--intent', 'analysis', '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id]));
  ok(wf(f.root, ['intent', 'implementation', '--attempt', e.id, '--reason', 'add the fix to the release']));
  const amend = path.join(f.base, 'amend-plan.json');
  fs.writeFileSync(amend, JSON.stringify({ plan: { summary: 'implement the fix' } }));
  const r = wf(f.root, ['criteria', 'amend', '--file', amend, '--reason', 'the implementation plan', '--attempt', e.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /the amendment carries `plan`, which no amendment applies: an amendment changes `criteria`, `expect`, `impact`, `scope`, `work` only/);
  assert.match(r.err, /record the planner's whole plan with `wf plan --from-agent <planner id> --attempt ENG-9\.1` \(it replaces the analysis plan\)/);
  const h = ok(wf(f.root, ['handoff', 'planner', '--agent', 'p2', '--attempt', e.id, '--context', 'the person: we are cutting a release, add the fix to it', '--json'])).json();
  const b = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  assert.equal(b.intent, 'implementation');
  assert.deepEqual(b.intentChanges.map((c) => [c.from, c.to, c.reason]), [['analysis', 'implementation', 'add the fix to the release']]);
  assert.match(b.replacesPlan, /replaces the analysis plan/);
  assert.equal(b.ownerContext, 'the person: we are cutting a release, add the fix to it');
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base, [{ id: 'C1', text: 'the fix ships in the release', uat: 'the release has the fix' }]), '--attempt', e.id]));
  const s = state(f.root, e.id);
  assert.equal(s.criteria[0].text, 'the fix ships in the release', 'the implementation plan replaced the analysis one');
  assert.equal(s.plansFrozen, 2);
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  assert.match(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id]).err, /criteria are already frozen/, 'once implementation started, never again');
  assert.match(wf(f.root, ['handoff', 'implementer', '--agent', 'i2', '--attempt', e.id, '--context', 'x']).err, /--context is for a planner handoff/);
});

// Named failure (I-78): with the evidence folder renamed, `wf verify --attempt X` printed "verified 1 attempt(s)" for an
// attempt with no ledger at all.
test('I-78: wf verify of an attempt that does not exist, or whose folder was renamed, fails instead of reporting success', () => {
  const f = singleRepoProject('verify-missing', { gate: { steps } });
  const e = planned(f, 'ENG-8');
  assert.match(ok(wf(f.root, ['verify', '--attempt', e.id])).out, /verified 1 attempt\(s\)/);
  const nope = wf(f.root, ['verify', '--attempt', 'ENG-99.1']);
  assert.equal(nope.code, 75);
  assert.match(nope.err, /ENG-99\.1 has no ledger here, so nothing was verified/);
  const dir = path.join(f.root, '.wf-evidence', 'attempts', e.id);
  fs.renameSync(dir, `${dir}-moved`);
  fs.mkdirSync(dir);
  const renamed = wf(f.root, ['verify', '--attempt', e.id]);
  assert.equal(renamed.code, 75);
  assert.match(renamed.err, /has no ledger here/);
  fs.rmdirSync(dir);
  fs.renameSync(`${dir}-moved`, dir);
  assert.match(ok(wf(f.root, ['verify', '--attempt', e.id])).out, /verified 1 attempt\(s\)/);
});

// Named failure (I-91): the step's completion was recorded without waiting for the evidence lock; when another command
// held it for longer than the lock's ten seconds the runner died with an unhandled error before recording a result.
test('I-91: a gate step finishing while another command holds the evidence lock waits for it instead of crashing the runner', async () => {
  const f = singleRepoProject('gate-contention', { gate: { steps: [{ id: 'brief', repo: 'app', run: 'sleep 2', inputs: ['src/**'] }] } });
  const e = planned(f, 'ENG-9');
  reviewedTree(f, e);
  const env = { ...process.env, WF_CONFIG_HOME: path.join(f.root, '..', '.wfhome'), ...spawnHome(f.root), WF_EVIDENCE_FLAGS: '0' };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k];
  const child = spawn(process.execPath, [WF, 'gate', '--attempt', e.id, '--json'], { cwd: f.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const gateLock = path.join(f.root, '.wf-evidence', 'attempts', e.id, 'gate', 'gate.lock');
  const running = () => {
    try {
      return JSON.parse(fs.readFileSync(gateLock, 'utf8')).children.length >= 1;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 100 && !running(); i++) await new Promise((r) => setTimeout(r, 50));
  // Hold the evidence lock (as a live command would) well past the ten seconds one try waits.
  const mine = lockFileOf(f.root, e.id);
  for (let i = 0; i < 200; i++) {
    try {
      fs.writeFileSync(mine, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'scenario' }), { flag: 'wx' });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  await new Promise((r) => setTimeout(r, 12500));
  fs.rmSync(mine, { force: true });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0, `${err}\n${out}`);
  assert.equal(JSON.parse(out).status, 'passed');
  assert.equal(state(f.root, e.id).lastGate.steps.find((s) => s.id === 'brief').status, 'passed');
});

// Named failure (I-50): a handoff bundle was written and only recorded when its process ended, so a command another
// session ran in between found an unrecorded file and refused with "does not match what wf recorded".
test('I-50: a handoff is recorded together with its bundle, and readers never list a file that is not recorded yet', () => {
  const f = singleRepoProject('handoff-publish', { gate: { steps } });
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-10', '--owner', 'plain:me', '--json'])).json();
  const result = handoff(f.root, 'planner', { attempt: e.id, agent: 'planner-1', runtime: 'claude' });
  const rel = path.relative(path.join(f.root, '.wf-evidence', 'attempts', e.id), result.bundle);
  const ledger = fs.readFileSync(path.join(f.root, '.wf-evidence', 'attempts', e.id, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const recorded = ledger.filter((x) => x.type === 'evidence.recorded').flatMap((x) => x.data.files.map((y) => y.path));
  assert.ok(recorded.includes(rel), `${rel} is in the manifest before the command ends (recorded: ${recorded.join(', ')})`);
  const handoffIndex = ledger.findIndex((x) => x.type === 'handoff');
  const recordedIndex = ledger.findIndex((x) => x.type === 'evidence.recorded' && x.data.files.some((y) => y.path === rel));
  assert.ok(handoffIndex >= 0 && recordedIndex > handoffIndex);

  // A file a command is writing right now is not listed (and not offered to `wf evidence show`).
  const inFlight = path.join(f.root, '.wf-evidence', 'attempts', e.id, 'handoffs', '99-implementer.json');
  fs.chmodSync(path.dirname(inFlight), 0o755);
  fs.writeFileSync(inFlight, '{}');
  const listed = listEvidence(f.root, loadState(f.root, e.id)).files.map((x) => x.path);
  assert.ok(listed.includes(rel));
  assert.ok(!listed.includes('handoffs/99-implementer.json'), listed.join(', '));
  fs.rmSync(inFlight);
});
