// The attempt's base and its diff (design section 2; D97). Stream 1.
//
// - Each repo's worktree starts at the fetched tip of its base (attempt.mjs); the engine merges nothing else in.
// - `changedFiles` is the attempt's diff against its merge-base with the base, per repo, classed by the repo's `kinds`,
//   plus the attempt's tree: one hash over every repo's committed tree. Every stream that records a tree (tests, screens,
//   reviews) takes it from here, so the trees they record compare equal.
// - The merge facts read git only: `merge:unreviewed` (anything other than git's automatic merge of the base changed
//   since the last reviewed commit, by D87's merge-tree comparison) and `merge:foreign` (a merge commit whose merged
//   parent is not on the base).
import fs from 'node:fs';
import { attemptState, canonicalJson, loadAdapter } from './contract.mjs';
import { git, matchesAny, run, sha256 } from './util.mjs';

export const remoteOf = (spec) => spec?.remote || 'origin';
export const repoSpec = (adapter, name) => adapter.repos.find((r) => r.name === name) ?? null;
// A repo-relative path as the project root sees it (`<repo path>/<file>`): risk, rules and contract globs use it.
export const rootPath = (spec, file) => (spec?.path && spec.path !== '.' ? `${spec.path.replace(/\/+$/, '')}/${file}` : file);

const ok = (cwd, args) => run('git', args, { cwd, allowFail: true }).status === 0;
export const isAncestor = (cwd, a, b) => ok(cwd, ['merge-base', '--is-ancestor', a, b]);
const revParse = (cwd, ref) => git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true }) || null;

// The base as last fetched (`<remote>/<base>`), else the local branch, else the commit recorded at start.
export function baseRef(cwd, spec, recorded = null) {
  const remote = `${remoteOf(spec)}/${spec.base}`;
  if (revParse(cwd, remote)) return remote;
  if (revParse(cwd, spec.base)) return spec.base;
  return recorded;
}

// Fetch a repo's base from its remote. Returns the fetched tip, or throws naming the failure.
export function fetchBase(dir, spec) {
  const remote = remoteOf(spec);
  const remotes = git(dir, ['remote']).split('\n').filter(Boolean);
  if (!remotes.includes(remote)) throw new Error(`${spec.name} has no remote \`${remote}\` to fetch ${spec.base} from`);
  const r = run('git', ['fetch', '--quiet', remote, `+refs/heads/${spec.base}:refs/remotes/${remote}/${spec.base}`], { cwd: dir, allowFail: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) throw new Error(`cannot fetch ${spec.base} from ${remote} in ${spec.name}: ${(r.stderr || r.stdout).trim()}`);
  const tip = revParse(dir, `${remote}/${spec.base}`);
  if (!tip) throw new Error(`${remote} has no branch ${spec.base} in ${spec.name}`);
  return tip;
}

export function kindOf(spec, file) {
  if (matchesAny(file, spec?.kinds?.tests ?? [])) return 'tests';
  if (matchesAny(file, spec?.kinds?.other ?? [])) return 'other';
  return 'product';
}

// Uncommitted changes per repo (reviews and the merge facts read commits only).
export function dirtyRepos(state) {
  const out = {};
  for (const [name, r] of Object.entries(state.repos ?? {})) {
    if (!fs.existsSync(r.worktree)) continue;
    const lines = git(r.worktree, ['status', '--porcelain', '--untracked-files=normal']).split('\n').filter(Boolean);
    if (lines.length) out[name] = lines.map((l) => l.slice(3));
  }
  return out;
}

// The repo's adapter spec with the attempt's recorded base (`wf start --base`): every base read of an attempt goes here.
export function specOf(adapter, name, r) {
  const spec = repoSpec(adapter, name) ?? { name, path: name, base: r?.base, remote: 'origin', kinds: { tests: [], other: [] } };
  return r?.base ? { ...spec, base: r.base } : spec;
}

export function baseOf(state, adapter, name) {
  const r = state.repos[name];
  return baseRef(r.worktree, specOf(adapter, name, r), r.baseSha);
}

export function mergeBaseOf(state, adapter, name) {
  const r = state.repos[name];
  const ref = baseOf(state, adapter, name);
  return (ref && git(r.worktree, ['merge-base', 'HEAD', ref], { allowFail: true })) || r.baseSha;
}

// The attempt's tree: sha256 over each repo's committed tree object, 16 hex, and the heads behind it. Events that record
// a tree (handoff, screens, reviews) carry the heads too, so the merge facts read the reviewed commits from the ledger.
export function treeOf(root, attempt, state) {
  const trees = {};
  const heads = {};
  for (const [name, r] of Object.entries(state.repos ?? {})) {
    if (!fs.existsSync(r.worktree)) continue;
    heads[name] = git(r.worktree, ['rev-parse', 'HEAD']);
    trees[name] = git(r.worktree, ['rev-parse', 'HEAD^{tree}']);
  }
  return { tree: sha256(canonicalJson(trees)).slice(0, 16), heads };
}

// ChangedFile[] of one repo between two commits.
export function diffFiles(cwd, spec, from, to = 'HEAD') {
  const status = new Map();
  for (const line of git(cwd, ['diff', '--name-status', '--no-renames', from, to]).split('\n').filter(Boolean)) {
    const [s, file] = line.split('\t');
    status.set(file, s[0]);
  }
  const out = [];
  for (const line of git(cwd, ['diff', '--numstat', '--no-renames', from, to]).split('\n').filter(Boolean)) {
    const [a, d, file] = line.split('\t');
    out.push({ repo: spec.name, path: file, kind: kindOf(spec, file), added: a === '-' ? 0 : Number(a), removed: d === '-' ? 0 : Number(d), status: status.get(file) ?? 'M' });
  }
  return out;
}

export function changedOf(root, attempt, state, adapter) {
  const files = [];
  for (const [name, r] of Object.entries(state.repos ?? {})) {
    if (!fs.existsSync(r.worktree)) continue;
    files.push(...diffFiles(r.worktree, specOf(adapter, name, r), mergeBaseOf(state, adapter, name)));
  }
  const { tree, heads } = treeOf(root, attempt, state);
  return { tree, heads, files };
}

async function changedFiles(root, attempt) {
  return changedOf(root, attempt, await attemptState(root, attempt), await loadAdapter(root));
}

// --- merge facts -------------------------------------------------------------------------------------------------------

// git's own automatic merge of two commits: its tree, or null when it conflicts or git cannot compute it.
function autoMergeTree(cwd, p1, p2) {
  const r = run('git', ['merge-tree', '--write-tree', '--no-messages', p1, p2], { cwd, allowFail: true });
  const first = r.stdout.split('\n')[0].trim();
  return r.status === 0 && /^[0-9a-f]{40,64}$/.test(first) ? first : null;
}

const subject = (cwd, sha) => git(cwd, ['log', '-1', '--format=%s', sha], { allowFail: true });

// What changed in one repo from the reviewed commit to HEAD other than git's automatic merges of the base, walking the
// first-parent line. [] when nothing did; else one line per commit that is not such a merge.
export function unreviewedCommits(cwd, reviewed, head, base) {
  if (reviewed === head) return [];
  if (!isAncestor(cwd, reviewed, head)) return [`HEAD ${head.slice(0, 10)} does not descend from the reviewed commit ${reviewed.slice(0, 10)} (history was rewritten)`];
  const out = [];
  for (const line of git(cwd, ['rev-list', '--first-parent', '--parents', `${reviewed}..${head}`]).split('\n').filter(Boolean)) {
    const [sha, ...parents] = line.split(' ');
    const what = `${sha.slice(0, 10)} "${subject(cwd, sha)}"`;
    if (parents.length !== 2) {
      out.push(`${what} is a commit after the review`);
      continue;
    }
    const [p1, p2] = parents;
    if (!base || !isAncestor(cwd, p2, base)) {
      out.push(`${what} merges a branch other than the base`);
      continue;
    }
    const auto = autoMergeTree(cwd, p1, p2);
    if (auto !== git(cwd, ['rev-parse', `${sha}^{tree}`])) {
      const files = auto ? git(cwd, ['diff', '--name-only', auto, sha], { allowFail: true }).split('\n').filter(Boolean) : null;
      out.push(`${what} differs from git's automatic merge of the base${files ? ` in ${files.slice(0, 8).join(', ')}` : ' (it resolved a conflict)'}`);
    }
  }
  return out;
}

// Merge commits on the attempt's branch whose merged parent is not on the base: [{ sha, parent, branches }].
export function foreignMerges(cwd, head, base) {
  if (!base) return [];
  const out = [];
  for (const line of git(cwd, ['rev-list', '--merges', '--parents', head, '--not', base], { allowFail: true }).split('\n').filter(Boolean)) {
    const [sha, , ...others] = line.split(' ');
    for (const p of others) {
      if (isAncestor(cwd, p, base)) continue;
      const branches = git(cwd, ['branch', '-r', '--contains', p], { allowFail: true }).split('\n').map((s) => s.trim()).filter((s) => s && !s.includes(' -> '));
      out.push({ sha, parent: p, branches });
    }
  }
  return out;
}

export const implements08 = { changedFiles };
