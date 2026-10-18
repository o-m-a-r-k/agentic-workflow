import { ledgerEmpty, withEvidenceTransaction, writeNoFollow } from './evidence.mjs';
import { headsNow } from './discovered.mjs';
import { mkdirStateDirectory } from './state-folders.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadConfigAtCommit, adapterLocation, adapterRecord, repoDir, trustedAdapter } from './config.mjs';
import { append, assertSchema, createAttempt, listAttempts, loadState, openEvidence, recordedTogether } from './ledger.mjs';
import { projectEnv } from './env.mjs';
import { loadCatalog, missingFor, provisionUse, redactor, stepEnv } from './secrets.mjs';
import { emitTrackerEvent, hasTicket, itemProblem } from './tracker.mjs';
import { adoptNeedsApproval } from './owner.mjs';
import { requireYes } from './approve.mjs';
import { FRAMES } from './asking.mjs';
import { settleRoundQuestions } from './strategy.mjs';
import { followAdapter } from './adapter-follow.mjs';
import { applyCommits, attemptTargets, ownCommits, parseTargets, portSource, targetsKey } from './targets.mjs';
import { detectOwner, ownerRuntime, ownerString } from './hosts/index.mjs';
import { noteAttempt } from './refusals.mjs';
import { WfError, assertEngine, assertPlainGit, assertSafeId, canonical as canonicalValue, git, hashFile, refuse, run, sha256 } from './util.mjs';

export const worktreesRoot = (root) => path.join(root, '.wf-worktrees');
export const worktreeDir = (root, id, repoName) => path.join(worktreesRoot(root), id, repoName);
export const branchName = (id) => `wf/${id}`;

export function actor(options = {}) {
  if (options.owner) return String(options.owner);
  const s = detectOwner();
  if (s) return ownerString(s.runtime, s.session);
  return `human:${os.userInfo().username}`;
}

const OPEN = (s) => !['done', 'abandoned'].includes(s.phase);

// Named failure: an attempt whose worktree folder was deleted (a cleanup, a moved checkout) crashed `wf status`, `wf status
// --all` and `wf resume` with "git failed to start: spawnSync git ENOENT" for every attempt, because the first git call
// ran with the missing folder as its working directory. A folder without its `.git` entry counts as missing too: git
// would walk up to the project's own repository from inside it and answer for the wrong tree. Decided before any git call.
// Whether an accepted attempt's tree is still the one that was accepted: its heads are unchanged (a commit after the
// acceptance, a repair or a base merge, moves them). An acceptance recorded without heads (before they were recorded)
// stands; a tree that cannot be read is not taken as moved. One answer for the strategist and the lessons (0.7.4).
export function acceptedTreeStands(state) {
  if (!state.accepted) return false;
  if (!state.accepted.heads) return true;
  try {
    return canonicalValue(state.accepted.heads) === canonicalValue(treeHashes(state));
  } catch {
    return true;
  }
}

export const missingWorktrees = (state) => Object.entries(state.repos ?? {}).filter(([, r]) => r.worktree && !fs.existsSync(path.join(r.worktree, '.git'))).map(([repo, r]) => ({ repo, worktree: r.worktree, branch: r.branch ?? branchName(state.id) }));

// --attempt wins; otherwise the attempt whose worktree contains cwd; otherwise the only open attempt. The answer is noted
// for the refusal log (engine/refusals.mjs), so a refusal is counted against the attempt even when none was typed.
export function resolveAttempt(root, options = {}) {
  const id = resolveAttemptId(root, options);
  noteAttempt(root, id);
  return id;
}
function resolveAttemptId(root, options) {
  if (options.attempt) return assertSafeId(options.attempt, 'attempt id');
  const wt = worktreesRoot(root) + path.sep;
  const cwd = fs.realpathSync(process.cwd()) + path.sep;
  const realWt = fs.existsSync(worktreesRoot(root)) ? fs.realpathSync(worktreesRoot(root)) + path.sep : wt;
  if (cwd.startsWith(realWt)) return cwd.slice(realWt.length).split(path.sep)[0];
  // A ledger that cannot be read (emptied, cut, edited) cannot say whether its attempt is open, so it is counted and named
  // (independent review of 0.7.4: one damaged ledger made `wf resume` fail with a raw path for every attempt).
  const open = [];
  const damaged = [];
  for (const id of listAttempts(root)) {
    try {
      if (OPEN(loadState(root, id))) open.push(id);
    } catch {
      damaged.push(id);
    }
  }
  if (open.length === 1 && !damaged.length) return open[0];
  if (!open.length && damaged.length === 1) return damaged[0];
  if (!open.length && !damaged.length) throw new WfError('no open attempt', { hint: 'start one with `wf entry`' });
  throw new WfError(`several open attempts (${[...open, ...damaged.map((id) => `${id} [ledger damaged: \`wf verify --attempt ${id}\`]`)].join(', ')}); pass --attempt <id>`);
}

// The attempt a name stands for: an attempt id, or an item (any case), whose open attempt is meant, else its latest one.
// 0.7.6: `wf resume <item>` ignored the name and showed the one open attempt, of another item, as if it were the one asked for.
export function attemptForName(root, name) {
  const all = listAttempts(root);
  const key = String(name).toLowerCase();
  const exact = all.find((id) => id.toLowerCase() === key);
  if (exact) return exact;
  const damaged = [];
  const states = all.flatMap((id) => {
    try {
      // An emptied ledger reads as a state with no admission (I-78), so it is damaged too.
      if (ledgerEmpty(root, id)) throw new Error('ledger empty');
      return [[id, loadState(root, id)]];
    } catch {
      damaged.push(id);
      return [];
    }
  });
  // A damaged ledger cannot say its item; one named like the item's attempts is named, never passed over for an older one
  // (independent review of 0.7.6).
  const unreadable = damaged.filter((id) => id.toLowerCase().startsWith(`${key}.`));
  if (unreadable.length) throw new WfError(`the ledger of ${unreadable.join(', ')} cannot be read, so which attempt of ${name} is current is not known`, { hint: `\`wf verify --attempt ${unreadable[0]}\` names what happened to it` });
  const mine = states.filter(([, s]) => String(s.item ?? '').toLowerCase() === key);
  if (!mine.length) throw new WfError(`no attempt for ${name}`, { hint: all.length ? `attempts here: ${all.join(', ')}` : 'start one with `wf entry`' });
  const open = mine.filter(([, s]) => OPEN(s)).map(([id]) => id);
  if (open.length > 1) throw new WfError(`several open attempts for ${name} (${open.join(', ')}); pass --attempt <id>`);
  const n = (id) => Number(id.split('.').at(-1)) || 0;
  return open[0] ?? mine.map(([id]) => id).sort((a, b) => n(a) - n(b)).at(-1);
}

export function openState(root, options, { follow = true } = {}) {
  const id = resolveAttempt(root, options);
  openEvidence(root, id);
  const state = loadState(root, id);
  assertSchema(state);
  // 0.7.29 (I-214): a round question an earlier release opened before it was due is withdrawn before anything reads the attempt.
  // 0.7.30 (I-151, D60): the attempt takes the adapter committed on its base branch, where it safely can, before anything reads it
  // (not for `wf hold`, which is recorded first, so the pin cannot move under the person's hold).
  const settled = settleRoundQuestions(root, state);
  return follow ? followAdapter(root, settled) : settled;
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
export function baseRef(dir, repo) {
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
  mkdirStateDirectory(path.dirname(dest), { recursive: true });
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
      mkdirStateDirectory(path.dirname(path.join(dir, rel)), { recursive: true });
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
    // Named failure (I-111): the install ran with the project environment only, so one that needs a private registry's token could
    // never succeed at `wf entry` (it failed and rolled back, every time), while a gate step's `prepare` gets its secrets. A
    // catalogued key that lists `provision:<repo>` in `usedBy` (the way a step lists its id) reaches this repo's install, and
    // nothing else: not another repo's install, not `onWorktreeCreate`, not a key that lists no provisioning. Its output is masked.
    const use = provisionUse(repo.name);
    const catalog = loadCatalog(root);
    const missing = missingFor(root, cfg, use, catalog);
    if (missing.length) throw refuse(`secrets missing for provisioning of ${repo.name}: ${missing.join(', ')}`, 'run `wf secrets guide` in your terminal, then `wf entry` again', { id: 'provision:secrets-missing' });
    const result = run('sh', ['-c', p.install], { cwd: dir, env: projectEnv(cfg, stepEnv(root, cfg, use, catalog)), allowFail: true });
    if (result.status !== 0) throw new WfError(redactor(root, cfg)(`sh -c ${p.install} failed (exit ${result.status}) in ${dir}:\n${(result.stderr || result.stdout).trim()}`));
    report.installed = true;
  }
  if (p.onWorktreeCreate) {
    run(process.execPath, [path.resolve(root, '.workflow', p.onWorktreeCreate), dir], { cwd: dir, env: projectEnv(cfg, { WF_ROOT: root, WF_REPO: repo.name }) });
  }
  return report;
}

export function entry(root, options) {
  // 0.7.30 (I-201): a port is of its source's item (and lane), unless named.
  if (options.port !== undefined && options.port !== true && !options.item) {
    try {
      const src = loadState(root, String(options.port));
      options = { ...options, item: src.item, autoItem: src.autoItem, lane: options.lane ?? (src.lane === 'quick' ? 'quick' : 'standard') };
    } catch {}
  }
  const cfg = loadConfig(root);
  if (!cfg.enabled) throw refuse('the workflow is disabled for this project', 'run `wf enable`');
  assertEngine(cfg);
  const intent = options.intent ?? 'implementation';
  if (!['implementation', 'analysis'].includes(intent)) throw new WfError('--intent must be implementation or analysis');
  const lane = options.lane ?? (options.item ? 'standard' : 'quick');
  if (!cfg.lanes.includes(lane)) throw refuse(`lane \`${lane}\` is not enabled for this project (lanes: ${cfg.lanes.join(', ')})`);
  let item = options.item ? assertSafeId(options.item, 'item') : null;
  if (lane === 'standard' && !item) throw new WfError('standard lane needs --item <ticket id>');
  // An item `wf` numbers itself (a quick fix with no ticket) is recorded as such and kept through reopen and split; any
  // other item is the tracker's ticket and is checked as one (independent review of 0.7.21: guessing from a `QF-` prefix
  // lost a real `QF-7` ticket and refused reopening a numbered fix under the project's id pattern).
  const autoItem = options.autoItem === true || (lane === 'quick' && !item);
  if ((lane === 'standard' || lane === 'quick') && item && !autoItem) {
    const wrong = itemProblem(cfg, item);
    if (wrong) throw refuse(wrong, 'run `wf entry --item <the tracker\'s ticket id>`');
  }
  if (lane === 'quick' && !item) item = `QF-${nextNumber(root, 'QF')}`;
  const owner = actor(options);

  const wanted = options.repos ? String(options.repos).split(',') : cfg.repos.map((r) => r.name);
  for (const name of wanted) if (!cfg.repos.find((r) => r.name === name)) throw new WfError(`unknown repo \`${name}\``);
  // 0.7.30 (I-201, D62): a repo's own target branch, a port of another attempt's change to it, and the targets this attempt is
  // also delivered to (each by a port, admitted by `wf deliver` once this delivery is complete). engine/targets.mjs.
  const source = options.port !== undefined ? portSource(root, options.port, item) : null;
  const targets = Object.fromEntries(Object.entries(parseTargets(options.target, wanted)).filter(([name, branch]) => source || branch !== cfg.repos.find((r) => r.name === name).base));
  const alsoTargets = Object.entries(parseTargets(options['also-target'], wanted, '--also-target')).map(([repo, branch]) => ({ repo, branch, reason: null }));
  if (source && !Object.keys(targets).length) throw refuse('--port needs --target <repo>=<branch>: the branch the change is carried to', null, { id: 'targets:port-no-target' });
  if (source) for (const [name, branch] of Object.entries(targets)) if ((source.repos[name]?.target ?? cfg.repos.find((r) => r.name === name).base) === branch) throw refuse(`--port: ${source.id} is already delivered to ${name} -> ${branch}`, null, { id: 'targets:port-same' });
  if (alsoTargets.length && (options.deferHeavy === true || options.sibling)) throw refuse('--also-target: a batch member is delivered with its batch; port it once the batch is delivered (`wf entry --port <member> --target <repo>=<branch>`)', null, { id: 'targets:batch' });
  // A sibling attempt (`wf split`) works part of the same item beside its parent; a port (another target) beside its source.
  // 0.7.31 (I-216, D67): an analysis beside an open attempt of its item (the premise of a fix traced before the fix round): it
  // changes, delivers and moves nothing, and what it records reaches that attempt's next implementers (engine/analysis.mjs).
  // Review of 0.7.31 (M1): a second analysis beside an open one is refused too (it would be a second record of one investigation).
  if (!options.sibling && intent === 'analysis') {
    for (const id of listAttempts(root)) {
      const s = loadState(root, id);
      if (s.item === item && OPEN(s) && s.intent === 'analysis' && targetsKey(attemptTargets(s)) === targetsKey(targets)) throw refuse(`${item} already has an open analysis ${id} owned by ${s.owner}`, `continue it (record what it finds with \`wf analysis record --attempt ${id}\`), or close it first: \`wf analysis close --attempt ${id} --reason "<what follows>"\``, { id: 'entry:analysis-beside-analysis' });
    }
  }
  if (!options.sibling && intent !== 'analysis') {
    for (const id of listAttempts(root)) {
      const s = loadState(root, id);
      if (s.item === item && OPEN(s) && targetsKey(attemptTargets(s)) === targetsKey(targets)) throw refuse(`${item} already has an open attempt ${id} owned by ${s.owner}`, `continue it, or take it over with \`wf adopt --attempt ${id}\`${s.intent === 'analysis' ? `; ${id} is an analysis: \`wf intent implementation --attempt ${id} --reason "<the person's words>"\` implements it in place, or \`wf analysis close --attempt ${id} --reason "<what follows>"\` once it is recorded` : ''}${Object.keys(targets).length ? '' : '; the same item on another branch is admitted with `--target <repo>=<branch>`'}`);
    }
  }
  const id = assertSafeId(options.id ?? nextAttemptId(root, item), 'attempt id');
  // Validate everything before creating anything: the adapter must be on the base the gate will trust.
  const { repo: adapterRepo } = adapterLocation(root, cfg);
  const bases = {};
  for (const name of new Set([...wanted, adapterRepo.name])) {
    const repo = cfg.repos.find((r) => r.name === name);
    assertPlainGit(repoDir(root, repo));
    const branch = targets[name] ?? repo.base;
    const ref = baseRef(repoDir(root, repo), { ...repo, base: branch });
    const commit = git(repoDir(root, repo), ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
    if (!commit) throw refuse(`branch ${branch} does not exist in ${name}${targets[name] ? ' (its --target)' : ''}`, targets[name] ? `create and push ${branch} in ${name} first, or name an existing branch` : undefined, { id: 'entry:no-branch' });
    bases[name] = { ref, commit };
  }
  const adapterBase = bases[adapterRepo.name].commit;
  // Where the adapter lives, recorded now: every later read of the adapter at base is located from this record only.
  const adapter = adapterRecord(root, cfg);
  let trusted;
  try {
    trusted = loadConfigAtCommit(root, cfg, adapterBase);
  } catch (error) {
    throw refuse(`${error.message.split('\n')[0]}`, `commit .workflow/ on ${adapterRepo.base} in ${adapterRepo.name} and push it to ${adapterRepo.remote}; the gate trusts only the adapter on the base it starts from (${bases[adapterRepo.name].ref})`);
  }
  // The gate judges with the committed adapter, so its pin counts too.
  assertEngine(trusted);
  // Validated with the rest, before anything is created: a missing file left the worktrees behind.
  const src = options['issue-file'] ? path.resolve(String(options['issue-file'])) : null;
  if (src && !fs.existsSync(src)) throw new WfError(`--issue-file not found: ${src}`);
  // Create worktrees; if any step fails, remove what was made so a retry starts clean.
  const repos = {};
  const made = [];
  try {
    for (const name of wanted) {
      const repo = cfg.repos.find((r) => r.name === name);
      const dir = repoDir(root, repo);
      const wt = worktreeDir(root, id, name);
      mkdirStateDirectory(path.dirname(wt), { recursive: true });
      if (git(dir, ['branch', '--list', branchName(id)])) throw refuse(`branch ${branchName(id)} already exists in ${name} from an earlier attempt`, `inspect it, then delete it: git -C ${dir} branch -D ${branchName(id)}`);
      run('git', ['worktree', 'add', '--quiet', '-b', branchName(id), wt, bases[name].commit], { cwd: dir });
      made.push({ dir, wt });
      const provisioned = provision(root, cfg, repo, wt);
      repos[name] = { base: bases[name].commit, baseRef: bases[name].ref, branch: branchName(id), worktree: wt, provisioned, provisionedUntracked: untrackedSnapshot(wt), ...(targets[name] ? { target: targets[name] } : {}) };
    }
  } catch (error) {
    for (const m of made.reverse()) {
      run('git', ['worktree', 'remove', '--force', m.wt], { cwd: m.dir, allowFail: true });
      run('git', ['branch', '-D', branchName(id)], { cwd: m.dir, allowFail: true });
    }
    fs.rmSync(path.join(worktreesRoot(root), id), { recursive: true, force: true });
    throw error;
  }

  // A port carries its source's own commits onto the target; the first that does not apply stops it, aborted and recorded.
  let port = null;
  if (source) {
    port = { of: source.id, repos: {} };
    for (const name of wanted) {
      if (!source.repos[name]) continue;
      const { head, commits } = ownCommits(root, cfg, source, name);
      port.repos[name] = { head, commits, ...applyCommits(repos[name].worktree, commits) };
    }
  }
  const originRuntime = detectOwner()?.runtime ?? ownerRuntime(owner);
  // Named failure (I-109): the copy of the issue file was written into the evidence, and the attempt entered in the ledger, with no
  // transaction around them, and the copy was recorded in the manifest only when the process ended (after the tracker's admission
  // read, which can take a while): a `wf` command another session ran in between listed the attempt and refused it with "extra
  // file (not written by wf)". Copied, admitted and recorded in one transaction: a reader sees none of it or all.
  recordedTogether(root, id, () => {
    let issue = null;
    if (src) {
      const dest = path.join(root, '.wf-evidence', 'attempts', id, 'issue', path.basename(src));
      // Opened first: the copy is then a file this process wrote, recorded in the manifest when it ends (copied before,
      // it was in the opening snapshot unrecorded and refused as an extra file).
      openEvidence(root, id);
      mkdirStateDirectory(path.dirname(dest), { recursive: true });
      writeNoFollow(dest, fs.readFileSync(src), { exclusive: true }); // never through a link planted at the destination
      issue = { file: dest, sha256: hashFile(dest) };
    }
    createAttempt(root, id, { id, item, lane, intent, autoItem, repos, adapterBase, adapter, issue, originRuntime, reopenedFrom: options.reopenedFrom ?? null, deferHeavy: options.deferHeavy === true || options.deferHeavy === 'true', ...(port ? { port } : {}), ...(alsoTargets.length ? { alsoTargets } : {}) }, owner);
    // A port is judged by the criteria its source froze (and its impact map), as a split's sibling is.
    if (source?.criteria) append(root, id, 'criteria.frozen', { criteria: source.criteria, plan: source.plan ?? null, source: { port: source.id }, ...(source.impact ? { impact: { survey: source.impact.survey, impact: source.impact.impact, results: source.impact.results ?? {}, addenda: source.impact.addenda ?? [] } } : {}) }, owner);
  });
  if (hasTicket({ lane, item, autoItem, portOf: port?.of ?? null }) && intent === 'implementation' && !options.sibling) emitTrackerEvent(root, cfg, id, 'admitted');
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
  mkdirStateDirectory(path.dirname(wt), { recursive: true });
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
  const item = options.item === undefined ? null : assertSafeId(options.item, 'ticket id');
  let selected = options;
  if (item && !options.attempt) {
    const matches = listAttempts(root).filter((id) => {
      const s = loadState(root, id);
      return s.item === item && OPEN(s);
    });
    if (matches.length !== 1) throw new WfError(matches.length ? `several open attempts for ${item} (${matches.join(', ')}); pass --attempt <id>` : `no open attempt for ${item}`);
    selected = { ...options, attempt: matches[0] };
  }
  const state = openState(root, selected);
  if (item && state.item !== item) throw refuse(`${state.id} belongs to ${state.item}, not ${item}`);
  if (!OPEN(state)) throw refuse(`${state.id} is closed (${state.phase}); only open attempts can be adopted`);
  const by = actor(options);
  if (state.owner === by) return state;
  // Named failure I-31: recovery required a release from an unavailable previous session, despite a current human request.
  // 0.7.0, named failure: the human-request grammar refused real adoptions (the request was in the chat already). Taking
  // over an attempt whose owner session wrote to its transcript in the last 30 minutes, whose owner is a person's name
  // (no session to measure) or whose transcript cannot be read is the person's decision (`wf approve`, kind adopt-live);
  // taking over a session owner whose transcript is gone or idle is bookkeeping, recorded with the caller as actor. The
  // key carries the number of earlier transfers, so an owner changing back and forth needs a new decision each time.
  const approval = adoptNeedsApproval(state.owner) ? requireYes(root, state, { kind: 'adopt-live', key: `adopt:${state.id}:${state.owner}:${by}:${state.ownerTransfers}`, summary: `adopt ${state.id} as ${by} from ${state.owner}, whose session is active, unreadable or not a session`, what: `adopting ${state.id} from ${state.owner}`, frame: FRAMES.adopt({ item: state.item }), options }) : null;
  append(root, state.id, 'owner.adopted', { from: state.owner, reason: options.reason ?? null, ...(approval ? { decision: approval.decision } : {}) }, by);
  return loadState(root, state.id);
}

// Whether the worktree's HEAD is on the repo's target branch (fetched now).
export function onTarget(r, repo) {
  if (!git(r.worktree, ['remote']).split('\n').includes(repo.remote)) return null;
  run('git', ['fetch', '--quiet', repo.remote, repo.base], { cwd: r.worktree, allowFail: true });
  const head = git(r.worktree, ['rev-parse', 'HEAD']);
  const landed = head !== r.base && run('git', ['merge-base', '--is-ancestor', head, `${repo.remote}/${repo.base}`], { cwd: r.worktree, allowFail: true }).status === 0;
  return landed ? { head, target: `${repo.remote}/${repo.base}` } : null;
}

export function abandon(root, options) {
  const state = openState(root, options);
  if (!options.reason) throw new WfError('--reason is required');
  // Independent review of 0.7.5: an attempt closed (delivered, or closed as shipped) was abandoned on top, its record flipped.
  if (['done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is already ${state.phase}${state.shipped ? ' (closed as shipped)' : ''}; a closed attempt is not abandoned`);
  // Independent review of 0.7.0 (HIGH): abandoning a split member dropped what the split moved into it. It is the person's
  // one-use decision.
  const splitDecision = (state.splitFrom || state.splits?.length) && !['done', 'abandoned'].includes(state.phase) ? requireYes(root, state, { kind: 'move-out-of-batch', key: `abandon-split:${state.id}`, summary: `abandon ${state.id}, which carries or handed work in a split batch`, what: `abandoning ${state.id}`, frame: FRAMES.abandonSplit({ item: state.item, id: state.id }), options }).decision : null;
  // I-22: the refusal names the case. A repo recorded as skipped had no changes, so nothing of it reached a target branch;
  // an attempt whose recorded repos are all skipped is abandoned like one with nothing recorded. A repo recorded as
  // delivered is on its target branch: the attempt is finished, never abandoned.
  const recorded = Object.values(state.delivery.repos);
  // Only the engine's own record of a repo with no changes is a skip (it carries no commit).
  const landed = recorded.filter((d) => !(d.skipped && !d.commit));
  if (landed.length) {
    const list = recorded.map((d) => (d.skipped ? `${d.repo} skipped (${d.skipped}; nothing pushed)` : `${d.repo} delivered (${String(d.commit ?? '').slice(0, 10)} on ${d.target ?? 'its target'})`)).join('; ');
    throw refuse(`${state.id} is partly delivered: ${list}; a delivered repo cannot be taken back, so the attempt is finished, not abandoned`, `\`wf deliver\` delivers the remaining repos; when every change is already on its target branch (merged outside the workflow), \`wf close --shipped --reason "<why>"\` closes it under the owner's decision; after a delivery adapter fault, commit and push the fixed adapter on the base branch: the attempt follows it, and the next \`wf deliver\` delivers the rest (docs/lifecycle.md, "Recovering from an adapter fault")`);
  }
  // Named failure (0.5.0 integration review): abandon looked only at `repo.delivered`. A delivery adapter that had already
  // merged the change (a post-merge state the owner had not acknowledged) or left it awaiting merge records only
  // `repo.integrating`, so the attempt was abandoned and its worktrees removed while its change was on, or could still
  // land on, the target branch, with nothing in the ledger saying so. A change on its target branch always refuses; an
  // integration the adapter last reported as anything but `rejected` refuses until the owner, having closed it where it
  // is integrated, acknowledges that repo and state (`--acknowledge-integration <repo>:<state>`, recorded). Each repo's
  // target branch is the adapter at base's, never the working copy's (0.5.0 adversarial review).
  const cfg = trustedAdapter(root, state);
  // An orphaned attempt (its worktree folder is gone) is abandoned without a git call into the missing folder; the branch stays.
  const gone = new Set(missingWorktrees(state).map((m) => m.repo));
  // A repo whose worktree is gone is asked from its recorded change in its own checkout (I-116: an orphan whose change had been
  // merged by hand was abandoned, the shipped change recorded as given up).
  const goneLanded = gone.size ? new Map(changesOnTarget(root, state, cfg).filter((c) => gone.has(c.repo) && c.landed).map((c) => [c.repo, c])) : new Map();
  const onTargets = [];
  const open = [];
  for (const [name, r] of Object.entries(state.repos)) {
    if (state.delivery.repos[name]) continue;
    const repo = cfg.repos.find((x) => x.name === name);
    const on = repo && r.worktree && !gone.has(name) ? onTarget(r, repo) : goneLanded.has(name) ? { head: goneLanded.get(name).commit, target: goneLanded.get(name).target } : null;
    if (on) onTargets.push(`${name}: ${on.head.slice(0, 10)} is already on ${on.target}`);
    const i = state.delivery.integrating?.[name];
    const st = i ? (i.observed?.state === undefined || i.observed?.state === null || i.observed?.state === '' ? 'none' : String(i.observed.state)) : null;
    if (i && st !== 'rejected' && !on) open.push({ repo: name, state: st, url: typeof i.url === 'string' ? i.url : null });
  }
  if (onTargets.length) throw refuse(`${state.id} is not abandoned: its change is on the target branch (${onTargets.join('; ')}); a change that landed is delivered, closed as shipped (\`wf close --shipped\`, the owner's decision) or reverted in a new attempt, never abandoned`, '`wf deliver` records it (the adapter is asked again); to take it back, revert it in a new attempt (`wf reopen`)');
  const given = typeof options['acknowledge-integration'] === 'string' ? options['acknowledge-integration'].split(',').map((x) => x.trim()).filter(Boolean) : [];
  const unacked = open.filter((o) => !given.includes(`${o.repo}:${o.state}`));
  // 0.7.0: abandoning past an integration the adapter still reports is overriding a check; the person confirms it.
  const decisions = unacked.length ? [] : open.map((o) => requireYes(root, state, { kind: 'override-gate', key: `abandon:${state.id}:${o.repo}:${o.state}`, summary: `abandon ${state.id} with ${o.repo}'s integration (${o.state}) closed where it is integrated`, what: `abandoning ${state.id} with ${o.repo}'s integration (${o.state}) closed`, frame: FRAMES.abandonIntegration({ item: state.item, repo: o.repo }), options }).decision);
  if (unacked.length) throw refuse(`${state.id} is not abandoned: the delivery adapter last reported ${unacked.map((o) => `${o.repo} ${o.state}${o.url ? ` (${o.url})` : ''}`).join('; ')}; that integration can still land on the target branch`, `close it where it is integrated, or let \`wf deliver\` finish it; once it is closed, \`wf abandon --acknowledge-integration ${unacked.map((o) => `${o.repo}:${o.state}`).join(',')} --reason "<why>"\` asks the owner to confirm it with \`wf approve\`, then records it`);
  // 0.7.24 (I-181), named failure (found fixing I-177): an abandoned batch left each member pointing at it, so a member could
  // be neither delivered alone, ejected (the batch's worktree was gone) nor batched again. Abandoning a batch releases its
  // members; members a split put together leave it only on the person's decision, one question for the batch (D1).
  const released = state.lane === 'batch' ? (state.batch?.members ?? []).map((m) => loadState(root, m)).filter((m) => m.batchOf === state.id && !['done', 'abandoned'].includes(m.phase)) : [];
  const splitMembers = released.filter((m) => m.splitFrom || m.splits?.length);
  const releaseDecision = splitMembers.length ? requireYes(root, state, { kind: 'move-out-of-batch', key: `abandon-batch:${state.id}:${sha256(JSON.stringify(Object.fromEntries(Object.entries(state.repos).map(([n, r]) => [n, gone.has(n) || !r.worktree ? null : git(r.worktree, ['rev-parse', 'HEAD'], { allowFail: true }) || null])))).slice(0, 16)}`, summary: `abandon ${state.id}; ${splitMembers.map((m) => m.id).join(', ')} came from or made a split and would leave the batch that ships them together`, what: `abandoning ${state.id}`, frame: FRAMES.abandonBatch({ batch: state.id, members: released.map((m) => m.id) }), options }).decision : null;
  for (const m of released) {
    withEvidenceTransaction(root, m.id, () => {
      append(root, m.id, 'batch.ejected', { batch: state.id, reason: `${state.id} was abandoned: ${String(options.reason)}`, ...(releaseDecision && splitMembers.includes(m) ? { decision: releaseDecision } : {}) }, actor(options));
      // What the member moved into the batch to be fixed there (0.7.23, I-177) comes back to it, still open, so its delivery
      // waits for it again (independent review of 0.7.24: the abandon dropped it, and the member delivered without the fix).
      // One the batch already fixed comes back too: its fix is only on the abandoned batch's branch, never in the member
      // (independent review of 0.7.24).
      for (const d of (state.discovered ?? []).filter((x) => ['open', 'fixed'].includes(x.status) && x.movedFrom?.attempt === m.id)) {
        const ms = loadState(root, m.id);
        const fixedThere = d.status === 'fixed' ? ` (fixed only in the abandoned ${state.id}, ${d.fixed?.repo ?? ''}@${String(d.fixed?.commit ?? '').slice(0, 10)}, which this change does not contain)` : '';
        append(root, m.id, 'discovered.added', { id: `D${(ms.discovered ?? []).length + 1}`, summary: `moved back from ${state.id} ${d.id}, abandoned: ${String(d.summary ?? '').replace(/^moved from \S+ \S+: /, '')}${fixedThere}`, kind: d.kind ?? 'defect', severity: d.severity ?? null, ...(d.invariant ? { invariant: d.invariant } : {}), where: d.where ?? null, foundBy: d.foundBy ?? null, blockedBy: null, movedFrom: { attempt: state.id, ref: d.id }, raisedOn: headsNow(ms) }, actor(options));
      }
    });
  }
  append(root, state.id, 'abandoned', { reason: String(options.reason), ...(splitDecision ? { decision: splitDecision } : {}), ...(released.length ? { released: released.map((m) => m.id) } : {}), ...(recorded.length ? { skipped: recorded.map((d) => d.repo) } : {}), ...(open.length ? { integrationsClosed: open.map((o) => `${o.repo}:${o.state}`), decisions } : {}) }, actor(options));
  cleanupWorktrees(root, loadState(root, state.id));
  return loadState(root, state.id);
}

// Named failure: an analysis attempt is read-only (only a planner handoff is allowed) and its intent could not change, so
// "the investigation is done, now implement it" meant abandoning the attempt and admitting a new one: 8 of 16 abandoned
// attempts were exactly that, and each threw away the plan, the criteria and the tracker state. The intent is upgraded in
// place and recorded (`intent.changed`); the tracker's admission step, which an analysis attempt skips, is queued as an
// implementation attempt's is. An implementation attempt never goes back to analysis.
export function setIntent(root, options, to) {
  if (to !== 'implementation') throw new WfError('usage: wf intent implementation --attempt ID --reason "why"', { hint: 'only an analysis attempt is upgraded, to implementation; an implementation attempt does not go back' });
  const state = openState(root, options);
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
  if (!OPEN(state)) throw refuse(`${state.id} is ${state.phase}; its intent is final`, 'admit a new attempt with `wf entry` (or `wf reopen` for a delivered item)', { id: 'intent:closed' });
  if (state.intent === 'implementation') return { state, changed: false };
  if (!reason) throw new WfError('--reason "why this analysis is now to be implemented" is required');
  // Review of 0.7.31 (M1). Named failure (a review's repro): an analysis admitted beside an open attempt of its item (D67) and then
  // upgraded made two open implementations of one item, the second with its tracker admission pending; `wf entry` refuses that
  // and the upgrade did not check it. An analysis beside an open attempt is closed once recorded, and what it found reaches that one.
  const beside = listAttempts(root).filter((id) => id !== state.id).map((id) => loadState(root, id)).find((s) => s.item === state.item && OPEN(s) && targetsKey(attemptTargets(s)) === targetsKey(attemptTargets(state)));
  if (beside) throw refuse(`${state.item} already has an open attempt ${beside.id} owned by ${beside.owner}: upgrading ${state.id} would make a second implementation of it`, `record what ${state.id} found (\`wf analysis record --attempt ${state.id}\`) and close it (\`wf analysis close --attempt ${state.id} --reason "<what follows>"\`): ${beside.id}'s next planner and implementers are given it${beside.intent === 'analysis' ? `; ${beside.id} is an analysis too: close one of them first` : ''}`, { id: 'intent:open-beside' });
  append(root, state.id, 'intent.changed', { from: state.intent, to, reason }, actor(options));
  if (hasTicket(state)) emitTrackerEvent(root, loadConfig(root), state.id, 'admitted');
  return { state: loadState(root, state.id), changed: true };
}

export function hold(root, options) {
  const state = openState(root, options, { follow: false });
  if (!options.reason) throw new WfError('--reason is required');
  // A hold vetoes a delivery; a closed attempt has none left to veto (independent review of 0.7.5).
  if (['done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is already ${state.phase}; a hold applies to an open attempt`);
  append(root, state.id, 'hold', { reason: String(options.reason) }, actor(options));
  return loadState(root, state.id);
}

export function release(root, options) {
  const state = openState(root, options);
  if (!state.activeHold) throw refuse(`${state.id} has no active hold`);
  // A hold is the owner's veto; only the person lifts it (0.5.0 second review: any agent could release it). 0.7.0: with
  // `wf approve` (kind lift-hold) instead of the owner's words read from a transcript.
  const approval = requireYes(root, state, { kind: 'lift-hold', key: `release:${state.id}:${state.activeHold.at ?? ''}`, summary: `lift the hold on ${state.id}: ${state.activeHold.reason}`, what: `lifting the hold on ${state.id}`, frame: FRAMES.liftHold({ item: state.item, reason: state.activeHold.reason }), options });
  append(root, state.id, 'release', { decision: approval.decision }, actor(options));
  return loadState(root, state.id);
}

// `wf close --shipped`: an attempt whose change reached its target branches outside the workflow (a repo delivered and the
// others merged by hand, or all of them), closed as shipped without the workflow's acceptance (I-116). Named failure: such an
// attempt could be neither abandoned (a delivered repo is never taken back) nor delivered (no acceptance), so it stayed
// ORPHANED in every listing after the person had decided to close it as it shipped.
//
// The engine checks the fact, the person makes the decision. Each repo's change is its delivered commit, else the head the
// last gate ran on, else the accepted head, else its worktree's HEAD; a repo whose change is its base changed nothing. Every
// other change must be on its repo's remote target branch (fetched now, in the repo's own checkout, so a missing worktree
// does not matter). Closing without the acceptance is the person's (override-gate), one decision that also covers a hold;
// what was still open (discovered issues, the last review's findings) is recorded with it. The tracker is not touched.
// Each repo's change and whether it is on its remote target branch, asked of the repo's own checkout (a missing worktree does
// not matter). The change is the attempt's own tip: its worktree's HEAD (refused while the worktree holds uncommitted work),
// else its branch's tip in the repo's checkout, and only when the branch is gone too the commit the workflow last recorded
// (the delivered commit, else the head of the last gate that passed, else the accepted head), named as such (`source`).
// Independent review of 0.7.5 (high): the last gate's head stood for the change, so commits made after the gate, and
// uncommitted work, were closed as shipped (and the work removed with the worktree).
// Returns { repo, commit, target, source, unchanged, landed, known, fetched } or { repo, problem }.
export function changesOnTarget(root, state, cfg = trustedAdapter(root, state)) {
  const lastPassed = (state.gates ?? []).filter((g) => g.tree && g.status === 'passed').at(-1);
  return Object.entries(state.repos).map(([name, r]) => {
    const repo = cfg.repos.find((x) => x.name === name);
    if (!repo) return { repo: name, problem: 'not a repo of the adapter this attempt was admitted under' };
    const dir = repoDir(root, repo);
    const branch = r.branch ?? branchName(state.id);
    let head = null;
    let source = null;
    if (r.worktree && fs.existsSync(path.join(r.worktree, '.git'))) {
      if (git(r.worktree, ['status', '--porcelain'])) return { repo: name, problem: `its worktree has uncommitted work (${r.worktree}); commit or discard it first` };
      head = git(r.worktree, ['rev-parse', 'HEAD']);
      source = 'worktree';
    } else {
      const tip = run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { cwd: dir, allowFail: true });
      if (tip.status === 0 && tip.stdout.trim()) {
        head = tip.stdout.trim();
        source = `branch ${branch}`;
      } else {
        const recorded = [[state.delivery.repos[name]?.commit, 'its delivered commit'], [lastPassed?.tree?.[name], 'the head of its last passed gate'], [state.accepted?.heads?.[name], 'its accepted head']].find(([c]) => typeof c === 'string' && c);
        if (recorded && /\+dirty/.test(recorded[0])) return { repo: name, problem: `${recorded[1]} was recorded with uncommitted changes, so no commit stands for the change` };
        if (recorded) {
          head = recorded[0];
          source = `${recorded[1]} (its worktree and branch are gone)`;
        }
      }
    }
    if (!head || !/^[0-9a-f]{40}$/.test(head)) return { repo: name, problem: 'no change to check: no worktree, no branch and nothing recorded' };
    const target = `${repo.remote ?? 'origin'}/${repo.base}`;
    if (head === r.base) return { repo: name, commit: head, target, source, unchanged: true, landed: false, known: true, fetched: true };
    const fetch = run('git', ['fetch', '--quiet', repo.remote ?? 'origin', repo.base], { cwd: dir, allowFail: true });
    const known = run('git', ['cat-file', '-e', `${head}^{commit}`], { cwd: dir, allowFail: true }).status === 0;
    const landed = known && run('git', ['merge-base', '--is-ancestor', head, target], { cwd: dir, allowFail: true }).status === 0;
    return { repo: name, commit: head, target, source, unchanged: false, landed, known, fetched: fetch.status === 0, fetchError: fetch.status === 0 ? null : String(fetch.stderr ?? '').trim().split('\n')[0] };
  });
}

export function closeShipped(root, options) {
  const state = openState(root, options);
  if (!options.reason || options.reason === true) throw new WfError('--reason is required: why the attempt is closed as it shipped');
  if (['done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is already ${state.phase}`);
  const heads = {};
  const problems = [];
  for (const c of changesOnTarget(root, state)) {
    if (c.problem) problems.push(`${c.repo}: ${c.problem}`);
    else if (c.unchanged) heads[c.repo] = { commit: c.commit, target: c.target, source: c.source, unchanged: true };
    // A positive "it shipped" is never asserted from a remote ref that could not be refreshed (independent review of 0.7.5).
    else if (!c.fetched) problems.push(`${c.repo}: ${c.target} could not be fetched (${c.fetchError || 'no answer'}), so whether ${c.commit.slice(0, 10)} is on it is not known now`);
    else if (!c.landed) problems.push(`${c.repo}: ${c.commit.slice(0, 10)} (${c.source}) is ${c.known ? 'not' : 'not known, so not shown to be'} on ${c.target}`);
    else heads[c.repo] = { commit: c.commit, target: c.target, source: c.source };
  }
  if (!problems.length && !Object.values(heads).some((h) => !h.unchanged)) throw refuse(`${state.id} is not closed as shipped: no repo of it changed anything, so nothing shipped`, '`wf abandon --reason "<why>"` closes an attempt that changed nothing', { id: 'close:nothing-shipped' });
  if (problems.length) throw refuse(`${state.id} is not closed as shipped: ${problems.join('; ')}`, 'a change that is not on its target branch is delivered (`wf deliver`) or abandoned; only an attempt whose every change has landed is closed as shipped', { id: 'close:not-shipped' });
  const list = Object.entries(heads).map(([n, h]) => (h.unchanged ? `${n} unchanged` : `${n} ${h.commit.slice(0, 10)} (${h.source}) on ${h.target}`)).join('; ');
  const decision = requireYes(root, state, { kind: 'override-gate', key: `close-shipped:${state.id}:${sha256(JSON.stringify(heads)).slice(0, 16)}`, summary: `close ${state.id} as shipped without its acceptance (${list})${state.activeHold ? `, over its hold "${state.activeHold.reason}"` : ''}`, what: `closing ${state.id} as shipped`, frame: FRAMES.closeShipped({ item: state.item, hold: state.activeHold?.reason ?? null }), options }).decision;
  const lastReview = (state.reviews ?? []).at(-1);
  const open = {
    discovered: (state.discovered ?? []).filter((d) => d.status === 'open').map((d) => ({ id: d.id, severity: d.severity ?? null, summary: String(d.summary ?? '').slice(0, 300) })),
    lastReview: lastReview ? (lastReview.closure?.findings ?? []).map((f) => ({ id: f.id, severity: f.severity ?? null, summary: String(f.summary ?? f.title ?? '').slice(0, 300) })) : [],
  };
  append(root, state.id, 'shipped.closed', { reason: String(options.reason), decision, repos: heads, open, ...(state.activeHold ? { hold: state.activeHold.reason } : {}) }, actor(options));
  cleanupWorktrees(root, loadState(root, state.id));
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
    } else {
      // The folder is gone (an orphaned attempt): drop git's registration of it from the repo's own checkout so the branch
      // can be reused or deleted later; the branch itself is kept.
      run('git', ['worktree', 'prune'], { cwd: dir, allowFail: true });
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

// 0.7.32 (D72, review of 0.7.32). Named failure (review repro): a commit of an accepted attempt pushed to its target outside the
// workflow is on the fetched base, so every diff against that base read empty: the gate skipped each step ("no changes in this
// repo") and recorded a pass, the reviewer was handed the pushed file as another change's (`baseMerged`), and the commit was
// accepted and recorded delivered untested and unattributed. Such a repo (accepted, not recorded for the delivery, its HEAD past
// the accepted commit and descending from it, and on the fetched base) is read against the last base the attempt recorded: the
// latest one `wf base merge` brought in, else its admission base. A worktree reset to the current base no longer holds the
// accepted commit, so it is not one (review of 0.7.32: it was read as pushed).
export function pushedRepo(state, name) {
  const r = state.repos?.[name];
  const accepted = state.accepted?.heads?.[name];
  if (!r?.worktree || !r.baseRef || !accepted || state.delivery?.completedAt || state.delivery?.repos?.[name] || state.delivery?.integrating?.[name]) return false;
  const head = git(r.worktree, ['rev-parse', 'HEAD'], { allowFail: true });
  if (!head || head === String(accepted).split('+')[0] || head === r.base) return false;
  const ancestor = (a, b) => run('git', ['merge-base', '--is-ancestor', a, b], { cwd: r.worktree, allowFail: true }).status === 0;
  return ancestor(String(accepted).split('+')[0], 'HEAD') && ancestor('HEAD', r.baseRef);
}
// What the attempt's own change in a repo is read against: its base ref, or for a pushed repo (above) the last base it recorded.
export function changeBase(state, name) {
  const r = state.repos[name];
  if (!pushedRepo(state, name)) return r.baseRef ?? r.base;
  return (state.baseMerges ?? []).filter((m) => m.repo === name && m.to).at(-1)?.to ?? r.base;
}

export function changedFiles(state, name) {
  const r = state.repos[name];
  const out = git(r.worktree, ['diff', '--name-only', `${changeBase(state, name)}...HEAD`]);
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
