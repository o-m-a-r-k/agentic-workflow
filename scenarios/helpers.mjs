import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wf');

export function sh(cwd, cmd) {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed in ${cwd}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const baseEnv = () => {
  // The immutable flag stays off in tests (temporary folders must stay removable); modes and the manifest still apply.
  const env = { ...process.env, WF_EVIDENCE_FLAGS: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.GROK_SESSION_ID;
  return env;
};

export function wf(cwd, args, { env = {}, input, home } = {}) {
  const r = spawnSync(process.execPath, [WF, ...args], { cwd, encoding: 'utf8', input, maxBuffer: 512 * 1024 * 1024, env: { ...baseEnv(), WF_CONFIG_HOME: home ?? path.join(cwd, '..', '.wfhome'), WF_HOME: path.join(cwd, '..', '.home'), WF_IMPROVEMENTS_DIR: path.join(cwd, '..', '.improvements'), ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
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
export function planDoc(design, { criteria = design.criteria, work = design.work } = {}) {
  const { survey, impact } = stages(criteria, work);
  return { survey, ...design, impact };
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

export const goodClosure = (reviewer = 'rev-1', extra = {}) => ({ reviewer, findings: [], criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log line 1' } }], screenshotsInspected: [], impactChecked: fixtureImpactChecked(), ...extra });

// Runs an attempt up to an accepted review. Returns the worktree path of `repo`.
export function toAccepted(root, base, { item = 'ENG-1', repo = 'app', change = { 'src/a.txt': 'b\n' }, owner = 'owner-1', extraEntry = [] } = {}) {
  const e = ok(wf(root, ['entry', '--item', item, '--owner', owner, '--json', ...extraEntry])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', owner]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', owner]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id, '--owner', owner]));
  const wt = e.repos[repo].worktree;
  commitIn(wt, change);
  ok(wf(root, ['gate', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', owner]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure()), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', owner]));
  return { id, wt, entry: e };
}

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
