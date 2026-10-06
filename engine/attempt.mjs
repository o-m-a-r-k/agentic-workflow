import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadConfigAtCommit, adapterLocation, repoDir } from './config.mjs';
import { append, assertSchema, createAttempt, listAttempts, loadState, openEvidence } from './ledger.mjs';
import { projectEnv } from './env.mjs';
import { emitTrackerEvent } from './tracker.mjs';
import { WfError, assertEngine, assertSafeId, git, hashFile, refuse, run, sessionIdentity, sha256 } from './util.mjs';

export const worktreesRoot = (root) => path.join(root, '.wf-worktrees');
export const worktreeDir = (root, id, repoName) => path.join(worktreesRoot(root), id, repoName);
export const branchName = (id) => `wf/${id}`;

export function actor(options = {}) {
  if (options.owner) return String(options.owner);
  const s = sessionIdentity();
  if (s) return `${s.runtime}:${s.session}`;
  return `human:${os.userInfo().username}`;
}

const OPEN = (s) => !['done', 'abandoned'].includes(s.phase);

// --attempt wins; otherwise the attempt whose worktree contains cwd; otherwise the only open attempt.
export function resolveAttempt(root, options = {}) {
  if (options.attempt) return assertSafeId(options.attempt, 'attempt id');
  const wt = worktreesRoot(root) + path.sep;
  const cwd = fs.realpathSync(process.cwd()) + path.sep;
  const realWt = fs.existsSync(worktreesRoot(root)) ? fs.realpathSync(worktreesRoot(root)) + path.sep : wt;
  if (cwd.startsWith(realWt)) return cwd.slice(realWt.length).split(path.sep)[0];
  const open = listAttempts(root).filter((id) => OPEN(loadState(root, id)));
  if (open.length === 1) return open[0];
  if (open.length === 0) throw new WfError('no open attempt', { hint: 'start one with `wf entry`' });
  throw new WfError(`several open attempts (${open.join(', ')}); pass --attempt <id>`);
}

export function openState(root, options) {
  const id = resolveAttempt(root, options);
  openEvidence(root, id);
  const state = loadState(root, id);
  assertSchema(state);
  return state;
}

function nextNumber(root, prefix) {
  const used = listAttempts(root)
    .map((id) => id.match(new RegExp(`^${prefix}-(\\d+)`))?.[1])
    .filter(Boolean)
    .map(Number);
  return used.length ? Math.max(...used) + 1 : 1;
}

export function nextAttemptId(root, item) {
  const n = listAttempts(root).filter((id) => id.startsWith(`${item}.`)).length + 1;
  return `${item}.${n}`;
}

// The remote base when there is one (fetched; offline falls back to the last fetched copy), else the local branch.
function baseRef(dir, repo) {
  const remotes = git(dir, ['remote']).split('\n').filter(Boolean);
  if (remotes.includes(repo.remote)) {
    const fetched = run('git', ['fetch', '--quiet', repo.remote, repo.base], { cwd: dir, allowFail: true });
    const ref = `${repo.remote}/${repo.base}`;
    if (fetched.status !== 0 && !git(dir, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true })) throw new WfError(`cannot fetch ${ref} in ${repo.name}: ${fetched.stderr.trim()}`);
    return ref;
  }
  return repo.base;
}

// Copy-on-write clone where the filesystem supports it (APFS clonefile, btrfs/xfs reflink).
function cloneTree(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tries = process.platform === 'darwin' ? [['-c', '-R'], ['-R']] : [['--reflink=auto', '-R'], ['-R']];
  for (const flags of tries) {
    if (run('cp', [...flags, src, dest], { allowFail: true }).status === 0) return;
  }
  throw new WfError(`could not copy ${src} to ${dest}`);
}

export function missingNodeDependencies(pkgDir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const names = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  return names.filter((n) => !fs.existsSync(path.join(pkgDir, 'node_modules', n, 'package.json')));
}

export function provision(root, cfg, repo, dir) {
  const source = repoDir(root, repo);
  const p = repo.provision;
  const report = { cloned: [], copied: [], installed: false };
  for (const rel of p.clone) {
    const src = path.join(source, rel);
    if (fs.existsSync(src) && !fs.existsSync(path.join(dir, rel))) {
      cloneTree(src, path.join(dir, rel));
      report.cloned.push(rel);
    }
  }
  for (const rel of p.copyIgnored) {
    const src = path.join(source, rel);
    if (fs.existsSync(src) && !fs.existsSync(path.join(dir, rel))) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.copyFileSync(src, path.join(dir, rel));
      fs.chmodSync(path.join(dir, rel), fs.statSync(src).mode);
      report.copied.push(rel);
    }
  }
  const drift = p.fingerprint.some((rel) => {
    const a = path.join(source, rel);
    const b = path.join(dir, rel);
    return fs.existsSync(b) && (!fs.existsSync(a) || hashFile(a) !== hashFile(b));
  });
  const missingClone = p.clone.some((rel) => !fs.existsSync(path.join(dir, rel)));
  // Matching lockfiles do not prove the copied dependencies were installed from them: the main checkout's
  // node_modules can lag behind its package.json. A declared dependency that is absent means install.
  const stale = p.clone.filter((rel) => path.basename(rel) === 'node_modules').some((rel) => missingNodeDependencies(path.join(dir, path.dirname(rel))).length > 0);
  report.stale = stale;
  if (p.install && (drift || missingClone || stale)) {
    run('sh', ['-c', p.install], { cwd: dir, env: projectEnv(cfg) });
    report.installed = true;
  }
  if (p.onWorktreeCreate) {
    run(process.execPath, [path.resolve(root, '.workflow', p.onWorktreeCreate), dir], { cwd: dir, env: projectEnv(cfg, { WF_ROOT: root, WF_REPO: repo.name }) });
  }
  return report;
}

export function entry(root, options) {
  const cfg = loadConfig(root);
  if (!cfg.enabled) throw refuse('the workflow is disabled for this project', 'run `wf enable`');
  assertEngine(cfg);
  const intent = options.intent ?? 'implementation';
  if (!['implementation', 'analysis'].includes(intent)) throw new WfError('--intent must be implementation or analysis');
  const lane = options.lane ?? (options.item ? 'standard' : 'quick');
  if (!cfg.lanes.includes(lane)) throw refuse(`lane \`${lane}\` is not enabled for this project (lanes: ${cfg.lanes.join(', ')})`);
  let item = options.item ? assertSafeId(options.item, 'item') : null;
  if (lane === 'standard' && !item) throw new WfError('standard lane needs --item <ticket id>');
  if (lane === 'quick' && !item) item = `QF-${nextNumber(root, 'QF')}`;
  const owner = actor(options);

  for (const id of listAttempts(root)) {
    const s = loadState(root, id);
    if (s.item === item && OPEN(s)) throw refuse(`${item} already has an open attempt ${id} owned by ${s.owner}`, `continue it, or take it over with \`wf adopt --attempt ${id}\``);
  }

  const wanted = options.repos ? String(options.repos).split(',') : cfg.repos.map((r) => r.name);
  for (const name of wanted) if (!cfg.repos.find((r) => r.name === name)) throw new WfError(`unknown repo \`${name}\``);
  const id = assertSafeId(options.id ?? nextAttemptId(root, item), 'attempt id');
  // Validate everything before creating anything: the adapter must be on the base the gate will trust.
  const { repo: adapterRepo } = adapterLocation(root, cfg);
  const bases = {};
  for (const name of new Set([...wanted, adapterRepo.name])) {
    const repo = cfg.repos.find((r) => r.name === name);
    const ref = baseRef(repoDir(root, repo), repo);
    bases[name] = { ref, commit: git(repoDir(root, repo), ['rev-parse', ref]) };
  }
  const adapterBase = bases[adapterRepo.name].commit;
  let trusted;
  try {
    trusted = loadConfigAtCommit(root, cfg, adapterBase);
  } catch (error) {
    throw refuse(`${error.message.split('\n')[0]}`, `commit .workflow/ on ${adapterRepo.base} in ${adapterRepo.name} and push it to ${adapterRepo.remote}; the gate trusts only the adapter on the base it starts from (${bases[adapterRepo.name].ref})`);
  }
  // The gate judges with the committed adapter, so its pin counts too.
  assertEngine(trusted);
  // Create worktrees; if any step fails, remove what was made so a retry starts clean.
  const repos = {};
  const made = [];
  try {
    for (const name of wanted) {
      const repo = cfg.repos.find((r) => r.name === name);
      const dir = repoDir(root, repo);
      const wt = worktreeDir(root, id, name);
      if (git(dir, ['branch', '--list', branchName(id)])) throw refuse(`branch ${branchName(id)} already exists in ${name} from an earlier attempt`, `inspect it, then delete it: git -C ${dir} branch -D ${branchName(id)}`);
      run('git', ['worktree', 'add', '--quiet', '-b', branchName(id), wt, bases[name].commit], { cwd: dir });
      made.push({ dir, wt });
      const provisioned = provision(root, cfg, repo, wt);
      repos[name] = { base: bases[name].commit, baseRef: bases[name].ref, branch: branchName(id), worktree: wt, provisioned, provisionedUntracked: untrackedSnapshot(wt) };
    }
  } catch (error) {
    for (const m of made.reverse()) {
      run('git', ['worktree', 'remove', '--force', m.wt], { cwd: m.dir, allowFail: true });
      run('git', ['branch', '-D', branchName(id)], { cwd: m.dir, allowFail: true });
    }
    fs.rmSync(path.join(worktreesRoot(root), id), { recursive: true, force: true });
    throw error;
  }

  let issue = null;
  if (options['issue-file']) {
    const src = path.resolve(String(options['issue-file']));
    if (!fs.existsSync(src)) throw new WfError(`--issue-file not found: ${src}`);
    const dest = path.join(root, '.wf-evidence', 'attempts', id, 'issue', path.basename(src));
    // Opened first: the copy is then a file this process wrote, recorded in the manifest when it ends (copied before,
    // it was in the opening snapshot unrecorded and refused as an extra file).
    openEvidence(root, id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    issue = { file: dest, sha256: hashFile(dest) };
  }
  createAttempt(root, id, { id, item, lane, intent, repos, adapterBase, issue, reopenedFrom: options.reopenedFrom ?? null, deferHeavy: options.deferHeavy === true || options.deferHeavy === 'true' }, owner);
  if (lane === 'standard' && intent === 'implementation') emitTrackerEvent(root, cfg, id, 'admitted');
  return loadState(root, id);
}

// I-19: a repo the running attempt needs for a fix, given its worktree on the attempt's branch from the current base,
// provisioned as at admission. Returns the repos entry; the caller records it (`repo.added`). Nothing is left behind on
// failure.
export function addRepoWorktree(root, cfg, state, name) {
  const repo = cfg.repos.find((r) => r.name === name);
  if (!repo) throw new WfError(`unknown repo \`${name}\` (repos: ${cfg.repos.map((r) => r.name).join(', ')})`);
  if (state.repos[name]) throw refuse(`${name} is already in ${state.id}`);
  const dir = repoDir(root, repo);
  const ref = baseRef(dir, repo);
  const commit = git(dir, ['rev-parse', ref]);
  const wt = worktreeDir(root, state.id, name);
  if (git(dir, ['branch', '--list', branchName(state.id)])) throw refuse(`branch ${branchName(state.id)} already exists in ${name}`, `inspect it, then delete it: git -C ${dir} branch -D ${branchName(state.id)}`);
  run('git', ['worktree', 'add', '--quiet', '-b', branchName(state.id), wt, commit], { cwd: dir });
  try {
    const provisioned = provision(root, cfg, repo, wt);
    return { base: commit, baseRef: ref, branch: branchName(state.id), worktree: wt, provisioned, provisionedUntracked: untrackedSnapshot(wt) };
  } catch (error) {
    run('git', ['worktree', 'remove', '--force', wt], { cwd: dir, allowFail: true });
    run('git', ['branch', '-D', branchName(state.id)], { cwd: dir, allowFail: true });
    throw error;
  }
}

export function adopt(root, options) {
  const state = openState(root, options);
  const by = actor(options);
  append(root, state.id, 'owner.adopted', { from: state.owner, reason: options.reason ?? null }, by);
  return loadState(root, state.id);
}

export function abandon(root, options) {
  const state = openState(root, options);
  if (!options.reason) throw new WfError('--reason is required');
  if (Object.keys(state.delivery.repos).length) throw refuse(`${state.id} is partly delivered; finish delivery instead of abandoning it`);
  append(root, state.id, 'abandoned', { reason: String(options.reason) }, actor(options));
  cleanupWorktrees(root, loadState(root, state.id));
  return loadState(root, state.id);
}

export function hold(root, options) {
  const state = openState(root, options);
  if (!options.reason) throw new WfError('--reason is required');
  append(root, state.id, 'hold', { reason: String(options.reason) }, actor(options));
  return loadState(root, state.id);
}

export function release(root, options) {
  const state = openState(root, options);
  if (!state.activeHold) throw refuse(`${state.id} has no active hold`);
  append(root, state.id, 'release', {}, actor(options));
  return loadState(root, state.id);
}

export function cleanupWorktrees(root, state) {
  const cfg = loadConfig(root);
  const problems = [];
  for (const [name, r] of Object.entries(state.repos)) {
    const repo = cfg.repos.find((x) => x.name === name);
    if (!repo) continue;
    const dir = repoDir(root, repo);
    if (fs.existsSync(r.worktree)) {
      const rm = run('git', ['worktree', 'remove', '--force', r.worktree], { cwd: dir, allowFail: true });
      if (rm.status !== 0) problems.push(`${name}: ${rm.stderr.trim()}`);
    }
    // Delivered work is on the target branch; an abandoned attempt keeps its branch so nothing is lost.
    if (state.delivery?.completedAt) run('git', ['branch', '-D', r.branch ?? branchName(state.id)], { cwd: dir, allowFail: true });
  }
  if (problems.length) process.stderr.write(`wf: could not remove worktree(s):\n  ${problems.join('\n  ')}\n`);
  removeReviewScratch(root, state.id);
}

// Removes the attempt's `_review` scratch folder (closures were copied into evidence by `wf review`). Fails closed:
// nothing is deleted unless `.wf-worktrees`, the attempt folder and `_review` are real directories (not links) that
// really lie where they should; entries are removed one by one without following links; anything uncertain is left
// in place with a warning. Named finding (0.1.18 review): a recursive delete under `.wf-worktrees` would follow a
// symlinked folder (for example `.wf-worktrees` itself pointing at the evidence).
export function removeReviewScratch(root, id) {
  assertSafeId(id, 'attempt id');
  const warn = (why) => process.stderr.write(`wf: left ${path.join(worktreesRoot(root), id)} in place: ${why}\n`);
  const wtRoot = worktreesRoot(root);
  const isDir = (p) => {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    return st ? (st.isDirectory() && !st.isSymbolicLink() ? 'dir' : 'other') : null;
  };
  const top = isDir(wtRoot);
  if (top === null) return;
  if (top !== 'dir') return warn('.wf-worktrees is not a real directory');
  const rootReal = fs.realpathSync(root);
  if (fs.realpathSync(wtRoot) !== path.join(rootReal, '.wf-worktrees')) return warn('.wf-worktrees does not really lie in the project');
  const dir = path.join(wtRoot, id);
  const d = isDir(dir);
  if (d === null) return;
  if (d !== 'dir' || fs.realpathSync(dir) !== path.join(rootReal, '.wf-worktrees', id)) return warn('the attempt folder is a link or lies elsewhere');
  const review = path.join(dir, '_review');
  const rv = isDir(review);
  if (rv === 'other') return warn('_review is a link or not a directory');
  if (rv === 'dir') {
    const ok = removeTree(review, fs.realpathSync(review));
    if (!ok) return warn('_review held something that is not a plain file or folder');
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

// Deletes a folder's plain files and folders bottom-up, unlinking (never following) a symlink; refuses anything that
// leaves `expected`. Returns false and leaves the rest in place when it meets something else.
function removeTree(dir, expected) {
  let clean = true;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(p);
    else if (st.isDirectory() && fs.realpathSync(p) === path.join(expected, name)) clean = removeTree(p, path.join(expected, name)) && clean;
    else clean = false;
  }
  if (clean) fs.rmdirSync(dir);
  return clean;
}

export function changedFiles(state, name) {
  const r = state.repos[name];
  const out = git(r.worktree, ['diff', '--name-only', `${r.baseRef ?? r.base}...HEAD`]);
  return out ? out.split('\n') : [];
}

export function untrackedFiles(worktree) {
  const out = git(worktree, ['ls-files', '--others', '--exclude-standard', '--directory', '-z']);
  return out ? out.split('\0').filter(Boolean) : [];
}

// Directories are recorded by presence, files by content.
export function untrackedSnapshot(worktree) {
  const snap = {};
  for (const f of untrackedFiles(worktree)) snap[f] = f.endsWith('/') ? 'dir' : hashFile(path.join(worktree, f));
  return snap;
}

export function uncommitted(state) {
  // What the last gate and the last `wf check` produced (reports, caches) is not the change.
  const lastCheck = state.checks?.at(-1)?.producedUntracked ?? {};
  const lastGate = state.lastGate?.producedUntracked ?? {};
  const produced = Object.fromEntries([...new Set([...Object.keys(lastCheck), ...Object.keys(lastGate)])].map((r) => [r, { ...(lastCheck[r] ?? {}), ...(lastGate[r] ?? {}) }]));
  const dirty = {};
  for (const [name, r] of Object.entries(state.repos)) {
    const tracked = git(r.worktree, ['status', '--porcelain', '--untracked-files=no']);
    const lines = tracked ? tracked.split('\n') : [];
    // Untracked files that provisioning (installs) or the last gate created are not the change; anything else is.
    const known = { ...(r.provisionedUntracked ?? {}), ...(produced[name] ?? {}) };
    for (const f of untrackedFiles(r.worktree)) {
      const abs = path.join(r.worktree, f);
      if (known[f] === 'dir' && f.endsWith('/')) continue;
      if (known[f] && known[f] !== 'dir' && fs.existsSync(abs) && hashFile(abs) === known[f]) continue;
      lines.push(`?? ${f}`);
    }
    if (lines.length) dirty[name] = lines;
  }
  return dirty;
}

// HEAD, plus a hash of tracked changes when the tree is dirty. Untracked files are never delivered
// (the gate refuses to start with any), so they are not part of it.
export function treeHash(dir) {
  const head = git(dir, ['rev-parse', 'HEAD']);
  const status = git(dir, ['status', '--porcelain', '--untracked-files=no']);
  return status ? `${head}+dirty:${sha256(status + git(dir, ['diff', 'HEAD']))}` : head;
}

export function treeHashes(state) {
  const t = {};
  for (const [name, r] of Object.entries(state.repos)) t[name] = treeHash(r.worktree);
  return t;
}
