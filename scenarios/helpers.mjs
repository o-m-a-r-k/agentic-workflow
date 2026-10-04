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
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.GROK_SESSION_ID;
  return env;
};

export function wf(cwd, args, { env = {}, input, home } = {}) {
  const r = spawnSync(process.execPath, [WF, ...args], { cwd, encoding: 'utf8', input, env: { ...baseEnv(), WF_CONFIG_HOME: home ?? path.join(cwd, '..', '.wfhome'), WF_HOME: path.join(cwd, '..', '.home'), ...env } });
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

export const criteriaFile = (dir, criteria = [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }]) => {
  const f = path.join(dir, `criteria-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ plan: 'change a', criteria }));
  return f;
};

export function closureFile(dir, closure) {
  const f = path.join(dir, `closure-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(closure));
  return f;
}

export const goodClosure = (reviewer = 'rev-1', extra = {}) => ({ reviewer, findings: [], criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log line 1' } }], screenshotsInspected: [], ...extra });

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
