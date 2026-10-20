// Launching a fresh reviewer (design section 2, step 6): `wf` starts it, so the engine knows its session, and the
// review bundle is its entire prompt. The launch runs under a small detached supervisor (this file with `--supervise`)
// that outlives the `wf` call: it feeds the prompt, keeps the host's event stream, and resumes the session when the host
// reports the model at capacity (D61), for as long as it keeps reporting it, with growing waits.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WfError, append, attemptDir, worktreeDir } from './contract.mjs';
import { callerSession, findHost, hostIds, jsonSpan, sessionVariables } from './hosts/index.mjs';

const SELF = fileURLToPath(import.meta.url);
const PLUGIN_BIN = path.resolve(path.dirname(SELF), '..', 'bin');
export const RESUME_PROMPT = 'The model was at capacity and your turn ended before you finished. Continue from where you stopped; your instructions are unchanged.';
const WAITS_S = [0, 60, 120, 240, 480, 600];

// The launched role calls this engine's `wf`, and carries no variable that would make it look like its launcher.
function launchEnv() {
  const env = { ...process.env, PATH: `${PLUGIN_BIN}${path.delimiter}${process.env.PATH ?? ''}` };
  for (const k of sessionVariables()) delete env[k];
  env.AI_AGENT = 'wf-reviewer'; // an agent, never mistaken for the person at a terminal
  return env;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const writeJson = (file, value) => {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
};

// The host that launches reviewers for a caller on `runtime` (its own when it can, else the first that can), and another
// installed host for a second reviewer with no model of its own.
export function reviewerHosts(runtime) {
  const caller = findHost(runtime);
  const first = caller?.launch ? caller : hostIds().map(findHost).find((h) => h?.launch) ?? null;
  return { first, other: otherHosts(first?.id)[0] ?? null };
}

// The hosts other than `id` that can launch a reviewer here: a launch spec, and its command on PATH.
export function otherHosts(id) {
  return hostIds().map(findHost).filter((h) => h && h.id !== id && h.launch && installed(h));
}
function installed(host) {
  try {
    const bin = host.launch({ model: null, cwd: process.cwd(), closure: null })?.bin;
    return Boolean(bin) && spawnSync('sh', ['-c', 'command -v "$1"', 'sh', bin], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

export async function launchReviewer(root, attempt, bundle, opts = {}) {
  if (typeof bundle?.prompt !== 'string' || !bundle.prompt.trim()) throw new WfError('the review bundle has no prompt; a reviewer is launched with the bundle as its whole prompt');
  // The caller's own host runs the reviewer when it can launch one; otherwise the first registered host that can.
  const hosts = reviewerHosts(opts.runtime ?? callerSession(process.env)?.runtime);
  // `otherHost`: a second reviewer with no model of its own runs on another host whose command is installed, so it
  // reviews on another model; with none, on the usual host (the merge facts then name the missing model).
  const host = (opts.otherHost && hosts.other) || hosts.first;
  if (!host) throw new WfError('no registered host can launch a reviewer');
  const model = opts.model ?? bundle.model ?? null;
  const worktrees = path.dirname(worktreeDir(root, attempt, 'x'));
  const cwd = fs.existsSync(worktrees) ? worktrees : root;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(attemptDir(root, attempt), 'reviews', `launch-${String(bundle.seat ?? 'whole').replace(/[^A-Za-z0-9-]/g, '-')}-r${bundle.round ?? 1}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  // The one file the reviewer may write: its review (findings and verified blockers), at a path fixed before launch.
  const closure = opts.closure ? path.resolve(opts.closure) : path.join(dir, 'review.json');
  const spec = { host: host.id, model, cwd, closure, prompt: path.join(dir, 'prompt.txt'), out: path.join(dir, 'events.jsonl'), err: path.join(dir, 'stderr.log'), status: path.join(dir, 'status.json') };
  fs.writeFileSync(spec.prompt, bundle.prompt, { mode: 0o600 });
  writeJson(path.join(dir, 'spec.json'), spec);
  const sup = spawn(process.execPath, [SELF, '--supervise', path.join(dir, 'spec.json')], { cwd, env: launchEnv(), detached: true, stdio: 'ignore' });
  let exited = false;
  sup.once('exit', () => { exited = true; });
  sup.once('error', () => { exited = true; });
  sup.unref();
  // Launched means the host has a session for it (a host may name its session only once the run has started).
  let status = null;
  for (;;) {
    status = readJson(spec.status);
    if (status?.session || status?.state === 'failed' || status?.state === 'done') break;
    if (exited && !readJson(spec.status)) {
      status = { state: 'failed', error: 'the launch supervisor ended without a word' };
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!status.session) throw new WfError(`the ${host.label} reviewer could not be launched: ${status.error ?? 'it ended before it started a session'} (${spec.err})`);
  const session = { runtime: host.id, id: status.session };
  await append(root, attempt, 'handoff', { role: 'reviewer', session, launchedBy: 'wf', seat: bundle.seat ?? 'whole', model, tree: bundle.tree ?? null, ...(bundle.heads ? { heads: bundle.heads } : {}), round: bundle.round ?? 1 }, callerSession(process.env));
  return { session, launchedAt: status.startedAt, closure };
}

// ---- The supervisor ----

function runOnce(host, spec, resumeSession, onEvent) {
  const l = resumeSession ? host.resume({ model: spec.model, cwd: spec.cwd, closure: spec.closure, session: resumeSession }) : host.launch({ model: spec.model, cwd: spec.cwd, closure: spec.closure });
  return new Promise((resolve) => {
    const err = fs.openSync(spec.err, 'a');
    let child;
    try {
      child = spawn(l.bin, l.args, { cwd: spec.cwd, env: process.env, stdio: ['pipe', 'pipe', err] });
    } catch (error) {
      fs.closeSync(err);
      return resolve({ error: error.message });
    }
    fs.closeSync(err);
    let ended = null;
    let capacity = false;
    let text = null;
    let buf = '';
    child.once('error', (error) => resolve({ error: error.message }));
    child.once('spawn', () => {
      if (l.session) onEvent({ started: l.session });
      child.stdin.end(resumeSession ? RESUME_PROMPT : fs.readFileSync(spec.prompt, 'utf8'));
    });
    child.stdout.on('data', (chunk) => {
      fs.appendFileSync(spec.out, chunk);
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        const r = host.event(e);
        if (r.started) onEvent({ started: r.started });
        if (typeof r.text === 'string') text = r.text;
        if (r.ended) ended = r.ended;
        if (r.capacity) capacity = true;
      }
    });
    child.once('close', (code) => resolve({ code, ended, capacity, text }));
  });
}

// The review file once the reviewer has ended: when the reviewer wrote none, its final message is written there; a file
// that is not JSON as it stands (a host that writes the last message whole, with a fence or a sentence around the
// JSON) keeps only its JSON, from the first `{` to the last `}`. recordReview checks the file against the reviewer's
// transcript (hosts `writtenBy`), so what is written here is only ever the reviewer's own final message.
export function settleClosure(closure, finalText) {
  let current = null;
  try {
    current = fs.readFileSync(closure, 'utf8');
  } catch {}
  if (current === null && (typeof finalText !== 'string' || !finalText.trim())) return;
  try {
    if (current !== null) JSON.parse(current);
    if (current !== null) return; // already JSON
  } catch {}
  const json = jsonSpan(current ?? finalText);
  const body = json !== null ? `${JSON.stringify(json, null, 2)}\n` : current ?? finalText;
  if (body === current) return;
  fs.writeFileSync(`${closure}.tmp`, body);
  fs.renameSync(`${closure}.tmp`, closure);
}

async function supervise(specFile) {
  const spec = readJson(specFile);
  const host = findHost(spec.host);
  // pid: this supervisor, so a reader knows a run whose supervisor died before it ended will never end (failed). pidAt:
  // when this process started (not when it got here), so the reader's 2-second match with `ps` holds however slow the
  // imports were.
  const status = { state: 'starting', session: null, startedAt: null, resumes: 0, pid: process.pid, pidAt: new Date(Date.now() - process.uptime() * 1000).toISOString() };
  const save = () => writeJson(spec.status, status);
  const onEvent = ({ started }) => {
    if (started && !status.session) {
      Object.assign(status, { state: 'running', session: started, startedAt: new Date().toISOString() });
      save();
    }
  };
  const testWait = process.env.WF_TEST === '1' && process.env.WF_CAPACITY_WAIT_MS ? Number(process.env.WF_CAPACITY_WAIT_MS) : null;
  for (let tries = 0; ; tries++) {
    const r = await runOnce(host, spec, tries ? status.session : null, onEvent);
    if (r.error) {
      Object.assign(status, { state: 'failed', error: r.error });
      return save();
    }
    if (!(r.capacity && !r.ended?.ok)) {
      const ok = r.code === 0 && r.ended?.ok !== false;
      if (ok) settleClosure(spec.closure, r.text);
      Object.assign(status, { state: ok ? 'done' : 'failed', exitCode: r.code, endedAt: new Date().toISOString() });
      return save();
    }
    status.resumes += 1;
    status.state = 'capacity';
    save();
    const wait = testWait ?? WAITS_S[Math.min(tries, WAITS_S.length - 1)] * 1000;
    await new Promise((res) => setTimeout(res, wait));
  }
}

if (process.argv[2] === '--supervise' && process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  supervise(process.argv[3]).catch((error) => {
    const spec = readJson(process.argv[3]);
    if (spec?.status) writeJson(spec.status, { state: 'failed', error: error.message });
  });
}

export const implements08 = { launchReviewer };
