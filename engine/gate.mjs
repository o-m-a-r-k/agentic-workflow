import { gateAdapter, validationCommit, validationDigest, validationIds, validationCatalog } from './validation.mjs';
import { mkdirStateDirectory } from './state-folders.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { adapterFileAtCommit, attemptAdapter, expandArtifactGlob, loadConfig, repoDir, trustedAdapter } from './config.mjs';
import { changedFiles, treeHash, treeHashes, uncommitted, untrackedSnapshot } from './attempt.mjs';
import { chooseShards, chooseWorkers } from './machine.mjs';
import { readJUnitFiles, readPlaywrightSuites } from './junit.mjs';
import { stepFailures } from './failures.mjs';
import { append, attemptDir, loadState } from './ledger.mjs';
import { projectEnv } from './env.mjs';
import { obligationSince } from './versions.mjs';
import { missingFor, redactor, stepEnv } from './secrets.mjs';
import { impact, inside, rel } from './topology.mjs';
import { canonical as canonicalPath } from './paths.mjs';
import { WfError, assertEngine, canonical, git, globToRegExp, hashFile, hashValue, isPidAlive, matchesAny, now, refuse, run, sha256, shellQuote, writeImmutable, writeJson } from './util.mjs';
import { appendStreamNoFollow, ownGateRun, prepareWrite, readRegular, seal, writeNoFollow } from './evidence.mjs';

const gateDir = (root, id) => path.join(attemptDir(root, id), 'gate');
const lockFile = (root, id) => path.join(gateDir(root, id), 'gate.lock');
const progressFile = (root, id, runId) => path.join(gateDir(root, id), runId, 'progress.json');
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'Pods', '.wf-worktrees', '.wf-evidence']);

function stepPackage(cfg, state, step) {
  const repo = cfg.repos.find((r) => r.name === step.repo);
  const pkg = step.package ? repo.packages.find((p) => p.name === step.package || p.path === step.package) : repo.packages[0];
  if (!pkg) throw new WfError(`step \`${step.id}\`: unknown package \`${step.package}\` in repo \`${repo.name}\``);
  return { repo, pkg, dir: path.join(state.repos[repo.name].worktree, pkg.path) };
}

function trackedFiles(worktree) {
  const out = git(worktree, ['ls-files', '-z']);
  return out ? out.split('\0').filter(Boolean) : [];
}

// Every tracked file under the package matching the step's inputs or the package's sharedInfra, with its content hash.
function stepInputs(state, step, repo, pkg) {
  if (!step.inputs?.length) return null;
  const wt = state.repos[repo.name].worktree;
  const fileHashes = {};
  for (const f of trackedFiles(wt).filter((x) => inside(x, pkg.path)).sort()) {
    const r = rel(f, pkg.path);
    if (!matchesAny(r, step.inputs) && !matchesAny(r, pkg.sharedInfra)) continue;
    const abs = path.join(wt, f);
    fileHashes[f] = fs.existsSync(abs) ? hashFile(abs) : 'deleted';
  }
  return { hash: hashValue(fileHashes), fileHashes };
}

// Identity of what runs the step: its definition (minus worker counts) and the committed plugin code.
function runnerIdentity(root, live, state, step) {
  const { workers, shards, ...definition } = step;
  const pluginHash = step.plugin ? hashFile(adapterFileAtCommit(root, state, validationCommit(state, step.id), step.plugin)) : null;
  return hashValue({ definition, pluginHash });
}

// Trees of the other repos a step reads (`alsoInputs`): the attempt's worktree when the repo is part of the
// attempt, else its main checkout. A tree that cannot be read is null, and the step then always runs.
function alsoInputTrees(root, cfg, state, step) {
  if (!step.alsoInputs?.length) return { trees: null, unreadable: [] };
  const trees = {};
  const unreadable = [];
  for (const name of step.alsoInputs) {
    const repo = cfg.repos.find((r) => r.name === name);
    try {
      trees[name] = treeHash(state.repos[name]?.worktree ?? repoDir(root, repo));
    } catch {
      unreadable.push(name);
    }
  }
  return { trees, unreadable };
}

// `wf check` runs record their steps under the same keys, so a full gate reuses what a check already proved.
const allGateSteps = (state) => [...state.gates, ...(state.checks ?? [])].sort((a, b) => String(a.at).localeCompare(String(b.at))).flatMap((g) => g.steps ?? []);

function findReuse(state, stepId, key) {
  if (!key) return null;
  return allGateSteps(state).filter((s) => s.id === stepId && s.key === key && ['passed', 'reused'].includes(s.status)).at(-1) ?? null;
}

// Selection is computed from the adapter committed at the attempt's base, never the worktree copy.
export async function planGate(root, state, options = {}) {
  const live = loadConfig(root);
  const cfg = gateAdapter(root, state);
  const changed = {};
  for (const name of Object.keys(state.repos)) changed[name] = changedFiles(state, name);
  const { repo: adapterRepo, relative } = attemptAdapter(root, state);
  const adapterRel = relative.split(path.sep).join('/');
  const adapterTouched = (changed[adapterRepo.name] ?? []).some((f) => inside(f, adapterRel));
  const full = adapterTouched || options.full === true;
  const imp = impact(cfg, changed);
  const allChanged = Object.values(changed).flat();
  let focused = false;
  if (options.focused) {
    const eligible = cfg.focused.length && allChanged.length && Object.entries(changed).every(([r, files]) => files.every((f) => matchesAny(f, cfg.focused) || matchesAny(`${r}:${f}`, cfg.focused)));
    if (!eligible) throw refuse("focused proof refused: not every changed file is in the adapter's `focused` paths");
    focused = !full;
  }
  const pkgOfStep = (st) => {
    const r = cfg.repos.find((x) => x.name === st.repo);
    return st.package ? r.packages.find((p) => p.name === st.package || p.path === st.package) : r.packages[0];
  };
  // A changed file that no step's `inputs` cover would let a stale result be reused: such a change forces
  // every step of its package to run, and a file no step checks at all is listed as unchecked.
  const uncovered = {};
  const unchecked = [];
  for (const [repoName, files] of Object.entries(changed)) {
    const repoCfg = cfg.repos.find((r) => r.name === repoName);
    for (const f of files) {
      const pkg = [...repoCfg.packages].filter((p) => inside(f, p.path)).sort((a, b) => b.path.length - a.path.length)[0];
      if (!pkg || matchesAny(rel(f, pkg.path), pkg.docsOnly)) continue;
      const stepsHere = cfg.gate.steps.filter((st) => st.repo === repoName && pkgOfStep(st) === pkg);
      if (!stepsHere.length) {
        unchecked.push(`${repoName}:${f}`);
        continue;
      }
      if (stepsHere.some((st) => !st.inputs?.length || matchesAny(rel(f, pkg.path), st.inputs))) continue;
      (uncovered[`${repoName}|${pkg.path}`] ??= []).push(f);
    }
  }
  const steps = [];
  for (const step of cfg.gate.steps) {
    const entry = { id: step.id, repo: step.repo, package: step.package ?? null, tier: step.tier ?? 'light' };
    if (!state.repos[step.repo]) {
      steps.push({ ...entry, decision: 'skip', reason: `repo ${step.repo} is not part of this attempt` });
      continue;
    }
    const { repo, pkg, dir } = stepPackage(cfg, state, step);
    const pkgChanged = (changed[repo.name] ?? []).filter((f) => inside(f, pkg.path));
    // Shared infrastructure (lockfiles, manifests, build config) can change what any step means: no skipping.
    const infraChanged = pkgChanged.some((f) => matchesAny(rel(f, pkg.path), pkg.sharedInfra)) || (changed[repo.name] ?? []).some((f) => matchesAny(f, repo.sharedInfra ?? []));
    const notCovered = uncovered[`${repo.name}|${pkg.path}`] ?? [];
    const component = cfg.components.find((c) => c.repo === repo.name && (c.package ?? '.') === pkg.path) ?? (step.component ? cfg.components.find((c) => c.id === step.component) : null);
    const isDependent = Boolean(component && imp.dependents.includes(component.id));
    const mustRun = validationIds(state).includes(step.id) || full || infraChanged || isDependent || notCovered.length > 0;
    // A change in a repo the step also reads keeps it from being skipped; reuse then depends on that repo's tree.
    const alsoChanged = (step.alsoInputs ?? []).flatMap((name) => {
      const other = cfg.repos.find((r) => r.name === name);
      return (changed[name] ?? []).filter((f) => {
        const p = [...other.packages].filter((x) => inside(f, x.path)).sort((a, b) => b.path.length - a.path.length)[0];
        return !p || !matchesAny(rel(f, p.path), p.docsOnly);
      }).map((f) => `${name}:${f}`);
    });
    if (!mustRun && !alsoChanged.length && !(changed[repo.name] ?? []).length) {
      steps.push({ ...entry, decision: 'skip', reason: 'no changes in this repo' });
      continue;
    }
    if (!mustRun && !alsoChanged.length) {
      if (step.when?.paths && !pkgChanged.some((f) => matchesAny(rel(f, pkg.path), step.when.paths))) {
        steps.push({ ...entry, decision: 'skip', reason: 'no change matches `when.paths`' });
        continue;
      }
      if (pkgChanged.length && pkgChanged.every((f) => matchesAny(rel(f, pkg.path), pkg.docsOnly))) {
        steps.push({ ...entry, decision: 'skip', reason: 'only docs changed in this package' });
        continue;
      }
    }
    if (!full && focused && entry.tier === 'heavy') {
      steps.push({ ...entry, decision: 'skip', skippedBy: 'focused', reason: 'focused proof runs light steps only' });
      continue;
    }
    if (options.check && (entry.tier === 'heavy' || (options.repos && !options.repos.includes(step.repo)))) {
      steps.push({ ...entry, decision: 'skip', skippedBy: 'check', reason: entry.tier === 'heavy' ? '`wf check` runs light steps only' : 'not one of the repos checked' });
      continue;
    }
    if (!full && state.deferHeavy && entry.tier === 'heavy' && step.deferrable !== false) {
      steps.push({ ...entry, decision: 'defer', reason: 'batch member: heavy steps run in the batch gate' });
      continue;
    }
    chooseWorkers(step);
    chooseShards(step);
    const inputs = stepInputs(state, step, repo, pkg);
    const runner = runnerIdentity(root, live, state, step);
    const also = alsoInputTrees(root, cfg, state, step);
    const key = !inputs || also.unreadable.length ? null : hashValue(also.trees ? { inputs: inputs.hash, runner, also: also.trees } : { inputs: inputs.hash, runner });
    let prior = findReuse(state, step.id, key);
    let outside = [];
    if (prior) {
      // Since the commit the passing run saw, did anything change in this package that the step's inputs don't
      // cover (and the step doesn't explicitly ignore)? Then the pass says nothing about the current code.
      const ranOn = [...state.gates, ...(state.checks ?? [])].find((g) => g.runId === prior.runId)?.tree?.[repo.name];
      const head = ranOn && /^[0-9a-f]{40}$/.test(ranOn) ? ranOn : null;
      const since = head ? git(state.repos[repo.name].worktree, ['diff', '--name-only', head, 'HEAD']).split('\n').filter(Boolean) : pkgChanged;
      outside = since.filter((f) => inside(f, pkg.path) && !matchesAny(rel(f, pkg.path), pkg.docsOnly) && !matchesAny(rel(f, pkg.path), step.inputs ?? ['**']) && !matchesAny(rel(f, pkg.path), step.ignores ?? []));
      if (outside.length || !head) prior = null;
    }
    if (options.rerunFailed && !prior && !options.rerunFailed.includes(step.id)) {
      steps.push({ ...entry, decision: 'skip', skippedBy: 'rerun-failed', reason: '--rerun-failed reruns only the steps that failed last time' });
      continue;
    }
    steps.push({
      ...entry,
      dir,
      key,
      inputsHash: inputs?.hash ?? null,
      fileHashes: step.select ? inputs?.fileHashes ?? null : undefined,
      runnerIdentity: runner,
      alsoInputs: also.trees ?? undefined,
      decision: prior ? 'reuse' : 'run',
      reason: prior ? `same inputs and runner as ${prior.runId}` : outside.length ? `changed file(s) outside this step's inputs since its last pass: ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? '…' : ''}` : notCovered.length ? `changed file(s) outside every step's inputs: ${notCovered.slice(0, 3).join(', ')}${notCovered.length > 3 ? '…' : ''}` : also.unreadable.length ? `cannot read the tree of ${also.unreadable.join(', ')} (alsoInputs): always runs` : key ? (isDependent ? 'dependent of a changed contract' : infraChanged ? 'shared infrastructure changed' : also.trees ? 'inputs or a repo in alsoInputs changed, or never passed' : 'inputs changed or never passed') : 'no `inputs` declared: always runs',
      reusedFrom: prior?.runId ?? null,
      missingSecrets: missingFor(root, cfg, step.id, validationCatalog(root, state, step.id)),
    });
  }
  return { cfg, live, changed, impact: imp, full, adapterTouched, focused, check: Boolean(options.check), repos: options.check && options.repos ? [...options.repos] : null, rerunFailed: options.rerunFailed ?? null, steps, unchecked, tree: treeHashes(state) };
}

function substitute(text, vars, quote = false) {
  return text.replace(/\{(\w+)\}/g, (m, k) => {
    if (vars[k] === undefined) return m;
    if (!quote || ['select', 'workers', 'shards', 'shard'].includes(k)) return String(vars[k]);
    return shellQuote(vars[k]);
  });
}

// Output is redacted on a rolling window so a secret split across two chunks is still masked.
function spawnStep(command, { cwd, env, logFile, redact, onSpawn }) {
  return new Promise((resolve) => {
    const out = appendStreamNoFollow(logFile);
    const keep = Math.max(0, (redact.maxLen ?? 0) - 1);
    let pending = '';
    const write = (b) => {
      pending += b.toString('utf8');
      const masked = redact(pending);
      if (masked.length > keep) {
        out.write(masked.slice(0, masked.length - keep));
        pending = masked.slice(masked.length - keep);
      } else pending = masked;
    };
    let child;
    try {
      child = spawn('sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      out.end(`failed to start: ${error.message}\n`, () => resolve({ code: 127, signal: null }));
      return;
    }
    onSpawn?.(child.pid);
    child.stdout.on('data', write);
    child.stderr.on('data', write);
    let done = false;
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      out.end(redact(pending), () => resolve({ code, signal }));
    };
    child.on('error', (error) => {
      pending += `failed to start: ${error.message}\n`;
      finish(127, null);
    });
    // A background process can keep the pipes open after the step exits; do not wait for it.
    child.on('exit', (code, signal) => {
      const t = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, 2000);
      child.on('close', () => {
        clearTimeout(t);
        finish(code, signal);
      });
    });
  });
}

function walkFiles(dir) {
  const out = [];
  const visit = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(path.join(d, e.name));
      } else if (e.isFile()) out.push(path.join(d, e.name));
    }
  };
  visit(dir);
  return out;
}

// Files matching a glob. Walks from the deepest directory before the first wildcard; matches absolute paths.
export function globFiles(baseDir, pattern) {
  const abs = path.isAbsolute(pattern) ? pattern : path.join(baseDir, pattern);
  if (!/[*?{]/.test(abs)) return fs.existsSync(abs) ? [abs] : [];
  const parts = abs.split('/');
  const firstWild = parts.findIndex((p) => /[*?{]/.test(p));
  const start = parts.slice(0, firstWild).join('/') || '/';
  const re = globToRegExp(abs);
  return walkFiles(start).filter((f) => re.test(f));
}

// Whose evidence a gate collects: the attempt itself, and for a batch every member (their heavy steps run here).
export function artifactUnits(root, state) {
  const units = [{ item: state.item ?? state.id, attempt: state.id }];
  for (const m of state.batch?.members ?? []) {
    const ms = loadState(root, m);
    units.push({ item: ms.item ?? ms.id, attempt: ms.id });
  }
  return units;
}

// Files this run produced under the step's `artifacts` globs, placeholders expanded for this attempt. Each glob records
// what it matched, so the reviewer is told exactly what to inspect; a file outside every expanded glob is not collected.
function collectArtifacts(step, dir, destDir, since, units) {
  const out = [];
  if (!step.artifacts?.length) return { artifacts: out, artifactGlobs: undefined };
  const globs = step.artifacts.map((glob) => ({ glob, expanded: expandArtifactGlob(glob, units), files: [] }));
  for (const file of walkFiles(dir)) {
    const r = path.relative(dir, file).split(path.sep).join('/');
    const hit = globs.filter((g) => matchesAny(r, g.expanded));
    if (!hit.length) continue;
    if (fs.statSync(file).mtimeMs < since - 1000) continue; // only what this run produced
    const dest = path.join(destDir, r);
    prepareWrite(dest);
    mkdirStateDirectory(path.dirname(dest), { recursive: true });
    // Read once, never through a link: the file recorded is the bytes hashed (a capture rewritten, or swapped for a link
    // to a file outside the worktree, meanwhile cannot slip in another).
    const read = readRegular(file);
    if (!read) continue;
    const bytes = read.bytes;
    writeNoFollow(dest, bytes);
    // Whose evidence the file is: the units whose own expansion of a matching glob matches it. A batch member delivers
    // (and attaches to its ticket) only its own files; a placeholder-less glob matches for every unit.
    const owners = units.filter((u) => hit.some((g) => matchesAny(r, expandArtifactGlob(g.glob, [u])))).map((u) => u.attempt);
    const a = { path: dest, sha256: sha256(bytes), kind: /\.(png|jpe?g|webp|gif)$/i.test(r) ? 'screenshot' : 'file', source: r, units: owners };
    out.push(a);
    for (const g of hit) g.files.push(a);
  }
  return { artifacts: out, artifactGlobs: globs };
}

// Suite-level reuse is allowed only when nothing but the suite files themselves changed since the prior run.
function priorFileHashes(prior) {
  if (prior?.fileHashes) return prior.fileHashes;
  const ref = prior?.fileHashesRef;
  if (!ref?.path || !fs.existsSync(ref.path) || hashFile(ref.path) !== ref.sha256) return null;
  return JSON.parse(fs.readFileSync(ref.path, 'utf8'));
}

function suitesToRerun(prior, planned) {
  const priorHashes = priorFileHashes(prior);
  if (!prior?.suites?.length || !priorHashes || !planned.fileHashes) return null;
  prior = { ...prior, fileHashes: priorHashes };
  const files = Object.keys(planned.fileHashes);
  const fileOf = (suite) => (suite.file ? files.find((f) => f === suite.file || f.endsWith(`/${suite.file}`) || suite.file.endsWith(`/${f}`)) : null);
  const suiteFiles = new Set(prior.suites.map(fileOf).filter(Boolean));
  const nonSuite = (hashes) => hashValue(Object.fromEntries(Object.entries(hashes).filter(([f]) => !suiteFiles.has(f))));
  if (nonSuite(prior.fileHashes) !== nonSuite(planned.fileHashes)) return null;
  const rerun = [];
  for (const s of prior.suites) {
    const f = fileOf(s);
    if (!f || s.status !== 'passed' || prior.fileHashes[f] !== planned.fileHashes[f]) rerun.push(s.file ?? s.id);
  }
  return rerun.length ? [...new Set(rerun)] : null;
}

// A step's scratch folder, copied into its evidence folder: regular files only (a link is skipped), each read once.
// Into the step's own `out/` folder, so a scratch file can never take the name of an engine file (its log, its
// artifacts); each file opened without following a link (a link swapped in is skipped), read once.
function copyScratch(scratch, dest) {
  for (const file of walkFiles(scratch)) {
    const r = readRegular(file);
    if (!r) continue;
    const relPath = path.relative(scratch, file);
    if (relPath.startsWith('..') || path.isAbsolute(relPath)) continue;
    const to = path.join(dest, 'out', relPath);
    prepareWrite(to);
    mkdirStateDirectory(path.dirname(to), { recursive: true });
    writeNoFollow(to, r.bytes, { exclusive: true });
  }
}

// The artifacts a step plugin names, recorded at their sealed copies in the evidence.
// Named failure (I-100): the plugin is handed only a scratch folder (never an evidence path), and returned the files it
// wrote there. The gate hashed those paths and copied the scratch bytes into the step's `out/` folder, but recorded the
// scratch paths, so `wf export screenshots --gate` refused every image as outside the project's attempt evidence even
// though the gate passed. Now each returned path is read through the copy the engine already sealed (a file in the
// step's own scratch folder is `out/<same relative path>`) or, for a file the plugin left in the step's package folder,
// copied under `artifacts/` the way a globbed capture is; the record carries the managed path and the sha256 of those
// bytes. A path in neither folder, or one that is not a regular file, is refused and fails the step: the outside-path
// guard of the readers is untouched and the plugin is never handed an evidence path.
function harvestPluginArtifacts(returned, { scratch, dir, evidenceDir, taken }) {
  const artifacts = [];
  const problems = [];
  const seen = new Set();
  const within = (file, base) => {
    const r = path.relative(base, file);
    return r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r) ? r.split(path.sep).join('/') : null;
  };
  for (const a of returned) {
    if (typeof a?.path !== 'string' || !a.path) {
      problems.push(`${JSON.stringify(a?.path ?? null)}: an artifact needs the path of a file the plugin wrote`);
      continue;
    }
    // The folders on the way are resolved (a link in the middle cannot lead out), the last name never.
    const given = path.resolve(a.path);
    const resolved = path.join(canonicalPath(path.dirname(given)), path.basename(given));
    const inScratch = within(resolved, canonicalPath(scratch));
    const inPackage = inScratch ? null : within(resolved, canonicalPath(dir));
    let managed;
    let source;
    let bytes;
    if (inScratch) {
      managed = path.join(evidenceDir, 'out', ...inScratch.split('/'));
      source = inScratch;
      bytes = readRegular(managed)?.bytes;
      if (!bytes) problems.push(`${a.path}: not a regular file in the step's output folder (a link, a folder or a missing file is not harvested)`);
    } else if (inPackage) {
      managed = path.join(evidenceDir, 'artifacts', ...inPackage.split('/'));
      source = inPackage;
      if (taken.has(managed) || seen.has(managed)) continue; // already collected through the step's `artifacts` globs
      bytes = readRegular(resolved)?.bytes;
      if (!bytes) problems.push(`${a.path}: not a regular file (a link, a folder or a missing file is not harvested)`);
      else {
        prepareWrite(managed);
        mkdirStateDirectory(path.dirname(managed), { recursive: true });
        writeNoFollow(managed, bytes);
      }
    } else {
      problems.push(`${a.path}: outside the step's output folder (the plugin's \`evidenceDir\`) and its package folder; write the file there`);
      continue;
    }
    if (!bytes || seen.has(managed)) continue;
    seen.add(managed);
    artifacts.push({ ...a, path: managed, sha256: sha256(bytes), source });
  }
  return { artifacts, problems };
}

async function executeStep(root, cfg, state, planned, ctx) {
  const step = cfg.gate.steps.find((s) => s.id === planned.id);
  const evidenceDir = path.join(ctx.runDir, step.id);
  prepareWrite(path.join(evidenceDir, 'x'));
  mkdirStateDirectory(evidenceDir, { recursive: true });
  const logFile = path.join(evidenceDir, 'output.log');
  // Steps and plugins write their reports into a scratch folder outside the evidence; the engine copies it in after
  // the step (WF_EVIDENCE and {evidence} name the scratch folder). Their processes are never handed an evidence path.
  const scratch = path.join(root, '.wf-worktrees', '_gate', state.id, ctx.runId, step.id);
  mkdirStateDirectory(scratch, { recursive: true });
  const workers = chooseWorkers(step);
  const shards = chooseShards(step);
  // An allowlisted environment, never the owner's whole one (session tokens included): see engine/env.mjs.
  // WF_ITEM / WF_ITEMS say WHICH tickets' captures the run is for (a batch runs its members' heavy steps); where the
  // tests write them is the project's convention, matched by the step's `artifacts` globs.
  const units = artifactUnits(root, state);
  const env = projectEnv(cfg, { ...stepEnv(root, cfg, step.id, validationCatalog(root, state, step.id)), WF_ROOT: root, WF_ATTEMPT: state.id, WF_ITEM: String(state.item ?? state.id), WF_ITEMS: [...new Set(units.map((u) => String(u.item)))].join(' '), WF_STEP: step.id, WF_EVIDENCE: scratch, WF_WORKERS: String(workers.n) });
  const started = Date.now();
  const prior = allGateSteps(state).filter((s) => s.id === step.id && s.status !== 'reused' && s.suites).at(-1);
  const rerun = step.select ? suitesToRerun(prior, planned) : null;
  const vars = { workers: workers.n, shards: shards.n, evidence: scratch };
  vars.select = rerun ? substitute(step.select, { suites: rerun.map(shellQuote).join(' ') }) : '';
  let result;
  let returned = [];
  if (step.plugin) {
    const mod = (await import(pathToFileURL(adapterFileAtCommit(root, state, validationCommit(state, step.id), step.plugin)).href)).default;
    const pctx = { root, attempt: state.id, step, dir: planned.dir, worktrees: Object.fromEntries(Object.entries(state.repos).map(([k, v]) => [k, v.worktree])), changed: ctx.changedSinceBase, evidenceDir: scratch, workers: workers.n, env, log: (s) => writeNoFollow(logFile, ctx.redact(`${s}\n`), { append: true }) };
    const decision = mod.plan ? await mod.plan(pctx) : null;
    if (decision && decision.run === false) {
      return { id: step.id, repo: step.repo, tier: planned.tier, key: planned.key, inputsHash: planned.inputsHash, runnerIdentity: planned.runnerIdentity, status: 'skipped', reason: decision.reason ?? 'step plugin decided not to run', suites: [], artifacts: [], runId: ctx.runId };
    }
    ctx.running.set(step.id, { plugin: mod, ctx: pctx });
    ctx.onPlugin(step.id, true);
    try {
      const r = await mod.run(pctx);
      // The artifacts the plugin names are harvested below, once its scratch folder has been copied into the evidence.
      result = { status: r.status, suites: r.suites ?? [], artifacts: [] };
      returned = Array.isArray(r.artifacts) ? r.artifacts : [];
    } catch (error) {
      writeNoFollow(logFile, ctx.redact(`step plugin threw: ${error.stack ?? error.message}\n`), { append: true });
      result = { status: 'failed', suites: [], artifacts: [] };
    } finally {
      ctx.running.delete(step.id);
      ctx.onPlugin(step.id, false);
    }
  } else {
    const codes = [];
    for (let shard = 1; shard <= shards.n; shard++) {
      const command = substitute(step.run, { ...vars, shard }, true);
      writeNoFollow(logFile, ctx.redact(`$ ${command}\n`), { append: true });
      codes.push(await spawnStep(command, { cwd: planned.dir, env: { ...env, WF_SHARD: String(shard), WF_SHARDS: String(shards.n) }, logFile, redact: ctx.redact, onSpawn: (pid) => ctx.addChild(pid) }));
    }
    const files = (step.report?.junit ? [step.report.junit].flat() : []).flatMap((p) => globFiles(planned.dir, substitute(p, vars)));
    // The suites come from a JUnit report, or from Playwright's JSON report (0.7.6, I-118), so `select` reruns only what failed.
    const playwrightFiles = (step.report?.playwright ? [step.report.playwright].flat() : []).flatMap((p) => globFiles(planned.dir, substitute(p, vars)));
    let suites = [...readJUnitFiles(files), ...readPlaywrightSuites(playwrightFiles)];
    for (const f of files) {
      prepareWrite(path.join(evidenceDir, `junit-${path.basename(f)}`));
      const junit = readRegular(f);
      if (junit) writeNoFollow(path.join(evidenceDir, `junit-${path.basename(f)}`), junit.bytes);
    }
    for (const f of playwrightFiles) {
      prepareWrite(path.join(evidenceDir, `playwright-${path.basename(f)}`));
      const report = readRegular(f);
      if (report) writeNoFollow(path.join(evidenceDir, `playwright-${path.basename(f)}`), report.bytes);
    }
    if (rerun && prior?.suites) {
      const fresh = new Map(suites.map((s) => [s.id, s]));
      suites = [...prior.suites.filter((s) => !fresh.has(s.id) && !rerun.includes(s.file ?? s.id)).map((s) => ({ ...s, carried: true })), ...fresh.values()];
    }
    const interrupted = codes.some((c) => c.signal);
    const failed = codes.some((c) => c.code !== 0) || suites.some((s) => s.status === 'failed');
    result = { status: interrupted ? 'interrupted' : failed ? 'failed' : 'passed', suites, exitCodes: codes.map((c) => c.code), artifacts: [] };
    // Which tests failed, recorded on the step (telemetry): read from the reports and output this run wrote.
    if (result.status === 'failed') {
      result.failures = stepFailures({ junitFiles: files, playwrightFiles, log: logFile, exitCodes: result.exitCodes, suites, redact: ctx.redact });
    }
  }
  copyScratch(scratch, evidenceDir);
  const collected = collectArtifacts(step, planned.dir, path.join(evidenceDir, 'artifacts'), started, units);
  if (returned.length) {
    const harvest = harvestPluginArtifacts(returned, { scratch, dir: planned.dir, evidenceDir, taken: new Set(collected.artifacts.map((a) => a.path)) });
    for (const problem of harvest.problems) writeNoFollow(logFile, ctx.redact(`step plugin artifact refused: ${problem}\n`), { append: true });
    if (harvest.problems.length && result.status === 'passed') result.status = 'failed';
    result.artifacts.push(...harvest.artifacts);
  }
  if (step.plugin && result.status === 'failed') result.failures = stepFailures({ log: logFile, suites: result.suites, redact: ctx.redact });
  result.artifacts.push(...collected.artifacts);
  result.artifactGlobs = collected.artifactGlobs;
  let fileHashesRef = null;
  if (planned.fileHashes) {
    const f = path.join(evidenceDir, 'inputs.json');
    prepareWrite(f);
    writeNoFollow(f, JSON.stringify(planned.fileHashes));
    fileHashesRef = { path: f, sha256: hashFile(f) };
  }
  return {
    id: step.id,
    repo: step.repo,
    tier: planned.tier,
    key: planned.key,
    inputsHash: planned.inputsHash,
    reason: planned.reason,
    fileHashesRef,
    runnerIdentity: planned.runnerIdentity,
    ...result,
    rerunSuites: rerun,
    workers,
    shards,
    durationMs: Date.now() - started,
    log: logFile,
    logSha256: fs.existsSync(logFile) ? hashFile(logFile) : null,
    runId: ctx.runId,
    startedAt: new Date(started).toISOString(),
  };
}

const leasesDir = () => path.join(process.env.WF_CONFIG_HOME ?? path.join(process.env.HOME ?? '/tmp', '.config', 'agentic-workflow'), 'leases');
const leaseBase = (name) => name.replace(/[^\w.-]/g, '_');
// Who holds a slot, beside the slot file (`docker.1.holder`): a slot file holds only its pid, because every `wf` version on the
// machine reads and writes the same folder, so what names the holder goes in a file an older version never opens.
const holderFileOf = (slot) => `${slot}.holder`;
function noteHolder(slot, who) {
  try {
    fs.writeFileSync(holderFileOf(slot), JSON.stringify({ pid: process.pid, since: now(), ...who }));
  } catch {}
}
export function releaseMachineLease(slot) {
  fs.rmSync(slot, { force: true });
  fs.rmSync(holderFileOf(slot), { force: true });
}
// One file per slot (`docker.1`, `docker.2`…), created exclusively; a slot whose holder process is gone is free.
// Named failure (I-91): the holder's pid was read with no guard, so a slot released between our failed create and this read
// ("ENOENT") threw out of the gate's scheduler and killed the runner with its step still running. A slot that vanished is
// tried again (a few times: a dangling link stays "vanished"); one that cannot be read at all is held by someone we cannot
// judge, and waited for like any other.
function takeMachineLease(name, capacity, who = null) {
  const dir = leasesDir();
  mkdirStateDirectory(dir, { recursive: true });
  for (let i = 1; i <= capacity; i++) {
    const file = path.join(dir, `${leaseBase(name)}.${i}`);
    for (let tries = 0; tries < 3; tries++) {
      try {
        const fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        if (who) noteHolder(file, who);
        return file;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let holder = 0;
        try {
          holder = Number(fs.readFileSync(file, 'utf8').trim() || 0);
        } catch (readError) {
          if (readError.code === 'ENOENT') continue;
        }
        if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && !isPidAlive(holder)) {
          releaseMachineLease(file);
          continue;
        }
        break;
      }
    }
  }
  return null;
}

// The live processes holding a lease's slots right now, with what they say they run (a gate step: the attempt and the step; a
// `wf run`: its program name); a holder that recorded nothing is only a pid.
export function leaseHolders(name) {
  const dir = leasesDir();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const base = leaseBase(name);
  const holders = [];
  for (const n of names.sort()) {
    const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)$`).exec(n);
    if (!m) continue;
    const slot = path.join(dir, n);
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(slot, 'utf8').trim() || 0);
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) continue;
    let who = {};
    try {
      const noted = JSON.parse(fs.readFileSync(holderFileOf(slot), 'utf8'));
      if (noted?.pid === pid) who = noted;
    } catch {}
    holders.push({ slot: Number(m[1]), pid, attempt: who.attempt ?? null, step: who.step ?? null, run: who.run ?? null, since: who.since ?? null, command: who.command ?? null });
  }
  return holders;
}
// A holder that recorded nothing (a `wf` of an older version, another tool) is named by its pid only: its command line can carry
// anything, and `wf status` is read by agents.
const describeHolder = (h) => {
  const what = h.attempt ? `${h.attempt}${h.step ? ` step ${h.step}` : ''}` : h.command ? `wf run ${h.command}` : null;
  return `pid ${h.pid}${what ? ` (${what})` : ' (no details recorded)'}${h.since ? ` since ${h.since.slice(11, 19)}Z` : ''}`;
};
const LEASE_REREAD_MS = 2000;
// What a lease wait says after the lease's name: who holds the slots, and how capacity is raised (the project's current config,
// read again while waiting).
export function leaseWaitText(name, holders = leaseHolders(name)) {
  const by = holders.length ? `held by ${holders.map(describeHolder).join(', ')}` : 'held by a process that has just let go';
  return `${by}. To allow more at once, raise \`gate.leases.${name}\` in the project's .workflow/project.yaml (a waiting run reads it again every ${LEASE_REREAD_MS / 1000} seconds)`;
}
// Named failure (I-88): lease capacity is an operational fact of this machine, not part of a frozen test definition: it is read
// from the project's current config (the owner's checkout; a ticket cannot change it), again every few seconds, and `first` is
// the fallback when the file cannot be read.
function leaseConfigReader(root, first) {
  let read = { at: Date.now(), value: first ?? {} };
  return () => {
    if (Date.now() - read.at > LEASE_REREAD_MS) {
      try {
        read = { at: Date.now(), value: loadConfig(root).gate.leases ?? {} };
      } catch {
        read = { ...read, at: Date.now() };
      }
    }
    return read.value;
  };
}

// `wf run --lease <name> -- <cmd>`: an implementer's docker or end-to-end stack takes the same machine-wide slot a gate
// step would, so concurrent attempts cannot start more stacks than `gate.leases` allows. Named failure: stacks started
// outside the `docker: 1` lease overloaded the machine. The slot is held by this process and freed when it exits.
export async function runWithLease(cfg, name, command, { log = process.stderr, cwd, env, redact, root = null } = {}) {
  // Named failure (I-88, residual): capacity was read once, so a lease raised in the project's config while this command waited
  // never reached it (docker.1 held, `gate.leases.docker` raised to 2, and `wf run --lease docker` kept waiting). The waiting
  // loop reads the project's current config again, as a waiting gate step does.
  const configured = root ? leaseConfigReader(root, cfg.gate.leases) : () => cfg.gate.leases ?? {};
  const capacityNow = () => configured()[name] ?? 1;
  const who = { command: path.basename(String(command?.[0] ?? '')) };
  let capacity = name ? capacityNow() : 0;
  let slot = name ? takeMachineLease(name, capacity, who) : null;
  if (name && !slot) log.write(`wf run: waiting for a \`${name}\` lease (${capacity} slot(s), all held): ${leaseWaitText(name)}\n`);
  while (name && !slot) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = capacityNow();
    if (now !== capacity) {
      log.write(`wf run: lease \`${name}\` now allows ${now} slot(s) (it was ${capacity}), from the project config\n`);
      capacity = now;
    }
    slot = takeMachineLease(name, capacity, who);
  }
  try {
    return await new Promise((resolve) => {
      const child = spawn(command[0], command.slice(1), { cwd, env, stdio: redact ? ['inherit', 'pipe', 'pipe'] : 'inherit' });
      const forward = (sig) => child.kill(sig);
      process.on('SIGINT', forward);
      process.on('SIGTERM', forward);
      // A secret reaches a command only through the engine, so what the command prints is masked on its way out; a value
      // split across two chunks is held back until it can be matched.
      if (redact) {
        const keep = Math.max(0, (redact.maxLen ?? 0) - 1);
        for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
          let pending = '';
          from.on('data', (b) => {
            pending = redact(pending + b.toString('utf8'));
            if (pending.length > keep) {
              to.write(pending.slice(0, pending.length - keep));
              pending = pending.slice(pending.length - keep);
            }
          });
          from.on('end', () => to.write(redact(pending)));
        }
      }
      child.on('error', (error) => {
        log.write(`wf run: ${error.message}\n`);
        resolve(127);
      });
      child.on(redact ? 'close' : 'exit', (code, signal) => {
        process.off('SIGINT', forward);
        process.off('SIGTERM', forward);
        resolve(code ?? (signal ? 128 : 1));
      });
    });
  } finally {
    if (slot) releaseMachineLease(slot);
  }
}

// The command line of a live process, or null when this host does not let us read it.
// Named failure: `wf status`, `wf resume` and `wf stop` ran `ps` through a helper that throws when `ps` cannot start, so
// under a sandbox that forbids `ps` (49 calls under one harness's sandbox) every one of them failed with "ps failed to start:
// spawnSync ps EPERM" while a gate lock existed. Linux reads /proc; elsewhere `ps` is asked and a failure of any kind
// (cannot start, refused, no output for a process known to be alive) means "unknown", never an error.
function processCommand(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').replace(/\0/g, ' ').trim();
    if (raw) return raw;
  } catch {}
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  const out = r.error || r.status !== 0 ? '' : String(r.stdout ?? '').trim();
  return out || null;
}

// `wf run --step <id> [--lease <name>] -- <cmd>` (I-73). Named failure: a frozen step's dependencies needed a registry token
// that only the gate injects, while `wf check` refuses a dirty worktree and the project's rules ask for lint and tests
// before the first commit: a fresh worktree could not install its dependencies at all. This runs a command in the
// step's package directory with exactly the secrets that list the step in `usedBy` (masked in its output), under the
// step's lease unless one is named. It writes nothing to the ledger and is never gate evidence.
// Security review of 0.7.0: an arbitrary command typed by an agent received the step's secrets (masking the output is not
// a confidentiality boundary, and DESIGN.md principle 14 says agents never handle secret values). Only the step's own
// `prepare` command, declared in the adapter at the attempt's base, runs with them.
export async function runPrepared(root, state, stepId, command, { lease = null } = {}) {
  const cfg = gateAdapter(root, state);
  const step = cfg.gate.steps.find((x) => x.id === stepId);
  if (!step) throw refuse(`no gate step \`${stepId}\` in the adapter this attempt was admitted under (steps: ${cfg.gate.steps.map((x) => x.id).join(', ')})`, 'name the step whose `usedBy` secrets the command needs');
  if (command?.length) throw refuse('`wf run --step` runs only the step\'s declared `prepare` command; a command given here never receives the step\'s secrets', 'declare it as `prepare:` on the step in .workflow/project.yaml (committed), then run `wf run --step <id>`', { id: 'run:arbitrary-command' });
  if (typeof step.prepare !== 'string' || !step.prepare.trim()) throw refuse(`step \`${step.id}\` declares no \`prepare\` command`, 'add `prepare: "<install command>"` to the step in the committed adapter', { id: 'run:no-prepare' });
  command = ['sh', '-c', step.prepare];
  const missing = missingFor(root, cfg, step.id, validationCatalog(root, state, step.id));
  if (missing.length) throw refuse(`secrets missing for step ${step.id}: ${missing.join(', ')}`, 'run `wf secrets guide` in your terminal');
  const { dir } = stepPackage(cfg, state, step);
  const env = projectEnv(cfg, { ...stepEnv(root, cfg, step.id, validationCatalog(root, state, step.id)), WF_ROOT: root, WF_ATTEMPT: state.id, WF_ITEM: String(state.item ?? state.id) });
  return runWithLease(loadConfig(root), lease ?? step.lease ?? null, command, { cwd: dir, env, redact: redactor(root, cfg), root });
}

// A pid in the lock belongs to us only if it is still a `wf` process (pids are reused after a crash). When the host
// hides the command line, a live pid that holds this attempt's lock is taken to be its runner: declaring a live gate
// dead would let a second one run on the same attempt.
function isWfRunner(pid) {
  if (!isPidAlive(pid)) return false;
  const cmd = processCommand(pid);
  return cmd === null || /(^|[\s/])wf(\s|$)/.test(cmd);
}

async function harvest(root, state, lock) {
  for (const pid of lock.children ?? []) {
    try {
      process.kill(-pid, 'SIGTERM'); // the step's process group; members survive their shell leader
    } catch {}
  }
  if (lock.plugins?.length) {
    const cfg = gateAdapter(root, state);
    for (const id of lock.plugins) {
      const step = cfg.gate.steps.find((s) => s.id === id);
      if (!step?.plugin) continue;
      try {
        const mod = (await import(pathToFileURL(adapterFileAtCommit(root, state, validationCommit(state, step.id), step.plugin)).href)).default;
        await mod.cleanup?.({ root, attempt: state.id, step, harvest: true });
      } catch {}
    }
  }
  // The run's results come from the ledger (each step was appended as it finished), never from its progress file: a
  // progress file is not recorded evidence and could claim steps that never ran.
  const progress = { steps: loadState(root, state.id).gateRuns?.[lock.runId]?.steps ?? [] };
  // A dead runner's folder is recorded by the process that harvests it, as found.
  ownGateRun(root, state.id, lock.runId);
  seal(append, { root, id: state.id, runId: lock.runId });
  append(root, state.id, lock.kind === 'check' ? 'check.finished' : 'gate.finished', { runId: lock.runId, status: 'recovered', reason: 'owner-dead', steps: progress.steps, tree: lock.tree, ...(lock.kind === 'check' ? { check: true } : {}) }, null);
  return { runId: lock.runId, carried: progress.steps.filter((s) => s.status === 'passed').length };
}

// Takes the gate lock atomically. A live runner is never duplicated; a dead one is harvested first.
async function acquireGateLock(root, state) {
  const file = lockFile(root, state.id);
  mkdirStateDirectory(path.dirname(file), { recursive: true });
  let recovered = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, runId: null, startedAt: now(), children: [], plugins: [] }));
      fs.closeSync(fd);
      return { recovered };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let lock;
      try {
        lock = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // Being written by the process that just created it: that process is alive and owns the gate.
        if (Date.now() - fs.statSync(file).mtimeMs < 5000) throw refuse(`a gate is already starting for ${state.id}; wait for it or run \`wf stop\``);
        lock = { pid: 0 };
      }
      if (lock.kind === REVIEW_HANDOFF && isWfRunner(lock.pid)) throw refuse(`a reviewer handoff is being recorded for ${state.id} (pid ${lock.pid}); review and gate never run side by side: the gate runs after that review round`);
      if (isWfRunner(lock.pid)) throw refuse(`a gate is already running for ${state.id} (pid ${lock.pid}${lock.runId ? `, run ${lock.runId}` : ''}); wait for it or run \`wf stop\``);
      if (lock.runId) recovered = await harvest(root, state, lock);
      fs.rmSync(file, { force: true });
    }
  }
  throw refuse(`could not take the gate lock for ${state.id}`);
}

export async function runGate(root, state, options = {}) {
  // An engine older than the adapter's pin would judge the ticket by rules the project does not run on.
  const live = loadConfig(root);
  assertEngine(live);
  assertEngine(trustedAdapter(root, state));
  // `wf check` needs only the repos it checks to be committed; a gate needs every repo.
  const dirty = Object.fromEntries(Object.entries(uncommitted(state)).filter(([r]) => !options.check || !options.repos || options.repos.includes(r)));
  if (Object.keys(dirty).length) throw refuse(`commit changes before the ${options.check ? 'check' : 'gate'}: ${Object.entries(dirty).map(([r, l]) => `${r} (${l.slice(0, 5).join('; ')}${l.length > 5 ? `; +${l.length - 5} more` : ''})`).join(', ')}`);
  // Named failure (I-92): after the owner stopped a check because the tree is about to change (remaining admitted fixes), the same
  // check was started again on the unchanged tree, queued behind an unrelated stack and ran for nothing. From 0.7.0 it waits for
  // a new commit.
  const lastCheck = options.check ? state.checks.at(-1) : null;
  const lastStop = lastCheck?.status === 'stopped' ? state.stops.filter((x) => x.runId === lastCheck.runId).at(-1) : null;
  if (lastStop && ['tree-change', 'major-finding'].includes(lastStop.class) && obligationSince(state, '0.7.0') && canonical(lastCheck.tree) === canonical(treeHashes(state))) {
    throw refuse(`the last check was stopped by the owner (${lastStop.class}: ${lastStop.reason}) and the tree has not changed since`, 'finish and commit the remaining fixes, then run `wf check`; it runs on the new tree', { id: 'check:stopped-tree-unchanged' });
  }
  if (options.rerunFailed === true) {
    const failed = (state.lastGate?.steps ?? []).filter((s) => ['failed', 'interrupted', 'not-started'].includes(s.status)).map((s) => s.id);
    if (!failed.length) throw refuse('--rerun-failed: the last gate has no failed step', 'run `wf gate`');
    options = { ...options, rerunFailed: failed };
  }
  if (options.prepareOnly) {
    const plan = await planGate(root, state, options);
    return { plan, recovered: null };
  }
  const { recovered } = await acquireGateLock(root, state);
  const release = () => fs.rmSync(lockFile(root, state.id), { force: true });
  try {
    if (recovered) state = loadState(root, state.id);
    // The order of work (I-27) is checked under the lock a reviewer handoff also takes, so a gate and a review round
    // never start side by side: whichever takes the lock first is seen by the other.
    if (options.afterLock) options.afterLock(loadState(root, state.id));
    const plan = await planGate(root, state, options);
    if (options.check && options.repos) for (const r of options.repos) if (!state.repos[r]) throw refuse(`repo \`${r}\` is not part of ${state.id}`);
    const missing = plan.steps.filter((s) => s.decision === 'run' && s.missingSecrets?.length);
    if (missing.length) throw refuse(`secrets missing: ${missing.map((s) => `${s.id} needs ${s.missingSecrets.join(', ')}`).join('; ')}`, 'run `wf secrets guide` in your terminal');
    const record = await execute(root, state, plan, options.live ?? null);
    return { record, recovered };
  } finally {
    release();
  }
}

// Runs `fn` again while it is refused only because another command holds the attempt's evidence lock (a live owner:
// a dead one is reclaimed by the lock itself). The lock waits ten seconds per try; this waits for up to five minutes more.
async function retryWhileLocked(fn, { tries = 30, waitMs = 2000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (error) {
      if (error?.refusalId !== 'lock:held' || i >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

// One line per event, written as it happens, so a gate run in the background shows progress in its log.
function failureExcerpt(result, redact) {
  const suite = (result.suites ?? []).find((x) => x.status === 'failed');
  if (suite) return [`first failure: ${suite.id}${suite.file && suite.file !== suite.id ? ` (${suite.file})` : ''}`];
  if (result.error) return [redact(result.error)];
  if (!result.log || !fs.existsSync(result.log)) return [];
  const lines = fs.readFileSync(result.log, 'utf8').split('\n').filter((l) => l.trim());
  return lines.slice(-5).map((l) => redact(l));
}

const killGroups = (pids) => {
  for (const pid of pids) {
    try {
      process.kill(-pid, 'SIGTERM'); // the step's process group; members survive their shell leader
    } catch {}
  }
};

// Named failure (I-91): the runner's scheduler could be left by an error nothing handled (a progress file that refused to be
// written, a lease slot that could not be read): the process died with exit 1, a step's process still running and the gate
// lock behind. Whatever leaves the run, an error or its end, signals every process the run started, frees the machine-wide
// lease slots it took and drops its signal handlers. The next gate still harvests what a killed runner left (`harvest`), but a
// stray process no longer outlives the runner that started it.
async function execute(root, state, plan, live = null) {
  const run = { children: new Set(), machine: new Map(), handlers: [] };
  try {
    return await executeRun(root, state, plan, live, run);
  } catch (error) {
    killGroups(run.children);
    throw error;
  } finally {
    for (const slot of run.machine.values()) releaseMachineLease(slot);
    for (const [signal, handler] of run.handlers) process.off(signal, handler);
  }
}

async function executeRun(root, state, plan, live, run) {
  const runId = `${now().replace(/[:.]/g, '-')}-${process.pid}`;
  const runDir = path.join(gateDir(root, state.id), runId);
  ownGateRun(root, state.id, runId);
  prepareWrite(path.join(runDir, 'x'));
  mkdirStateDirectory(runDir, { recursive: true });
  append(root, state.id, 'gate.started', { runId, kind: plan.check ? 'check' : 'gate' }, null);
  const lockData = { pid: process.pid, runId, kind: plan.check ? 'check' : 'gate', startedAt: now(), tree: plan.tree, children: [], plugins: [] };
  const persistLock = () => writeJson(lockFile(root, state.id), lockData);
  persistLock();
  const children = run.children;
  const ctx = {
    runId,
    runDir,
    live: plan.live,
    redact: redactor(root, plan.cfg),
    running: new Map(),
    changedSinceBase: plan.changed,
    // The lock is how a dead runner's children are found; one that cannot be written ends the run (the child is already known).
    addChild: (pid) => {
      children.add(pid);
      lockData.children.push(pid);
      guarded(persistLock);
    },
    onPlugin: (id, on) => {
      lockData.plugins = on ? [...lockData.plugins, id] : lockData.plugins.filter((x) => x !== id);
      guarded(persistLock);
    },
  };
  const results = [];
  const runningNow = new Map(); // step id -> start time
  const waiting = new Map(); // step id -> { lease, capacity, since }: queued behind a full lease (shown by `wf status`)
  const saveProgress = () => writeJson(progressFile(root, state.id, runId), { runId, pid: process.pid, steps: results, running: [...runningNow].map(([id, at]) => ({ id, startedAt: new Date(at).toISOString() })), waiting: [...waiting].map(([id, w]) => ({ id, lease: w.lease, capacity: w.capacity, since: new Date(w.since).toISOString() })) });
  const say = (line) => live?.write(`wf ${plan.check ? 'check' : 'gate'}: ${line}\n`);
  let stopping = false;
  let fatal = null; // the first error that escaped the scheduler (I-91); the run ends as failed, nothing it started keeps running
  let wake = () => {};
  const onSignal = async () => {
    if (stopping) return;
    stopping = true;
    killGroups(children);
    for (const { plugin, ctx: pctx } of ctx.running.values()) {
      try {
        await plugin.cleanup?.(pctx);
      } catch {}
    }
  };
  const abort = (error) => {
    if (!fatal) {
      fatal = error;
      try {
        say(`aborting: ${ctx.redact(String(error?.message ?? error))}`);
      } catch {}
    }
    onSignal();
    wake();
  };
  const guarded = (fn) => {
    try {
      return fn();
    } catch (error) {
      abort(error);
      return undefined;
    }
  };
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, onSignal);
    run.handlers.push([signal, onSignal]);
  }
  // Whatever else throws while the run goes on (a step plugin's timer, a stream callback) is the run's failure, not the
  // process's: it ends the run the same way, instead of killing the runner with its steps' processes still running.
  const onFatal = (error) => abort(error instanceof Error ? error : new Error(String(error)));
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, onFatal);
    run.handlers.push([event, onFatal]);
  }

  // Light steps first (their failures are cheap to learn early), then heavy steps longest first, so the gate's wall
  // time is not the serial chain of heavy steps started in adapter order. Unknown durations count as longest.
  const lastDuration = (id) => allGateSteps(state).filter((s) => s.id === id && s.durationMs !== undefined && s.status !== 'reused').at(-1)?.durationMs ?? Infinity;
  const queue = plan.steps.filter((s) => s.decision === 'run').map((s, i) => ({ s, i, heavy: s.tier === 'heavy' ? 1 : 0, d: lastDuration(s.id) }))
    .sort((a, b) => a.heavy - b.heavy || (a.heavy ? b.d - a.d : 0) || a.i - b.i)
    .map((x) => x.s);
  for (const s of plan.steps.filter((x) => x.decision === 'reuse')) {
    const prior = findReuse(state, s.id, s.key);
    results.push({ ...prior, status: 'reused', reusedFrom: prior.runId, reason: s.reason, runId });
  }
  for (const s of plan.steps.filter((x) => ['skip', 'defer'].includes(x.decision))) results.push({ id: s.id, repo: s.repo, tier: s.tier, status: s.decision === 'defer' ? 'deferred' : 'skipped', reason: s.reason, skippedBy: s.skippedBy, runId });
  if (results.length) append(root, state.id, 'gate.step', { runId, steps: results }, null);
  saveProgress();
  say(`run ${runId}: ${queue.length} to run, ${results.filter((r) => r.status === 'reused').length} reused, ${results.length - results.filter((r) => r.status === 'reused').length} skipped or deferred`);
  for (const r of results) say(`${r.status.padEnd(8)} ${r.id}  ${r.reason ?? ''}`.trimEnd());

  // Named failure (I-88): lease capacity was pinned with the admission adapter, so a project raising `gate.leases` could not
  // unblock a check queued behind another attempt's stack; the only way on was to supersede the attempt. Capacity is an
  // operational fact of this machine, not part of the frozen test definition: it is read from the project's current
  // config (the owner's checkout; a ticket cannot change it) every few seconds, and the pinned value is the fallback.
  // A capacity that differs from the pinned one is said once and recorded in the run's result.
  const pinnedLeases = plan.cfg.gate.leases ?? {};
  const leaseCapacity = {};
  const leasesNow = leaseConfigReader(root, plan.live?.gate?.leases);
  const capacityOf = (lease) => {
    const capacity = leasesNow()[lease] ?? pinnedLeases[lease] ?? 1;
    if (capacity !== (pinnedLeases[lease] ?? 1) && leaseCapacity[lease]?.capacity !== capacity) {
      leaseCapacity[lease] = { capacity, pinned: pinnedLeases[lease] ?? 1 };
      say(`lease ${lease}: capacity ${capacity} from the project config (the admission adapter pinned ${pinnedLeases[lease] ?? 1})`);
    }
    return capacity;
  };
  const held = {};
  const machine = run.machine; // step id -> machine-wide lease slot file
  const max = Math.max(1, plan.cfg.gate.maxParallelSteps ?? 1);
  const active = new Set();
  const leaseOf = (p) => plan.cfg.gate.steps.find((x) => x.id === p.id).lease;
  // Named failure (I-113): a check waiting for a full lease printed nothing after "N to run", and `wf status` said only "waiting
  // for a lease". The wait names the lease, who holds its slots and how capacity is raised, once when it begins (again when
  // the capacity it waits on changes), and `progress.json` carries it for `wf status` and `wf resume`.
  let waitingChanged = false;
  const noteWaiting = (p, lease, capacity) => {
    const was = waiting.get(p.id);
    if (was && was.lease === lease && was.capacity === capacity) return;
    waiting.set(p.id, { lease, capacity, since: was?.since ?? Date.now() });
    waitingChanged = true;
    say(`waiting  ${p.id}  for lease ${lease} (${capacity} slot(s), all held): ${leaseWaitText(lease)}`);
  };
  // Leases are machine-wide: two gates on one machine (other attempts or projects) never share a docker slot.
  const canStart = (p) => {
    const lease = leaseOf(p);
    if (!lease) return true;
    const capacity = capacityOf(lease);
    const slot = (held[lease] ?? 0) >= capacity ? null : takeMachineLease(lease, capacity, { attempt: state.id, step: p.id, run: runId });
    if (!slot) {
      noteWaiting(p, lease, capacity);
      return false;
    }
    machine.set(p.id, slot);
    return true;
  };
  await new Promise((resolve) => {
    wake = resolve;
    // The step taken off the queue and not yet handed to a job: if the scheduler fails right there, it goes back, not-started.
    let starting = null;
    const pump = () => {
      try {
        while (!stopping && active.size < max) {
          const idx = queue.findIndex(canStart);
          if (idx < 0) break;
          const p = queue.splice(idx, 1)[0];
          starting = p;
          const lease = leaseOf(p);
          if (lease) held[lease] = (held[lease] ?? 0) + 1;
          waiting.delete(p.id);
          runningNow.set(p.id, Date.now());
          saveProgress();
          say(`start    ${p.id}`);
          // Named failure (I-91): this completion handler threw when the evidence lock stayed held for ten seconds (a long read
          // by another command): the rejection was unhandled, so the runner died with exit 1 before its leases, its signal
          // handlers and its final record were dealt with, and the run had no result. Recording the step now waits for the
          // lock; whatever else goes wrong in here is the step's own failure, and the job is always finished.
          const job = executeStep(root, plan.cfg, state, p, ctx)
            .catch((error) => ({ id: p.id, repo: p.repo, tier: p.tier, key: p.key, status: 'failed', error: error.message, runId }))
            .then(async (r) => {
              let pushed = false;
              try {
                if (lease) held[lease] -= 1;
                if (machine.has(p.id)) releaseMachineLease(machine.get(p.id));
                machine.delete(p.id);
                // A run ended by its own error certifies nothing that was still running when it ended, whatever the step returns after it was signalled.
                let final = fatal || (stopping && r.status !== 'passed') ? { ...r, status: 'interrupted' } : r;
                const secs = ((Date.now() - runningNow.get(p.id)) / 1000).toFixed(1);
                runningNow.delete(p.id);
                try {
                  await retryWhileLocked(() => append(root, state.id, 'gate.step', { runId, step: final }, null));
                } catch (error) {
                  final = { ...final, status: 'failed', error: `the step finished ${r.status} but recording it failed: ${error.message}` };
                }
                results.push(final);
                pushed = true;
                // The live view is not the step's result: a progress file that cannot be written ends the run, not this step.
                guarded(saveProgress);
                say(`${final.status.padEnd(8)} ${p.id}  ${secs}s`);
                if (final.status === 'failed') for (const line of failureExcerpt(final, ctx.redact)) say(`  ${p.id} | ${line}`);
              } catch (error) {
                if (!pushed) results.push({ id: p.id, repo: p.repo, tier: p.tier, key: p.key, status: 'failed', error: `finishing the step failed: ${error.message}`, runId });
              } finally {
                runningNow.delete(p.id);
                active.delete(job);
                pump();
              }
            });
          active.add(job);
          starting = null;
        }
        if (waitingChanged) {
          waitingChanged = false;
          saveProgress();
        }
        if (active.size === 0 && (queue.length === 0 || stopping)) return resolve();
        // A step waiting for a lease another gate holds: look again shortly.
        if (queue.length && !stopping) setTimeout(pump, 500);
      } catch (error) {
        // Named failure (I-91): an error here (the progress file, a lease slot) left the callback of a timer or of a finished
        // step, so nothing caught it and the runner died with its steps' processes still running. It ends the run instead:
        // every child is signalled, the step being started goes back to the queue, and the run is recorded failed.
        if (starting) {
          const p = starting;
          starting = null;
          queue.unshift(p);
          if (leaseOf(p)) held[leaseOf(p)] -= 1;
          if (machine.has(p.id)) releaseMachineLease(machine.get(p.id));
          machine.delete(p.id);
          runningNow.delete(p.id);
        }
        abort(error);
      }
    };
    pump();
  });
  // An aborted run waits for the steps it signalled to end, so their results are in the record.
  if (fatal) await Promise.allSettled([...active]);
  for (const slot of machine.values()) releaseMachineLease(slot);
  machine.clear();
  for (const [signal, handler] of run.handlers) process.off(signal, handler);
  for (const p of queue) results.push({ id: p.id, repo: p.repo, tier: p.tier, status: 'not-started', runId });

  const bad = results.filter((r) => ['failed', 'interrupted', 'not-started'].includes(r.status) || (!plan.check && validationIds(state).includes(r.id) && !['passed', 'reused'].includes(r.status)));
  const status = fatal ? 'failed' : stopping ? 'stopped' : bad.length ? 'failed' : 'passed';
  // Named failure (I-92): a check stopped by the owner ended as `stopped` with nothing said about why, so the implementer that ran it
  // retried the check on an unfinished tree. The stop `wf stop` recorded for this run (class and reason) travels with the result.
  const ownerStop = stopping && !fatal ? loadState(root, state.id).stops.filter((x) => x.runId === runId).at(-1) : null;
  // Untracked files the steps produced (reports, screenshots) are recorded so they do not block the next gate.
  const producedUntracked = {};
  for (const [name, r] of Object.entries(state.repos)) producedUntracked[name] = untrackedSnapshot(r.worktree);
  say(`${status} (${runId})`);
  const record = { runId, status, producedUntracked, changed: plan.changed, full: plan.full, focused: plan.focused, check: plan.check || undefined, repos: plan.repos ?? undefined, rerunFailed: plan.rerunFailed ?? undefined, adapterBase: state.adapterBase, validationDigest: validationDigest(state), tree: plan.tree, impact: plan.impact, unchecked: plan.unchecked, ...(Object.keys(leaseCapacity).length ? { leaseCapacity } : {}), ...(ownerStop ? { stop: { class: ownerStop.class, reason: ownerStop.reason } } : {}), ...(fatal ? { error: ctx.redact(String(fatal.message ?? fatal)) } : {}), steps: results, finishedAt: now() };
  writeImmutable(path.join(runDir, 'result.json'), `${JSON.stringify(record, null, 2)}\n`);
  // Recorded before the run is: once it is finished, an unrecorded file in its folder is an extra file.
  await retryWhileLocked(() => {
    seal(append, { root, id: state.id, runId });
    append(root, state.id, plan.check ? 'check.finished' : 'gate.finished', { ...record, evidence: path.join(runDir, 'result.json') }, null);
  });
  const flaky = flakesIn(state, results);
  if (flaky.length) await retryWhileLocked(() => append(root, state.id, 'gate.flaky', { runId, flaky }, null));
  record.flaky = flaky;
  return record;
}

// The gate running right now for this attempt, read from its lock and live progress file; null when none runs.
export function liveGate(root, state) {
  const file = lockFile(root, state.id);
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!lock.runId || !isWfRunner(lock.pid)) return null;
  let progress = { steps: [], running: [] };
  try {
    progress = JSON.parse(fs.readFileSync(progressFile(root, state.id, lock.runId), 'utf8'));
  } catch {}
  const at = Date.now();
  return {
    runId: lock.runId,
    pid: lock.pid,
    startedAt: lock.startedAt,
    running: (progress.running ?? []).map((r) => ({ id: r.id, seconds: Math.round((at - Date.parse(r.startedAt)) / 1000) })),
    // Steps queued behind a full lease (I-113), with the lease's current holders read now.
    waiting: (progress.waiting ?? []).map((w) => ({ id: w.id, lease: w.lease, capacity: w.capacity, seconds: Math.round((at - Date.parse(w.since)) / 1000), text: leaseWaitText(w.lease) })),
    finished: (progress.steps ?? []).map((r) => ({ id: r.id, status: r.status, seconds: r.durationMs !== undefined && r.status !== 'reused' ? Math.round(r.durationMs / 1000) : null })),
  };
}

// Named failure (I-27): reviewers were handed the tree while a gate ran on it, so every finding made that gate obsolete
// (15 of 16 gates stopped on one ticket). The reviewer handoff and the gate share the gate lock: the handoff refuses
// while a live `wf` process holds it (a gate running or starting), and holds it itself while it records the round.
const REVIEW_HANDOFF = 'review-handoff';

// The live `wf` process holding this attempt's gate lock, or null. Unlike `liveGate` it includes a gate that is still
// starting (no run id yet) and a lock being written right now.
export function gateBusy(root, state) {
  const file = lockFile(root, state.id);
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return Date.now() - fs.statSync(file).mtimeMs < 5000 ? { pid: null, runId: null, kind: 'gate' } : null;
  }
  if (lock.kind === REVIEW_HANDOFF || !isWfRunner(lock.pid)) return null;
  return { pid: lock.pid, runId: lock.runId ?? null, kind: lock.kind ?? 'gate' };
}

// Runs `fn` (recording a reviewer handoff) holding the gate lock, so no gate starts between the check and the record.
// A lock a dead runner left stays for the next gate to harvest (its finished steps are recovered from it); the handoff
// then records without the lock.
export function withReviewLock(root, state, fn) {
  const file = lockFile(root, state.id);
  mkdirStateDirectory(path.dirname(file), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const busy = gateBusy(root, state);
    if (busy) throw gateRunningRefusal(state, busy);
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    if (holder?.kind === REVIEW_HANDOFF && isWfRunner(holder.pid)) throw refuse(`another reviewer handoff is being recorded for ${state.id}; one review round at a time`);
    return fn();
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, runId: null, kind: REVIEW_HANDOFF, startedAt: now(), children: [], plugins: [] }));
    fs.closeSync(fd);
    return fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export const gateRunningRefusal = (state, busy) => busy.kind === 'check'
  ? refuse(`a \`wf check\` is running on ${state.id}${busy.pid ? ` (pid ${busy.pid})` : ''}: the implementer is still proving its work`, 'wait for the check to finish, then hand the committed tree to the reviewer')
  : refuse(`a gate is ${busy.runId ? `running on ${state.id} (run ${busy.runId}${busy.pid ? `, pid ${busy.pid}` : ''})` : `starting on ${state.id}`}: review and gate never run side by side, since any finding makes the running gate obsolete`, 'wait for the gate to finish and hand the evidence review to a fresh reviewer then; or, when the tree must change, `wf stop --class tree-change|major-finding|owner-decision --reason "why"`');

export const STOP_CLASSES = ['major-finding', 'tree-change', 'owner-decision'];

// Named failure (I-23): 15 of 16 gates on one ticket were stopped with nothing recorded but free text, so the cost
// (about 175 of 271 gate minutes) was invisible. A stop names its class (required) and records what it threw away: the
// steps still running (interrupted, their time lost: `discardedMinutes`) and the wall-clock minutes the run had spent
// (`wallMinutes`; finished passing steps are kept for reuse by their inputs).
export function stopGate(root, state, reason, cls) {
  if (!STOP_CLASSES.includes(cls)) throw new WfError(`--class is required: one of ${STOP_CLASSES.join(', ')} (why the gate's work is being thrown away)`);
  const file = lockFile(root, state.id);
  if (!fs.existsSync(file)) throw refuse(`no gate is running for ${state.id}`);
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (lock.kind === REVIEW_HANDOFF) throw refuse(`no gate is running for ${state.id} (a reviewer handoff is being recorded)`);
  if (!isWfRunner(lock.pid)) throw refuse(`the gate runner for ${state.id} is gone (pid ${lock.pid}); \`wf gate\` will recover its finished steps`);
  const steps = loadState(root, state.id).gateRuns?.[lock.runId]?.steps ?? [];
  // Discarded work: the steps still running are interrupted and their time is lost; finished passing steps are kept
  // for reuse. A reviewer handed the attempt and not yet recorded means the gate was given up during a review.
  const live = liveGate(root, state);
  const inFlight = (live?.running ?? []).map((r) => ({ id: r.id, seconds: r.seconds }));
  const discardedSeconds = inFlight.reduce((n, r) => n + r.seconds, 0);
  const discardedMinutes = Math.round(discardedSeconds / 6) / 10;
  const started = Date.parse(lock.startedAt);
  const lastReviewer = state.handoffs.filter((h) => h.role === 'reviewer').at(-1);
  const reviewerOpen = Boolean(lastReviewer && !(state.reviews ?? []).some((r) => r.handoff === lastReviewer.bundle) && !(state.reviewRounds ?? []).some((r) => r.bundle === lastReviewer.bundle));
  append(root, state.id, 'gate.stopped', {
    runId: lock.runId,
    kind: lock.kind ?? 'gate',
    reason,
    class: cls,
    stepsFinished: steps.filter((s) => !['skipped', 'deferred', 'reused'].includes(s.status)).length,
    stepsInFlight: inFlight,
    discardedSeconds,
    discardedMinutes,
    wallSeconds: Number.isFinite(started) ? Math.round((Date.now() - started) / 1000) : null,
    wallMinutes: Number.isFinite(started) ? Math.round((Date.now() - started) / 6000) / 10 : null,
    reviewerOpen,
  }, null);
  process.kill(lock.pid, 'SIGTERM');
  return { ...lock, discardedMinutes };
}

// A step (or suite) that failed and then passed with the same inputs and runner: the code did not change, so the
// failure was the environment or the test. Recorded as evidence and shown to the reviewer and in `wf status`.
function flakesIn(state, results) {
  const out = [];
  const earlier = allGateSteps(state);
  for (const r of results.filter((x) => x.status === 'passed' && x.key)) {
    const failed = earlier.filter((s) => s.id === r.id && s.key === r.key && s.status === 'failed').at(-1);
    if (!failed) continue;
    const suites = (failed.suites ?? []).filter((s) => s.status === 'failed' && (r.suites ?? []).some((p) => p.id === s.id && p.status === 'passed')).map((s) => s.id);
    out.push({ step: r.id, key: r.key, failedRun: failed.runId, passedRun: r.runId, suites });
  }
  return out;
}

// Steps a `--focused` gate left out. Such a gate is proof while repairing, never the full proof of a tree.
export const focusedSkips = (g) => (g?.steps ?? []).filter((s) => s.status === 'skipped' && (['focused', 'rerun-failed', 'check'].includes(s.skippedBy) || s.reason === 'focused proof runs light steps only')).map((s) => s.id);

// A passing gate counts only for the exact tree it ran on, and only when it ran every step that tree needs.
export function gatePassedForCurrentTree(state) {
  const g = state.lastGate;
  if (!g || g.status !== 'passed') return { ok: false, reason: g ? `last gate ${g.status}` : 'no gate has run' };
  if ((g.validationDigest ?? null) !== validationDigest(state)) return { ok: false, reason: 'required supplemental validation changed after the last passing gate' };
  const missing = validationIds(state).filter((id) => !g.steps.some((s) => s.id === id && ['passed', 'reused'].includes(s.status)));
  if (missing.length) return { ok: false, reason: `required supplemental validation did not pass: ${missing.join(', ')}` };
  const skipped = focusedSkips(g);
  if (skipped.length) return { ok: false, reason: `the last gate was focused and skipped ${skipped.join(', ')}; run \`wf gate\` without --focused` };
  if (canonical(treeHashes(state)) !== canonical(g.tree)) return { ok: false, reason: 'the code changed after the last passing gate' };
  return { ok: true, gate: g };
}

// Named failure (I-94): a project whose adapter has no capture step could not bring in the captures a criterion required, and
// acceptance found the gap only at the end. The captures the owner imported (`wf captures import`, engine/captures.mjs) are
// part of the gate's screenshots for the tree they were made on: the tree of the last gate, or of the run it was carried from
// when a base merge moved the tree without touching the change. A later change to the tree leaves them behind, as it does a
// gate's own.
export function importedCaptures(state) {
  const trees = [];
  for (const g of [...(state.gates ?? [])].reverse()) {
    trees.push(canonical(g.tree));
    if (!g.carriedFrom) break;
  }
  return (state.captureImports ?? []).filter((i) => trees.includes(canonical(i.tree))).flatMap((i) => i.files);
}

export function screenshots(state) {
  return [...(state.lastGate?.steps ?? []).flatMap((s) => s.artifacts ?? []), ...importedCaptures(state)].filter((a) => a.kind === 'screenshot');
}

