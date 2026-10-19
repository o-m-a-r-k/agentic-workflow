// Stream 5 scenario support (not a test file): a normalised adapter double for the fixture project, commits at fixed
// times, and a clock.
import path from 'node:path';
import { adapterFor, git, writeFiles } from './helpers/index.mjs';

// What stream 6's loadAdapter returns for the fixture (only the keys stream 5 reads, normalised).
export function normalisedAdapter(p, overrides = {}) {
  const raw = adapterFor({ root: p.root, overrides });
  return {
    version: 2, name: raw.name, root: p.root,
    repos: raw.repos.map((r) => ({ ...r, remote: 'origin', provision: { clone: [], fingerprint: [], install: null, copyIgnored: [] } })),
    risk: { confirmed: true, paths: raw.risk },
    budget: raw.budget,
  };
}

// Commit `files` in `cwd` with author and committer time `iso`. Returns the commit.
export function commitAt(cwd, files, message, iso) {
  writeFiles(cwd, files);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '--quiet', '-m', message], { env: { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } });
  return git(cwd, ['rev-parse', 'HEAD']);
}

// A day after the real present, on the minute: fixture times are later than the fixture's own initial commits.
export function futureStart() {
  const d = new Date(Date.now() + 86400000);
  d.setUTCHours(9, 0, 0, 0);
  return d.getTime();
}
export const at = (t0, min) => new Date(t0 + min * 60000).toISOString();
export const wt = (p, attempt, repo) => path.join(p.root, '.wf-worktrees', attempt, repo);
