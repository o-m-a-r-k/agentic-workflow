// Whether a line of an attempt's tree was written by the attempt's own commits (design-0.8 section 2, the findings rule).
//
// Named failure: repairs created 41% of later defects, and a reviewer could class a defect on a line the attempt wrote
// as `other`, so it left the ticket. `finding:other-own` (stream 1) refuses that, from this fact: `git blame` of the line
// on the attempt's tree, and whether the blamed commit is outside every base the attempt started from or merged in.
// Telemetry uses the same fact for `introducedByRepair`.
import fs from 'node:fs';
import path from 'node:path';
import { WfError, branchName, loadAdapter, parseLocation, worktreeDir } from './contract.mjs';
import { attemptState } from './ledger.mjs';
import { run } from './util.mjs';

const gitOut = (cwd, args) => {
  const r = run('git', args, { cwd, allowFail: true });
  return r.status === 0 ? r.stdout.trim() : null;
};
const isAncestor = (cwd, a, b) => run('git', ['merge-base', '--is-ancestor', a, b], { cwd, allowFail: true }).status === 0;

// Where a repo of the attempt can be read: its worktree (HEAD), or after close the repo's own checkout at the kept branch.
export async function repoView(root, state, repo) {
  const wt = state.repos?.[repo]?.worktree ?? worktreeDir(root, state.id, repo);
  if (fs.existsSync(wt)) return { cwd: wt, ref: 'HEAD' };
  let dir = null;
  try {
    const adapter = await loadAdapter(root);
    const spec = adapter.repos.find((r) => r.name === repo);
    if (spec) dir = path.join(root, spec.path);
  } catch {
    dir = null;
  }
  dir ??= path.join(root, repo);
  if (!fs.existsSync(dir)) return null;
  return { cwd: dir, ref: state.repos?.[repo]?.branch ?? branchName(state.id) };
}

// The bases an attempt's repo started from or merged in (git's automatic merge of the base, `base.updated`).
export const basesOf = (state, repo) => [state.repos?.[repo]?.baseSha, ...(state.baseUpdates ?? []).filter((u) => u.repo === repo).map((u) => u.to)].filter(Boolean);

// The commit that last changed one line at `ref`, or a WfError saying why it cannot be known.
export function blameLine(cwd, ref, file, line) {
  const r = run('git', ['blame', '--porcelain', '-L', `${line},${line}`, ref, '--', file], { cwd, allowFail: true });
  if (r.status !== 0) throw new WfError(`cannot blame ${file}:${line} at ${ref}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
  const sha = /^([0-9a-f]{40}) /.exec(r.stdout)?.[1] ?? null;
  return sha && !/^0+$/.test(sha) ? sha : null;
}

/** Whether `<repo>/<path>:<line>` of the attempt's tree was written by this attempt's commits. */
export async function blameToAttempt(root, attempt, location) {
  const loc = parseLocation(location);
  if (!loc) throw new WfError(`not a location: \`${location}\`; a finding's location is <repo>/<path>:<line>`);
  const state = await attemptState(root, attempt);
  if (state.schema !== 2) throw new WfError(`${attempt} is a 0.7 attempt; its lines are not blamed`);
  const view = await repoView(root, state, loc.repo);
  if (!view) throw new WfError(`${attempt} has no repo \`${loc.repo}\` to blame ${location} in`);
  const bases = basesOf(state, loc.repo);
  if (!bases.length) throw new WfError(`${attempt} recorded no base commit for ${loc.repo}; ${location} cannot be blamed`);
  const commit = blameLine(view.cwd, view.ref, loc.path, loc.line);
  if (!commit) return { own: false, commit: null };
  const own = !bases.some((b) => isAncestor(view.cwd, commit, b));
  return { own, commit };
}

// The committer time of a commit (ISO), or null.
export const commitTime = (cwd, sha) => gitOut(cwd, ['show', '-s', '--format=%cI', sha]);

export const implements08 = { blameToAttempt };
