// Named failure I-41: an assistant-reported desktop spawn cannot establish the encrypted start prompt.
// wf sends the frozen line itself to a fresh native Codex exec process with the trusted role/model/effort.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { actor, openState, treeHashes } from './attempt.mjs';
import { adapterFileAtCommit, trustedAdapter } from './config.mjs';
import { append, loadState } from './ledger.mjs';
import { seal } from './evidence.mjs';
import { roleInstructions } from './onboard.mjs';
import { canonical, refuse, sha256, withFileLock, writeJson } from './util.mjs';

export async function runCodexRole(root, options) {
  const state = openState(root, options);
  const h = state.handoffs.filter((h) => h.agent === options.agent).at(-1);
  if (!h || h.runtime !== 'codex') throw refuse('name an existing Codex handoff with `--agent <id>`');
  if (state.activeHold) throw refuse(`this attempt is on hold: ${state.activeHold.reason}`);
  if (h.role === 'reviewer' && state.handoffs.filter((h) => h.role === 'reviewer').at(-1)?.bundle !== h.bundle) throw refuse('only the current reviewer handoff can be launched');
  if (h.tree && canonical(treeHashes(state)) !== canonical(h.tree)) throw refuse('the handed tree changed before launch; create a fresh handoff');
  if (['planner', 'reviewer'].includes(h.role) && !h.model) throw refuse('pin the Codex planning/review model in the adapter before launch; run `wf doctor --runtime codex`');
  const cfg = trustedAdapter(root, state);
  const appendix = cfg.roles?.[h.role]?.appendix;
  const extra = appendix ? fs.readFileSync(adapterFileAtCommit(root, state, state.adapterBase, appendix), 'utf8') : '';
  const body = roleInstructions(cfg, h.role, h.class, extra);
  const file = h.bundle.replace(/\.json$/, '.launch.json');
  const receipt = { handoff: h.bundle, agentType: h.agentType, prompt: h.startPrompt, model: h.model, effort: h.effort, developerInstructions: body };
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
  if (h.model) args.push('--model', h.model);
  if (h.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(h.effort)}`);
  args.push('-');
  const child = spawn('codex', args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
      if (e.type === 'thread.started') {
        if (session || typeof e.thread_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(e.thread_id)) throw new Error('Codex supplied an invalid or repeated session id');
        if (loadState(root, state.id).handoffs.some((other) => other.bundle !== h.bundle && other.session === e.thread_id)) throw new Error('Codex reused another handoff session id');
        session = e.thread_id;
        append(root, state.id, 'agent.launch.started', { handoff: h.bundle, session }, 'engine:codex');
        seal(append);
      }
      if (e.type === 'turn.completed') completed = true;
      if (e.type === 'turn.failed' || e.type === 'error') problem = 'Codex reported a failed turn';
    }
  } catch (e) { problem = e.message; child.kill('SIGTERM'); }
  const exitCode = await ended;
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  const success = exitCode === 0 && session && completed && !problem;
  append(root, state.id, 'agent.launch.finished', { handoff: h.bundle, status: success ? 'completed' : 'failed', exitCode }, 'engine:codex');
  if (!success) process.stderr.write(`Codex role failed: ${problem ?? (stderr.trim() || 'no completed turn')}\n`);
  return { agent: h.agent, session, status: success ? 'completed' : 'failed', exitCode: success ? 0 : exitCode || 1 };
}
