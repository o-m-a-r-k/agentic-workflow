// 0.7.30 (I-201, D62): delivery to a branch other than a repo's configured base, and to more than one branch.
//
// Named failure (field): an accepted ticket targeted the repo's base (master); the person asked for it on a divergent staging
// branch too ("commit and push straight to staging and master"). The adapter knew one base per repo and `wf entry` took no
// target, so the owner applied the accepted change to staging by hand outside the workflow; it conflicted, its fixture
// verification failed, and it was thrown away, with no supported route for a separately reviewed staging integration that
// changed neither the project's base nor the completed delivery to master.
//
// - An attempt can be based on and delivered to its own branch of a repo (`wf entry --target <repo>=<branch>`), recorded at
//   admission: its worktree starts from that branch, its base comparisons, `wf base merge` and its delivery (push-main or the
//   delivery adapter's `ctx.repo.base`) use it, and its adapter is the one committed there (engine/config.mjs `withTargets`).
// - An attempt can name additional targets (`--also-target` at admission, or `wf target add` later, with the reason recorded).
//   Each is delivered by a port: an attempt of the same item on that target (`wf entry --port <attempt> --target ...`), which
//   `wf deliver` admits by itself once the attempt's own delivery is complete. A port carries the source's own commits
//   (cherry-picked, base merges left out), its frozen criteria and impact map, and is gated, reviewed, accepted and delivered
//   like any attempt. A commit that does not apply is not hidden: the cherry-pick is aborted, the port keeps the commits that
//   applied, and the commit and its conflicting files are recorded and shown with what to do. A port moves no ticket status.
import { branchName } from './attempt.mjs';
import { repoDir } from './config.mjs';
import { append, listAttempts, loadState } from './ledger.mjs';
import { WfError, git, refuse, run } from './util.mjs';

const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]+(?<![./])$/;

// `<repo>=<branch>[,<repo>=<branch>]`, or a bare `<branch>` for every repo of `repos`.
export function parseTargets(value, repos, flag = '--target') {
  if (value === undefined || value === null || value === false) return {};
  if (value === true || !String(value).trim()) throw new WfError(`${flag} names a branch: <repo>=<branch>[,<repo>=<branch>], or <branch> for every repo`);
  const out = {};
  for (const part of String(value).split(',').map((x) => x.trim()).filter(Boolean)) {
    const [repo, branch] = part.includes('=') ? part.split('=').map((x) => x.trim()) : [null, part];
    for (const name of repo ? [repo] : repos) {
      if (!repos.includes(name)) throw new WfError(`${flag}: \`${name}\` is not a repo of this attempt (repos: ${repos.join(', ')})`);
      if (!BRANCH.test(branch ?? '')) throw new WfError(`${flag}: \`${branch}\` is not a branch name`);
      out[name] = branch;
    }
  }
  return out;
}

export const targetsKey = (targets) => JSON.stringify(Object.entries(targets ?? {}).sort());
export const attemptTargets = (state) => Object.fromEntries(Object.entries(state.repos ?? {}).filter(([, r]) => r?.target).map(([n, r]) => [n, r.target]));

// The source attempt's own commits in a repo, oldest first: on its branch (or what it recorded), not on its admission base and
// not brought in by a base merge. Merges are left out: a port carries the change, not the base it was merged with.
export function ownCommits(root, cfg, source, name) {
  const r = source.repos[name];
  const repo = cfg.repos.find((x) => x.name === name);
  const dir = repoDir(root, repo);
  const branch = git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${r.branch ?? branchName(source.id)}^{commit}`], { allowFail: true });
  const head = source.delivery?.repos?.[name]?.commit ?? (branch || null) ?? source.accepted?.heads?.[name] ?? null;
  if (!head || head === r.base) return { head, commits: [] };
  const merged = (source.baseMerges ?? []).filter((m) => m.repo === name && m.to).map((m) => m.to);
  const out = git(dir, ['rev-list', '--reverse', '--no-merges', head, '--not', r.base, ...merged], { allowFail: true });
  return { head, commits: out ? out.split('\n').filter(Boolean) : [] };
}

// Cherry-picks `commits` onto the worktree, in order. Stops at the first that does not apply: aborted, so the worktree holds
// the ones that applied, and the conflict is returned (commit, subject, files), never resolved by guessing.
export function applyCommits(worktree, commits) {
  const applied = [];
  for (const c of commits) {
    const pick = run('git', ['cherry-pick', '-x', '--allow-empty', '--keep-redundant-commits', c], { cwd: worktree, allowFail: true });
    if (pick.status === 0) {
      applied.push(c);
      continue;
    }
    const files = git(worktree, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).split('\n').filter(Boolean);
    run('git', ['cherry-pick', '--abort'], { cwd: worktree, allowFail: true });
    return { applied, conflict: { commit: c, subject: git(worktree, ['log', '-1', '--format=%s', c], { allowFail: true }), files, left: commits.slice(commits.indexOf(c)).length } };
  }
  return { applied, conflict: null };
}

// A port whose every commit applied holds its change already, as a batch holds its members': it needs no implementer first.
export const portApplied = (state) => Boolean(state?.portOf) && Object.values(state.port?.repos ?? {}).some((p) => p.applied?.length) && Object.values(state.port?.repos ?? {}).every((p) => !p.conflict);

// The source a port is made from: an attempt of the same item whose change was accepted (or delivered).
export function portSource(root, id, item) {
  let source;
  try {
    source = loadState(root, String(id));
  } catch {
    throw refuse(`--port: no attempt \`${id}\``);
  }
  if (item && source.item !== item) throw refuse(`--port: ${source.id} is ${source.item}, not ${item}; a port carries one item's change to another branch`, null, { id: 'targets:port-item' });
  if (!source.accepted && !source.delivery?.completedAt) throw refuse(`--port: ${source.id} has no accepted change to carry yet`, `port it once it is accepted (or delivered); a port carries a reviewed change`, { id: 'targets:port-unaccepted' });
  return source;
}

// `wf target add <repo>=<branch>[,...] --reason "why" [--attempt <id>]`: a target the attempt is also delivered to, recorded
// with the reason (the person's request). Bookkeeping: it adds a delivery, it takes nothing away.
export function addTargets(root, state, value, { reason, by }) {
  if (['done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is ${state.phase}`);
  if (state.batch || state.batchOf || state.deferHeavy) throw refuse(`${state.id} is delivered with a batch; port it once the batch is delivered: \`wf entry --item ${state.item} --port ${state.id} --target <repo>=<branch>\``, null, { id: 'targets:batch' });
  if (!reason || reason === true) throw new WfError('--reason is required: why the change also goes to that branch (the person\'s words, when they asked)');
  const wanted = parseTargets(value, Object.keys(state.repos), 'wf target add');
  const own = attemptTargets(state);
  const added = Object.entries(wanted).filter(([repo, branch]) => (own[repo] ?? null) !== branch && !(state.alsoTargets ?? []).some((t) => t.repo === repo && t.branch === branch)).map(([repo, branch]) => ({ repo, branch }));
  if (!added.length) throw refuse('nothing to add: the attempt is already delivered to each of those branches', null, { id: 'targets:nothing' });
  append(root, state.id, 'targets.added', { targets: added, reason: String(reason) }, by);
  return loadState(root, state.id);
}

// The additional targets of an attempt with the port that delivers each (null while none is admitted).
export function portsOf(root, state) {
  const ports = listAttempts(root).flatMap((id) => {
    try {
      const s = loadState(root, id);
      return s.portOf === state.id ? [s] : [];
    } catch {
      return [];
    }
  });
  const groups = new Map();
  for (const t of state.alsoTargets ?? []) {
    const key = `${t.repo}=${t.branch}`;
    groups.set(key, { ...t, port: ports.find((p) => p.repos?.[t.repo]?.target === t.branch && p.phase !== 'abandoned') ?? null });
  }
  return [...groups.values()];
}

// Lines for `wf status` and `wf resume`: the attempt's own target, the port it is and the additional targets it owes.
export function targetLines(root, state) {
  const lines = [];
  const own = attemptTargets(state);
  if (Object.keys(own).length) lines.push(`  delivered to: ${Object.entries(own).map(([n, b]) => `${n} -> ${b}`).join(', ')} (its own target, not the repo's base)`);
  if (state.portOf) {
    const c = Object.entries(state.port?.repos ?? {}).filter(([, p]) => p.conflict);
    lines.push(`  port of ${state.portOf}: ${Object.entries(state.port?.repos ?? {}).map(([n, p]) => `${n} ${p.applied.length} of ${p.commits.length} commit(s) applied`).join(', ') || 'no commits'}; no ticket status moves for a port`);
    for (const [n, p] of c) lines.push(`  PORT CONFLICT in ${n}: ${p.conflict.commit.slice(0, 10)} "${p.conflict.subject}" does not apply to ${state.repos[n]?.target}${p.conflict.files.length ? ` (${p.conflict.files.join(', ')})` : ''}; ${p.conflict.left} commit(s) left: an implementer ports them by hand against the frozen criteria (\`git cherry-pick -x ${p.conflict.commit.slice(0, 12)}\` and on, resolving each), then the review and the gate as usual`);
  }
  for (const t of portsOf(root, state)) lines.push(`  also to deliver: ${t.repo} -> ${t.branch} (${t.reason ?? 'recorded at admission'}): ${t.port ? `ported by ${t.port.id} (${t.port.phase})` : state.delivery?.completedAt ? `\`wf entry --item ${state.item} --port ${state.id} --target ${t.repo}=${t.branch}\` admits its port` : 'its port is admitted by `wf deliver` once this delivery is complete'}`);
  return lines;
}

// After the attempt's own delivery is complete: a port for each additional target that has none, admitted with the same
// owner. A port that cannot be admitted (the branch does not exist, its adapter cannot be read) is said, never fatal to the
// delivery that already happened.
export async function admitPorts(root, state, options, entry) {
  if (!state.delivery?.completedAt) return [];
  const out = [];
  for (const t of portsOf(root, state).filter((x) => !x.port)) {
    try {
      const p = entry(root, { owner: options.owner, item: state.item, lane: state.lane === 'quick' ? 'quick' : 'standard', autoItem: state.autoItem, port: state.id, target: `${t.repo}=${t.branch}`, repos: t.repo });
      out.push({ ...t, admitted: p.id, conflict: Object.values(p.port?.repos ?? {}).some((x) => x.conflict) });
    } catch (error) {
      out.push({ ...t, problem: String(error?.message ?? error).split('\n')[0] });
    }
  }
  return out;
}

export const portLines = (state, ports) => ports.map((p) => (p.problem ? `\n  also to deliver ${p.repo} -> ${p.branch}: its port was not admitted: ${p.problem}; \`wf entry --item ${state.item} --port ${state.id} --target ${p.repo}=${p.branch}\` once that is fixed` : `\n  also to deliver ${p.repo} -> ${p.branch}: admitted its port ${p.admitted}${p.conflict ? ' (a commit did not apply: `wf resume --attempt ' + p.admitted + '` names it)' : ''}; it is gated, reviewed, accepted and delivered like any attempt`)).join('');

