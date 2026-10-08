// Named failure I-41: an assistant-reported desktop spawn cannot establish the encrypted start prompt.
// wf sends the frozen line itself to a fresh native Codex exec process with the trusted role/model/effort.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { executionSettings, rejectModelOverrides } from './models.mjs';
import { actor, openState, treeHashes } from './attempt.mjs';
import { adapterFileAtCommit, trustedAdapter } from './config.mjs';
import { append, loadState } from './ledger.mjs';
import { seal } from './evidence.mjs';
import { roleInstructions } from './onboard.mjs';
import { roleProgress, ROLE_HEARTBEAT_MS } from './role-progress.mjs';
import { assertPlainGit, canonical, git, refuse, sha256, withFileLock, writeJson } from './util.mjs';

export async function runCodexRole(root, options) {
  rejectModelOverrides(options);
  const state = openState(root, options);
  const h = state.handoffs.filter((h) => h.agent === options.agent).at(-1);
  if (!h || h.runtime !== 'codex') throw refuse('name an existing Codex handoff with `--agent <id>`');
  if (state.activeHold) throw refuse(`this attempt is on hold: ${state.activeHold.reason}`);
  if (h.role === 'reviewer' && state.handoffs.filter((h) => h.role === 'reviewer').at(-1)?.bundle !== h.bundle) throw refuse('only the current reviewer handoff can be launched');
  if (h.tree && canonical(treeHashes(state)) !== canonical(h.tree)) throw refuse('the handed tree changed before launch; create a fresh handoff');
  if (['planner', 'reviewer'].includes(h.role) && !h.model) throw refuse('this handoff pins no Codex model; run `wf models refresh --attempt <id>`, then create a fresh handoff');
  const expected = executionSettings(root, state, h.role, h.class, 'codex', h.runtimeAdapterBase ?? state.adapterBase);
  if (h.model !== expected.model || h.effort !== expected.effort) throw refuse('handoff execution settings differ from their committed pin; create a fresh handoff');
  const cfg = trustedAdapter(root, state);
  const appendix = cfg.roles?.[h.role]?.appendix;
  const extra = appendix ? fs.readFileSync(adapterFileAtCommit(root, state, state.adapterBase, appendix), 'utf8') : '';
  const body = roleInstructions(cfg, h.role, h.class, extra);
  // Named failure I-46: registered multi-repo projects intentionally have no parent Git repo.
  // Bypass only Codex's Git-root prerequisite, after checking every recorded worktree; keep the sandbox.
  const nonGitRoot = git(root, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }) !== 'true';
  if (nonGitRoot) {
    const repos = Object.values(state.repos);
    if (!repos.length) throw refuse('a native role needs at least one recorded Git worktree');
    for (const repo of repos) {
      assertPlainGit(repo.worktree);
      const top = git(repo.worktree, ['rev-parse', '--show-toplevel']);
      if (fs.realpathSync(top) !== fs.realpathSync(repo.worktree)) throw refuse('a recorded role worktree is not a Git repository root');
    }
  }
  const file = h.bundle.replace(/\.json$/, '.launch.json');
  const receipt = { handoff: h.bundle, agentType: h.agentType, prompt: h.startPrompt, model: h.model, effort: h.effort, runtimeAdapterBase: expected.runtimeAdapterBase, sourceClass: expected.sourceClass, developerInstructions: body, cwd: root, sandbox: 'workspace-write', skipGitRepoCheck: nonGitRoot };
  withFileLock(h.bundle + '.launch.lock', () => {
    if (loadState(root, state.id).handoffs.find((x) => x.bundle === h.bundle)?.launch) throw refuse('this handoff was already launched; create a fresh handoff, never reuse a review round');
    writeJson(file, receipt);
    append(root, state.id, 'agent.launch.requested', { handoff: h.bundle, file, sha256: sha256(JSON.stringify(receipt, null, 2) + '\n') }, actor(options));
  });
  seal(append);
  const env = { ...process.env };
  // I-41: the launched role must call this engine, even when the user's global wf still points to an older plugin.
  env.PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin') + path.delimiter + (env.PATH ?? '');
  for (const name of ['CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'GROK_SESSION_ID', 'AI_AGENT']) delete env[name];
  const args = ['exec', '--json', '--cd', root, '--sandbox', 'workspace-write', '-c', `developer_instructions=${JSON.stringify(body)}`];
  if (nonGitRoot) args.push('--skip-git-repo-check');
  if (h.model) args.push('--model', h.model);
  if (h.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(h.effort)}`);
  args.push('-');
  const child = spawn('codex', args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  // Named failure I-52: quiet launches caused repeated owner transcript scans and duplicated interim review analysis.
  // Observe only this live child handle; a historical launch receipt never establishes current liveness.
  const progress = roleProgress(h);
  const heartbeat = setInterval(() => {
    if (child.exitCode === null && child.signalCode === null && !child.killed) progress.heartbeat();
  }, ROLE_HEARTBEAT_MS);
  heartbeat.unref();
  let session = null, completed = false, problem = null, stderr = '';
  const interrupted = () => { problem = 'the role launch was interrupted'; child.kill('SIGTERM'); };
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-4000); });
  const ended = new Promise((resolve) => { child.once('error', (e) => { problem = e.message; resolve(1); }); child.once('close', (code) => resolve(code ?? 1)); });
  child.stdin.on('error', () => {});
  child.stdin.end(h.startPrompt);
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 8 * 1024 * 1024) throw new Error('Codex event exceeds the read cap');
      let e; try { e = JSON.parse(line); } catch { continue; }
      progress.event();
      if (e.type === 'thread.started') {
        if (session || typeof e.thread_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(e.thread_id)) throw new Error('Codex supplied an invalid or repeated session id');
        if (loadState(root, state.id).handoffs.some((other) => other.bundle !== h.bundle && other.session === e.thread_id)) throw new Error('Codex reused another handoff session id');
        session = e.thread_id;
        append(root, state.id, 'agent.launch.started', { handoff: h.bundle, session }, 'engine:codex');
        seal(append);
        progress.start(session);
      }
      if (e.type === 'turn.completed') completed = true;
      if (e.type === 'turn.failed' || e.type === 'error') problem = 'Codex reported a failed turn';
    }
  } catch (e) { problem = e.message; child.kill('SIGTERM'); }
  const exitCode = await ended;
  clearInterval(heartbeat);
  progress.finish();
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  const success = exitCode === 0 && session && completed && !problem;
  // Named failure I-47: a parent sandbox can block host initialization before any native session starts.
  // Diagnose only the observed permission signature; never change or retry the child's sandbox here.
  const permission = !session && !success && !problem && /failed to initialize in-process app-server client:\s*(Operation not permitted|Permission denied)(?: \(os error \d+\))?/.exec(stderr);
  const failure = permission ? { kind: 'host-initialization-permission', detail: permission[0] } : null;
  append(root, state.id, 'agent.launch.finished', { handoff: h.bundle, status: success ? 'completed' : 'failed', exitCode, ...(failure ? { failure } : {}) }, 'engine:codex');
  if (!success) process.stderr.write(`Codex role failed: ${problem ?? (stderr.trim() || 'no completed turn')}\n`);
  if (failure) process.stderr.write('Native Codex host initialization was denied before a session started. Create a fresh handoff, then use approved host execution with access to the native runtime and session store. Retain the child sandbox (workspace-write); do not bypass a rejected approval or reuse this failed handoff.\n');
  return { agent: h.agent, session, status: success ? 'completed' : 'failed', exitCode: success ? 0 : exitCode || 1 };
}
