// Doubles of the other streams' facades for stream 1 scenarios (the flow). File-backed, so a spawned `wf` (through
// WF_DOUBLES and WF_TEST=1) and the test process see the same ledger. They follow the contract's shapes only as far as
// the flow reads them; the owning streams' own scenarios test the real ones.
//
// Test knobs (environment): WF_TEST_SESSION (the caller's session id), WF_TEST_NO_TRANSCRIPT=1 (filesRead → null),
// WF_TEST_RISKBASE_PASS=1 (risk-base runs pass), WF_TEST_FAST_FAIL=1 (fast runs fail). Answers: a test writes
// `<attempt dir>/test-answers.json` as { "<decision id>": "<choice>" }.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EVENTS, WfError, attemptDir, hostHome, ledgerFile, parseLocation } from '../engine/contract.mjs';
import { YAML } from './helpers/project.mjs';
import { git } from '../engine/util.mjs';

const read = (root, attempt) => {
  const f = ledgerFile(root, attempt);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : null;
};

let clock = 0;
const now = () => {
  // strictly increasing, so "after" comparisons in one test are exact
  clock = Math.max(Date.now(), clock + 1);
  return new Date(clock).toISOString();
};

export async function append(root, attempt, type, data, actor) {
  const spec = EVENTS[type];
  if (!spec) throw new WfError(`unknown event ${type}`);
  for (const k of spec.required) if (!(k in data)) throw new WfError(`${type}: missing ${k}`);
  const lines = read(root, attempt) ?? [];
  if (!lines.length && type !== 'attempt.started') throw new WfError(`first event of ${attempt} must be attempt.started`);
  const prev = lines.at(-1)?.hash ?? null;
  const e = { seq: lines.length + 1, at: now(), type, actor: actor ?? null, data, prev, schema: 2 };
  e.hash = crypto.createHash('sha256').update(JSON.stringify(e)).digest('hex');
  fs.mkdirSync(path.dirname(ledgerFile(root, attempt)), { recursive: true });
  fs.appendFileSync(ledgerFile(root, attempt), `${JSON.stringify(e)}\n`);
  return e;
}

export async function readEvents(root, attempt) {
  const lines = read(root, attempt);
  if (!lines) throw new WfError(`no attempt ${attempt}`);
  return lines;
}

export async function listAttempts(root, { item } = {}) {
  const dir = path.join(root, '.wf-evidence', 'attempts');
  if (!fs.existsSync(dir)) return [];
  const ids = fs.readdirSync(dir).filter((id) => fs.existsSync(ledgerFile(root, id)));
  const n = (id) => Number(/\.(\d+)$/.exec(id)?.[1] ?? 0);
  return ids.filter((id) => !item || (read(root, id)[0]?.data?.item ?? id.replace(/\.\d+$/, '')) === item).sort((a, b) => n(a) - n(b));
}

export async function attemptState(root, attempt) {
  const ev = await readEvents(root, attempt);
  if (ev[0].schema !== 2) return { schema: 1, open: !ev.some((e) => ['attempt.done', 'attempt.abandoned'].includes(e.type)), outcome: null, item: ev[0].data?.item ?? null, id: attempt };
  const s = { id: attempt, item: ev[0].data.item, n: ev[0].data.n, schema: 2, open: true, outcome: null, owner: ev[0].actor, repos: ev[0].data.repos, stages: ev[0].data.stages, criteria: { list: [], areas: [], hash: null, history: [] }, tests: [], screens: [], handoffs: [], reviews: [], findings: {}, decisions: {}, hold: null, stageResults: {}, landings: [], baseUpdates: [] };
  for (const e of ev) {
    if (e.type === 'attempt.closed') Object.assign(s, { open: false, outcome: e.data.outcome });
    if (e.type === 'criteria.set') s.criteria = { list: e.data.criteria, areas: e.data.areas, hash: e.data.hash, history: [...s.criteria.history, e.data] };
    if (e.type === 'hold') s.hold = { reason: e.data.reason, quote: e.data.quote, at: e.at };
    if (e.type === 'release') s.hold = null;
    if (e.type === 'stage') s.stageResults[e.data.index] = { ...e.data, at: e.at };
  }
  return s;
}

export async function findProject(cwd) {
  for (let d = cwd; ; d = path.dirname(d)) {
    const f = path.join(d, '.workflow', 'project.yaml');
    if (fs.existsSync(f)) return { root: d, file: f, location: 'repo' };
    if (d === path.dirname(d)) return null;
  }
}

export async function loadAdapter(root) {
  const file = path.join(root, '.workflow', 'project.yaml');
  const raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  return {
    ...raw,
    root,
    source: { file, location: 'repo', hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') },
    repos: raw.repos.map((r) => ({ remote: 'origin', provision: { clone: [], fingerprint: [], install: null, copyIgnored: [] }, kinds: { tests: [], other: [] }, ...r })),
    components: raw.components ?? [],
    invariants: raw.invariants ?? null,
    rules: raw.rules ?? [],
    risk: raw.risk === 'none' ? { confirmed: true, paths: [] } : { confirmed: Array.isArray(raw.risk), paths: raw.risk ?? [] },
    models: raw.models ?? {},
    delivery: { landing: 'direct', order: raw.repos.map((r) => r.name), stages: [], ...(raw.delivery ?? {}) },
  };
}

export async function normaliseId(root, raw) {
  const a = await loadAdapter(root);
  const item = String(raw).trim().toUpperCase();
  if (a.ticketing?.idPattern && !new RegExp(a.ticketing.idPattern).test(item)) throw new WfError(`\`${raw}\` is not an item id of this project`);
  return { item, canonical: item, verified: true };
}

export async function runStage(root, attempt, stage) {
  const index = typeof stage === 'number' ? stage : -1;
  const s = typeof stage === 'number' ? (await attemptState(root, attempt)).stages[stage] : stage;
  await append(root, attempt, 'stage', { index, do: s.do, state: 'done' }, null);
  return { state: 'done', evidence: null, next: null };
}

export async function ask(root, attempt, q) {
  const ev = await readEvents(root, attempt);
  const answered = new Set(ev.filter((e) => e.type === 'decision.answered').map((e) => e.data.id));
  const same = ev.find((e) => e.type === 'decision.asked' && e.data.kind === q.kind && JSON.stringify(e.data.refs) === JSON.stringify(q.refs) && !answered.has(e.data.id));
  if (same) return { id: same.data.id, shownAt: same.at, new: false };
  const id = `D${ev.filter((e) => e.type === 'decision.asked').length + 1}`;
  const e = await append(root, attempt, 'decision.asked', { id, ...q }, null);
  return { id, shownAt: e.at, new: true };
}

export async function answered(root, id, { attempt } = {}) {
  const ev = await readEvents(root, attempt);
  const done = ev.find((e) => e.type === 'decision.answered' && e.data.id === id);
  if (done) return { ...done.data, at: done.at };
  const file = path.join(attemptDir(root, attempt), 'test-answers.json');
  const answers = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (!answers[id]) return null;
  const data = { id, choice: answers[id], quote: answers[id], via: 'turn', session: { runtime: 'claude', id: 'person' } };
  const e = await append(root, attempt, 'decision.answered', data, null);
  return { ...data, at: e.at };
}

export const answer = (root, attempt, id, choice) => {
  const file = path.join(attemptDir(root, attempt), 'test-answers.json');
  const answers = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...answers, [id]: choice }));
};

export async function callerSession(env) {
  return env.WF_TEST_SESSION ? { runtime: 'claude', id: env.WF_TEST_SESSION } : null;
}

export async function filesRead(session) {
  if (process.env.WF_TEST_NO_TRANSCRIPT === '1') return null;
  const dir = path.join(hostHome(), '.claude', 'projects');
  if (!fs.existsSync(dir)) return null;
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, `${session.id}.jsonl`);
    if (!fs.existsSync(f)) continue;
    const out = [];
    for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      for (const c of JSON.parse(l).message?.content ?? []) if (c?.type === 'tool_use' && c.name === 'Read' && !out.includes(c.input.file_path)) out.push(c.input.file_path);
    }
    return out;
  }
  return null;
}

let launches = 0;
export async function launchReviewer(root, attempt, bundle, { model } = {}) {
  const session = { runtime: 'claude', id: `rev-${process.pid}-${++launches}-${bundle.seat.replace(/[^A-Za-z0-9]/g, '-')}` };
  await append(root, attempt, 'handoff', { role: 'reviewer', session, launchedBy: 'wf', seat: bundle.seat, tree: bundle.tree, round: bundle.round, ...(model ? { model } : {}) }, null);
  return { session, launchedAt: new Date().toISOString() };
}

export async function runTests(root, attempt, repo, kind) {
  const s = await attemptState(root, attempt);
  const wt = s.repos[repo].worktree;
  const tree = git(wt, ['rev-parse', 'HEAD^{tree}']);
  const pass = kind === 'risk-base' ? process.env.WF_TEST_RISKBASE_PASS === '1' : !(kind === 'fast' && process.env.WF_TEST_FAST_FAIL === '1');
  await append(root, attempt, 'test.run', { repo, kind, tree, pass, exitCode: pass ? 0 : 1, ms: 1, source: 'attempt' }, null);
  return { pass, tree, ms: 1, exitCode: pass ? 0 : 1, log: '' };
}

// git blame of one line against the attempt's base commit.
export async function blameToAttempt(root, attempt, location) {
  const s = await attemptState(root, attempt);
  const loc = parseLocation(location);
  const wt = s.repos[loc.repo].worktree;
  const out = git(wt, ['blame', '-l', '-s', '-L', `${loc.line},${loc.line}`, 'HEAD', '--', loc.path], { allowFail: true });
  const commit = out.replace(/^\^/, '').split(' ')[0];
  if (!commit) return { own: false, commit: null };
  const onBase = spawnSync('git', ['merge-base', '--is-ancestor', commit, s.repos[loc.repo].baseSha], { cwd: wt }).status === 0;
  return { own: !onBase, commit };
}

let filed = 100;
export async function fileFollowUp(root, attempt, f) {
  return { state: 'done', value: { id: `TK-${++filed}`, duplicateOf: null } };
}
export async function search() {
  return { state: 'done', value: [] };
}
export async function recordRefusal(root, attempt, id) {
  if (root) fs.appendFileSync(path.join(root, '.wf-test-refusals.jsonl'), `${JSON.stringify({ attempt, id })}\n`);
}
export async function row(root, attempt) {
  const s = await attemptState(root, attempt);
  return { schema: 'wf-ticket@1', attempt, item: s.item, outcome: s.outcome };
}

export default {
  append, readEvents, listAttempts, attemptState, findProject, loadAdapter, normaliseId, runStage, ask, answered, callerSession,
  filesRead, launchReviewer, runTests, blameToAttempt, fileFollowUp, search, recordRefusal, row,
};
