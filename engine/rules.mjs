// Project rules (design section 2, "Review bundle"): the documents a reviewer reads for the paths a change touches.
// The adapter's `rules: [{ paths, read }]` maps root-relative globs to root-relative documents. A document is read as
// the attempt's base holds it, never as its worktree does: a ticket cannot loosen the rules or the invariants it is
// judged by. Read only; nothing here writes outside the bundle folder it is given.
import fs from 'node:fs';
import path from 'node:path';
import { git, matchesAny, run } from './util.mjs';

// The documents that govern any of the given root-relative paths, in the adapter's order, each once.
export function ruleDocs(adapter, rootPaths) {
  return [...new Set((adapter.rules ?? []).filter((r) => rootPaths.some((f) => matchesAny(f, r.paths ?? []))).flatMap((r) => r.read ?? []))];
}

// The repo that holds a root-relative path (the longest matching repo path), or null when it is outside every repo.
export function repoOfPath(adapter, rel) {
  return [...adapter.repos].sort((a, b) => b.path.length - a.path.length).find((r) => r.path === '.' || rel === r.path || rel.startsWith(`${r.path.replace(/\/+$/, '')}/`)) ?? null;
}

// One project document as the attempt's base holds it, copied to `<dir>/base/<rel>`; returns that file, or null when
// the base does not hold it. A path inside a repo is read at the attempt's base commit for that repo (or the repo's
// fetched base when the attempt does not hold the repo); a path outside every repo is read from the project root.
export function docAtBase(root, state, adapter, rel, dir) {
  const spec = repoOfPath(adapter, rel);
  if (!spec) {
    const f = path.resolve(root, rel);
    return fs.existsSync(f) ? f : null;
  }
  const inRepo = spec.path === '.' ? rel : rel.slice(spec.path.replace(/\/+$/, '').length + 1);
  const own = state?.repos?.[spec.name];
  const cwd = own?.worktree && fs.existsSync(own.worktree) ? own.worktree : path.join(root, spec.path);
  if (!fs.existsSync(cwd)) return null;
  const at = (ref) => git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true }) || null;
  const commit = own?.baseSha ?? at(`${spec.remote || 'origin'}/${spec.base}`) ?? at(spec.base);
  if (!commit) return null;
  const r = run('git', ['show', `${commit}:${inRepo}`], { cwd, allowFail: true });
  if (r.status !== 0) return null;
  const out = path.join(dir, 'base', rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, r.stdout);
  return out;
}
