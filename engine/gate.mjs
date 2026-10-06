import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { adapterFileAtCommit, adapterLocation, expandArtifactGlob, loadConfig, loadConfigAtCommit, repoDir } from './config.mjs';
import { changedFiles, treeHash, treeHashes, uncommitted, untrackedSnapshot } from './attempt.mjs';
import { chooseShards, chooseWorkers } from './host.mjs';
import { readJUnitFiles } from './junit.mjs';
import { append, attemptDir, loadState } from './ledger.mjs';
import { projectEnv } from './env.mjs';
import { missingFor, redactor, stepEnv } from './secrets.mjs';
import { impact, inside, rel } from './topology.mjs';
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
  const pluginHash = step.plugin ? hashFile(adapterFileAtCommit(root, live, state.adapterBase, step.plugin)) : null;
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
  const cfg = loadConfigAtCommit(root, live, state.adapterBase);
  const changed = {};
  for (const name of Object.keys(state.repos)) changed[name] = changedFiles(state, name);
  const { repo: adapterRepo, relative } = adapterLocation(root, live);
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
    const mustRun = full || infraChanged || isDependent || notCovered.length > 0;
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
      missingSecrets: missingFor(root, cfg, step.id),
    });
  }
  return { cfg, live, changed, impact: imp, full, adapterTouched, focused, check: Boolean(options.check), rerunFailed: options.rerunFailed ?? null, steps, unchecked, tree: treeHashes(state) };
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
    fs.mkdirSync(path.dirname(dest), { recursive: true });
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
    fs.mkdirSync(path.dirname(to), { recursive: true });
    writeNoFollow(to, r.bytes, { exclusive: true });
  }
}

async function executeStep(root, cfg, state, planned, ctx) {
  const step = cfg.gate.steps.find((s) => s.id === planned.id);
  const evidenceDir = path.join(ctx.runDir, step.id);
  prepareWrite(path.join(evidenceDir, 'x'));
  fs.mkdirSync(evidenceDir, { recursive: true });
  const logFile = path.join(evidenceDir, 'output.log');
  // Steps and plugins write their reports into a scratch folder outside the evidence; the engine copies it in after
  // the step (WF_EVIDENCE and {evidence} name the scratch folder). Their processes are never handed an evidence path.
  const scratch = path.join(root, '.wf-worktrees', '_gate', state.id, ctx.runId, step.id);
  fs.mkdirSync(scratch, { recursive: true });
  const workers = chooseWorkers(step);
  const shards = chooseShards(step);
  // An allowlisted environment, never the owner's whole one (session tokens included): see engine/env.mjs.
  // WF_ITEM / WF_ITEMS say WHICH tickets' captures the run is for (a batch runs its members' heavy steps); where the
  // tests write them is the project's convention, matched by the step's `artifacts` globs.
  const units = artifactUnits(root, state);
  const env = projectEnv(cfg, { ...stepEnv(root, cfg, step.id), WF_ROOT: root, WF_ATTEMPT: state.id, WF_ITEM: String(state.item ?? state.id), WF_ITEMS: [...new Set(units.map((u) => String(u.item)))].join(' '), WF_STEP: step.id, WF_EVIDENCE: scratch, WF_WORKERS: String(workers.n) });
  const started = Date.now();
  const prior = allGateSteps(state).filter((s) => s.id === step.id && s.status !== 'reused' && s.suites).at(-1);
  const rerun = step.select ? suitesToRerun(prior, planned) : null;
  const vars = { workers: workers.n, shards: shards.n, evidence: scratch };
  vars.select = rerun ? substitute(step.select, { suites: rerun.map(shellQuote).join(' ') }) : '';
  let result;
  if (step.plugin) {
    const mod = (await import(pathToFileURL(adapterFileAtCommit(root, ctx.live, state.adapterBase, step.plugin)).href)).default;
    const pctx = { root, attempt: state.id, step, dir: planned.dir, worktrees: Object.fromEntries(Object.entries(state.repos).map(([k, v]) => [k, v.worktree])), changed: ctx.changedSinceBase, evidenceDir: scratch, workers: workers.n, env, log: (s) => writeNoFollow(logFile, ctx.redact(`${s}\n`), { append: true }) };
    const decision = mod.plan ? await mod.plan(pctx) : null;
    if (decision && decision.run === false) {
      return { id: step.id, repo: step.repo, tier: planned.tier, key: planned.key, inputsHash: planned.inputsHash, runnerIdentity: planned.runnerIdentity, status: 'skipped', reason: decision.reason ?? 'step plugin decided not to run', suites: [], artifacts: [], runId: ctx.runId };
    }
    ctx.running.set(step.id, { plugin: mod, ctx: pctx });
    ctx.onPlugin(step.id, true);
    try {
      const r = await mod.run(pctx);
      result = { status: r.status, suites: r.suites ?? [], artifacts: (r.artifacts ?? []).map((a) => ({ ...a, sha256: a.sha256 ?? hashFile(a.path) })) };
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
    let suites = readJUnitFiles(files);
    for (const f of files) {
      prepareWrite(path.join(evidenceDir, `junit-${path.basename(f)}`));
      const junit = readRegular(f);
      if (junit) writeNoFollow(path.join(evidenceDir, `junit-${path.basename(f)}`), junit.bytes);
    }
    if (rerun && prior?.suites) {
      const fresh = new Map(suites.map((s) => [s.id, s]));
      suites = [...prior.suites.filter((s) => !fresh.has(s.id) && !rerun.includes(s.file ?? s.id)).map((s) => ({ ...s, carried: true })), ...fresh.values()];
    }
    const interrupted = codes.some((c) => c.signal);
    const failed = codes.some((c) => c.code !== 0) || suites.some((s) => s.status === 'failed');
    result = { status: interrupted ? 'interrupted' : failed ? 'failed' : 'passed', suites, exitCodes: codes.map((c) => c.code), artifacts: [] };
  }
  copyScratch(scratch, evidenceDir);
  const collected = collectArtifacts(step, planned.dir, path.join(evidenceDir, 'artifacts'), started, units);
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
// One file per slot (`docker.1`, `docker.2`…), created exclusively; a slot whose holder process is gone is free.
function takeMachineLease(name, capacity) {
  const dir = leasesDir();
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= capacity; i++) {
    const file = path.join(dir, `${name.replace(/[^\w.-]/g, '_')}.${i}`);
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return file;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = Number(fs.readFileSync(file, 'utf8') || 0);
      if (holder && holder !== process.pid && !isPidAlive(holder)) {
        fs.rmSync(file, { force: true });
        i--;
      }
    }
  }
  return null;
}

// `wf run --lease <name> -- <cmd>`: an implementer's docker or end-to-end stack takes the same machine-wide slot a gate
// step would, so concurrent attempts cannot start more stacks than `gate.leases` allows. Named failure: stacks started
// outside the `docker: 1` lease overloaded the machine. The slot is held by this process and freed when it exits.
export async function runWithLease(cfg, name, command, { log = process.stderr } = {}) {
  const capacity = cfg.gate.leases?.[name] ?? 1;
  let slot = takeMachineLease(name, capacity);
  if (!slot) log.write(`wf run: waiting for a \`${name}\` lease (${capacity} slot(s), all held)\n`);
  while (!slot) {
    await new Promise((r) => setTimeout(r, 1000));
    slot = takeMachineLease(name, capacity);
  }
  try {
    return await new Promise((resolve) => {
      const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
      const forward = (sig) => child.kill(sig);
      process.on('SIGINT', forward);
      process.on('SIGTERM', forward);
      child.on('error', (error) => {
        log.write(`wf run: ${error.message}\n`);
        resolve(127);
      });
      child.on('exit', (code, signal) => {
        process.off('SIGINT', forward);
        process.off('SIGTERM', forward);
        resolve(code ?? (signal ? 128 : 1));
      });
    });
  } finally {
    fs.rmSync(slot, { force: true });
  }
}

// A pid in the lock belongs to us only if it is still a `wf` process (pids are reused after a crash).
function isWfRunner(pid) {
  if (!isPidAlive(pid)) return false;
  const cmd = run('ps', ['-o', 'command=', '-p', String(pid)], { allowFail: true }).stdout;
  return /(^|[\s/])wf(\s|$)/.test(cmd);
}

async function harvest(root, state, lock) {
  for (const pid of lock.children ?? []) {
    try {
      process.kill(-pid, 'SIGTERM'); // the step's process group; members survive their shell leader
    } catch {}
  }
  if (lock.plugins?.length) {
    const live = loadConfig(root);
    const cfg = loadConfigAtCommit(root, live, state.adapterBase);
    for (const id of lock.plugins) {
      const step = cfg.gate.steps.find((s) => s.id === id);
      if (!step?.plugin) continue;
      try {
        const mod = (await import(pathToFileURL(adapterFileAtCommit(root, live, state.adapterBase, step.plugin)).href)).default;
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
  assertEngine(loadConfigAtCommit(root, live, state.adapterBase));
  // `wf check` needs only the repos it checks to be committed; a gate needs every repo.
  const dirty = Object.fromEntries(Object.entries(uncommitted(state)).filter(([r]) => !options.check || !options.repos || options.repos.includes(r)));
  if (Object.keys(dirty).length) throw refuse(`commit changes before the ${options.check ? 'check' : 'gate'}: ${Object.entries(dirty).map(([r, l]) => `${r} (${l.slice(0, 5).join('; ')}${l.length > 5 ? `; +${l.length - 5} more` : ''})`).join(', ')}`);
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

// One line per event, written as it happens, so a gate run in the background shows progress in its log.
function failureExcerpt(result, redact) {
  const suite = (result.suites ?? []).find((x) => x.status === 'failed');
  if (suite) return [`first failure: ${suite.id}${suite.file && suite.file !== suite.id ? ` (${suite.file})` : ''}`];
  if (result.error) return [redact(result.error)];
  if (!result.log || !fs.existsSync(result.log)) return [];
  const lines = fs.readFileSync(result.log, 'utf8').split('\n').filter((l) => l.trim());
  return lines.slice(-5).map((l) => redact(l));
}

async function execute(root, state, plan, live = null) {
  const runId = `${now().replace(/[:.]/g, '-')}-${process.pid}`;
  const runDir = path.join(gateDir(root, state.id), runId);
  ownGateRun(root, state.id, runId);
  prepareWrite(path.join(runDir, 'x'));
  fs.mkdirSync(runDir, { recursive: true });
  append(root, state.id, 'gate.started', { runId, kind: plan.check ? 'check' : 'gate' }, null);
  const lockData = { pid: process.pid, runId, kind: plan.check ? 'check' : 'gate', startedAt: now(), tree: plan.tree, children: [], plugins: [] };
  const persistLock = () => writeJson(lockFile(root, state.id), lockData);
  persistLock();
  const children = new Set();
  const ctx = {
    runId,
    runDir,
    live: plan.live,
    redact: redactor(root, plan.cfg),
    running: new Map(),
    changedSinceBase: plan.changed,
    addChild: (pid) => {
      children.add(pid);
      lockData.children.push(pid);
      persistLock();
    },
    onPlugin: (id, on) => {
      lockData.plugins = on ? [...lockData.plugins, id] : lockData.plugins.filter((x) => x !== id);
      persistLock();
    },
  };
  const results = [];
  const runningNow = new Map(); // step id -> start time
  const saveProgress = () => writeJson(progressFile(root, state.id, runId), { runId, pid: process.pid, steps: results, running: [...runningNow].map(([id, at]) => ({ id, startedAt: new Date(at).toISOString() })) });
  const say = (line) => live?.write(`wf ${plan.check ? 'check' : 'gate'}: ${line}\n`);
  let stopping = false;
  const onSignal = async () => {
    if (stopping) return;
    stopping = true;
    for (const pid of children) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {}
    }
    for (const { plugin, ctx: pctx } of ctx.running.values()) {
      try {
        await plugin.cleanup?.(pctx);
      } catch {}
    }
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

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

  const leases = plan.cfg.gate.leases ?? {};
  const held = {};
  const machine = new Map(); // step id -> machine-wide lease slot file
  const max = Math.max(1, plan.cfg.gate.maxParallelSteps ?? 1);
  const active = new Set();
  const leaseOf = (p) => plan.cfg.gate.steps.find((x) => x.id === p.id).lease;
  // Leases are machine-wide: two gates on one machine (other attempts or projects) never share a docker slot.
  const canStart = (p) => {
    const lease = leaseOf(p);
    if (!lease) return true;
    if ((held[lease] ?? 0) >= (leases[lease] ?? 1)) return false;
    const slot = takeMachineLease(lease, leases[lease] ?? 1);
    if (!slot) return false;
    machine.set(p.id, slot);
    return true;
  };
  await new Promise((resolve) => {
    const pump = () => {
      while (!stopping && active.size < max) {
        const idx = queue.findIndex(canStart);
        if (idx < 0) break;
        const p = queue.splice(idx, 1)[0];
        const lease = leaseOf(p);
        if (lease) held[lease] = (held[lease] ?? 0) + 1;
        runningNow.set(p.id, Date.now());
        saveProgress();
        say(`start    ${p.id}`);
        const job = executeStep(root, plan.cfg, state, p, ctx)
          .catch((error) => ({ id: p.id, repo: p.repo, tier: p.tier, key: p.key, status: 'failed', error: error.message, runId }))
          .then((r) => {
            if (lease) held[lease] -= 1;
            if (machine.has(p.id)) fs.rmSync(machine.get(p.id), { force: true });
            const final = stopping && r.status !== 'passed' ? { ...r, status: 'interrupted' } : r;
            const secs = ((Date.now() - runningNow.get(p.id)) / 1000).toFixed(1);
            runningNow.delete(p.id);
            results.push(final);
            append(root, state.id, 'gate.step', { runId, step: final }, null);
            saveProgress();
            say(`${final.status.padEnd(8)} ${p.id}  ${secs}s`);
            if (final.status === 'failed') for (const line of failureExcerpt(final, ctx.redact)) say(`  ${p.id} | ${line}`);
            active.delete(job);
            pump();
          });
        active.add(job);
      }
      if (active.size === 0 && (queue.length === 0 || stopping)) return resolve();
      // A step waiting for a lease another gate holds: look again shortly.
      if (queue.length && !stopping) setTimeout(pump, 500);
    };
    pump();
  });
  for (const slot of machine.values()) fs.rmSync(slot, { force: true });
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  for (const p of queue) results.push({ id: p.id, repo: p.repo, tier: p.tier, status: 'not-started', runId });

  const bad = results.filter((r) => ['failed', 'interrupted', 'not-started'].includes(r.status));
  const status = stopping ? 'stopped' : bad.length ? 'failed' : 'passed';
  // Untracked files the steps produced (reports, screenshots) are recorded so they do not block the next gate.
  const producedUntracked = {};
  for (const [name, r] of Object.entries(state.repos)) producedUntracked[name] = untrackedSnapshot(r.worktree);
  say(`${status} (${runId})`);
  const record = { runId, status, producedUntracked, changed: plan.changed, full: plan.full, focused: plan.focused, check: plan.check || undefined, rerunFailed: plan.rerunFailed ?? undefined, adapterBase: state.adapterBase, tree: plan.tree, impact: plan.impact, unchecked: plan.unchecked, steps: results, finishedAt: now() };
  writeImmutable(path.join(runDir, 'result.json'), `${JSON.stringify(record, null, 2)}\n`);
  // Recorded before the run is: once it is finished, an unrecorded file in its folder is an extra file.
  seal(append, { root, id: state.id, runId });
  append(root, state.id, plan.check ? 'check.finished' : 'gate.finished', { ...record, evidence: path.join(runDir, 'result.json') }, null);
  const flaky = flakesIn(state, results);
  if (flaky.length) append(root, state.id, 'gate.flaky', { runId, flaky }, null);
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
    finished: (progress.steps ?? []).map((r) => ({ id: r.id, status: r.status, seconds: r.durationMs !== undefined && r.status !== 'reused' ? Math.round(r.durationMs / 1000) : null })),
  };
}

export function stopGate(root, state, reason) {
  const file = lockFile(root, state.id);
  if (!fs.existsSync(file)) throw refuse(`no gate is running for ${state.id}`);
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isWfRunner(lock.pid)) throw refuse(`the gate runner for ${state.id} is gone (pid ${lock.pid}); \`wf gate\` will recover its finished steps`);
  append(root, state.id, 'gate.stopped', { runId: lock.runId, reason }, null);
  process.kill(lock.pid, 'SIGTERM');
  return lock;
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
  const skipped = focusedSkips(g);
  if (skipped.length) return { ok: false, reason: `the last gate was focused and skipped ${skipped.join(', ')}; run \`wf gate\` without --focused` };
  if (canonical(treeHashes(state)) !== canonical(g.tree)) return { ok: false, reason: 'the code changed after the last passing gate' };
  return { ok: true, gate: g };
}

export function screenshots(state) {
  return (state.lastGate?.steps ?? []).flatMap((s) => s.artifacts ?? []).filter((a) => a.kind === 'screenshot');
}

