import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closureFile, commitIn, goodClosure, ok, planDoc, singleRepoProject, tmp, wf } from './helpers.mjs';

// Shared by the strategist and split scenarios.
//
// Obligations of 0.7.0 gate on the version an attempt was admitted at (engine/versions.mjs), and the engine's version
// is read from package.json: a scenario needs attempts admitted at 0.7.0 and at an earlier version whatever the
// checkout's own version is. `engineAt(version)` copies the plugin (a few MB) into a temporary folder with that version
// in its package.json; `wf(root, args, { bin })` then runs that copy's CLI. Identical code, a different admission stamp.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copies = new Map();
export function engineAt(version) {
  if (copies.has(version)) return copies.get(version);
  const dir = tmp(`engine-${version}`);
  for (const d of ['bin', 'engine', 'templates', 'docs', 'skills', 'adapters', 'hooks']) fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, version }));
  const bin = path.join(dir, 'bin', 'wf');
  copies.set(version, bin);
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return bin;
}

// `wf` bound to an engine version.
export const runner = (version) => {
  const bin = engineAt(version);
  const run = (root, args, opts = {}) => wf(root, args, { ...opts, bin });
  const state = (root, id) => ok(run(root, ['resume', '--attempt', id, '--json'])).json();
  const signals = (root, id) => ok(run(root, ['signals', '--attempt', id, '--json'])).json();
  return { run, state, signals, bin };
};

export const project = (name, config = {}, files = {}) => singleRepoProject(name, { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }] }, ...config }, files);

export const C = [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }, { id: 'C2', text: 'b changes', uat: 'b shows the new text' }];
export const W = [{ id: 'W1', criteria: ['C1'], repos: ['app'], class: 'full', why: 'first' }, { id: 'W2', criteria: ['C2'], repos: ['app'], class: 'full', why: 'second' }];

export function planFile(dir, { criteria = C, work = null, expect = null } = {}) {
  const f = path.join(dir, `plan-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(planDoc({ plan: { summary: 'change a and b', anchors: ['src/a.txt', 'src/b.txt'], ...(expect ? { expect } : {}) }, criteria, ...(work ? { work } : {}) })));
  return f;
}

// An attempt at the point where implementers work: planned, one implementer handed (W1 when the plan has work items).
export function started(r, { root, base }, { item, work = null, criteria = C, owner = 'owner-1', expect = null } = {}) {
  const e = ok(r.run(root, ['entry', '--item', item, '--owner', owner, '--json'])).json();
  ok(r.run(root, ['handoff', 'planner', '--agent', `plan-${item}`, '--attempt', e.id, '--owner', owner]));
  ok(r.run(root, ['plan', '--file', planFile(base, { criteria, work, expect }), '--attempt', e.id, '--owner', owner]));
  ok(r.run(root, ['handoff', 'implementer', '--agent', `impl-${item}`, '--attempt', e.id, '--owner', owner, ...(work ? ['--work', 'W1'] : [])]));
  return { id: e.id, wt: e.repos.app.worktree, owner };
}

let n = 0;
// One recorded review round on the current tree: commit a change, hand a fresh reviewer, record its closure. `findings`
// are the open findings the reviewer reports; `criteria` the ids its closure must give evidence for.
export function reviewRound(r, ctx, a, { findings = 1, criteria = ['C1', 'C2'], tag = `${++n}` } = {}) {
  commitIn(a.wt, { 'src/a.txt': `round ${tag} ${Math.random()}\n` });
  const agent = `rev-${tag}`;
  // 0.7.0: an attempt with several work items passes `wf check` on the combined tree before each review.
  ok(r.run(ctx.root, ['check', '--attempt', a.id, '--owner', a.owner]));
  const handed = ok(r.run(ctx.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', a.id, '--owner', a.owner]));
  // A delta round (0.7.0) is handed the earlier open findings and answers each in its one closure; here they persist.
  const bundleFile = handed.out.match(/^Read (\S+)/m)?.[1];
  const prior = bundleFile ? (JSON.parse(fs.readFileSync(bundleFile, 'utf8')).openFindings ?? []) : [];
  const closure = goodClosure(agent, {
    ...(prior.length ? { priorFindings: prior.map((f) => ({ round: f.round, id: f.id, status: 'open', evidence: 'still present at src/a.txt:1' })) } : {}),
    criteria: criteria.map((id) => ({ id, evidence: { kind: 'output', ref: 'log line 1' } })),
    findings: Array.from({ length: findings }, (_, i) => ({ id: `F${i + 1}`, severity: 'major', summary: `defect ${i + 1} of round ${tag}`, status: 'open', evidence: 'src/a.txt:1' })),
  });
  ok(r.run(ctx.root, ['review', '--closure', closureFile(ctx.base, closure), '--attempt', a.id]));
  return agent;
}

// Runs engine code in this process the way a `wf` process sees the project: its working folder, its scenario home.
export async function inProcess(root, fn) {
  const cwd = process.cwd();
  const keep = { ...process.env };
  Object.assign(process.env, { WF_EVIDENCE_FLAGS: '0', WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), WF_HOME: path.join(root, '..', '.home'), WF_IMPROVEMENTS_DIR: path.join(root, '..', '.improvements') });
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
}

// Grows the attempt's diff to `total` changed files (src/a.txt is already one). Growth refuses nothing: the scenarios use it
// to show the plan's expectation against a diff far past it, and that every handoff is still accepted.
export function growTo(a, total) {
  const files = {};
  for (let i = 1; i < total; i++) files[`src/extra-${i}.txt`] = `extra ${i}\n`;
  commitIn(a.wt, files);
}

// JSON lines to a file (a transcript or a rollout).
export function jsonl(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

// The strategist's closure file for the bundle a handoff printed.
export function strategistClosure(base, bundleFile, closure) {
  const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
  const f = path.join(base, `strategy-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(closure));
  return { file: f, bundle };
}
