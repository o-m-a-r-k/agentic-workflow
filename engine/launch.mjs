// Named failure I-41: an assistant-reported desktop spawn cannot establish the encrypted start prompt.
// wf sends the frozen line itself to a fresh native agent process with the trusted role/model/effort. Everything that
// is a harness's own (its command line, its event stream, how it fails) is the host adapter's: buildLaunch,
// interpretEvent, roleReport and diagnoseLaunch (engine/hosts/). This file holds the neutral shell: the checks before a
// launch, the receipt, the lock, the ledger events and the progress heartbeat.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { canonical as canonicalPath } from './paths.mjs';
import { executionSettings, rejectModelOverrides } from './models.mjs';
import { actor, openState, treeHashes } from './attempt.mjs';
import { assertRuntimeLaunch } from './runtime-policy.mjs';
import { adapterFileAtCommit, adapterPin, trustedAdapter } from './config.mjs';
import { append, loadState, recordedTogether } from './ledger.mjs';
import { readRegular, seal } from './evidence.mjs';
import { reviewDocumentProblems } from './rules.mjs';
import { isCurrentReviewer, reviewSnapshot } from './review-groups.mjs';
import { closureMissingGuidance, roundMode, unreachedOf } from './review-policy.mjs';
import { roleInstructions } from './onboard.mjs';
import { roleProgress, ROLE_HEARTBEAT_MS } from './role-progress.mjs';
import { findHost, hostNames, launchEnvDeletes } from './hosts/index.mjs';
import { isPlainSessionId } from './hosts/safe-file.mjs';
import { endProcessTree, leftOver, stillTheRole } from './process-tree.mjs';
import { WfError, assertPlainGit, canonical, git, refuse, sha256, withFileLock, writeJson } from './util.mjs';
import { readStatement } from './expectations.mjs';
import { RESUME_PROMPT } from './hosts/resume.mjs';

export async function runRole(root, options) {
  rejectModelOverrides(options);
  const state = openState(root, options);
  const h = state.handoffs.filter((h) => h.agent === options.agent).at(-1);
  const host = h ? findHost(h.runtime) : null;
  if (!host) throw refuse(`name an existing ${hostNames()} handoff with \`--agent <id>\``);
  // The strategist runs on the runtime the adapter names for it (`roles.strategist.runtime`), not the owning chat's.
  if (h.role !== 'strategist') assertRuntimeLaunch(state, h);
  const runtime = h.runtime, label = host.name;
  if (state.activeHold) throw refuse(`this attempt is on hold: ${state.activeHold.reason}`);
  if (h.role === 'reviewer' && !isCurrentReviewer(state, h)) throw refuse('only the current reviewer handoff or its frozen group members can be launched');
  if (h.reviewGroup && h.reviewGroup.snapshot !== reviewSnapshot(state)) throw refuse('review group obligations changed before launch; create a fresh group');
  // 0.7.30 (I-153): a launch the model's capacity ended is resumed, not launched again: the role itself changed the tree.
  const resumable = h.launch?.status === 'failed' && h.launch.failure?.kind === 'capacity';
  if (!resumable && h.tree && canonical(treeHashes(state)) !== canonical(h.tree)) throw refuse('the handed tree changed before launch; create a fresh handoff');
  // Named failure: the shared launcher accidentally prohibited inherited implementer/tester models.
  if (['planner', 'reviewer'].includes(h.role) && !h.model) throw refuse('this handoff pins no runtime model; run `wf models refresh --attempt <id>`, then create a fresh handoff');
  const expected = executionSettings(root, state, h.role, h.class, runtime, h.runtimeAdapterBase ?? state.adapterBase);
  if (h.model !== expected.model || h.effort !== expected.effort) throw refuse('handoff execution settings differ from their committed pin; create a fresh handoff');
  if (h.role === 'reviewer') {
    const handed = readRegular(h.bundle);
    if (!handed) throw refuse('the frozen reviewer bundle is unavailable before native launch');
    const bundle = JSON.parse(handed.bytes.toString('utf8'));
    if (h.reviewGroup && sha256(handed.bytes) !== h.reviewGroup.bundleSha256) throw refuse('review group bundle changed from its frozen hash before launch');
    const problems = reviewDocumentProblems(bundle);
    if (problems.length) throw refuse(`review readiness refused before native launch:\n  - ${problems.join('\n  - ')}`);
  }
  const cfg = trustedAdapter(root, state);
  const appendix = cfg.roles?.[h.role]?.appendix;
  const extra = appendix ? fs.readFileSync(adapterFileAtCommit(root, state, adapterPin(state), appendix), 'utf8') : '';
  const body = roleInstructions(cfg, h.role, h.class, extra, host);
  // Named failure I-46: registered multi-repo projects intentionally have no parent Git repo.
  // Bypass only a harness's Git-root prerequisite, after checking every recorded worktree; keep the sandbox.
  const nonGitRoot = git(root, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }) !== 'true';
  if (nonGitRoot && host.needsGitRoot) {
    const repos = Object.values(state.repos);
    if (!repos.length) throw refuse('a native role needs at least one recorded Git worktree');
    for (const repo of repos) {
      assertPlainGit(repo.worktree);
      const top = git(repo.worktree, ['rev-parse', '--show-toplevel']);
      if (fs.realpathSync(top) !== fs.realpathSync(repo.worktree)) throw refuse('a recorded role worktree is not a Git repository root');
    }
  }
  if (resumable) return resumeLaunch(root, state, h, { host, runtime, label, options });
  const file = h.bundle.replace(/\.json$/, '.launch.json');
  const requestedSession = host.requestedSession?.() ?? null;
  const receipt = { runtime, requestedSession, handoff: h.bundle, agentType: h.agentType, prompt: h.startPrompt, model: h.model, effort: h.effort, runtimeAdapterBase: expected.runtimeAdapterBase, sourceClass: expected.sourceClass, developerInstructions: body, cwd: root, sandbox: host.sandbox, skipGitRepoCheck: nonGitRoot };
  // Native control locks are outside sealed evidence so a concurrent status read cannot chmod them closed.
  const launchLock = path.join(root, '.wf-worktrees', state.id, '_runner', path.basename(h.bundle) + '.launch.lock');
  if (canonicalPath(launchLock) !== path.join(fs.realpathSync(root), '.wf-worktrees', state.id, '_runner', path.basename(h.bundle) + '.launch.lock')) throw refuse('native launch control path resolves outside its recorded location');
  withFileLock(launchLock, () => {
    recordedTogether(root, state.id, () => {
    // Named failure (I-69): the refusal named no way on for an owner whose launched reviewer ended without a closure.
    if (loadState(root, state.id).handoffs.find((x) => x.bundle === h.bundle)?.launch) throw refuse('this handoff was already launched; create a fresh handoff, never reuse a review round', `\`wf handoff ${h.role} --agent <new id> --attempt ${state.id}\` hands a fresh ${h.role}, then \`wf handoff run --agent <new id> --attempt ${state.id}\` launches it${h.role === 'reviewer' ? '; a round with no recorded closure is not an audit and counts toward nothing' : ''}`);
    writeJson(file, receipt);
    append(root, state.id, 'agent.launch.requested', { handoff: h.bundle, file, sha256: sha256(JSON.stringify(receipt, null, 2) + '\n') }, actor(options));
    });
  });
  seal(append);
  const env = launchEnv();
  const launch = host.buildLaunch(h, { root, body, requestedSession, nonGitRoot });
  // 0.7.0: the role runs in its own process group with its output in files outside the evidence, so the owner is never
  // trapped in this call: it returns when the role finishes, or when the role passes the estimate it stated itself, and
  // the role keeps running; `wf handoff wait` follows it again and `wf handoff stop` ends it. Named failure (final review
  // of 0.7.0): a hung role run in the foreground blocked the owner with no way back, and a review round stayed open 745
  // minutes after its session died.
  const io = runnerFiles(root, state.id, h);
  fs.mkdirSync(path.dirname(io.out), { recursive: true });
  fs.writeFileSync(io.prompt, h.startPrompt, { mode: 0o600 });
  const fds = [fs.openSync(io.prompt, 'r'), fs.openSync(io.out, 'w', 0o600), fs.openSync(io.err, 'w', 0o600)];
  // An interrupt from here on cancels the role. Named failure (Linux verify of 0.7.14, under load): a SIGTERM that arrived
  // after the spawn but before follow() listened (the spawn event, the ledger write and its seal) killed this process by the
  // default action and left the role's tree running with no owner. It is held until follow() listens, which ends the tree.
  let earlyInterrupt = false;
  const early = () => { earlyInterrupt = true; };
  process.on('SIGINT', early);
  process.on('SIGTERM', early);
  const releaseEarly = () => { process.removeListener('SIGINT', early); process.removeListener('SIGTERM', early); return earlyInterrupt; };
  const child = spawn(launch.bin, launch.args, { cwd: root, env, stdio: fds, detached: true });
  for (const fd of fds) fs.closeSync(fd);
  const spawned = await new Promise((resolve) => { child.once('spawn', () => resolve(null)); child.once('error', (e) => resolve(e.message)); });
  if (spawned) {
    releaseEarly();
    append(root, state.id, 'agent.launch.finished', { handoff: h.bundle, status: 'failed', exitCode: 1 }, `engine:${runtime}`);
    seal(append);
    process.stderr.write(`${label} role failed: ${spawned}\n`);
    return { agent: h.agent, session: null, status: 'failed', exitCode: 1 };
  }
  append(root, state.id, 'agent.launch.spawned', { handoff: h.bundle, pid: child.pid, out: io.out, err: io.err }, `engine:${runtime}`);
  seal(append);
  // The owner's own expectation (`--minutes`) is the return point for a role that states none (a planner, a strategist, or
  // any role before it writes its estimate). Named failure (second final review of 0.7.0): such a launch still never returned.
  const ownerMinutes = options.minutes === undefined ? null : Number(options.minutes);
  if (ownerMinutes !== null && !(Number.isFinite(ownerMinutes) && ownerMinutes > 0)) {
    releaseEarly();
    throw new WfError('--minutes is a positive number (your own expectation for this role, minutes since its launch)');
  }
  // `--detach` (0.7.22): return once the role has started, so an owner starts two roles that run at the same time (a
  // planning panel's drafts); `wf handoff wait` follows each to its end.
  return follow(root, state.id, h, { host, runtime, label, requestedSession, child, io, ownerMinutes, releaseEarly, detach: options.detach === true, relaunch: { body, nonGitRoot } });
}

// I-41: the launched role must call this engine, even when the user's global wf still points to an older plugin.
function launchEnv() {
  const env = { ...process.env };
  env.PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin') + path.delimiter + (env.PATH ?? '');
  for (const name of launchEnvDeletes()) delete env[name];
  return env;
}

// 0.7.30 (I-153). Named failure (audit of role launches): seven launches failed because the model was at capacity (a harness's
// `server_overloaded`) and were replaced by fresh handoffs; four had made no edit, and the others' work was taken over by a
// role that had to find it again. The host recognises its own capacity signal (`interpretEvent` -> `capacity`); the launch is
// resumed: its session continued (`buildLaunch(..., { resume })`), or started again when none had begun, with the same
// instructions, model and effort, after a wait that grows (now, then 1, 2, 4, 8 and every 10 minutes) for as long as the
// harness keeps reporting capacity, within the call while the owner's return point (`--minutes`, the role's own estimate)
// allows. Past it, the launch is recorded failed with kind `capacity`, and `wf handoff run` on that handoff resumes it.
const CAPACITY_WAITS_S = [0, 60, 120, 240, 480, 600];

function respawn(root, h, host, io, { session, requestedSession, body, nonGitRoot }) {
  const launch = host.buildLaunch(h, { root, body, requestedSession, nonGitRoot, resume: session ?? null });
  fs.mkdirSync(path.dirname(io.out), { recursive: true });
  fs.writeFileSync(io.prompt, session ? RESUME_PROMPT : h.startPrompt, { mode: 0o600 });
  const fds = [fs.openSync(io.prompt, 'r'), fs.openSync(io.out, 'a', 0o600), fs.openSync(io.err, 'a', 0o600)];
  try {
    return spawn(launch.bin, launch.args, { cwd: root, env: launchEnv(), stdio: fds, detached: true });
  } finally {
    for (const fd of fds) fs.closeSync(fd);
  }
}
const spawnedOrError = (child) => new Promise((resolve) => { child.once('spawn', () => resolve(null)); child.once('error', (e) => resolve(e.message)); });

// The instructions the launch was given, from its protected receipt: a resumed role continues under the same ones.
function launchedBody(h) {
  try {
    const r = readRegular(h.bundle.replace(/\.json$/, '.launch.json'));
    return r ? JSON.parse(r.bytes.toString('utf8')) : null;
  } catch {
    return null;
  }
}

// `wf handoff run` on a launch recorded failed at capacity: the same session continues (or the launch starts again when no
// session had begun), recorded as resumed, and followed from where its event stream ended.
async function resumeLaunch(root, state, h, { host, runtime, label, options }) {
  const receipt = launchedBody(h);
  if (!receipt?.developerInstructions) throw refuse(`${h.agent}'s launch receipt cannot be read, so it is not resumed`, `create a fresh handoff: \`wf handoff ${h.role} --agent <new id> --attempt ${state.id}\``, { id: 'launch:resume-receipt' });
  const io = { ...runnerFiles(root, state.id, h), ...(h.launch.out ? { out: h.launch.out, err: h.launch.err } : {}) };
  let offset = 0;
  try {
    offset = fs.statSync(io.out).size;
  } catch {}
  const session = h.session ?? null;
  const child = respawn(root, h, host, io, { session, requestedSession: h.launch.requestedSession ?? null, body: receipt.developerInstructions, nonGitRoot: receipt.skipGitRepoCheck === true });
  const failed = await spawnedOrError(child);
  if (failed) throw refuse(`${label} ${h.role} ${h.agent} could not be resumed: ${failed}`);
  const resume = (h.launch.resumes ?? 0) + 1;
  append(root, state.id, 'agent.launch.resumed', { handoff: h.bundle, pid: child.pid, out: io.out, err: io.err, reason: 'capacity', resume, session }, `engine:${runtime}`);
  seal(append);
  process.stderr.write(`${label} ${h.role} ${h.agent}: resuming ${session ? `session ${session}` : 'the launch'} after the model was at capacity (resume ${resume})\n`);
  const ownerMinutes = options.minutes === undefined ? null : Number(options.minutes);
  return follow(root, state.id, loadState(root, state.id).handoffs.find((x) => x.bundle === h.bundle), { host, runtime, label, requestedSession: h.launch.requestedSession ?? null, child, io, ownerMinutes, offset, relaunch: { body: receipt.developerInstructions, nonGitRoot: receipt.skipGitRepoCheck === true } });
}

// Where an engine-launched role's start prompt, event stream and error output live (outside the evidence).
function runnerFiles(root, id, h) {
  const base = path.join(root, '.wf-worktrees', id, '_runner', path.basename(h.bundle).replace(/\.json$/, ''));
  return { prompt: `${base}.prompt`, out: `${base}.out.jsonl`, err: `${base}.err.log` };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// Follows a launched role's event stream from the start and records what it shows: the session it started, then its end.
// Returns when the process has ended, or (still running) once `untilMinutes` have passed since this call, or once it has
// passed the estimate it stated itself (`expect.minutes` in its report or closure file) when no `untilMinutes` is given.
// Nothing is decided from the estimate: the role keeps running and the owner judges (D9).
async function follow(root, id, h, { host, runtime, label, requestedSession, child = null, io, untilMinutes = null, ownerMinutes = null, releaseEarly = () => false, detach = false, offset = 0, relaunch = null }) {
  const progress = roleProgress(h, { runtime: label });
  // Both move when a launch the model's capacity ended is resumed (0.7.30, I-153).
  let pid = child?.pid ?? h.launch?.pid ?? null;
  const exited = () => (child ? child.exitCode !== null || child.signalCode !== null : !pid || !alive(pid));
  let exitCode = null;
  let exitSignal = null;
  const watchExit = (c) => c.once('exit', (code, signal) => { exitCode = code ?? 1; exitSignal = signal ?? null; });
  if (child) watchExit(child);
  let session = loadState(root, id).handoffs.find((x) => x.bundle === h.bundle)?.session ?? null;
  let completed = false, problem = null, lastError = null, rest = '';
  // The model at capacity, as the harness reported it, with no turn completed after it (I-153), and how often resumed.
  let capacity = false, resumes = h.launch?.resumes ?? 0, stopped = false;
  if (session) progress.start(session);
  const startedAt = Date.parse(h.launch?.requestedAt ?? '') || Date.now();
  const followedFrom = Date.now();
  // An interrupt of this process cancels the role, as before 0.7.0: the owner meant to stop it. Named failure (I-128): the
  // interrupt and error paths sent one SIGTERM to the role's group and then waited for the role itself to exit, so a role that
  // ignored it hung the interrupted command, and a child outside the group outlived it unseen. The whole tree is ended and
  // verified (engine/process-tree.mjs, bounded); what is left is said, never waited for.
  let ending = null, stillRunning = null;
  const endTree = () => { ending ??= endProcessTree(pid).then((ended) => { if (ended.left.length) stillRunning = ended; }); };
  const interrupted = () => { stopped = true; problem = 'the role launch was interrupted'; if (pid) endTree(); };
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  if (releaseEarly()) interrupted();
  const heartbeat = setInterval(() => { if (!exited()) progress.heartbeat(); }, ROLE_HEARTBEAT_MS);
  heartbeat.unref();
  const readNew = () => {
    let fd;
    try {
      fd = fs.openSync(io.out, 'r');
    } catch {
      return [];
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return [];
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const text = rest + buf.toString('utf8');
      const lines = text.split('\n');
      rest = lines.pop();
      return lines;
    } finally {
      fs.closeSync(fd);
    }
  };
  const roleSaid = () => {
    const file = h.role === 'implementer' ? h.reportFile : h.role === 'reviewer' ? h.closureFile : null;
    return readStatement(file, h.role === 'reviewer' ? 'scope' : 'approach')?.minutes != null;
  };
  // The owner's `--minutes` at launch is also an upper bound on a role's own estimate: an owner whose harness limits how long
  // one call may block gets control back within it (independent review of 0.7.15: a 90-minute estimate outlasted the call).
  const estimate = () => {
    if (untilMinutes !== null) return untilMinutes;
    const file = h.role === 'implementer' ? h.reportFile : h.role === 'reviewer' ? h.closureFile : null;
    const own = readStatement(file, h.role === 'reviewer' ? 'scope' : 'approach')?.minutes ?? null;
    return own !== null && ownerMinutes !== null ? Math.min(own, ownerMinutes) : own ?? ownerMinutes;
  };
  // A bare `wait` on a role already past the estimate it stated follows it to its end (or to a later estimate it states):
  // returning at once on the estimate already passed made the owner call it again and again (I-140).
  const passedAtStart = (() => {
    if (untilMinutes !== null) return null;
    const m = estimate();
    return m !== null && (followedFrom - startedAt) / 60000 > m ? m : null;
  })();
  // When this call would hand control back to the owner (the `over` test below), or null when it follows the role to its end.
  const returnAt = () => {
    if (untilMinutes !== null) return followedFrom + untilMinutes * 60000;
    const m = estimate();
    return m !== null && m !== passedAtStart ? startedAt + m * 60000 : null;
  };
  let returned = null;
  try {
    for (;;) {
      const done = exited();
      for (const line of readNew()) {
        if (line.length > 8 * 1024 * 1024) throw new Error(`${label} event exceeds the read cap`);
        let e; try { e = JSON.parse(line); } catch { continue; }
        progress.event();
        const seen = host.interpretEvent(e);
        if (seen.started !== undefined && seen.started !== session) {
          if (requestedSession && seen.started !== requestedSession) throw new Error(`${label} supplied a different session id`);
          if (session || typeof seen.started !== 'string' || !isPlainSessionId(seen.started)) throw new Error(`${label} supplied an invalid or repeated session id`);
          if (loadState(root, id).handoffs.some((other) => other.bundle !== h.bundle && other.session === seen.started)) throw new Error(`${label} reused another handoff session id`);
          session = seen.started;
          append(root, id, 'agent.launch.started', { handoff: h.bundle, session }, `engine:${runtime}`);
          seal(append);
          progress.start(session);
        }
        progress.report(host.roleReport?.(e) ?? null);
        if (seen.terminal) {
          if (seen.terminal.session !== undefined && (completed || seen.terminal.session !== session)) throw new Error(`${label} supplied an invalid terminal result`);
          completed = seen.terminal.success;
          if (!completed && seen.terminal.session !== undefined) problem = `${label} reported a failed turn`;
          if (completed) capacity = false;
        }
        if (seen.capacity) capacity = true;
        if (seen.failed) problem = `${label} reported a failed turn`;
        // Named failure (audit of role launches): four roles that finished cleanly were recorded failed, because one passing
        // error event set the failure for good. It counts only if no turn completes after it.
        if (seen.error) lastError = seen.error;
      }
      // 0.7.30 (I-153): the role ended because the model was at capacity: resume it here, after a growing wait, while the
      // owner's return point allows; past it, the launch is recorded failed with kind `capacity` and `wf handoff run` resumes it.
      if (done && !completed && capacity && !stopped && !stillRunning && relaunch) {
        const wait = CAPACITY_WAITS_S[Math.min(resumes, CAPACITY_WAITS_S.length - 1)] * 1000;
        const until = returnAt();
        if (until === null || Date.now() + wait <= until) {
          process.stderr.write(`${label} ${h.role} ${h.agent}: the model is at capacity (${lastError ?? 'reported by the harness'}); resuming ${session ? `session ${session}` : 'the launch'} ${wait ? `in ${Math.round(wait / 60000)} min` : 'now'} (resume ${resumes + 1})\n`);
          const resumeAt = Date.now() + wait;
          while (!stopped && Date.now() < resumeAt) await new Promise((r) => setTimeout(r, Math.min(250, resumeAt - Date.now())));
          if (stopped) break;
          const next = respawn(root, h, host, io, { session, requestedSession, body: relaunch.body, nonGitRoot: relaunch.nonGitRoot });
          const failed = await spawnedOrError(next);
          if (failed) {
            problem = `${label} could not be resumed after the model was at capacity: ${failed}`;
            break;
          }
          resumes += 1;
          child = next;
          pid = next.pid;
          exitCode = null;
          exitSignal = null;
          watchExit(next);
          problem = null;
          lastError = null;
          capacity = false;
          append(root, id, 'agent.launch.resumed', { handoff: h.bundle, pid, out: io.out, err: io.err, reason: 'capacity', resume: resumes, session }, `engine:${runtime}`);
          seal(append);
          continue;
        }
      }
      if (done || stillRunning) break;
      if (problem) { await new Promise((r) => setTimeout(r, 100)); continue; }
      if (detach && session) { returned = 'detached'; break; }
      const minutes = estimate();
      // `--minutes` on `wait` is a new interval measured from this call (I-140); a role's own estimate and the owner's
      // expectation at launch are totals since the launch (a launch's interval and total coincide).
      const over = untilMinutes !== null ? (Date.now() - followedFrom) / 60000 > untilMinutes : minutes !== null && minutes !== passedAtStart && (Date.now() - startedAt) / 60000 > minutes;
      if (over) { returned = untilMinutes !== null ? 'waited' : ownerMinutes !== null && minutes === ownerMinutes ? 'owner-estimate' : 'past-estimate'; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (e) {
    problem = e.message;
    if (pid) endTree();
  } finally {
    clearInterval(heartbeat);
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
  if (ending) await ending;
  if (stillRunning) {
    // The tree could not be ended: the launch stays recorded as running, which is what is true.
    progress.finish();
    const { why, byHand } = leftOver(stillRunning);
    process.stderr.write(`${label} ${h.role} ${h.agent}: ${problem}, and it is still running: ${why}. Nothing was recorded as finished. ${byHand}, then \`wf handoff stop --agent ${h.agent} --attempt ${id}\` records it.\n`);
    return { agent: h.agent, session, status: 'running', pid, exitCode: 1 };
  }
  if (returned && !problem) {
    // The role keeps running in its own process group; this process no longer waits for it.
    child?.unref();
    progress.finish();
    const minutes = Math.round((Date.now() - startedAt) / 60000);
    const said = estimate();
    process.stderr.write(`${label} ${h.role} ${h.agent} is still running (pid ${pid}, ${minutes} min since launch${returned === 'past-estimate' ? `, past its own estimate of ${said} min` : returned === 'owner-estimate' ? `, past your expectation of ${ownerMinutes} min${roleSaid() ? '' : ' (it stated none)'}` : returned === 'waited' ? `, the ${untilMinutes} min you chose to wait` : returned === 'detached' ? ', detached as you asked' : ''}). Judge it: \`wf handoff wait --agent ${h.agent} --attempt ${id} [--minutes N]\` follows it again (N: how much longer you expect), \`wf handoff stop --agent ${h.agent} --attempt ${id}\` ends it so a fresh handoff can take over.\n`);
    return { agent: h.agent, session, status: 'running', pid, minutes, exitCode: 0 };
  }
  // The process has ended (or was stopped): wait for its exit code when this call launched it.
  if (child && exitCode === null) exitCode = await new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) r(child.exitCode ?? 1); else child.once('exit', (c) => r(c ?? 1)); });
  progress.finish();
  const code = exitCode ?? (completed ? 0 : 1);
  if (!completed && !problem && lastError) problem = `${label} reported an error: ${lastError}`;
  const success = code === 0 && session && completed && !problem;
  let stderr = '';
  try { stderr = fs.readFileSync(io.err, 'utf8').slice(-4000); } catch {}
  try { fs.rmSync(io.prompt, { force: true }); } catch {}
  // Named failure I-47: a parent sandbox can block host initialization before any native session starts.
  // Diagnose only the observed permission signature; never change or retry the child's sandbox here.
  const diagnosis = !session && !success && !problem ? host.diagnoseLaunch?.({ stderr }) ?? null : null;
  // Why a launch did not succeed, in the ledger. Named failure (audit of role launches): 30 failed launches carried only
  // "exit 1"; telling an owner's stop from a model at capacity from a crash took reading transcripts by hand.
  // 0.7.30 (I-153): `capacity` when the harness's last word was that the model was at capacity (a resumable launch).
  const failure = diagnosis ? { kind: diagnosis.kind, detail: diagnosis.detail } : success ? null : { kind: problem === 'the role launch was interrupted' ? 'interrupted' : capacity && !completed ? 'capacity' : !session ? 'no-session' : !completed && /failed turn|reported an error/.test(problem ?? '') ? 'failed-turn' : 'exited', detail: String((capacity && lastError) || problem || (stderr.trim().split('\n').slice(-3).join(' ') || 'no completed turn')).slice(-500), ...(exitSignal ? { signal: exitSignal } : {}), ...(resumes ? { resumes } : {}) };
  if (!['completed', 'failed'].includes(loadState(root, id).handoffs.find((x) => x.bundle === h.bundle)?.launch?.status)) {
    append(root, id, 'agent.launch.finished', { handoff: h.bundle, status: success ? 'completed' : 'failed', exitCode: code, ...(failure ? { failure } : {}) }, `engine:${runtime}`);
    seal(append);
  }
  if (!success) process.stderr.write(failure?.kind === 'capacity' ? `${label} ${h.role} ${h.agent} stopped: the model is at capacity (${failure.detail})${resumes ? ` after ${resumes} resume(s)` : ''}; its session is kept: \`wf handoff run --agent ${h.agent} --attempt ${id}\` resumes it when the model has room (no fresh handoff)\n` : `${label} role failed: ${problem ?? (stderr.trim() || 'no completed turn')}\n`);
  if (diagnosis) process.stderr.write(`${diagnosis.advice}\n`);
  if (success && h.role === 'reviewer' && !h.reviewGroup) await reviewerEnded(root, id, h, label);
  if (success && h.role === 'implementer') await implementerEnded(root, id, h, label);
  // A round the model's capacity ended is resumed, not kept as partial.
  if (!success && h.role === 'reviewer' && !h.reviewGroup && failure?.kind !== 'capacity') await reviewerPartial(root, id, h, label, failure?.kind ?? 'failed');
  return { agent: h.agent, session, status: success ? 'completed' : 'failed', exitCode: success ? 0 : code || 1 };
}

// A launched reviewer's process ended cleanly. Named failure (I-69): two launched reviewers ended with no closure and the
// owner was told only that the process had completed; one that recorded a closure naming scope it did not reach was counted
// as the full audit. Said once, on stderr, at the moment the owner learns the process ended.
async function reviewerEnded(root, id, h, label) {
  let now = loadState(root, id);
  const handed = now.handoffs.find((x) => x.bundle === h.bundle);
  if (!handed) return;
  // The closure the reviewer wrote and did not record is recorded for it, with every check `wf review` makes. Named failure
  // (audit of 51 attempts): three launched reviewers ended with their work done and no closure recorded, and fresh
  // reviewers judged the same tree again.
  const file = handed.closureFile ?? null;
  if (file && fs.existsSync(file) && !(now.reviews ?? []).some((r) => r.handoff === h.bundle) && !(now.reviewsRefused ?? []).some((r) => r.handoff === h.bundle)) {
    try {
      const { recordReview } = await import('./lifecycle.mjs');
      recordReview(root, { attempt: id, closure: file, salvaged: true });
      process.stderr.write(`${label} reviewer ${h.agent} ended without recording its closure; the engine recorded the closure it wrote (${file})\n`);
    } catch (error) {
      process.stderr.write(`${label} reviewer ${h.agent} ended without recording its closure, and the closure it wrote was not recorded: ${String(error.message ?? error).split('\n')[0]}\n`);
    }
    now = loadState(root, id);
  }
  const recorded = (now.reviews ?? []).filter((r) => r.handoff === h.bundle).at(-1);
  if (recorded) {
    const unreached = unreachedOf(recorded.closure);
    if (unreached.length && recorded.covered !== true) process.stderr.write(`${label} reviewer ${h.agent} recorded a closure that names scope it did not reach: ${unreached.slice(0, 5).join('; ')}${unreached.length > 5 ? ` and ${unreached.length - 5} more` : ''}. That round does not count as the full audit (the next reviewer is handed a ${roundMode(now)} round and sees this list).\n`);
    return;
  }
  if ((now.reviewsRefused ?? []).some((r) => r.handoff === h.bundle)) return;
  process.stderr.write(`${label} ${closureMissingGuidance(now, handed)}\n`);
}

// A launched reviewer that did not finish: the findings it wrote into its closure file so far are kept, as a partial round
// that names what it did not reach (so it is no audit). Named failure (I-152, audit of role launches): a reviewer that ran
// 12 hours on a 1,303-file change and one stopped after 94 minutes kept their findings only in their transcripts.
async function reviewerPartial(root, id, h, label, why) {
  const now = loadState(root, id);
  const handed = now.handoffs.find((x) => x.bundle === h.bundle);
  const file = handed?.closureFile ?? null;
  // The stop and a `wait` following the role both see it end: whichever records second says what the first kept.
  const keptNote = (r) => process.stderr.write(`${label} reviewer ${h.agent} did not finish; the ${r.closure?.findings?.length ?? 0} finding(s) it had written were kept as a partial round\n`);
  const already = (now.reviews ?? []).find((r) => r.handoff === h.bundle);
  if (already?.partial) keptNote(already);
  if (!file || !fs.existsSync(file) || already || (now.reviewsRefused ?? []).some((r) => r.handoff === h.bundle)) return;
  let closure;
  try {
    closure = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    process.stderr.write(`${label} reviewer ${h.agent} did not finish, and its closure file is not readable JSON (${file}); nothing was kept\n`);
    return;
  }
  if (!Array.isArray(closure.findings) || !closure.findings.length) return;
  const partial = path.join(path.dirname(file), `partial-${path.basename(file)}`);
  const unreached = Array.isArray(closure.notReached) ? closure.notReached.filter((x) => typeof x === 'string' && x.trim() && !/^none$/i.test(x.trim())) : [];
  fs.writeFileSync(partial, JSON.stringify({ ...closure, criteria: Array.isArray(closure.criteria) ? closure.criteria : [], notReached: [...unreached, `the round ended before the reviewer finished (${why}); the findings it wrote so far are kept`] }));
  try {
    const { recordReview } = await import('./lifecycle.mjs');
    recordReview(root, { attempt: id, closure: partial, salvaged: true, partial: true });
    process.stderr.write(`${label} reviewer ${h.agent} did not finish; the engine kept the ${closure.findings.length} finding(s) it had written, as a partial round (not an audit: the next round covers what it did not reach, from the last finished round)\n`);
  } catch (error) {
    const meanwhile = (loadState(root, id).reviews ?? []).find((r) => r.handoff === h.bundle && r.partial);
    if (meanwhile) return void keptNote(meanwhile);
    process.stderr.write(`${label} reviewer ${h.agent} did not finish, and its findings so far could not be kept: ${String(error.message ?? error).split('\n')[0]} (they are in ${file})\n`);
  }
}

// A launched implementer that completed is closed by the engine, with every check `wf handoff close` makes (its work
// committed, its report written); when one fails, it stays open and the owner is told why. Named failure (lessons of one
// attempt): 4,381 of 11,083 implementer minutes (40%) were finished roles waiting for the owner to close them.
async function implementerEnded(root, id, h, label) {
  const open = (loadState(root, id).implementers ?? []).some((x) => x.agent === h.agent && !x.closedAt);
  if (!open) return;
  try {
    const { closeImplementer, leftNotes } = await import('./lifecycle.mjs');
    const closed = closeImplementer(root, { attempt: id, agent: h.agent, closedBy: 'engine' });
    process.stderr.write(`${label} implementer ${h.agent} completed and the engine closed it (its work is committed and its report recorded); read its report in \`wf resume\` and continue\n${leftNotes(closed, id).map((l) => `${label} ${l}\n`).join('')}`);
  } catch (error) {
    // The owner may have closed it meanwhile: then there is nothing to say.
    if (!(loadState(root, id).implementers ?? []).some((x) => x.agent === h.agent && !x.closedAt)) return;
    process.stderr.write(`${label} implementer ${h.agent} completed but is still open: ${String(error.message ?? error).split('\n')[0]}; close it with \`wf handoff close --agent ${h.agent} --attempt ${id}\` once that is settled\n`);
  }
}

// The launched role of `--agent`, with its host, for `wf handoff wait|stop`.
function launched(root, options) {
  const state = openState(root, options);
  const h = state.handoffs.filter((x) => x.agent === options.agent && x.launch).at(-1);
  if (!h) throw refuse(`\`${options.agent ?? ''}\` has no engine-launched handoff on ${state.id}`, 'name the agent `wf handoff run` started');
  return { state, h, host: findHost(h.runtime) };
}

// `wf handoff wait --agent X [--minutes N]`: follows a launched role again and records its end. With `--minutes`, returns
// after that many more minutes from now if it is still running (the owner's own new expectation).
export async function waitRole(root, options) {
  const { state, h, host } = launched(root, options);
  if (['completed', 'failed'].includes(h.launch.status)) return { agent: h.agent, session: h.session ?? null, status: h.launch.status, exitCode: h.launch.status === 'completed' ? 0 : 1 };
  const minutes = options.minutes === undefined ? null : Number(options.minutes);
  if (minutes !== null && !(Number.isFinite(minutes) && minutes > 0)) throw new WfError('--minutes is a positive number (how many more minutes to follow it, from now)');
  // A role whose pid the system has given to another process ended long ago: following that process would end its group
  // on an interrupt (independent review of 0.7.9). `wf handoff stop` records it, signalling nothing.
  if (h.launch.pid && !stillTheRole(h.launch.pid, h.launch.spawnedAt)) throw refuse(`${h.agent}'s process ended; pid ${h.launch.pid} is another process now, so it is not followed`, `record it with \`wf handoff stop --agent ${h.agent} --attempt ${state.id}\` (it signals nothing), then hand a fresh role`, { id: 'launch:pid-reused' });
  const io = { ...runnerFiles(root, state.id, h), ...(h.launch.out ? { out: h.launch.out, err: h.launch.err } : {}) };
  const receipt = launchedBody(h);
  return follow(root, state.id, h, { host, runtime: h.runtime, label: host.name, requestedSession: h.launch.requestedSession ?? null, io, untilMinutes: minutes, relaunch: receipt?.developerInstructions ? { body: receipt.developerInstructions, nonGitRoot: receipt.skipGitRepoCheck === true } : null });
}

// `wf handoff stop --agent X`: ends a launched role's whole process tree and, once they are observed gone, records the
// role failed (stopped by the owner). Named failure (I-128): the stop was recorded and reported after one SIGTERM to the
// role's group that nothing checked; the role and its child kept running. A tree that cannot be ended is an error that
// says what still runs, and nothing is recorded.
export async function stopRole(root, options) {
  const { state, h } = launched(root, options);
  if (['completed', 'failed'].includes(h.launch.status)) throw refuse(`${h.agent} already ${h.launch.status}`);
  // A role whose pid now belongs to another process ended long ago: nothing of it is left to signal.
  const reused = h.launch.pid && !stillTheRole(h.launch.pid, h.launch.spawnedAt);
  if (h.launch.pid && !reused) {
    const ended = await endProcessTree(h.launch.pid);
    if (ended.left.length) {
      const { why, byHand } = leftOver(ended);
      throw new WfError(`${h.agent} was not stopped, still running: ${why}`, { hint: `nothing was recorded as stopped. ${byHand}, then \`wf handoff stop --agent ${h.agent} --attempt ${state.id}\` again to record it` });
    }
  }
  append(root, state.id, 'agent.launch.finished', { handoff: h.bundle, status: 'failed', exitCode: 143, failure: { kind: 'stopped', detail: `stopped by the owner${typeof options.reason === 'string' && options.reason.trim() ? `: ${options.reason.trim()}` : ''}${reused ? ` (its process had already ended; pid ${h.launch.pid} is another process now, left alone)` : ''}` } }, actor(options));
  seal(append);
  if (h.role === 'reviewer' && !h.reviewGroup) await reviewerPartial(root, state.id, h, h.agent, 'stopped');
  return { agent: h.agent, status: 'stopped' };
}
