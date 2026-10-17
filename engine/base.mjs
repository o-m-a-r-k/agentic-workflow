import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { actor, branchName, changedFiles, openState, uncommitted } from './attempt.mjs';
import { loadConfig } from './config.mjs';
import { liveGate } from './gate.mjs';
import { append, listAttempts, loadState } from './ledger.mjs';
import { packageOf } from './topology.mjs';
import { git, gitEnv, matchesAny, refuse, run } from './util.mjs';

// Base movement used to surface only at delivery, after the gate and the review were spent on a stale base.
// `wf status` / `wf resume` now fetch each repo's base and say how far it moved and whether it touches the ticket.

const FETCH_TIMEOUT_MS = 15000;

// One fetch per repository, remote and base for the whole command: an attempt's worktrees share their repository's object
// store, so every attempt on that repository sees it. Named cost (audit of one project): `wf status` over 25 open attempts
// fetched the same remotes about a hundred times and took six minutes, 308 seconds of them in `git fetch`.
const fetched = new Map();
function fetchBase(dir, repo) {
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true }) || dir;
  const key = `${common}\0${repo.remote}\0${repo.base}`;
  if (!fetched.has(key)) {
    const r = spawnSync('git', ['fetch', '--quiet', repo.remote, repo.base], { cwd: dir, encoding: 'utf8', timeout: FETCH_TIMEOUT_MS, env: gitEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0' }) });
    fetched.set(key, r.status === 0);
  }
  return fetched.get(key);
}

function sharedInfraTouched(repo, files) {
  return files.filter((f) => {
    const pkg = packageOf(repo, f);
    return pkg && matchesAny(pkg.path === '.' ? f : f.slice(pkg.path.length + 1), pkg.sharedInfra);
  });
}

// One entry per repo of the attempt: how far its base moved past the worktree, and what that touches.
// The commits this project's workflow delivered, per repo (every attempt's recorded delivery), in one pass over the ledgers.
const deliveredCache = new Map();
function deliveredHeads(root) {
  if (deliveredCache.has(root)) return deliveredCache.get(root);
  const out = {};
  for (const id of listAttempts(root)) {
    try {
      for (const [repo, r] of Object.entries(loadState(root, id).delivery?.repos ?? {})) if (typeof r?.commit === 'string' && /^[0-9a-f]{7,40}$/.test(r.commit)) (out[repo] ??= new Set()).add(r.commit);
    } catch {
      // a damaged ledger names nothing delivered
    }
  }
  const heads = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
  deliveredCache.set(root, heads);
  return heads;
}

export function baseStatus(root, state, { fetch = true } = {}) {
  const cfg = loadConfig(root);
  const out = [];
  let delivered = null; // every attempt's delivered commits, read once, on the first repo whose base moved (I-119)
  for (const [name, r] of Object.entries(state.repos)) {
    const repo = cfg.repos.find((x) => x.name === name);
    if (!repo || !fs.existsSync(r.worktree)) continue;
    const hasRemote = git(r.worktree, ['remote']).split('\n').includes(repo.remote);
    const ref = hasRemote ? `${repo.remote}/${repo.base}` : repo.base;
    const fetched = hasRemote && fetch ? fetchBase(r.worktree, repo) : null;
    const tip = git(r.worktree, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true });
    if (!tip) continue;
    const own = git(r.worktree, ['merge-base', 'HEAD', tip], { allowFail: true });
    // 0.7.26 (I-183): the attempt's commits are already in the base (its merge request was merged). Merging the base in would
    // only fast-forward the branch past the commit the delivery recognises, so there is nothing to merge in.
    const head = git(r.worktree, ['rev-parse', 'HEAD'], { allowFail: true });
    const landed = Boolean(head) && head !== r.base && own === head;
    const entry = { repo: name, ref, fetched, note: fetched === false ? 'not fetched (offline?); compared with the last fetched base' : null, commits: 0, overlap: [], infra: [], files: 0, tip, own, ...(landed ? { landed: true } : {}) };
    if (own && own !== tip) {
      const delta = git(r.worktree, ['diff', '--name-only', own, tip]).split('\n').filter(Boolean);
      const mine = new Set(changedFiles(state, name));
      Object.assign(entry, { commits: Number(git(r.worktree, ['rev-list', '--count', `${own}..${tip}`])), files: delta.length, overlap: delta.filter((f) => mine.has(f)), infra: sharedInfraTouched(repo, delta) });
      // I-119: commits the base gained that no workflow delivery of this project covers (merged by hand, so no gate passed
      // them). Named failure (field): a change merged by hand after its gates failed made the base red, and the next
      // attempt's gate failed on it with nothing saying the failures came from the base. Information, never a stop.
      delivered ??= deliveredHeads(root);
      const shipped = (delivered[name] ?? []).filter((c) => git(r.worktree, ['cat-file', '-t', c], { allowFail: true }) === 'commit');
      const unproven = git(r.worktree, ['rev-list', '--no-merges', `${own}..${tip}`, ...(shipped.length ? ['--not', ...shipped] : [])], { allowFail: true }).split('\n').filter(Boolean);
      if (unproven.length) entry.unproven = { count: unproven.length, subjects: unproven.slice(0, 3).map((c) => git(r.worktree, ['log', '-1', '--format=%s', c], { allowFail: true })) };
    }
    out.push(entry);
  }
  return out;
}

// 0.7.26 (I-183): the repos still to deliver whose base moved past the branch (read from the last fetch). A repo recorded for the
// delivery is settled, one this ticket changes nothing in is skipped, and one whose change is already on its target has nothing
// to merge in.
export function baseMovedForDelivery(root, state) {
  const open = Object.keys(state.repos).filter((n) => !state.delivery.repos[n] && fs.existsSync(state.repos[n].worktree) && changedFiles(state, n).length > 0);
  if (!open.length) return [];
  return baseStatus(root, { ...state, repos: Object.fromEntries(open.map((n) => [n, state.repos[n]])) }, { fetch: false }).filter((e) => e.commits && !e.landed);
}

const list = (files) => `${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}`;

export function baseLines(entries) {
  return entries
    .filter((e) => e.commits || e.note)
    .map((e) => `  base ${e.repo}: ${e.commits && e.landed ? `${e.ref} moved ${e.commits} commit(s) and already holds this attempt's commits (nothing to merge in)` : e.commits ? `${e.ref} moved ${e.commits} commit(s); ${e.overlap.length ? `overlaps your changed files: ${list(e.overlap)}` : 'no overlap with your changed files'}${e.infra.length ? `; touches shared infrastructure: ${list(e.infra)}` : ''} (\`wf base merge\` merges it in)` : 'current'}${e.unproven ? `; ${e.unproven.count} of them reached ${e.ref} without a workflow delivery, so no gate passed them (${e.unproven.subjects.join('; ')}${e.unproven.count > 3 ? ', ...' : ''}): a gate failure may come from the base` : ''}${e.note ? ` — ${e.note}` : ''}`);
}

// Merges each repo's base into its worktree. Refuses a dirty tree or a running gate; a conflict is aborted so the
// worktree is left as it was, and reported. The gate and the review are bound to the tree, so a merge that moves HEAD
// leaves neither counting for the new tree.
//
// 0.7.26 (I-183). Named failure (field): a manual delivery adapter opened a merge request and `observe` kept reporting
// `awaiting-merge` while the base branch moved on by dozens of commits. `wf base merge` refused ("already being delivered;
// `wf deliver` merges the base itself") because the first `wf deliver` had recorded the attempt's unchanged repos as
// skipped, yet only the built-in push-main merges the base at delivery: with an adapter every later `wf deliver` just asked
// the adapter again and the branch stayed behind. Now the base comes into every repo still to deliver. A repo recorded for
// the delivery (delivered, or skipped for having no change), a repo this ticket changes nothing in and a repo whose change is
// already on its target are left as they are. When the delivery had started and the attempt was accepted, the acceptance is withdrawn
// (`withdrewAcceptance` on the event): it names the commit the pending integration was opened for, so the merged tree
// gets its gate, its review and its acceptance before `wf deliver` asks the adapter to integrate it again; carried over, a
// manual merge of the reconciled branch was later refused as "not the accepted, gated commit".
export function baseMerge(root, options) {
  const state = openState(root, options);
  if (['done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is ${state.phase}`);
  if (state.delivery.completedAt) throw refuse(`${state.id} is already delivered; nothing is left to merge the base into`, '`wf resume` says what is left (the tracker handoff)', { id: 'base:delivered' });
  if (liveGate(root, state)) throw refuse('a gate is running on these worktrees; wait for it or `wf stop` it first');
  const dirty = uncommitted(state);
  if (Object.keys(dirty).length) throw refuse(`commit or remove uncommitted changes before merging the base: ${Object.entries(dirty).map(([r, l]) => `${r} (${l.slice(0, 3).join('; ')})`).join(', ')}`);
  const names = options.repo ? [String(options.repo)] : Object.keys(state.repos);
  for (const n of names) if (!state.repos[n]) throw refuse(`repo \`${n}\` is not part of ${state.id} (repos: ${Object.keys(state.repos).join(', ')})`);
  const recorded = (n) => state.delivery.repos[n] ?? null;
  const how = (d) => (d.skipped ? `skipped, ${d.skipped}` : `delivered ${String(d.commit ?? '').slice(0, 10)}`);
  const settled = names.filter(recorded);
  if (options.repo && settled.length) throw refuse(`${names[0]} is already settled in this delivery (${how(recorded(names[0]))}); \`wf base merge\` leaves what is recorded as delivered or skipped as it is`, `merge the base into a repo that is still to deliver (${Object.keys(state.repos).filter((n) => !recorded(n)).join(', ') || 'none is left: \`wf deliver\` finishes the delivery'})`, { id: 'base:settled-repo' });
  const open = names.filter((n) => !recorded(n));
  if (!open.length) throw refuse(`every repo of ${state.id} is already recorded in its delivery (${settled.map((n) => `${n} ${how(recorded(n))}`).join('; ')}); nothing is left to merge the base into`, '`wf deliver` finishes the delivery', { id: 'base:delivered' });
  // The delivery has started when a repo is recorded or an adapter was asked: the accepted commit is already out.
  const started = Object.keys(state.delivery.repos).length > 0 || Object.keys(state.delivery.integrating ?? {}).length > 0;
  const withdraws = started && Boolean(state.accepted);
  const results = settled.map((n) => ({ repo: n, settled: how(recorded(n)) }));
  for (const entry of baseStatus(root, { ...state, repos: Object.fromEntries(open.map((n) => [n, state.repos[n]])) })) {
    if (entry.landed && state.delivery.integrating?.[entry.repo]) {
      results.push({ repo: entry.repo, landed: true, ref: entry.ref });
      continue;
    }
    // A repo this ticket changes nothing in has nothing to deliver; the delivery records it as skipped. Once the delivery has
    // started its base is not merged in unasked: it would move that repo's tree, so its gate steps would run again for nothing.
    if (started && !options.repo && changedFiles(state, entry.repo).length === 0) {
      results.push({ repo: entry.repo, idle: true });
      continue;
    }
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
      const done = results.filter((x) => x.headAfter).map((x) => x.repo);
      throw refuse(`merging ${entry.ref} into ${entry.repo} conflicts${conflicts.length ? ` in ${list(conflicts)}` : ''}; the merge was aborted and ${entry.repo} is unchanged${done.length ? ` (already merged: ${done.join(', ')})` : ''}`, `have the implementer of the overlapping work merge ${entry.ref} in ${wt}, resolve and commit; then \`wf gate\` and a fresh reviewer`);
    }
    const after = git(wt, ['rev-parse', 'HEAD']);
    const data = { repo: entry.repo, ref: entry.ref, from: entry.own, to: entry.tip, commits: entry.commits, files: entry.files, overlap: entry.overlap, infra: entry.infra, headBefore: before, headAfter: after, note: entry.note, ...(withdraws && before !== after ? { withdrewAcceptance: true } : {}) };
    append(root, state.id, 'base.merged', data, actor(options));
    results.push(data);
  }
  return { state: loadState(root, state.id), results, withdrewAcceptance: withdraws && results.some((x) => x.withdrewAcceptance) };
}
