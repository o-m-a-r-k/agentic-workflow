import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { actor, branchName, changedFiles, openState, uncommitted } from './attempt.mjs';
import { loadConfig } from './config.mjs';
import { liveGate } from './gate.mjs';
import { append, loadState } from './ledger.mjs';
import { packageOf } from './topology.mjs';
import { git, matchesAny, refuse, run } from './util.mjs';

// Base movement used to surface only at delivery, after the gate and the review were spent on a stale base.
// `wf status` / `wf resume` now fetch each repo's base and say how far it moved and whether it touches the ticket.

const FETCH_TIMEOUT_MS = 15000;

function fetchBase(dir, repo) {
  const r = spawnSync('git', ['fetch', '--quiet', repo.remote, repo.base], { cwd: dir, encoding: 'utf8', timeout: FETCH_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return r.status === 0;
}

function sharedInfraTouched(repo, files) {
  return files.filter((f) => {
    const pkg = packageOf(repo, f);
    return pkg && matchesAny(pkg.path === '.' ? f : f.slice(pkg.path.length + 1), pkg.sharedInfra);
  });
}

// One entry per repo of the attempt: how far its base moved past the worktree, and what that touches.
export function baseStatus(root, state, { fetch = true } = {}) {
  const cfg = loadConfig(root);
  const out = [];
  for (const [name, r] of Object.entries(state.repos)) {
    const repo = cfg.repos.find((x) => x.name === name);
    if (!repo || !fs.existsSync(r.worktree)) continue;
    const hasRemote = git(r.worktree, ['remote']).split('\n').includes(repo.remote);
    const ref = hasRemote ? `${repo.remote}/${repo.base}` : repo.base;
    const fetched = hasRemote && fetch ? fetchBase(r.worktree, repo) : null;
    const tip = git(r.worktree, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true });
    if (!tip) continue;
    const own = git(r.worktree, ['merge-base', 'HEAD', tip], { allowFail: true });
    const entry = { repo: name, ref, fetched, note: fetched === false ? 'not fetched (offline?); compared with the last fetched base' : null, commits: 0, overlap: [], infra: [], files: 0, tip, own };
    if (own && own !== tip) {
      const delta = git(r.worktree, ['diff', '--name-only', own, tip]).split('\n').filter(Boolean);
      const mine = new Set(changedFiles(state, name));
      Object.assign(entry, { commits: Number(git(r.worktree, ['rev-list', '--count', `${own}..${tip}`])), files: delta.length, overlap: delta.filter((f) => mine.has(f)), infra: sharedInfraTouched(repo, delta) });
    }
    out.push(entry);
  }
  return out;
}

const list = (files) => `${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}`;

export function baseLines(entries) {
  return entries
    .filter((e) => e.commits || e.note)
    .map((e) => `  base ${e.repo}: ${e.commits ? `${e.ref} moved ${e.commits} commit(s); ${e.overlap.length ? `overlaps your changed files: ${list(e.overlap)}` : 'no overlap with your changed files'}${e.infra.length ? `; touches shared infrastructure: ${list(e.infra)}` : ''} (\`wf base merge\` merges it in)` : 'current'}${e.note ? ` — ${e.note}` : ''}`);
}

// Merges each repo's base into its worktree. Refuses a dirty tree or a running gate; a conflict is aborted so the
// worktree is left as it was, and reported. The gate and the review are bound to the tree, so a merge that moves HEAD
// leaves neither counting for the new tree.
export function baseMerge(root, options) {
  const state = openState(root, options);
  if (['done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is ${state.phase}`);
  if (Object.keys(state.delivery.repos).length) throw refuse(`${state.id} is already being delivered; \`wf deliver\` merges the base itself`);
  if (liveGate(root, state)) throw refuse('a gate is running on these worktrees; wait for it or `wf stop` it first');
  const dirty = uncommitted(state);
  if (Object.keys(dirty).length) throw refuse(`commit or remove uncommitted changes before merging the base: ${Object.entries(dirty).map(([r, l]) => `${r} (${l.slice(0, 3).join('; ')})`).join(', ')}`);
  const names = options.repo ? [String(options.repo)] : Object.keys(state.repos);
  for (const n of names) if (!state.repos[n]) throw refuse(`repo \`${n}\` is not part of ${state.id} (repos: ${Object.keys(state.repos).join(', ')})`);
  const results = [];
  for (const entry of baseStatus(root, { ...state, repos: Object.fromEntries(names.map((n) => [n, state.repos[n]])) })) {
    if (!entry.commits) {
      results.push({ repo: entry.repo, upToDate: true, note: entry.note });
      continue;
    }
    const wt = state.repos[entry.repo].worktree;
    const before = git(wt, ['rev-parse', 'HEAD']);
    const merge = run('git', ['merge', '--no-edit', '-m', `Merge ${entry.ref} into ${branchName(state.id)}`, entry.tip], { cwd: wt, allowFail: true });
    if (merge.status !== 0) {
      const conflicts = git(wt, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).split('\n').filter(Boolean);
      run('git', ['merge', '--abort'], { cwd: wt, allowFail: true });
      const done = results.filter((x) => !x.upToDate).map((x) => x.repo);
      throw refuse(`merging ${entry.ref} into ${entry.repo} conflicts${conflicts.length ? ` in ${list(conflicts)}` : ''}; the merge was aborted and ${entry.repo} is unchanged${done.length ? ` (already merged: ${done.join(', ')})` : ''}`, `have the implementer of the overlapping work merge ${entry.ref} in ${wt}, resolve and commit; then \`wf gate\` and a fresh reviewer`);
    }
    const after = git(wt, ['rev-parse', 'HEAD']);
    const data = { repo: entry.repo, ref: entry.ref, from: entry.own, to: entry.tip, commits: entry.commits, files: entry.files, overlap: entry.overlap, infra: entry.infra, headBefore: before, headAfter: after, note: entry.note };
    append(root, state.id, 'base.merged', data, actor(options));
    results.push(data);
  }
  return { state: loadState(root, state.id), results };
}
