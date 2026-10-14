// Which implementer handoff introduced the defects reviewers found (0.7.0). Measurement only; nothing is decided from it.
//
// Named failure: every defect in one build was found by someone other than its author, after the hand-off, and nothing
// measured where defects came from, only where they were found. Each located review finding is traced with `git blame`
// on the tree the reviewer judged to the commit that last touched the cited line, and that commit to the implementer
// handoff whose commits contain it (between the heads at its handoff and at its close). Harness-neutral: the ledger and
// git only.
import { git, run } from './util.mjs';
import fs from 'node:fs';
import { classifyFinding, locationsOf } from './review-policy.mjs';

const head = (t) => String(t ?? '').split('+')[0] || null;
const isAncestor = (dir, a, b) => run('git', ['merge-base', '--is-ancestor', a, b], { cwd: dir, allowFail: true }).status === 0;

// The commit that last changed `file:line` at `commit`, or null.
function blameLine(dir, commit, file, line) {
  const out = git(dir, ['blame', '--porcelain', '-L', `${line},${line}`, commit, '--', file], { allowFail: true });
  const sha = /^([0-9a-f]{40}) /.exec(String(out ?? ''))?.[1] ?? null;
  return sha && !/^0+$/.test(sha) ? sha : null;
}

// The repo and repo-relative path a cited file names (`repo:path`, `repo/path`, or a path that exists in one repo).
function resolve(state, cited, commitOf) {
  const repos = Object.entries(state.repos ?? {});
  for (const [name, r] of repos) {
    for (const prefix of [`${name}:`, `${name}/`]) if (cited.startsWith(prefix)) return { repo: name, dir: r.worktree, file: cited.slice(prefix.length) };
  }
  for (const [name, r] of repos) {
    const c = commitOf(name);
    if (c && r.worktree && fs.existsSync(r.worktree) && run('git', ['cat-file', '-e', `${c}:${cited}`], { cwd: r.worktree, allowFail: true }).status === 0) return { repo: name, dir: r.worktree, file: cited };
  }
  return null;
}

// { byAgent: { [agent]: { work, blocking, observations } }, unattributed, traced } for the attempt's recorded rounds.
export function introducedFindings(state, { limit = 200 } = {}) {
  const byAgent = {};
  let unattributed = 0, traced = 0;
  const impl = (state.implementers ?? []).filter((x) => x.heads);
  for (const r of state.reviews ?? []) {
    for (const f of r.closure?.findings ?? []) {
      if (traced >= limit) break;
      const loc = locationsOf(f)[0];
      if (!loc) continue;
      traced++;
      const where = resolve(state, loc.file.replace(/^\.\//, ''), (name) => head(r.tree?.[name]));
      const commit = where ? head(r.tree?.[where.repo]) : null;
      const sha = where && commit && fs.existsSync(where.dir) ? blameLine(where.dir, commit, where.file, loc.start) : null;
      const who = sha ? impl.find((x) => {
        const from = head(x.heads?.[where.repo]);
        const to = head(x.closedHeads?.[where.repo]) ?? commit;
        return from && to && sha !== from && isAncestor(where.dir, from, sha) && isAncestor(where.dir, sha, to);
      }) : null;
      if (!who) {
        unattributed++;
        continue;
      }
      const row = (byAgent[who.agent] ??= { work: who.work ?? null, blocking: 0, observations: 0 });
      if (classifyFinding(state, f).blocks) row.blocking++;
      else row.observations++;
    }
  }
  return { byAgent, unattributed, traced };
}
