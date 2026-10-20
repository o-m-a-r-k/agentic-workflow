// Stream 2's scenario support (not a test file): a fixture project with attempt worktrees, and doubles for the other
// streams' facades (adapter, ledger, changed files, merge facts). The ledger double checks every payload against the
// contract's EVENTS, so a payload stream 5 would refuse fails here too.
import fs from 'node:fs';
import path from 'node:path';
import { EVENTS, clearDoubles, setDoubles, worktreeDir, branchName } from '../engine/contract.mjs';
import { adapterFor, git, makeProject, writeFiles } from './helpers/index.mjs';
import { matchesAny } from '../engine/util.mjs';

const TEST_KINDS = ['test/**', '**/*.spec.mjs'];

// The engine's own git calls run with this process's environment: make them deterministic.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
});

// The normalised Adapter (contract typedef) for a raw fixture adapter: every key present.
export function normalise(raw, root) {
  return {
    version: 2, name: raw.name, root, source: { file: path.join(root, '.workflow', 'project.yaml'), location: 'repo', hash: 'x' },
    requires: { connectors: [], tools: [], skills: [] },
    repos: raw.repos.map((r) => ({
      name: r.name, path: r.path, base: r.base, remote: r.remote ?? 'origin',
      provision: { clone: [], fingerprint: [], install: null, copyIgnored: [], ...(r.provision ?? {}) },
      tests: { fast: r.tests?.fast ?? null, full: r.tests?.full ?? null },
      kinds: r.kinds ?? { tests: [], other: [] },
    })),
    components: raw.components ?? [], invariants: raw.invariants ?? null, rules: raw.rules ?? [],
    screens: { routes: null, shared: [], sentinel: [], langs: [], viewports: [], capture: null, ...(raw.screens ?? {}) },
    review: raw.review ?? { diffRead: 'before' },
    ticketing: raw.ticketing,
    delivery: { landing: 'direct', order: raw.repos.map((r) => r.name), authority: { push: 'agent', mergeRequest: 'agent', merge: 'agent' }, stages: [], ...(raw.delivery ?? {}) },
    models: {}, budget: raw.budget, onboarded: { at: null, engine: null, hashes: {} },
  };
}

// A project whose repos' tests and settings are `repoOverrides[name]`, plus top-level `overrides`.
export function fixture({ repos, repoOverrides = {}, overrides = {} } = {}) {
  const p = makeProject({ ...(repos ? { repos } : {}), overrides });
  const raw = adapterFor({ root: p.root, ...(repos ? { repos } : {}), overrides });
  raw.repos = raw.repos.map((r) => ({ ...r, ...(repoOverrides[r.name] ?? {}) }));
  p.adapter = normalise(raw, p.root);
  p.events = [];
  p.states = new Map();
  p.facts = new Map();
  process.env.WF_USER_DIR = p.env.WF_USER_DIR;
  return p;
}

// Start an attempt: a worktree per repo on `wf/<attempt>` at the remote base, its state registered for the doubles.
export function startAttempt(p, attempt, repos = Object.keys(p.repos), extra = {}) {
  const state = { id: attempt, item: attempt.replace(/\.\d+$/, ''), n: Number(attempt.split('.').pop()), schema: 2, open: true, outcome: null, repos: {}, stages: [], stageResults: {}, landings: [], ...extra };
  for (const repo of repos) {
    const { dir, base } = p.repos[repo];
    const wt = worktreeDir(p.root, attempt, repo);
    git(dir, ['fetch', '--quiet', 'origin']);
    git(dir, ['worktree', 'add', '--quiet', '-b', branchName(attempt), wt, `origin/${base}`]);
    state.repos[repo] = { branch: branchName(attempt), base, baseSha: git(wt, ['rev-parse', 'HEAD']), worktree: wt };
  }
  p.states.set(attempt, state);
  return state;
}

// Write (and commit, unless commit: false) files in an attempt's worktree of a repo.
export function change(p, attempt, repo, files, { commit = true, message = 'change' } = {}) {
  const wt = worktreeDir(p.root, attempt, repo);
  writeFiles(wt, files);
  if (commit) {
    git(wt, ['add', '-A']);
    git(wt, ['commit', '--quiet', '-m', message]);
  }
  return wt;
}

function changedFilesOf(p, attempt) {
  const state = p.states.get(attempt);
  const files = [];
  const trees = [];
  const heads = {};
  for (const [repo, r] of Object.entries(state.repos)) {
    heads[repo] = git(r.worktree, ['rev-parse', 'HEAD']);
    const mb = git(r.worktree, ['merge-base', 'HEAD', `origin/${r.base}`]);
    for (const line of git(r.worktree, ['diff', '--name-status', mb]).split('\n').filter(Boolean)) {
      const [status, file] = line.split('\t');
      // Classed by the fixture's `kinds.tests`, as base.mjs classes them.
      files.push({ repo, path: file, kind: matchesAny(file, TEST_KINDS) ? 'tests' : 'product', added: 1, removed: 0, status: status[0] });
    }
    trees.push(git(r.worktree, ['rev-parse', 'HEAD^{tree}']));
  }
  return { tree: trees.join('+'), heads, files };
}

// Install the doubles for this project. `mergeFacts`: attempt → Problem[].
export function useDoubles(p) {
  clearDoubles();
  setDoubles({
    loadAdapter: async () => p.adapter,
    attemptState: async (_root, attempt) => {
      const s = p.states.get(attempt);
      if (!s) throw new Error(`unknown attempt ${attempt}`);
      return s;
    },
    listAttempts: async () => [...p.states.keys()],
    append: async (_root, attempt, type, data) => {
      const spec = EVENTS[type];
      if (!spec) throw new Error(`event type ${type} is not in the contract`);
      for (const k of spec.required) if (!(k in data)) throw new Error(`${type} is missing ${k}`);
      const entry = { attempt, type, data, at: new Date().toISOString() };
      p.events.push(entry);
      if (type === 'landing') p.states.get(attempt)?.landings.push({ ...data, at: entry.at });
      return entry;
    },
    changedFiles: async (_root, attempt) => changedFilesOf(p, attempt),
    mergeFacts: async (_root, attempt) => p.facts.get(attempt) ?? [],
  });
}

export const eventsOf = (p, type, attempt) => p.events.filter((e) => e.type === type && (!attempt || e.attempt === attempt)).map((e) => e.data);

export function done(p) {
  clearDoubles();
  p.cleanup();
}

export const read = (file) => fs.readFileSync(file, 'utf8');
