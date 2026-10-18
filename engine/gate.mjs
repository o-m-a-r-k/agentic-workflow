import { gateAdapter, validationCommit, validationDigest, validationIds, validationCatalog } from './validation.mjs';
import { requireYes } from './approve.mjs';
import { FRAMES } from './asking.mjs';
import { mkdirStateDirectory } from './state-folders.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { adapterFileAtCommit, adapterPin, attemptAdapter, expandArtifactGlob, loadConfig, repoDir, trustedAdapter } from './config.mjs';
import { adapterMovedSince } from './adapter-follow.mjs';
import { changedFiles, treeHash, treeHashes, uncommitted, untrackedSnapshot } from './attempt.mjs';
import { chooseShards, chooseWorkers } from './machine.mjs';
import { oneSuitePerId, readJUnitFiles, readPlaywrightSuites } from './junit.mjs';
import { stepFailures } from './failures.mjs';
import { append, attemptDir, listAttempts, loadState } from './ledger.mjs';
import { projectEnv } from './env.mjs';
import { obligationSince } from './versions.mjs';
import { missingFor, redactor, stepEnv } from './secrets.mjs';
import { impact, inside, rel } from './topology.mjs';
import { canonical as canonicalPath } from './paths.mjs';
import { WfError, assertEngine, canonical, git, globToRegExp, hashFile, hashValue, isPidAlive, matchesAny, now, refuse, run, sha256, shellQuote, writeImmutable, writeJson } from './util.mjs';
import { appendStreamNoFollow, ownGateRun, prepareWrite, readRegular, seal, writeNoFollow } from './evidence.mjs';
import { imageSize } from './image-size.mjs';

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
// `legacyHash` is the hash the same files had before 0.7.11, when the workflow's own folder (`skipFolder`) still counted:
// computed in the same pass, so matching a pass recorded then costs no second walk of a large tree.
function stepInputs(state, step, repo, pkg, skipFolder = null) {
  if (!step.inputs?.length) return null;
  const wt = state.repos[repo.name].worktree;
  const fileHashes = {};
  const ownHashes = {};
  for (const f of trackedFiles(wt).filter((x) => inside(x, pkg.path)).sort()) {
    const r = rel(f, pkg.path);
    if (!matchesAny(r, step.inputs) && !matchesAny(r, pkg.sharedInfra)) continue;
    const abs = path.join(wt, f);
    const into = skipFolder && repo.name === skipFolder.repo && inside(f, skipFolder.folder) ? ownHashes : fileHashes;
    into[f] = fs.existsSync(abs) ? hashFile(abs) : 'deleted';
  }
  const hash = hashValue(fileHashes);
  return { hash, fileHashes, legacyHash: Object.keys(ownHashes).length ? hashValue({ ...fileHashes, ...ownHashes }) : hash };
}

// Identity of what runs the step: its definition and the committed plugin code, without the fields that cannot change a
// result (0.7.11): worker counts, which files are kept as evidence (`artifacts`), scheduling (`tier`, `lease`, `deferrable`),
// when it is planned (`when`, `component`, `ignores`) and `prepare` (run by `wf prepare` only, never by the gate). Named
// failure (audit of 51 attempts; one ticket's correction of its evidence glob): the whole definition was hashed, so a
// change to which screenshots count as the ticket's made a 25-minute e2e step look new, though its result could not change.
// `needs` (0.7.30, I-163) only orders steps within a run, and `affects` (0.7.30, I-134) only chooses which specs a run takes: a
// run of chosen specs has a key of its own (planGate), so neither can make a recorded pass mean something else.
export const RESULT_NEUTRAL = ['workers', 'shards', 'artifacts', 'tier', 'lease', 'deferrable', 'when', 'component', 'ignores', 'prepare', 'specs', 'needs', 'affects'];
function pluginHashOf(root, state, step) {
  return step.plugin ? hashFile(adapterFileAtCommit(root, state, validationCommit(state, step.id), step.plugin)) : null;
}
function runnerIdentity(root, live, state, step) {
  const definition = Object.fromEntries(Object.entries(step).filter(([k]) => !RESULT_NEUTRAL.includes(k)));
  return hashValue({ definition, pluginHash: pluginHashOf(root, state, step) });
}
// The identity a step recorded before 0.7.11 under this definition, with the evidence globs it ran with: the whole
// definition minus worker counts. A pass recorded then is reusable when it differs from today's only in its evidence globs.
function legacyRunnerIdentity(root, state, step, artifacts) {
  const { workers, shards, artifacts: _ignored, ...rest } = step;
  const definition = artifacts?.length ? { ...rest, artifacts } : rest;
  return hashValue({ definition, pluginHash: pluginHashOf(root, state, step) });
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

// `legacy(s)` gives the key a step recorded before 0.7.11 would have under today's definition (see runnerIdentity).
function findReuse(state, stepId, key, legacy = null) {
  if (!key) return null;
  return allGateSteps(state).filter((s) => s.id === stepId && ['passed', 'reused'].includes(s.status) && (s.key === key || (legacy && !s.resultIdentity && s.key === legacy(s)))).at(-1) ?? null;
}
const reusedRecord = (state, stepId, runId) => allGateSteps(state).filter((s) => s.id === stepId && s.runId === runId && ['passed', 'reused'].includes(s.status)).at(-1) ?? null;

// Whether files collected under the `before` expanded globs include everything the `now` globs can match: each glob now
// is one of them, or one of them matches it as a path (`e2e/.evidence/**/*.png` covers `e2e/.evidence/t-1/**/*.png`).
// A recorded run holds only the files its globs matched, so narrowing re-selects from it and widening reruns.
// A glob with `**` now is covered only by one that has `**` at the same segment or earlier: `*` matching the literal `**`
// would read a widened glob as narrowed (independent review of 0.7.11).
const deepAt = (g) => g.split('/').indexOf('**');
export const globsCovered = (now, before) => now.every((p) => before.some((q) => q === p || (matchesAny(p, [q]) && (deepAt(p) < 0 || (deepAt(q) >= 0 && deepAt(q) <= deepAt(p))))));

// Which step keys an attempt has passed: a small index kept in the project's scratch folder and rebuilt only when the
// attempt's ledger changed (its size or time), so a plan reads another attempt's ledger once after it changes, and in full
// only for an attempt holding a matching pass. Named cost (independent review of 0.7.12): every plan parsed every other
// attempt's whole ledger (up to 115 MB, ~0.4 GB of memory for two) under its lock. An index that cannot be refreshed (the
// ledger is being written) is used as it stands: a pass recorded is never unrecorded. Null when there is none to use.
function passIndex(root, id) {
  const ledger = path.join(attemptDir(root, id), 'ledger.jsonl');
  const file = path.join(root, '.wf-worktrees', '_passes', `${id}.json`);
  let st;
  try {
    st = fs.statSync(ledger);
  } catch {
    return null;
  }
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && Array.isArray(cached.passes)) return cached.passes;
  let s;
  try {
    s = loadState(root, id);
  } catch {
    return Array.isArray(cached?.passes) ? cached.passes : null;
  }
  const seen = new Set();
  const passes = [];
  for (const x of [...s.gates, ...(s.checks ?? [])].flatMap((g) => g.steps ?? [])) {
    if (!['passed', 'reused'].includes(x.status) || !x.key) continue;
    const k = `${x.id}|${x.key}|${x.resultIdentity ? 1 : 0}`;
    if (seen.has(k)) continue;
    seen.add(k);
    passes.push({ id: x.id, key: x.key, resultIdentity: Boolean(x.resultIdentity) });
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs, passes }));
    fs.renameSync(tmp, file);
  } catch {}
  return passes;
}

// Selection is computed from the adapter committed at the attempt's base, never the worktree copy.
export async function planGate(root, state, options = {}) {
  const live = loadConfig(root);
  const cfg = gateAdapter(root, state);
  const changed = {};
  for (const name of Object.keys(state.repos)) changed[name] = changedFiles(state, name);
  const { adapterRepo, adapterRel, own, namesOwnFolder } = workflowFolder(root, state);
  const adapterTouched = (changed[adapterRepo.name] ?? []).some((f) => inside(f, adapterRel));
  const changedCode = Object.fromEntries(Object.entries(changed).map(([r, files]) => [r, files.filter((f) => !own(r, f))]));
  // A change in the adapter folder no longer makes the run full (0.7.11): the gate reads its steps from the adapter at the
  // pin, never the worktree, and a step whose inputs include the adapter folder sees the change in its inputs hash. Named
  // failure (audit of 51 attempts): 38 step runs for packages with no changed file, after a change to adapter files only.
  const full = options.full === true;
  // The project's other attempts (I-150): their pass indexes, read once per plan and only when a step looks in them; an
  // attempt's ledger is read in full only when its index holds a pass for the key a step looks for.
  let others = null;
  const otherIndexes = () => (others ??= listAttempts(root).filter((x) => x !== state.id).map((x) => ({ id: x, passes: passIndex(root, x) })).filter((x) => x.passes?.length));
  const loaded = new Map();
  const otherState = (x) => {
    if (!loaded.has(x)) {
      try {
        loaded.set(x, loadState(root, x));
      } catch {
        loaded.set(x, null);
      }
    }
    return loaded.get(x);
  };
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
  for (const [repoName, files] of Object.entries(changedCode)) {
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
  const units = artifactUnits(root, state);
  for (const step of cfg.gate.steps) {
    const entry = { id: step.id, repo: step.repo, package: step.package ?? null, tier: step.tier ?? 'light' };
    if (!state.repos[step.repo]) {
      steps.push({ ...entry, decision: 'skip', reason: `repo ${step.repo} is not part of this attempt` });
      continue;
    }
    const { repo, pkg, dir } = stepPackage(cfg, state, step);
    const forStep = namesOwnFolder(step, pkg) ? changed : changedCode;
    const pkgChanged = (forStep[repo.name] ?? []).filter((f) => inside(f, pkg.path));
    // Shared infrastructure (lockfiles, manifests, build config) can change what any step means: no skipping.
    const infraChanged = pkgChanged.some((f) => matchesAny(rel(f, pkg.path), pkg.sharedInfra)) || (forStep[repo.name] ?? []).some((f) => matchesAny(f, repo.sharedInfra ?? []));
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
    if (!mustRun && !alsoChanged.length && !(forStep[repo.name] ?? []).length) {
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
    // 0.7.28 (I-212). Named failure (field): with every heavy step deferred, a ticket's own new end-to-end spec first ran at hour
    // 28, in the batch gate, and no reviewer saw its screenshots before then. A member runs the spec files its own change adds or
    // edits (the step's `specs`, run through its `select`); the whole step still runs in the batch gate.
    let ownSpecs = null;
    if (!full && state.deferHeavy && entry.tier === 'heavy' && step.deferrable !== false) {
      ownSpecs = step.specs?.length && step.select && !step.plugin ? pkgChanged.map((f) => rel(f, pkg.path)).filter((f) => matchesAny(f, step.specs) && fs.existsSync(path.join(dir, f))) : [];
      if (!ownSpecs.length) {
        steps.push({ ...entry, decision: 'defer', reason: 'batch member: heavy steps run in the batch gate' });
        continue;
      }
    }
    // 0.7.30 (I-134, D59): a standard attempt runs only the spec files its change can affect, when the step says which (`specs`
    // and `affects`); any doubt runs the whole step.
    let affected = null;
    let whole = null;
    if (!ownSpecs && !full && state.lane === 'standard' && !state.deferHeavy && entry.tier === 'heavy' && step.affects?.length) {
      const doubt = validationIds(state).includes(step.id) ? 'it is a check the ticket froze as its own' : infraChanged ? 'shared infrastructure changed' : isDependent ? 'it depends on a changed contract' : notCovered.length ? `${notCovered[0]} is outside every step's inputs` : alsoChanged.length ? `${alsoChanged[0]} changed in a repo it also reads` : null;
      const picked = doubt ? { whole: doubt } : affectedSpecs(state, step, repo, pkg, dir, pkgChanged);
      if (picked.specs) affected = picked.specs;
      else whole = picked.whole;
    }
    chooseWorkers(step);
    chooseShards(step);
    const inputs = stepInputs(state, step, repo, pkg, namesOwnFolder(step, pkg) ? null : { repo: adapterRepo.name, folder: adapterRel });
    const runner = runnerIdentity(root, live, state, step);
    const also = alsoInputTrees(root, cfg, state, step);
    const keyOf = (r) => (!inputs || also.unreadable.length ? null : hashValue(also.trees ? { inputs: inputs.hash, runner: r, also: also.trees } : { inputs: inputs.hash, runner: r }));
    // A run of the member's own specs proves those specs only: its key is its own, so it never stands for the whole step. So
    // does a run of the specs a change can affect (I-134).
    const key = ownSpecs && keyOf(runner) ? hashValue({ step: keyOf(runner), ownSpecs }) : affected && keyOf(runner) ? hashValue({ step: keyOf(runner), affectedSpecs: affected }) : keyOf(runner);
    // A pass recorded before 0.7.11 was keyed on the whole definition and on inputs that counted the workflow folder: it is
    // matched on those terms, so an upgrade reruns nothing that 0.7.10 would have reused.
    const recordedBefore = allGateSteps(state).some((s) => s.id === step.id && !s.resultIdentity && ['passed', 'reused'].includes(s.status));
    // Hashed the old way only when no pass matches today's key (a reuse records today's key, so this happens once).
    const inputsBefore = inputs ? { hash: inputs.legacyHash } : inputs;
    const legacyKey = (s) => (!inputsBefore || also.unreadable.length ? null : hashValue(also.trees ? { inputs: inputsBefore.hash, runner: legacyRunnerIdentity(root, state, step, (s.artifactGlobs ?? []).map((g) => g.glob)), also: also.trees } : { inputs: inputsBefore.hash, runner: legacyRunnerIdentity(root, state, step, (s.artifactGlobs ?? []).map((g) => g.glob)) }));
    let prior = findReuse(state, step.id, key, recordedBefore ? legacyKey : null);
    // Which of the recorded run's files are this ticket's evidence now: its expanded globs must cover today's, or it reruns.
    const expandedNow = (step.artifacts ?? []).map((glob) => ({ glob, expanded: expandArtifactGlob(glob, units) }));
    let reselect = null;
    if (prior) {
      const before = (prior.artifactGlobs ?? []).flatMap((g) => g.expanded ?? []);
      const now = expandedNow.flatMap((g) => g.expanded);
      if (canonical(now) !== canonical(before)) {
        if (globsCovered(now, before)) reselect = expandedNow;
        else prior = null;
      }
    }
    let outside = [];
    if (prior) {
      // Since the commit the passing run saw, did anything change in this package that the step's inputs don't
      // cover (and the step doesn't explicitly ignore)? Then the pass says nothing about the current code.
      const ranOn = [...state.gates, ...(state.checks ?? [])].find((g) => g.runId === prior.runId)?.tree?.[repo.name];
      const head = ranOn && /^[0-9a-f]{40}$/.test(ranOn) ? ranOn : null;
      const since = head ? git(state.repos[repo.name].worktree, ['diff', '--name-only', head, 'HEAD']).split('\n').filter(Boolean) : pkgChanged;
      outside = since.filter((f) => inside(f, pkg.path) && (namesOwnFolder(step, pkg) || !own(repo.name, f)) && !matchesAny(rel(f, pkg.path), pkg.docsOnly) && !matchesAny(rel(f, pkg.path), step.inputs ?? ['**']) && !matchesAny(rel(f, pkg.path), step.ignores ?? []));
      if (outside.length || !head) prior = null;
    }
    // A pass another attempt of this project recorded under the same key (inputs, runner, alsoInputs trees), on a tree
    // that differs from this one in no file of the package the step's inputs leave out: the same proof, so it is reused
    // and says where it came from. Only for a step that keeps no evidence files, which are this ticket's own. Named
    // failure (I-150, audit of 51 attempts): 163 reruns had a key another attempt had already passed.
    let fromAttempt = null;
    // Review of 0.7.30 (I-163): a step another step `needs` leaves its output in the worktree it ran in; one reused from
    // another attempt never ran in this one, and its consumer failed its precondition. It is never taken from another attempt.
    const needed = cfg.gate.steps.some((x) => (x.needs ?? []).includes(step.id));
    if (!prior && key && !ownSpecs && !affected && !needed && !step.artifacts?.length && !options.rerunFailed?.includes(step.id)) {
      // The key a pass recorded before 0.7.11 would have here (hashed the old way once, and only if such a pass exists).
      let legacy;
      const legacyAcross = () => {
        if (legacy !== undefined) return legacy;
        const before = inputsBefore;
        const runnerBefore = legacyRunnerIdentity(root, state, step, []);
        return (legacy = !before || also.unreadable.length ? null : hashValue(also.trees ? { inputs: before.hash, runner: runnerBefore, also: also.trees } : { inputs: before.hash, runner: runnerBefore }));
      };
      const found = otherIndexes().filter((x) => x.passes.some((p) => p.id === step.id && (p.key === key || (!p.resultIdentity && p.key === legacyAcross())))).flatMap((x) => {
        const o = otherState(x.id);
        const p = o ? findReuse(o, step.id, key, legacyAcross) : null;
        return p ? [{ o, p }] : [];
      }).sort((a, b) => String(b.p.runId ?? '').localeCompare(String(a.p.runId ?? '')));
      for (const { o, p } of found) {
        const ranOn = [...o.gates, ...(o.checks ?? [])].find((g) => g.runId === p.runId)?.tree?.[repo.name];
        if (!ranOn || !/^[0-9a-f]{40}$/.test(ranOn)) continue;
        let since;
        try {
          since = git(state.repos[repo.name].worktree, ['diff', '--name-only', ranOn, 'HEAD']).split('\n').filter(Boolean);
        } catch {
          continue;
        }
        if (since.some((f) => inside(f, pkg.path) && (namesOwnFolder(step, pkg) || !own(repo.name, f)) && !matchesAny(rel(f, pkg.path), pkg.docsOnly) && !matchesAny(rel(f, pkg.path), step.inputs ?? ['**']) && !matchesAny(rel(f, pkg.path), step.ignores ?? []))) continue;
        prior = p;
        fromAttempt = o.id;
        break;
      }
    }
    if (options.rerunFailed && !prior && !options.rerunFailed.includes(step.id)) {
      steps.push({ ...entry, decision: 'skip', skippedBy: 'rerun-failed', reason: '--rerun-failed reruns only the steps that failed last time' });
      continue;
    }
    // A quick fix runs the light steps (lint, types, unit, build of what it touched): its gate takes minutes, not hours.
    // A heavy step is reused when an identical pass exists, and otherwise runs only when the owner asks for the whole gate
    // (`--full`), the attempt froze it as a validation of its own, or it failed in this attempt and has not passed since: it
    // runs until it passes, whatever changed (a known failure is never skipped into a pass: independent review of 0.7.13;
    // the fix that follows a failure is the hotfix path itself). The person's rule (2026-10-15): "hotfixes should be quick
    // fixes, not ones that take hours"; the independent review stays, and its bundle lists what did not run. A gate that
    // skips them counts for acceptance and delivery. The plugin sets the default; a project's adapter may run every step in
    // its quick fixes (`gate.quickLane: full`).
    if (!prior && !full && state.lane === 'quick' && (cfg.gate.quickLane ?? 'light') === 'light' && entry.tier === 'heavy' && !validationIds(state).includes(step.id)) {
      const last = allGateSteps(state).filter((s) => s.id === step.id && ['passed', 'reused', 'failed'].includes(s.status)).at(-1) ?? null;
      if (last?.status !== 'failed') {
        steps.push({ ...entry, decision: 'skip', skippedBy: 'quick-lane', reason: 'a quick fix runs light steps only (`wf gate --full` runs this one too)', lastResult: last ? { status: last.status, runId: last.runId } : null });
        continue;
      }
    }
    // 0.7.30 (I-158, D58): the person decided to deliver without the full test run (`wf gate light-only`). A heavy step is left
    // out as in a quick fix, on the same terms: an identical pass is still reused, and one that failed in this attempt, or that
    // the ticket froze as its own check, still runs (a known failure is never left out into a pass). `--full` runs it.
    const personal = !prior && !full && entry.tier === 'heavy' ? lightOnlyDecision(state) : null;
    if (personal && !validationIds(state).includes(step.id)) {
      const last = allGateSteps(state).filter((s) => s.id === step.id && ['passed', 'reused', 'failed'].includes(s.status)).at(-1) ?? null;
      if (last?.status !== 'failed') {
        steps.push({ ...entry, decision: 'skip', skippedBy: 'person', personDecision: personal.id, reason: `left out by the person's decision (${personal.id}): delivered without the full test run (\`wf gate --full\` runs it)`, lastResult: last ? { status: last.status, runId: last.runId } : null });
        continue;
      }
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
      ...(ownSpecs ? { ownSpecs } : {}),
      ...(affected ? { affectedSpecs: affected } : {}),
      reason: ownSpecs && !prior ? `batch member: only the spec files this change adds or edits (${ownSpecs.join(', ')}); the whole step runs in the batch gate` : affected && !prior ? `only the spec files this change can affect, by the step's \`affects\` rule (${affected.length}): ${affected.join(', ')}; \`wf gate --full\` runs the whole step` : prior ? `same inputs and runner as ${prior.runId}${fromAttempt ? ` in ${fromAttempt}` : ''}` : outside.length ? `changed file(s) outside this step's inputs since its last pass: ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? '…' : ''}` : notCovered.length ? `changed file(s) outside every step's inputs: ${notCovered.slice(0, 3).join(', ')}${notCovered.length > 3 ? '…' : ''}` : also.unreadable.length ? `cannot read the tree of ${also.unreadable.join(', ')} (alsoInputs): always runs` : key ? (isDependent ? 'dependent of a changed contract' : infraChanged ? 'shared infrastructure changed' : also.trees ? 'inputs or a repo in alsoInputs changed, or never passed' : 'inputs changed or never passed') : 'no `inputs` declared: always runs',
      ...(whole && !prior ? { wholeBecause: whole } : {}),
      reusedFrom: prior?.runId ?? null,
      // The record itself travels with the plan: the other attempt's ledger is not read again when the gate runs.
      ...(fromAttempt ? { reusedFromAttempt: fromAttempt, sourceRecord: prior } : {}),
      ...(prior && reselect ? { reselect } : {}),
      missingSecrets: missingFor(root, cfg, step.id, validationCatalog(root, state, step.id)),
    });
    const last = steps.at(-1);
    if (last.wholeBecause) last.reason = `${last.reason}; the whole step runs: ${last.wholeBecause}`;
  }
  return { cfg, live, changed, impact: imp, full, adapterTouched, focused, check: Boolean(options.check), repos: options.check && options.repos ? [...options.repos] : null, rerunFailed: options.rerunFailed ?? null, steps, unchecked, tree: treeHashes(state) };
}

// 0.7.30 (I-134, D59). Named failure (field): a one-line change reran the whole 1,200-test end-to-end step (27 to 40 minutes); the
// gate could not run only the specs related to the touched modules, so its cost did not scale with the change and unrelated
// flaky specs blocked small fixes. The spec files a change can affect, by the step's `affects` rule: every file of the change
// that the step reads is a spec file itself (it runs) or is in the `paths` of a rule (the rule's `specs` run); one that no rule
// accounts for, or a selection that comes out empty, runs the whole step ({ whole: why }). A suite that did not pass in the
// step's last run in this attempt runs with them, so a known failure is never left out into a pass.
function affectedSpecs(state, step, repo, pkg, dir, pkgChanged) {
  const reads = (r) => !matchesAny(r, pkg.docsOnly) && matchesAny(r, step.inputs ?? ['**']) && !matchesAny(r, step.ignores ?? []);
  const changed = pkgChanged.map((f) => rel(f, pkg.path)).filter(reads);
  if (!changed.length) return { whole: 'no file it reads changed' };
  const specFiles = trackedFiles(state.repos[repo.name].worktree).filter((f) => inside(f, pkg.path)).map((f) => rel(f, pkg.path)).filter((f) => matchesAny(f, step.specs));
  const picked = new Set();
  // Review of 0.7.30: a changed file that matches `specs` was taken to affect only itself; under a broad `specs` glob a helper
  // the specs import is such a file, and the specs importing it were left out of a gate that counted. A spec-matching file a
  // rule's `paths` cover adds that rule's specs too; one no rule covers is in doubt when another spec file names it (its path
  // without the extension, as an import would), and the whole step runs.
  let texts = null;
  const namedBy = (f) => {
    texts ??= new Map(specFiles.map((x) => { try { return [x, fs.readFileSync(path.join(dir, x), 'utf8')]; } catch { return [x, '']; } }));
    const stem = path.posix.basename(f).replace(/\.[^.]+$/, '');
    const parent = path.posix.basename(path.posix.dirname(f));
    const needle = parent && parent !== '.' ? `${parent}/${stem}` : stem;
    return specFiles.filter((x) => x !== f && texts.get(x).includes(needle));
  };
  for (const f of changed) {
    const rules = step.affects.filter((a) => matchesAny(f, a.paths));
    if (matchesAny(f, step.specs)) {
      if (fs.existsSync(path.join(dir, f))) picked.add(f);
      if (!rules.length) {
        const users = namedBy(f);
        if (users.length) return { whole: `${f} matches \`specs\`, no \`affects\` rule covers it, and other spec files name it (${users.slice(0, 5).join(', ')}${users.length > 5 ? ', ...' : ''}): it may be a helper they use` };
        continue;
      }
    } else if (!rules.length) return { whole: `no \`affects\` rule covers ${f}` };
    for (const a of rules) for (const s of specFiles) if (matchesAny(s, a.specs)) picked.add(s);
  }
  const last = allGateSteps(state).filter((s) => s.id === step.id && ['passed', 'failed'].includes(s.status)).at(-1);
  if (last?.status === 'failed') {
    const open = (last.suites ?? []).filter((x) => x.status !== 'passed');
    if (!open.length || open.some((x) => !x.file)) return { whole: 'it failed in its last run and its failing suites are not all known by file' };
    for (const x of open) if (fs.existsSync(path.join(dir, x.file))) picked.add(x.file);
  }
  if (!picked.size) return { whole: 'the `affects` rule picks no spec file for this change' };
  return { specs: [...picked].sort() };
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

// The files of a recorded run that today's expanded globs select, with the units that own each (I-136/WAK correction).
function reselectArtifacts(prior, globsNow, units) {
  const artifacts = (prior.artifacts ?? []).filter((a) => globsNow.some((g) => matchesAny(a.source, g.expanded))).map((a) => ({ ...a, units: units.filter((u) => globsNow.some((g) => matchesAny(a.source, expandArtifactGlob(g.glob, [u])))).map((u) => u.attempt) }));
  return { artifacts, artifactGlobs: globsNow.map((g) => ({ glob: g.glob, expanded: g.expanded, files: artifacts.filter((a) => matchesAny(a.source, g.expanded)) })) };
}

// The workflow's own folder (the adapter, its lessons and step code) is not the project's code: a change there counts for
// a step only when the step's inputs name that folder explicitly (a step that tests the workflow code), never through a
// broad `**`. Named failure (audit of 51 attempts): an attempt whose only change was in that folder (a lesson, the
// adapter) ran ten steps for 32 minutes, seven of them identical to passes already recorded.
// A step that runs or reads something in that folder (its inputs name it, or its command, selection or report path does)
// depends on it (independent review of 0.7.11: `run: bash .workflow/check.sh` was reused after the script changed).
// One rule for the plan and for the quarantine question (third review of 0.7.28: the question named an adapter change as a file
// the step reads).
function workflowFolder(root, state) {
  const { repo: adapterRepo, relative } = attemptAdapter(root, state);
  const adapterRel = relative.split(path.sep).join('/');
  const own = (repoName, f) => repoName === adapterRepo.name && inside(f, adapterRel);
  const namesOwnFolder = (step, pkg) => step.repo === adapterRepo.name && ((step.inputs ?? []).some((p) => { const r = pkg.path === '.' ? p : `${pkg.path}/${p}`; return r === adapterRel || r.startsWith(`${adapterRel}/`); }) || [step.run, step.select, JSON.stringify(step.report ?? null)].some((t) => typeof t === 'string' && t.includes(`${path.basename(adapterRel)}/`)));
  return { adapterRepo, adapterRel, own, namesOwnFolder };
}

// 0.7.28 (I-212): the suites of a step the person set aside for this attempt (`override-gate`, key `quarantine:<attempt>:<step>:<suite>`).
export function quarantinedSuites(state, stepId) {
  const prefix = `quarantine:${state.id}:${stepId}:`;
  return (state.decisions ?? []).filter((d) => d.kind === 'override-gate' && String(d.key).startsWith(prefix) && d.approved?.choice === 'yes').map((d) => String(d.key).slice(prefix.length));
}

// `wf gate quarantine --step <id> --suite <file> --reason "<why>"`: the person's one decision to set aside a suite that failed in the
// last gate and that the delivery does not touch, instead of repair rounds for it. Named failure (field): a batch gate failed five
// times (158 minutes) on end-to-end specs that were flaky before the batch and that it never touched, and each failure became a
// repair round. The engine checks the facts (the suite failed in the last gate on this tree; no file of it is in the delivery's
// change); the person decides; the gate then counts the step passed when that suite is its only failure, and the delivered
// comment says it was not proven.
export function quarantineSuite(root, state, options) {
  const stepId = typeof options.step === 'string' ? options.step : null;
  const suite = typeof options.suite === 'string' ? options.suite.trim() : '';
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
  if (!stepId || !suite || !reason) throw new WfError('usage: wf gate quarantine --step <step id> --suite <the failing suite\'s file, as the gate reported it> --reason "<why it fails before this delivery>"');
  const cfg = gateAdapter(root, state);
  const step = cfg.gate.steps.find((x) => x.id === stepId);
  if (!step) throw refuse(`no gate step \`${stepId}\` (steps: ${cfg.gate.steps.map((x) => x.id).join(', ')})`, null, { id: 'gate:quarantine-step' });
  const last = state.lastGate;
  const ran = last?.steps?.find((x) => x.id === stepId);
  const failing = (ran?.suites ?? []).filter((x) => x.status === 'failed').map((x) => x.file ?? x.id);
  if (!last || canonical(last.tree) !== canonical(treeHashes(state)) || !failing.includes(suite)) throw refuse(`${suite} did not fail in ${stepId} in the last gate on this tree${failing.length ? ` (failed there: ${failing.join(', ')})` : ''}`, 'only a suite that failed in the last gate on the tree as it is can be set aside: run `wf gate`, then name a suite it reports failed', { id: 'gate:quarantine-not-failing' });
  const { repo, pkg } = stepPackage(cfg, state, step);
  const file = pkg.path === '.' ? suite : `${pkg.path}/${suite}`;
  if (changedFiles(state, repo.name).includes(file)) throw refuse(`${suite} is changed by this delivery (${repo.name}:${file}): its failure is this delivery's to fix`, 'fix it through the implementer that changed it; only a suite the delivery does not touch can be set aside', { id: 'gate:quarantine-touched' });
  // Review of 0.7.28 (M1). Named failure (a review's case): the question said "this change does not touch it" when the engine had
  // only seen that the test file is not in the diff; a change to the code the suite exercises (a service it calls) can be what
  // fails it, and with the agent's "flaky before this ticket" beside it the person would set aside the regression it shows. The
  // question says only what was checked, names every file the change edits that the step reads, and gives the agent's reason
  // as the agent's. Running the suite on the base tree would make the claim true, but a heavy suite needs the project's whole
  // environment (services, secrets, leases) in a base worktree: not something the engine can do cheaply for every project.
  // What the step reads, as the gate itself reads it (its inputs, less its ignores and the package's docs-only files), in its own
  // repo and in every repo it declares (`alsoInputs`); a repo of the attempt it does not declare is named apart (review of 0.7.28:
  // a README was listed as read, and in a multi-repo attempt an api change that breaks a portal suite was not listed at all).
  // The workflow's own folder counts only for a step that names it, as the gate's plan has it (`changedCode`).
  const wfFolder = workflowFolder(root, state);
  const code = (name) => (f) => wfFolder.namesOwnFolder(step, pkg) && name === repo.name ? true : !wfFolder.own(name, f);
  const reads = (f) => inside(f, pkg.path) && f !== file && !matchesAny(rel(f, pkg.path), pkg.docsOnly ?? []) && matchesAny(rel(f, pkg.path), step.inputs ?? ['**']) && !matchesAny(rel(f, pkg.path), step.ignores ?? []);
  const own = changedFiles(state, repo.name).filter(code(repo.name)).filter(reads).map((f) => `${repo.name}:${f}`);
  const notDocs = (name) => (f) => {
    const other = cfg.repos.find((r) => r.name === name);
    const p = [...(other?.packages ?? [])].filter((x) => inside(f, x.path)).sort((a, b) => b.path.length - a.path.length)[0];
    return !p || !matchesAny(rel(f, p.path), p.docsOnly ?? []);
  };
  const also = (step.alsoInputs ?? []).filter((name) => state.repos[name]).flatMap((name) => changedFiles(state, name).filter(code(name)).filter(notDocs(name)).map((f) => `${name}:${f}`));
  const read = [...own, ...also];
  const undeclared = Object.keys(state.repos).filter((name) => name !== repo.name && !(step.alsoInputs ?? []).includes(name)).map((name) => [name, changedFiles(state, name).filter(code(name)).filter(notDocs(name)).length]).filter(([, n]) => n > 0);
  const elsewhere = undeclared.length ? ` This change also edits ${undeclared.map(([name, n]) => `${n} file(s) in ${name}`).join(' and ')}, which the step does not declare it reads (\`alsoInputs\`); a suite that drives ${undeclared.length > 1 ? 'those repos' : 'that repo'} can fail because of ${undeclared.length > 1 ? 'them' : 'it'}.` : '';
  const checked = `What the engine checked: this change does not edit the test file. ${read.length ? `What it did not check: whether the code the suite exercises changed; this change edits ${read.length} file(s) the step reads: ${read.join(', ')}.` : `This change edits no other file the step reads (its declared inputs${step.alsoInputs?.length ? ` in ${[repo.name, ...step.alsoInputs].join(', ')}` : ''}).`}${elsewhere}`;
  const setAsideFrame = {
    question: `Should ${state.item ?? state.id} ship with the test suite ${suite} (${stepId}) set aside for this delivery, instead of more repair rounds? It failed in the gate. ${checked} The agent's reason: ${reason.replace(/[.\s]+$/, '')}.`,
    labels: { yes: 'Set it aside and ship', no: 'No, fix it in this delivery' },
    then: { yes: `the gate counts ${stepId} passed while ${suite} is its only failure; the delivered comment says that suite was not proven`, no: `${suite} stays a failure: it is fixed in this delivery before the gate passes` },
  };
  const approval = requireYes(root, state, { kind: 'override-gate', key: `quarantine:${state.id}:${stepId}:${suite}`, summary: `set aside ${suite} of ${stepId} for this delivery: the change does not edit the test file${read.length ? ` and edits ${read.length} file(s) the step reads` : ' nor any other file the step reads'}${undeclared.length ? `; it also edits ${undeclared.map(([name]) => name).join(', ')}, which the step does not declare` : ''} (the agent's reason: ${reason})`, what: `setting aside ${suite} of ${stepId}`, frame: setAsideFrame, options });
  return { decision: approval.decision, step: stepId, suite };
}

// 0.7.30 (I-158, D58): the person's answered decision to deliver this attempt without the full test run, or null.
export const lightOnlyDecision = (state) => (state.decisions ?? []).find((d) => d.kind === 'override-gate' && d.key === `light-only:${state.id}` && d.approved?.choice === 'yes' && !d.withdrawn) ?? null;

// `wf gate light-only --reason "<why>"`: the person's one decision to deliver without the full test run. Named failure (field):
// the person said "skip the full gate but do the review"; the engine had decisions to run the gate out of order and to correct a
// frozen check, but none for this, so their choice could not be recorded without working around the gate's acceptance. The
// question says what would not run, what passed on this code so far and what still runs; the gate then leaves the heavy steps
// out (planGate) and counts, the evidence reviewer is handed what did not run (`notRun`), and the delivered comment says so.
// The light steps still run: they take minutes, and the gate's record is what acceptance and delivery read (as in a quick fix,
// D23).
export async function lightOnly(root, state, options) {
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
  if (!reason) throw new WfError('usage: wf gate light-only --reason "<why: the person\'s words when they asked for it>"');
  const cfg = gateAdapter(root, state);
  if (state.lane === 'quick' && (cfg.gate.quickLane ?? 'light') === 'light') throw refuse(`a quick fix's gate already runs the light steps only: ${state.id} needs no decision for it`, 'run `wf gate`', { id: 'gate:light-only-quick' });
  const plan = await planGate(root, state, {});
  const frozen = validationIds(state);
  const lastOf = (id) => allGateSteps(state).filter((s) => s.id === id && ['passed', 'reused', 'failed'].includes(s.status)).at(-1)?.status ?? null;
  // What the plan would do without the decision: a step it already leaves out by this decision counts as one that would run.
  const wouldRun = plan.steps.filter((s) => s.tier === 'heavy' && (s.decision === 'run' || s.skippedBy === 'person'));
  const failed = wouldRun.filter((s) => lastOf(s.id) === 'failed').map((s) => s.id);
  const own = wouldRun.filter((s) => frozen.includes(s.id) && !failed.includes(s.id)).map((s) => s.id);
  const leftOut = wouldRun.map((s) => s.id).filter((id) => !failed.includes(id) && !own.includes(id));
  if (!leftOut.length) {
    const why = [failed.length ? `failed in this attempt (${failed.join(', ')})` : '', own.length ? `is a check the ticket froze as its own (${own.join(', ')})` : ''].filter(Boolean).join(' or ');
    throw refuse(`nothing to leave out: ${why ? `every heavy step of ${state.id} that would run ${why}; a known failure is never left out into a pass` : `no heavy step of ${state.id} would run on this code`}`, 'run `wf gate`', { id: 'gate:light-only-nothing' });
  }
  const tree = canonical(treeHashes(state));
  const proven = [...new Set([...state.gates, ...(state.checks ?? [])].filter((g) => canonical(g.tree ?? {}) === tree).flatMap((g) => g.steps ?? []).filter((s) => ['passed', 'reused'].includes(s.status)).map((s) => s.id))];
  const stillRun = [...plan.steps.filter((s) => s.tier !== 'heavy' && s.decision === 'run').map((s) => s.id), ...failed.map((id) => `${id} (it failed in this attempt)`), ...own.map((id) => `${id} (the ticket's own check)`)];
  const approval = requireYes(root, state, { kind: 'override-gate', key: `light-only:${state.id}`, summary: `deliver ${state.item ?? state.id} without the full test run: ${leftOut.join(', ')} would not run${proven.length ? `; passed on this code: ${proven.join(', ')}` : '; nothing has passed on this code yet'} (the agent's reason: ${reason})`, what: 'delivering without the full test run', frame: FRAMES.lightOnly({ item: state.item ?? state.id, leftOut, proven, stillRun, reason }), options });
  return { decision: approval.decision, leftOut, stillRun };
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
    const kind = /\.(png|jpe?g|webp|gif)$/i.test(r) ? 'screenshot' : 'file';
    const a = { path: dest, sha256: sha256(bytes), kind, ...(kind === 'screenshot' ? sizeOf(bytes) : {}), source: r, units: owners };
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

function suitesToRerun(prior, planned, { listsEverySuite = false } = {}) {
  const priorHashes = priorFileHashes(prior);
  if (!prior?.suites?.length || !priorHashes || !planned.fileHashes) return null;
  prior = { ...prior, fileHashes: priorHashes };
  const files = Object.keys(planned.fileHashes);
  // An exact path first; a suffix that matches more than one file names none, so the suite reruns (0.7.6 review: a top-level
  // b.spec.ts could take a/b.spec.ts's hash).
  const fileOf = (suite) => {
    if (!suite.file) return null;
    if (files.includes(suite.file)) return suite.file;
    const near = files.filter((f) => f.endsWith(`/${suite.file}`) || suite.file.endsWith(`/${f}`));
    return near.length === 1 ? near[0] : null;
  };
  const suiteFiles = new Set(prior.suites.map(fileOf).filter(Boolean));
  const nonSuite = (hashes) => hashValue(Object.fromEntries(Object.entries(hashes).filter(([f]) => !suiteFiles.has(f))));
  if (nonSuite(prior.fileHashes) !== nonSuite(planned.fileHashes)) return null;
  const rerun = [];
  for (const s of prior.suites) {
    const f = fileOf(s);
    if (!f || s.status !== 'passed' || prior.fileHashes[f] !== planned.fileHashes[f]) rerun.push(s.file ?? s.id);
  }
  // A report that names only the suites that ran (JUnit) leaves out the ones a run that stopped early never reached (Jest
  // --bail): every input named like a suite (the last two parts of a reported suite's file name, `.e2e-spec.ts`, so
  // `invoice.service.e2e-spec.ts` and `auth.e2e-spec.ts` are named alike) that the prior run did not report is rerun too,
  // so a suite that never ran is never passed over (independent review of 0.7.6).
  if (!listsEverySuite) {
    const suffix = (f) => {
      const parts = path.basename(f).split('.');
      return parts.length >= 3 && parts[0] ? `.${parts.slice(-2).join('.')}` : null;
    };
    // A suite file named with its extension alone (`login.ts`) does not say which other inputs are suites: rerun whole.
    if ([...suiteFiles].some((f) => !suffix(f))) return null;
    const suffixes = new Set([...suiteFiles].map(suffix));
    for (const f of files) if (!suiteFiles.has(f) && suffixes.has(suffix(f)) && planned.fileHashes[f] !== 'deleted') rerun.push(f);
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
    artifacts.push({ ...a, path: managed, sha256: sha256(bytes), ...(/\.(png|jpe?g|webp|gif)$/i.test(managed) ? sizeOf(bytes) : {}), source });
  }
  return { artifacts, problems };
}

// I-117: a screenshot's measured pixel size, for the reviewer to compare with the viewport its criterion names.
const sizeOf = (bytes) => {
  const s = imageSize(bytes);
  return s ? { width: s.width, height: s.height } : {};
};

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
  // Playwright's JSON report names every test it found, run or not; a JUnit report names only the suites that ran.
  // A batch member's own specs (I-212) are what this run runs; nothing an earlier whole run passed is carried into it.
  // The spec files a standard attempt's change can affect (I-134) are likewise all this run runs.
  const onlySpecs = planned.ownSpecs?.length ? planned.ownSpecs : planned.affectedSpecs?.length ? planned.affectedSpecs : null;
  const rerun = onlySpecs ?? (step.select ? suitesToRerun(prior, planned, { listsEverySuite: Boolean(step.report?.playwright) }) : null);
  const vars = { workers: workers.n, shards: shards.n, evidence: scratch };
  vars.select = rerun ? substitute(step.select, { suites: rerun.map(shellQuote).join(' ') }) : '';
  // The report files present before the run, by signature: only a report this run wrote or rewrote is read after it (one an
  // earlier run left at a fixed path is not this run's; a run that died before writing would otherwise be read as the
  // earlier run's suites, and their passes carried).
  const reportSignature = (f) => {
    try {
      const st = fs.statSync(f);
      return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return null;
    }
  };
  const reportGlobs = step.plugin ? [] : [step.report?.junit, step.report?.playwright].flat().filter(Boolean);
  const reportsBefore = new Map(reportGlobs.flatMap((p) => globFiles(planned.dir, substitute(p, vars))).map((f) => [f, reportSignature(f)]));
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
    const fresh = (f) => !reportsBefore.has(f) || reportsBefore.get(f) !== reportSignature(f);
    const files = (step.report?.junit ? [step.report.junit].flat() : []).flatMap((p) => globFiles(planned.dir, substitute(p, vars))).filter(fresh);
    // The suites come from a JUnit report, or from Playwright's JSON report (0.7.6, I-118), so `select` reruns only what failed.
    const playwrightFiles = (step.report?.playwright ? [step.report.playwright].flat() : []).flatMap((p) => globFiles(planned.dir, substitute(p, vars))).filter(fresh);
    // One suite per id (0.7.6 review: a step with both reports listed each spec twice, once with no file, so it reran whole).
    let suites = oneSuitePerId([...readJUnitFiles(files), ...readPlaywrightSuites(playwrightFiles)]);
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
    // A suite the gate asked to rerun that this run did not report (the runner died before writing, or ran something else)
    // stays as `not-run`, rerun the next time, and the step does not pass (independent review of 0.7.6: it was dropped, so a
    // later gate went green without it). Suites it was not asked to rerun are carried.
    let unreported = [];
    if (rerun && prior?.suites && !onlySpecs) {
      const fresh = new Map(suites.map((s) => [s.id, s]));
      const reported = (s) => fresh.has(s.id) || (s.file && [...fresh.values()].some((x) => x.file === s.file));
      const requested = (s) => rerun.includes(s.file ?? s.id);
      unreported = prior.suites.filter((s) => requested(s) && !reported(s)).map((s) => ({ ...s, status: 'not-run', carried: undefined }));
      suites = [...prior.suites.filter((s) => !reported(s) && !requested(s)).map((s) => ({ ...s, carried: true })), ...unreported, ...fresh.values()];
    }
    const interrupted = codes.some((c) => c.signal);
    // Independent review of 0.7.6: a run whose exit code was swallowed (`|| true`, a wrapper) passed with a test that never
    // started. Only this run's suites count (a carried suite ran in an earlier run).
    const neverStarted = suites.filter((s) => !s.carried && s.neverStarted > 0).map((s) => s.file ?? s.id);
    const failed = codes.some((c) => c.code !== 0) || suites.some((s) => s.status === 'failed') || unreported.length > 0 || neverStarted.length > 0;
    // 0.7.28 (I-212): a suite the person set aside for this delivery (a pre-existing failure the delivery does not touch,
    // `wf gate quarantine`) does not fail the step when it is the step's only failure; the step records it, and the reviewer and
    // the delivered comment see it.
    const setAside = quarantinedSuites(state, step.id);
    const failedSuites = suites.filter((x) => x.status === 'failed' && !x.carried).map((x) => x.file ?? x.id);
    const onlySetAside = failed && failedSuites.length > 0 && failedSuites.every((f) => setAside.includes(f)) && !suites.some((x) => x.status === 'failed' && x.carried) && !unreported.length && !neverStarted.length;
    result = { status: interrupted ? 'interrupted' : failed && !onlySetAside ? 'failed' : 'passed', suites, exitCodes: codes.map((c) => c.code), artifacts: [], ...(onlySetAside ? { quarantined: failedSuites } : {}), ...(unreported.length ? { unreported: unreported.map((s) => s.file ?? s.id) } : {}), ...(neverStarted.length ? { neverStarted } : {}) };
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
    resultIdentity: true,
    inputsHash: planned.inputsHash,
    reason: planned.reason,
    fileHashesRef,
    runnerIdentity: planned.runnerIdentity,
    ...result,
    rerunSuites: rerun,
    ...(planned.ownSpecs?.length ? { ownSpecs: planned.ownSpecs } : {}),
    ...(planned.affectedSpecs?.length ? { affectedSpecs: planned.affectedSpecs } : {}),
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
// What a lease wait says after the lease's name: who holds the slots, the waiting run's place among the live waiters (when it is
// known), and how capacity is raised (the project's current config, read again while waiting).
export function leaseWaitText(name, holders = leaseHolders(name), queue = null) {
  const by = holders.length ? `held by ${holders.map(describeHolder).join(', ')}` : 'held by a process that has just let go';
  const place = queue?.place ? `; place ${queue.place} of ${queue.of} waiting (the live run waiting longest goes next)` : '';
  return `${by}${place}. To allow more at once, raise \`gate.leases.${name}\` in the project's .workflow/project.yaml (a waiting run reads it again every ${LEASE_REREAD_MS / 1000} seconds)`;
}

// ---- Fair admission among live waiters (0.7.30, I-157, D57) ----
// Named failure (field): a small focused proof waited more than 35 minutes for the Docker lease while other live runs kept
// taking it. Every waiting run polled (a gate every 500 ms, `wf run` every second) and whichever asked first after a slot freed
// took it. Now a waiting run marks itself beside the lease's slots (`docker.wait.<pid>.<tag>`: since when it waits, and what it
// is) every time it asks, and a free slot goes to the live waiters in the order they began to wait: a run takes one only when
// fewer live runs than there are free slots have waited longer. The mark is no queue and no reservation (principle 8): a mark
// whose process is gone is skipped and removed, one not refreshed for WAITER_FRESH_MS (its run stopped asking, or the pid was
// reused) counts for nothing, and a run that takes its slot, or stops waiting, removes its own. A `wf` older than this one
// takes a free slot as before; slots are still taken only through the exclusive create in `takeMachineLease`.
const WAITER_FRESH_MS = 20000;
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const waiterFileOf = (name, tag, pid = process.pid) => path.join(leasesDir(), `${leaseBase(name)}.wait.${pid}.${hashValue(String(tag)).slice(0, 12)}`);
function noteWaiter(name, tag, since, who = null) {
  const file = waiterFileOf(name, tag);
  try {
    mkdirStateDirectory(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, tag: String(tag), since, ...(who ?? {}) }));
  } catch {}
  return file;
}
const dropWaiter = (file) => {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
};
// The live runs waiting for a lease, the one waiting longest first.
export function leaseWaiters(name) {
  const dir = leasesDir();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const re = new RegExp(`^${escapeRe(leaseBase(name))}\\.wait\\.(\\d+)\\.([0-9a-f]{12})$`);
  const out = [];
  for (const n of names) {
    const m = re.exec(n);
    if (!m) continue;
    const file = path.join(dir, n);
    const pid = Number(m[1]);
    if (!isPidAlive(pid)) {
      dropWaiter(file);
      continue;
    }
    let st;
    let w;
    try {
      st = fs.statSync(file);
      w = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (Date.now() - st.mtimeMs > WAITER_FRESH_MS || w?.pid !== pid || !Number.isFinite(Date.parse(w.since))) continue;
    out.push({ pid, file, since: w.since, tag: w.tag ?? null, attempt: w.attempt ?? null, step: w.step ?? null, command: w.command ?? null });
  }
  return out.sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.pid - b.pid || a.file.localeCompare(b.file));
}
// A waiting run's place among the live waiters (1 = goes next), or null when it holds none.
export function waiterPlace(name, tag, pid = process.pid) {
  const all = leaseWaiters(name);
  const at = all.findIndex((w) => w.file === waiterFileOf(name, tag, pid));
  return at >= 0 ? { place: at + 1, of: all.length } : null;
}
// Takes a slot for a waiting run when its turn has come: { slot, file, place, of, free }. `me` is { tag, since }: the same tag and
// first `since` every time the same run asks, so its place is kept while it keeps asking.
function takeFairLease(name, capacity, who, me) {
  const file = noteWaiter(name, me.tag, me.since, who);
  const free = capacity - leaseHolders(name).length;
  const all = leaseWaiters(name);
  const at = all.findIndex((w) => w.file === file);
  const place = at >= 0 ? at : all.length;
  const slot = free > 0 && place < free ? takeMachineLease(name, capacity, who) : null;
  if (slot) dropWaiter(file);
  return { slot, file, place: place + 1, of: Math.max(all.length, place + 1), free };
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

// The slot of a machine-wide lease for a `wf run` (a command, or a step's preparation), once it is this run's turn; null when no
// lease is named. Named failure (I-88, residual): capacity was read once, so a lease raised in the project's config while this
// command waited never reached it (docker.1 held, `gate.leases.docker` raised to 2, and `wf run --lease docker` kept waiting).
// The waiting loop reads the project's current config again, as a waiting gate step does.
async function waitForLease(cfg, name, who, { log = process.stderr, root = null } = {}) {
  if (!name) return null;
  const configured = root ? leaseConfigReader(root, cfg.gate.leases) : () => cfg.gate.leases ?? {};
  const capacityNow = () => configured()[name] ?? 1;
  let capacity = capacityNow();
  // 0.7.30 (I-157): the slot goes to the live run that waited longest; this run says its place when it waits and as it moves up.
  const me = { tag: 'wf run', since: now() };
  let turn = takeFairLease(name, capacity, who, me);
  let slot = turn.slot;
  const dropOnExit = () => turn.file && dropWaiter(turn.file);
  if (!slot) process.once('exit', dropOnExit);
  if (!slot) log.write(`wf run: waiting for a \`${name}\` lease (${capacity} slot(s), ${turn.free > 0 ? 'a free one goes to a run that has waited longer' : 'all held'}): ${leaseWaitText(name, undefined, turn)}\n`);
  let place = turn.place;
  while (!slot) {
    await new Promise((r) => setTimeout(r, 1000));
    const capNow = capacityNow();
    if (capNow !== capacity) {
      log.write(`wf run: lease \`${name}\` now allows ${capNow} slot(s) (it was ${capacity}), from the project config\n`);
      capacity = capNow;
    }
    turn = takeFairLease(name, capacity, who, me);
    slot = turn.slot;
    if (!slot && turn.place !== place) log.write(`wf run: place ${turn.place} of ${turn.of} waiting for the \`${name}\` lease\n`);
    place = turn.place;
  }
  process.off('exit', dropOnExit);
  dropOnExit();
  return slot;
}

// `wf run --lease <name> -- <cmd>`: an implementer's docker or end-to-end stack takes the same machine-wide slot a gate
// step would, so concurrent attempts cannot start more stacks than `gate.leases` allows. Named failure: stacks started
// outside the `docker: 1` lease overloaded the machine. The slot is held by this process and freed when it exits.
export async function runWithLease(cfg, name, command, { log = process.stderr, cwd, env, redact, root = null } = {}) {
  const slot = await waitForLease(cfg, name, { command: path.basename(String(command?.[0] ?? '')) }, { log, root });
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
  // 0.7.30 (I-155, D59): a plugin step prepares through its plugin's own `prepare(ctx)`, committed at the attempt's base like its
  // `run`. Named failure (field): a runtime plugin provisioned its isolated private dependencies only inside a check or a gate,
  // the step declared no `prepare` command, and `wf check` refuses uncommitted work: lint before the first commit could not run.
  const declared = typeof step.prepare === 'string' && step.prepare.trim() ? step.prepare : null;
  const plugin = !declared && step.plugin ? await stepPlugin(root, state, step) : null;
  if (plugin?.prepare === false) {
    process.stdout.write(`step ${step.id} needs no preparation (its plugin says \`prepare: false\`)\n`);
    return 0;
  }
  if (!declared && typeof plugin?.prepare !== 'function') throw refuse(`step \`${step.id}\` declares no \`prepare\` command${step.plugin ? ' and its plugin has no `prepare`' : ''}`, step.plugin ? 'add `prepare(ctx)` to the plugin\'s default export (it installs what the step needs into the worktree; committed with the plugin), or `prepare: "<install command>"` to the step, in the committed adapter' : 'add `prepare: "<install command>"` to the step in the committed adapter', { id: 'run:no-prepare' });
  const missing = missingFor(root, cfg, step.id, validationCatalog(root, state, step.id));
  if (missing.length) throw refuse(`secrets missing for step ${step.id}: ${missing.join(', ')}`, 'run `wf secrets guide` in your terminal');
  const { dir } = stepPackage(cfg, state, step);
  const env = projectEnv(cfg, { ...stepEnv(root, cfg, step.id, validationCatalog(root, state, step.id)), WF_ROOT: root, WF_ATTEMPT: state.id, WF_ITEM: String(state.item ?? state.id) });
  const redact = redactor(root, cfg);
  if (declared) return runWithLease(loadConfig(root), lease ?? step.lease ?? null, ['sh', '-c', declared], { cwd: dir, env, redact, root });
  // The plugin runs in this process, as in a gate: it is handed the step's filtered environment (`ctx.env`, the step's secrets
  // with it), never an evidence path, and what it logs is masked on its way out.
  const slot = await waitForLease(loadConfig(root), lease ?? step.lease ?? null, { command: `prepare ${step.id}` }, { root });
  try {
    const pctx = { root, attempt: state.id, step, dir, worktrees: Object.fromEntries(Object.entries(state.repos).map(([k, v]) => [k, v.worktree])), env, log: (line) => process.stdout.write(redact(`${line}\n`)) };
    const r = await plugin.prepare(pctx);
    if (r?.status === 'failed') {
      process.stderr.write(`wf run: step ${step.id}: its plugin's prepare reported failed\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    process.stderr.write(redact(`wf run: step ${step.id}: its plugin's prepare threw: ${error?.message ?? error}\n`));
    return 1;
  } finally {
    if (slot) releaseMachineLease(slot);
  }
}

// A step's plugin module as committed for the attempt (the copy a gate runs).
async function stepPlugin(root, state, step) {
  return (await import(pathToFileURL(adapterFileAtCommit(root, state, validationCommit(state, step.id), step.plugin)).href)).default;
}

// `wf doctor` (0.7.30, I-155): a plugin step with no preparation route. Named failure: a runtime plugin provisioned its isolated
// dependencies only inside a check or gate, and nothing said so before an implementer needed them before its first commit. Doctor
// cannot see what a plugin installs, so a plugin with nothing to prepare says so (`prepare: false` on its default export); a step
// with a `prepare` command, or whose plugin exports `prepare(ctx)`, has its route. Read from the adapter committed at `commit`.
export async function prepareRouteWarnings(root, cfg, commit) {
  const out = [];
  for (const step of cfg.gate.steps.filter((s) => s.plugin && !(typeof s.prepare === 'string' && s.prepare.trim()))) {
    let mod;
    try {
      mod = await stepPlugin(root, { id: 'doctor', adapterBase: commit, validations: [] }, step);
    } catch {
      continue;
    }
    if (mod?.prepare === false || typeof mod?.prepare === 'function') continue;
    out.push({ check: `preparation of step ${step.id}`, problem: `a plugin step with no preparation route: \`wf run --step ${step.id}\` cannot prepare its dependencies before the first commit, and \`wf check\` refuses uncommitted work; if its plugin installs anything when it runs (a runtime with private or isolated dependencies), an implementer cannot lint or test before committing`, fix: `export \`prepare(ctx)\` from the plugin's default export (it installs into \`ctx.dir\` with the step's secrets in \`ctx.env\`; \`wf run --step ${step.id}\` runs it), or say it needs none with \`prepare: false\` there; commit it on the adapter base branch` });
  }
  return out;
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
  const run = { children: new Set(), machine: new Map(), handlers: [], waiters: new Map() };
  try {
    return await executeRun(root, state, plan, live, run);
  } catch (error) {
    killGroups(run.children);
    throw error;
  } finally {
    for (const slot of run.machine.values()) releaseMachineLease(slot);
    for (const file of run.waiters.values()) dropWaiter(file);
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
  const waiting = new Map(); // step id -> { lease, capacity, since, place }: queued behind a full lease (shown by `wf status`)
  const waiterTag = (id) => `${runId}:${id}`; // what names a step's mark among the machine's lease waiters (I-157)
  const saveProgress = () => writeJson(progressFile(root, state.id, runId), { runId, pid: process.pid, steps: results, running: [...runningNow].map(([id, at]) => ({ id, startedAt: new Date(at).toISOString() })), waiting: [...waiting].map(([id, w]) => ({ id, lease: w.lease, capacity: w.capacity, since: new Date(w.since).toISOString(), tag: waiterTag(id) })) });
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
  // A pass reused from another attempt brings its log into this run's evidence, verified against the sha256 that run
  // recorded: the proof then lives with the attempt that relies on it. Named failure (independent review of 0.7.12): the
  // log stayed in the other attempt, and releasing that attempt's evidence left this one citing a file that was gone. A log
  // that cannot be read or does not match makes the step run.
  const copiedLogs = new Map();
  for (const s of plan.steps.filter((x) => x.decision === 'reuse' && x.reusedFromAttempt)) {
    const from = s.sourceRecord?.log;
    const read = from ? readRegular(from) : null;
    if (!read || (s.sourceRecord.logSha256 && sha256(read.bytes) !== s.sourceRecord.logSha256)) {
      // It runs now, so it needs its secrets like any step planned to run (second review of 0.7.12).
      if (s.missingSecrets?.length) throw refuse(`secrets missing: ${s.id} needs ${s.missingSecrets.join(', ')} (the pass it would have reused from ${s.reusedFromAttempt} has no readable log, so it runs)`, 'run `wf secrets guide` in your terminal');
      Object.assign(s, { decision: 'run', reason: `the log of ${s.reusedFrom} in ${s.reusedFromAttempt} ${read ? 'differs from its recorded sha256' : 'cannot be read'}: runs`, reusedFrom: null, reusedFromAttempt: undefined, sourceRecord: undefined });
      continue;
    }
    const dir = path.join(runDir, s.id);
    const log = path.join(dir, 'output.log');
    prepareWrite(log);
    mkdirStateDirectory(dir, { recursive: true });
    writeNoFollow(log, read.bytes, { exclusive: true });
    copiedLogs.set(s.id, { log, logSha256: sha256(read.bytes) });
  }
  const queue = plan.steps.filter((s) => s.decision === 'run').map((s, i) => ({ s, i, heavy: s.tier === 'heavy' ? 1 : 0, d: lastDuration(s.id) }))
    .sort((a, b) => a.heavy - b.heavy || (a.heavy ? b.d - a.d : 0) || a.i - b.i)
    .map((x) => x.s);
  for (const s of plan.steps.filter((x) => x.decision === 'reuse')) {
    const prior = s.sourceRecord ?? reusedRecord(state, s.id, s.reusedFrom);
    // Recorded under today's key and identity, so the next gate finds it directly; the evidence is re-selected when the
    // step's globs narrowed since the run (files the run collected, by their source path, unchanged bytes).
    const picked = s.reselect ? reselectArtifacts(prior, s.reselect, artifactUnits(root, state)) : null;
    results.push({ ...prior, ...(picked ?? {}), ...(copiedLogs.get(s.id) ?? {}), key: s.key, runnerIdentity: s.runnerIdentity, resultIdentity: true, status: 'reused', reusedFrom: prior.runId, reusedFromAttempt: s.reusedFromAttempt ?? null, reason: s.reselect ? `${s.reason}; evidence re-selected by the step's current globs` : s.reason, runId });
  }
  for (const s of plan.steps.filter((x) => ['skip', 'defer'].includes(x.decision))) results.push({ id: s.id, repo: s.repo, tier: s.tier, status: s.decision === 'defer' ? 'deferred' : 'skipped', reason: s.reason, skippedBy: s.skippedBy, ...(s.lastResult !== undefined ? { lastResult: s.lastResult } : {}), runId });
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
  const leaseWaits = new Map();
  const leaseOf = (p) => plan.cfg.gate.steps.find((x) => x.id === p.id).lease;
  // Named failure (I-113): a check waiting for a full lease printed nothing after "N to run", and `wf status` said only "waiting
  // for a lease". The wait names the lease, who holds its slots and how capacity is raised, once when it begins (again when
  // the capacity it waits on changes), and `progress.json` carries it for `wf status` and `wf resume`.
  let waitingChanged = false;
  // 0.7.30 (I-157): the step's place among the machine's live waiters is said when it begins to wait and whenever it moves.
  const noteWaiting = (p, lease, capacity, since, turn = null) => {
    const was = waiting.get(p.id);
    if (was && was.lease === lease && was.capacity === capacity && was.place === (turn?.place ?? null)) return;
    waiting.set(p.id, { lease, capacity, since, place: turn?.place ?? null });
    waitingChanged = true;
    say(`waiting  ${p.id}  for lease ${lease} (${capacity} slot(s), all held): ${leaseWaitText(lease, undefined, turn)}`);
  };
  // 0.7.30 (I-163, D56). Named failure (field): a full gate started browser-only proof steps while the Docker-leased steps that
  // prepare their isolated dependencies waited for capacity; one consumer failed its dependency precondition in 0.2 seconds just
  // after its producer started, which later passed. The first startable step was taken, so a blocked lease reordered steps. A
  // step that names the steps whose output it consumes (`needs`) starts only after each of them that runs in this run has
  // finished; one whose producer failed, was interrupted or never started is not started, with why. A producer this run does
  // not run (reused, skipped) left its output in an earlier run, or has none to give: nothing waits for it.
  const inRun = new Set(queue.map((p) => p.id));
  const ended = new Map(); // step id -> how it ended in this run (or `not-started` for one that never will)
  const blocked = [];
  const needsOf = (p) => (plan.cfg.gate.steps.find((x) => x.id === p.id).needs ?? []).filter((n) => inRun.has(n) && n !== p.id);
  const pendingNeeds = (p) => needsOf(p).filter((n) => !ended.has(n));
  const toldAfter = new Set();
  const notStart = (p, reason) => {
    queue.splice(queue.indexOf(p), 1);
    ended.set(p.id, 'not-started');
    blocked.push({ id: p.id, repo: p.repo, tier: p.tier, status: 'not-started', reason, runId });
    say(`${'not-started'.padEnd(8)} ${p.id}  ${reason}`);
  };
  const ENDED_WELL = ['passed', 'reused', 'skipped'];
  const pruneBlocked = () => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const p of [...queue]) {
        const bad = needsOf(p).find((n) => ended.has(n) && !ENDED_WELL.includes(ended.get(n)));
        if (!bad) continue;
        const how = ended.get(bad);
        notStart(p, `needs ${bad}, which ${how === 'not-started' ? 'did not start' : how === 'interrupted' ? 'was interrupted' : how}: it was not started`);
        changed = true;
      }
    }
  };
  // Leases are machine-wide: two gates on one machine (other attempts or projects) never share a docker slot.
  const canStart = (p) => {
    const pending = pendingNeeds(p);
    if (pending.length) {
      if (!toldAfter.has(p.id)) {
        toldAfter.add(p.id);
        say(`after    ${p.id}  waits for ${pending.join(', ')} (it needs ${pending.length > 1 ? 'their' : 'its'} output)`);
      }
      return false;
    }
    const lease = leaseOf(p);
    if (!lease) return true;
    const capacity = capacityOf(lease);
    // 0.7.30 (I-157, D57): a free slot goes to the live run waiting longest, this step's place kept from when it began to wait.
    // When this run already holds every slot, the step still marks its place (it can only go after one of its own steps).
    const who = { attempt: state.id, step: p.id, run: runId };
    const since = waiting.get(p.id)?.since ?? Date.now();
    const me = { tag: waiterTag(p.id), since: new Date(since).toISOString() };
    let turn = null;
    if ((held[lease] ?? 0) >= capacity) run.waiters.set(p.id, noteWaiter(lease, me.tag, me.since, who));
    else {
      turn = takeFairLease(lease, capacity, who, me);
      if (turn.slot) run.waiters.delete(p.id);
      else run.waiters.set(p.id, turn.file);
    }
    if (!turn?.slot) {
      noteWaiting(p, lease, capacity, since, turn);
      return false;
    }
    machine.set(p.id, turn.slot);
    return true;
  };
  await new Promise((resolve) => {
    wake = resolve;
    // The step taken off the queue and not yet handed to a job: if the scheduler fails right there, it goes back, not-started.
    let starting = null;
    const pump = () => {
      try {
        pruneBlocked();
        while (!stopping && active.size < max) {
          const idx = queue.findIndex(canStart);
          if (idx < 0) break;
          const p = queue.splice(idx, 1)[0];
          starting = p;
          const lease = leaseOf(p);
          if (lease) held[lease] = (held[lease] ?? 0) + 1;
          // How long it waited for a slot another gate held: recorded with its result (audit of one project: 22% of gate
          // time had no step running, and nothing recorded why).
          const waited = waiting.get(p.id);
          if (waited) leaseWaits.set(p.id, { lease: waited.lease, seconds: Math.round((Date.now() - waited.since) / 1000) });
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
                if (leaseWaits.has(p.id)) final = { ...final, leaseWait: leaseWaits.get(p.id) };
                const secs = ((Date.now() - runningNow.get(p.id)) / 1000).toFixed(1);
                runningNow.delete(p.id);
                try {
                  await retryWhileLocked(() => append(root, state.id, 'gate.step', { runId, step: final }, null));
                } catch (error) {
                  final = { ...final, status: 'failed', error: `the step finished ${r.status} but recording it failed: ${error.message}` };
                }
                results.push(final);
                ended.set(p.id, final.status);
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
        // A step that cannot ask for its lease now (every job slot of this run is busy) holds no place among the machine's
        // waiters until it asks again (I-157): it keeps the time it began to wait, but a free slot never sits idle for it.
        if (active.size >= max) for (const [id, file] of [...run.waiters]) {
          dropWaiter(file);
          run.waiters.delete(id);
        }
        // Nothing runs and every queued step waits for another queued step: they need each other (a registered check can
        // extend the gate after the adapter's own cycle check), so none of them can start.
        if (active.size === 0 && !stopping && queue.length && queue.every((p) => pendingNeeds(p).length)) for (const p of [...queue]) notStart(p, `needs ${pendingNeeds(p).join(', ')}, which need it in turn (a cycle): it was not started`);
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
  results.push(...blocked);
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
  const record = { runId, status, producedUntracked, changed: plan.changed, full: plan.full, focused: plan.focused, check: plan.check || undefined, repos: plan.repos ?? undefined, rerunFailed: plan.rerunFailed ?? undefined, adapterBase: adapterPin(state), validationDigest: validationDigest(state), tree: plan.tree, impact: plan.impact, unchecked: plan.unchecked, ...(Object.keys(leaseCapacity).length ? { leaseCapacity } : {}), ...(leaseWaits.size ? { leaseWaitSeconds: Math.max(...[...leaseWaits.values()].map((w) => w.seconds)) } : {}), ...(ownerStop ? { stop: { class: ownerStop.class, reason: ownerStop.reason } } : {}), ...(fatal ? { error: ctx.redact(String(fatal.message ?? fatal)) } : {}), steps: results, finishedAt: now() };
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

// The last whole run of a step on this attempt: one that ran to its end (passed or failed) over every suite. A reused one ran
// nothing, a stopped one ended early, and a rerun of only the failed suites is shorter (independent review of 0.7.16).
function lastRunOf(state, id) {
  const last = allGateSteps(state).filter((s) => s.id === id && ['passed', 'failed'].includes(s.status) && typeof s.durationMs === 'number' && !s.rerunSuites?.length).at(-1);
  return last ? { lastSeconds: Math.round(last.durationMs / 1000) } : {};
}

// The latest complete line of a step's live log: what the step is doing now, in its own words. Only lines that end in a
// newline count: the gate holds back the tail of a step's output until it can redact it, so the file usually ends mid-line.
// Read like every evidence file (independent review of 0.7.16): never through a link, never blocking on a FIFO, never a file
// with another name elsewhere; anything else shows nothing.
export function latestLogLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) return {};
    const length = Math.min(st.size, 16384);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, st.size - length);
    const text = buf.toString('utf8');
    const complete = text.slice(0, Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1);
    // eslint-disable-next-line no-control-regex
    const line = complete.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).at(-1);
    return line ? { latest: line.length > 160 ? `…${line.slice(-159)}` : line } : {};
  } catch {
    return {};
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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
    // How far a long step is (0.7.16): its last run's duration on this attempt, and the latest line of its live log (written
    // redacted as it runs). Named failure: an owner waiting on a 27-minute end-to-end step could not tell test 200 from 1,100.
    running: (progress.running ?? []).map((r) => ({ id: r.id, seconds: Math.round((at - Date.parse(r.startedAt)) / 1000), ...lastRunOf(state, r.id), ...latestLogLine(path.join(gateDir(root, state.id), lock.runId, r.id, 'output.log')) })),
    // Steps queued behind a full lease (I-113), with the lease's current holders read now.
    waiting: (progress.waiting ?? []).map((w) => {
      const queue = w.tag ? waiterPlace(w.lease, w.tag, lock.pid) : null;
      return { id: w.id, lease: w.lease, capacity: w.capacity, seconds: Math.round((at - Date.parse(w.since)) / 1000), ...(queue ? { place: queue.place, of: queue.of } : {}), text: leaseWaitText(w.lease, undefined, queue) };
    }),
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
  // 0.7.30 (I-151, D60): a gate counts at the adapter it ran under; a move of the adapter since that changed what it ran (or
  // what this tree may need) leaves it standing no longer.
  const moved = adapterMovedSince(state, g);
  if (moved) return { ok: false, reason: moved };
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
  return [...(state.lastGate?.steps ?? []).flatMap((s) => (s.artifacts ?? []).map((a) => (a.step ? a : { ...a, step: s.id }))), ...importedCaptures(state)].filter((a) => a.kind === 'screenshot');
}

