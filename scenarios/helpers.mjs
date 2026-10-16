import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRoot } from '../engine/config.mjs';
import { verifyAttempt } from '../engine/evidence.mjs';
import { assertSchema, listAttempts, loadState } from '../engine/ledger.mjs';
import { ENGINE_VERSION } from '../engine/util.mjs';

export const WF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wf');

// Named cost: on macOS without another git first on PATH, `git` is /usr/bin/git, the developer-tools shim that asks
// xcrun where the real binary is on every call (9.4ms against 3.8ms for `git --version` here). The engine runs git
// about ten times per command: some 35,000 calls a suite run. Scenarios put the folder the shim resolves to on PATH,
// for this process and every process it starts: the same binary and the same git-core (checked below), without
// the lookup. The folder goes right before /usr/bin, so anything found earlier on PATH still wins and anything else in
// it is what the /usr/bin shims resolve to anyway. CI's macOS runners already have another git first on PATH.
(function realGitFirst() {
  if (process.platform !== 'darwin') return;
  const which = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  if (which !== '/usr/bin/git') return;
  const real = spawnSync('xcrun', ['-f', 'git'], { encoding: 'utf8' }).stdout?.trim();
  if (!real || !path.isAbsolute(real) || real === which) return;
  const execPath = (g) => spawnSync(g, ['--exec-path'], { encoding: 'utf8' }).stdout?.trim();
  if (!execPath(which) || execPath(real) !== execPath(which)) return;
  const dirs = process.env.PATH.split(path.delimiter);
  if (!dirs.includes('/usr/bin')) return;
  dirs.splice(dirs.indexOf('/usr/bin'), 0, path.dirname(real));
  process.env.PATH = dirs.join(path.delimiter);
})();

export function sh(cwd, cmd) {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed in ${cwd}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

// The person's own user-level state (the refusal log, the improvements inbox, the project registry, gate leases) is
// never a scenario's: a command a test spawns with a copy of process.env inherits this test-file process's private
// folders. Named failure (I-131): one scenario's runs wrote 138 refusals from temporary projects into the person's log, which
// `wf refusals` and plugin triage then read as real use. Spawns that name their own folders still override these.
{
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wf-user-state-'));
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.WF_IMPROVEMENTS_DIR = path.join(dir, 'improvements');
  process.env.WF_CONFIG_HOME = path.join(dir, 'config');
  // No scenario calls a real model: the learning classifier (engine/learning.mjs) runs only where a scenario turns it on
  // with a fake runtime on PATH.
  process.env.WF_LEARNING = 'off';
}

// Node's on-disk compile cache for the `wf` processes this test file starts (keyed by source hash, so an edited engine
// file is compiled afresh). Named cost: a scenario run starts some 3,000 of them, each compiling the whole engine
// (about 8ms). The cache is code the engine runs, so it is never at a path anyone else can predict or pre-create: a
// fresh `mkdtemp` folder (mode 0700, this user's) per test-file process, checked after creation, removed at exit.
let compileCache = null;
export function compileCacheDir() {
  if (compileCache) return compileCache;
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wf-node-cache-'));
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || st.mode & 0o077) throw new Error(`compile cache folder ${dir} is not a private folder of this user`);
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return (compileCache = dir);
}

const baseEnv = () => {
  // The immutable flag stays off in tests (temporary folders must stay removable); modes and the manifest still apply.
  // A scenario runs this checkout's wf, never the release installed on the machine (0.7.19 forwards an older copy to it).
  const env = { NODE_COMPILE_CACHE: compileCacheDir(), ...process.env, WF_NO_FORWARD: '1', WF_EVIDENCE_FLAGS: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k]; // no agent runtime: the scenario is the owner at a terminal (engine/owner.mjs)
  delete env.CODEX_THREAD_ID;
  delete env.GROK_SESSION_ID;
  return env;
};

// Owner decisions (engine/owner.mjs, engine/approve.mjs). Bookkeeping needs nothing. A reserved decision (lifting a hold,
// overriding the gate order, deferring a discovered issue, adopting a live owner's attempt, ...) is created by the refused
// command and confirmed by the person with `wf approve`. A scenario plays that person: a command refused with a pending
// decision is confirmed (scenarios/approve-as-owner.mjs, the shape `wf approve` accepts) and run once more. Scenarios about
// the refusal itself pass `ownerSilent: true`. A person's name given to `--owner` (or none, at entry) becomes a synthetic
// Codex session id, so that role handoffs default to Codex as they always did here; `plain:<name>` keeps the name as is.
export const ownerSession = (name) => (/^(claude|codex):/.test(String(name)) ? String(name) : /^plain:/.test(String(name)) ? String(name).slice(6) : `codex:owner-${Buffer.from(String(name)).toString('hex').slice(0, 40)}`);
const homeOf = (cwd, env) => env.WF_HOME ?? path.join(cwd, '..', '.home');
const APPROVE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'approve-as-owner.mjs');

export function wf(cwd, args, { env = {}, input, home, implementersOpen = false, ownerSilent = false, preserveRuntime = false, bin = WF } = {}) {
  args = [...args];
  // Historical role fixtures model Claude unless a runtime was explicit.
  if (!preserveRuntime && args[0] === 'handoff' && ['planner', 'implementer', 'reviewer', 'tester'].includes(args[1]) && !args.includes('--runtime')) {
    args.push('--runtime', env.CLAUDE_CODE_SESSION_ID ? 'claude' : env.CODEX_THREAD_ID ? 'codex' : 'claude');
  }
  const at = args.indexOf('--owner');
  if (at >= 0 && typeof args[at + 1] === 'string') args[at + 1] = ownerSession(args[at + 1]);
  else if (args[0] === 'entry' && !args.includes('--help')) args.push('--owner', ownerSession('owner'));
  const opts = { env, home, bin };
  // The owner closes each implementer once it reports done (`wf handoff close`), and `wf handoff reviewer` refuses while
  // one is open (I-23). Scenarios about something else take that step here, before each reviewer handoff; the ones
  // about the refusal itself pass `implementersOpen: true` (or `--reason`) and see the engine as it is.
  if (args[0] === 'handoff' && args[1] === 'reviewer' && !implementersOpen && !args.includes('--reason')) closeOpenImplementers(cwd, args, opts, ownerSilent);
  const run = () => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', input, maxBuffer: 512 * 1024 * 1024, env: { ...baseEnv(), WF_CONFIG_HOME: home ?? path.join(cwd, '..', '.wfhome'), WF_HOME: path.join(cwd, '..', '.home'), WF_IMPROVEMENTS_DIR: path.join(cwd, '..', '.improvements'), ...env } });
  if (!ownerSilent) scriptedReport(cwd, args);
  let r = run();
  if (!ownerSilent && r.status === 75 && approvePending(cwd, args, r.stderr, opts)) r = run();
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

const optionOf = (args, k) => {
  const i = args.indexOf(k);
  return i >= 0 && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

// 0.7.0: an implementer closed as done has written its report (`implementerReportFile` in its bundle); the scenarios'
// implementers are scripted, so the scripted owner writes a minimal one for them unless a scenario wrote its own (or
// passes ownerSilent).
export function reportFileOf(root, id, agent) {
  const h = loadState(root, id).handoffs.filter((x) => x.role === 'implementer' && x.agent === agent).at(-1);
  if (!h?.reportFile) throw new Error(`${id} handed ${agent} no report file`);
  return h.reportFile;
}

// The report an implementer writes: the fields it must carry, with `extra` (summary, approach, ran, proofs, left) over them.
export function writeReport(root, id, agent, extra = {}) {
  const file = reportFileOf(root, id, agent);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ implementer: agent, summary: 'scenario implementer: the work item is built and committed', ran: [], proofs: [], left: [], ...extra }));
  return file;
}

function scriptedReport(cwd, args) {
  if (args[0] !== 'handoff' || args[1] !== 'close') return;
  const i = args.indexOf('--agent');
  const o = args.indexOf('--outcome');
  if (i < 0 || (o >= 0 && args[o + 1] !== 'done')) return;
  let root;
  try {
    root = findRoot(cwd);
  } catch {
    return;
  }
  const agent = args[i + 1];
  const a = args.indexOf('--attempt');
  for (const id of a >= 0 ? [args[a + 1]] : listAttempts(root)) {
    let s;
    try {
      s = loadState(root, id);
    } catch {
      continue;
    }
    const h = s.handoffs.filter((x) => x.role === 'implementer' && x.agent === agent).at(-1);
    if (!h?.reportFile || fs.existsSync(h.reportFile)) continue;
    writeReport(root, id, agent);
  }
}

// The person confirms the decision a refusal named (`wf approve A1 --attempt X`, choices a | b): `--choice` when the
// command carries one the decision offers, else yes.
function approvePending(cwd, args, stderr, opts) {
  // 0.7.8 (D18): items that would leave a delivery are asked one question each; the scripted person lets them all leave.
  if (/the person decides th/.test(stderr)) {
    const asked = [...stderr.matchAll(/wf approve (A\d+) --from-question --attempt (\S+)/g)];
    for (const [, id, attempt] of asked) approveAsOwner(cwd, attempt, id, 'let it leave', opts);
    return asked.length > 0;
  }
  const m = /`wf approve (A\d+) --attempt (\S+)` in their own terminal \(choices: ([^)]*)\)/.exec(stderr);
  if (!m) return false;
  const choices = m[3].split(' | ');
  const want = optionOf(args, '--choice');
  const choice = want && choices.includes(want) ? want : choices.includes('yes') ? 'yes' : choices[0];
  approveAsOwner(cwd, m[2], m[1], choice, opts);
  return true;
}

// The scripted person types the choice for decision `id` of `attempt` (`wf approve` at a terminal).
export function approveAsOwner(cwd, attempt, id, choice, { env = {}, home } = {}) {
  const r = spawnSync(process.execPath, [APPROVE, findRoot(cwd), attempt, id, choice], { cwd, encoding: 'utf8', env: { ...baseEnv(), WF_CONFIG_HOME: home ?? path.join(cwd, '..', '.wfhome'), WF_HOME: homeOf(cwd, env), WF_IMPROVEMENTS_DIR: path.join(cwd, '..', '.improvements'), ...env } });
  if (r.status !== 0) throw new Error(`the scenario owner could not confirm ${id} on ${attempt}: ${r.stderr || r.stdout}`);
}

// For a `wf` process a scenario spawns itself (a gate it watches or stops): run the command once so that it is refused
// with its pending decision, and confirm that decision; the scenario then spawns the same command. Its env must carry the
// scenario's WF_HOME (`spawnHome`).
export function ownerSpeaks(cwd, args) {
  const r = spawnSync(process.execPath, [WF, ...args], { cwd, encoding: 'utf8', env: { ...baseEnv(), WF_CONFIG_HOME: path.join(cwd, '..', '.wfhome'), WF_HOME: path.join(cwd, '..', '.home'), WF_IMPROVEMENTS_DIR: path.join(cwd, '..', '.improvements') } });
  if (r.status === 75) approvePending(cwd, args, r.stderr, { env: {} });
}
export const spawnHome = (cwd) => ({ WF_HOME: path.join(cwd, '..', '.home') });

// What the scripted owner knows of the attempt a command names: its id, owner and implementers. Named cost: each lookup
// was a `wf resume` process (about 14 git calls, 0.3s), 595 of the suite's 3,750 `wf` processes, none of them the
// subject of a scenario. When the command names its attempt, this process reads it as `wf resume` would: the evidence
// verified (`verifyAttempt`, the check every `wf` process runs when it opens an attempt; any problem and resume refuses,
// so the owner says and closes nothing), then the ledger folded (`loadState`, hash chain checked). Anything else (no
// `--attempt`, `--root`, an attempt another engine version created and the engine adopts on first open) runs
// `wf resume`. The commands themselves still run as real processes. `WF_SCENARIO_CHECK_OWNER=1` does both and fails
// on any difference (CONTRIBUTING.md, "Running the suite").
function attemptOf(cwd, args, opts) {
  const id = optionOf(args, '--attempt');
  const viaResume = () => {
    const r = wf(cwd, ['resume', '--json', ...(id ? ['--attempt', id] : [])], { ...opts, ownerSilent: true });
    return r.code === 0 ? JSON.parse(r.out) : null;
  };
  const known = id && !args.includes('--root') ? ledgerState(cwd, id) : undefined;
  if (known === undefined) return viaResume();
  if (process.env.WF_SCENARIO_CHECK_OWNER) {
    const slow = viaResume();
    const pick = (s) => (s ? JSON.stringify({ id: s.id, owner: s.owner, implementers: s.implementers ?? [] }) : 'null');
    if (pick(slow) !== pick(known)) throw new Error(`scenario owner lookup differs from \`wf resume\` for ${id}:\n  ledger: ${pick(known)}\n  resume: ${pick(slow)}`);
  }
  return known;
}

// undefined: only `wf resume` can tell; null: `wf resume` refuses (unknown attempt, changed evidence, broken chain,
// newer schema).
function ledgerState(cwd, id) {
  const root = findRoot(cwd);
  if (!root) return undefined;
  let s;
  try {
    s = loadState(root, id);
  } catch {
    return verifyAttempt(root, id).length ? null : undefined;
  }
  if (s.engineVersion !== ENGINE_VERSION) return undefined;
  try {
    assertSchema(s);
  } catch {
    return null;
  }
  return verifyAttempt(root, id).length ? null : s;
}

// A line in a synthetic owner session's transcript (Codex rollout, or Claude Code when the scenario made the owner a
// Claude session itself). Writing it also makes the session "alive" for `wf adopt` (engine/owner.mjs: a transcript
// written in the last 30 minutes).
export function ownerSays(homeDir, owner, text) {
  const m = /^(claude|codex):(.+)$/.exec(String(owner ?? ''));
  if (!m) return;
  const [, runtime, sid] = m;
  const at = new Date().toISOString();
  if (runtime === 'codex') {
    const file = path.join(homeDir, '.codex', 'sessions', `rollout-scenario-${sid}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })}\n`);
    return;
  }
  const projects = path.join(homeDir, '.claude', 'projects');
  const existing = fs.existsSync(projects) ? fs.readdirSync(projects).map((d) => path.join(projects, d, `${sid}.jsonl`)).find((f) => fs.existsSync(f)) : null;
  const file = existing ?? path.join(projects, '-proj', `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ type: 'user', userType: 'external', timestamp: at, sessionId: sid, message: { role: 'user', content: text } })}\n`);
}

function closeOpenImplementers(cwd, args, opts, ownerSilent) {
  const s = attemptOf(cwd, args, opts);
  if (!s) return; // the reviewer handoff reports the problem itself
  // A close the engine refuses (uncommitted work) leaves the implementer open; the reviewer handoff then says why.
  for (const impl of (s.implementers ?? []).filter((y) => !y.closedAt)) wf(cwd, ['handoff', 'close', '--agent', impl.agent, '--attempt', s.id], { ...opts, ownerSilent });
}

export function ok(r) {
  if (r.code !== 0) throw new Error(`expected success, got ${r.code}:\n${r.err}\n${r.out}`);
  return r;
}

export function write(dir, rel, content) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

export const yaml = (o) => JSON.stringify(o, null, 2); // JSON is valid YAML.

// A git repo with a bare "origin" remote, initial commit on main.
export function makeRepo(dir, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const remote = `${dir}.origin.git`;
  sh(path.dirname(dir), `git init -q --bare -b main ${JSON.stringify(remote)}`);
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email t@example.test && git config user.name t && git config commit.gpgsign false');
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  sh(dir, `git add -A && git commit -q -m init && git remote add origin ${JSON.stringify(remote)} && git push -q origin main`);
  return { dir, remote };
}

export function tmp(name) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `wf-${name}-`));
}

// Single-repo project: the repo is the root and holds .workflow/.
export function singleRepoProject(name, config, files = {}) {
  const base = tmp(name);
  const root = path.join(base, 'proj');
  const cfg = { version: 1, enabled: true, name, repos: [{ name: 'app', path: '.', base: 'main' }], lanes: ['quick', 'standard', 'batch'], ...config };
  makeRepo(root, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\n', '.workflow/project.yaml': yaml(cfg), 'src/a.txt': 'a\n', ...files });
  return { base, root, remote: `${root}.origin.git` };
}

export function commitIn(dir, files, msg = 'change') {
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  sh(dir, `git add -A && git commit -q -m ${JSON.stringify(msg)}`);
}

// The two impact stages (I-26) for scenarios about other things: one zero-hit query, one survey pattern the one change
// covers. A plan uses the fixed `fixture` ids (goodClosure's impactChecked names them); an amendment's addendum needs
// new ids (amendFile).
export function stages(criteria = [{ id: 'C1' }], work = null, n = 'fixture') {
  const q = `Q-${n}`;
  const cites = criteria.filter((c) => !c.dropped).map((c) => c.id);
  return {
    survey: { queries: [{ id: q, pattern: 'scenario-fixture-matches-nothing', kind: 'literal', hits: 0 }], patterns: [{ id: `P-${n}`, description: 'scenario fixture', query: q, hits: 0 }] },
    impact: { changes: [{ id: `I-${n}`, element: 'the scenario change', kind: 'symbol', cites, covers: [`P-${n}`], consumers: { query: q, hits: 0 }, flows: [{ flow: 'use it', failure: 'shows an error', query: q, hits: 0 }], contracts: [], suites: [{ suite: 'scenario-suite', query: q, hits: 0 }], ...(work?.length ? { work: work.map((w) => w.id) } : {}) }] },
  };
}

// A plan file in stage order: survey, the design, impact.
// 0.7.0: a plan states its own prediction (D9); scenarios that are not about it carry a neutral one.
export const FIXTURE_EXPECT = { files: 2, rounds: 2, minutes: 60 };
export function planDoc(design, { criteria = design.criteria, work = design.work } = {}) {
  const { survey, impact } = stages(criteria, work);
  const stated = design.expect !== undefined || (design.plan && typeof design.plan === 'object' && design.plan.expect !== undefined);
  return { survey, ...(stated ? {} : { expect: FIXTURE_EXPECT }), ...design, impact };
}

export const criteriaFile = (dir, criteria = [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }]) => {
  const f = path.join(dir, `criteria-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(planDoc({ plan: 'change a', criteria })));
  return f;
};

// An amendment file with its impact addendum (I-26): an amendment that adds or changes criteria owes one.
export function impactAddendum(criteria, work = null) {
  const { survey, impact } = stages(criteria, work, Math.random().toString(36).slice(2, 8));
  return { survey, changes: impact.changes };
}
export const amendFile = (dir, criteria, extra = {}) => {
  const f = path.join(dir, `amend-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ criteria, impact: impactAddendum(criteria, extra.work), ...extra }));
  return f;
};

// The impact check from a reviewer bundle whose recorded queries did not change (zero-hit fixtures): every query at its
// recorded count, every inventory entry sampled, every derived caller judged in-map.
export const impactCheckedFrom = (bundle) => ({
  queries: Object.entries(bundle.impactMap?.queries ?? {}).map(([query, q]) => ({ query, hits: q.hits })),
  sampled: (bundle.impactMap?.inventory ?? []).map((entry) => ({ entry, verdict: 'matches', evidence: 'checked' })),
  derived: (bundle.impactMap?.derived?.outside ?? []).map((o) => ({ symbol: o.symbol, file: o.file, verdict: 'in-map', evidence: 'checked' })),
});

// The impact check a reviewer of a criteriaFile plan writes: the fixture query re-run, both inventory entries sampled.
export const fixtureImpactChecked = () => ({ queries: [{ query: 'Q-fixture', hits: 0 }], sampled: [{ entry: 'P-fixture', verdict: 'matches', evidence: 'no hit' }, { entry: 'I-fixture', verdict: 'matches', evidence: 'no hit' }], derived: [] });

export function closureFile(dir, closure) {
  const f = path.join(dir, `closure-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(closure));
  return f;
}

export const goodClosure = (reviewer = 'rev-1', extra = {}) => ({ reviewer, findings: [], criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log line 1' } }], screenshotsInspected: [], impactChecked: fixtureImpactChecked(), anomalies: 'none seen', ...extra });

// Runs an attempt up to an accepted review. Returns the worktree path of `repo`.
export function toAccepted(root, base, { item = 'ENG-1', repo = 'app', change = { 'src/a.txt': 'b\n' }, owner = 'owner-1', extraEntry = [] } = {}) {
  const e = ok(wf(root, ['entry', '--item', item, '--owner', owner, '--json', ...extraEntry])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', owner]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', owner]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id, '--owner', owner]));
  const wt = e.repos[repo].worktree;
  commitIn(wt, change);
  // The order of work: a clean code review, one gate on that tree, then the evidence review.
  const rt = /^claude:/.test(owner) ? ['--runtime', 'codex'] : [];
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-0', '--attempt', id, '--owner', owner, ...rt]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-0')), '--attempt', id]));
  ok(wf(root, ['gate', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', owner, ...rt]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure()), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', owner]));
  return { id, wt, entry: e };
}

// A gate run outside the order of work (no clean code review on the tree first), for scenarios about the gate itself
// or about what follows it: `--reason` runs it and records the override in the ledger.
export const OUT_OF_ORDER = ['--reason', 'scenario: gate mechanics, outside the order of work'];

export const state = (root, id) => ok(wf(root, ['resume', '--attempt', id, '--json'])).json();

// Raw Linear readbacks, shaped as the Linear MCP tools return them (get_issue, list_comments): every field the engine
// requires of a delivered capture, uploads.linear.app urls signed as Linear signs them on read.
const sign = (url) => (/^https:\/\/uploads\.linear\.app\//.test(url) && !/[?&]signature=/.test(url) ? `${url}?signature=s` : url);
export const signBody = (body) => String(body).replace(/(https:\/\/uploads\.linear\.app\/[^)\s]+)/g, (u) => sign(u));
export function rawIssue(item, status, { attachments = [], description = 'd' } = {}) {
  const at = '2026-01-01T00:00:00.000Z';
  return { id: item, uuid: '00000000-0000-0000-0000-000000000000', title: 't', description, priority: { value: 0, name: 'No priority' }, url: `https://linear.example.test/${item}`, createdAt: at, updatedAt: at, status, statusType: 'started', labels: [], attachments: attachments.map((a, i) => ({ id: a.id ?? `a${i}`, title: a.title, subtitle: a.subtitle ?? null, url: sign(a.url) })), documents: [], stateHistory: [{ state: { id: 's', name: status, type: 'started' }, startedAt: at, endedAt: null }], createdBy: 'o', team: 't' };
}
export function rawComments(comments = []) {
  return { comments: comments.map((c, i) => ({ id: c.id ?? `c${i}`, body: signBody(c.body), attachments: [], createdAt: c.createdAt, updatedAt: c.updatedAt ?? c.createdAt, parentId: null, resolvedAt: null, quotedText: null, author: { id: 'u', name: 'Owner' }, onBehalfOf: null })), hasNextPage: false };
}
export const rawReadback = (item, status, { attachments = [], comments = [] } = {}) => ({ issue: rawIssue(item, status, { attachments }), comments: rawComments(comments) });

// The delivered comment `wf` rendered, as posted: each {assetUrl:<title>} replaced by that upload's asset url.
export function postedComment(root, id, assets = {}) {
  const body = fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', id, 'delivery', 'delivered-comment.md'), 'utf8');
  return body.replace(/\{assetUrl:([^}]+)\}/g, (m, t) => assets[t] ?? m);
}

export function summaryFile(dir, text = 'The home screen now shows the new text.') {
  const f = path.join(dir, `summary-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(f, `${text}\n`);
  return f;
}
