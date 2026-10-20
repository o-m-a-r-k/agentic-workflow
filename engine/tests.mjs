// Tests (design-0.8 section 2, step 4; stream 2). `wf test fast|full|risk-base` runs one repo's tests on the attempt's
// tree and records `test.run` against the tree the tests ran on. A spec is a shell command (`run`) or a module
// (`{ repo, path }`), and may name a machine-wide counted lock that every project on the machine shares.
//
// Named failures this module answers:
// - Push-to-main with no CI: a `full` run is the only proof of a landed tree, so the tree it ran on is recorded, never
//   assumed (merge:untested reads it).
// - Tests that asserted nothing: `risk-base` runs the repo's `fast` tests at the merge-base with the attempt's changed
//   test files (`kinds.tests`) applied; they must fail there when a reviewer's risk needs a failing test.
// - Parallel attempts starving one machine: a lock with a count, held across projects, in the user folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { WfError, append, attemptDir, attemptState, changedFiles, loadAdapter, userDir, worktreeDir } from './contract.mjs';
import { baseRef, specOf } from './base.mjs';
import { baseModuleFile } from './base-module.mjs';
import { projectEnv } from './env.mjs';
import { endProcessTree } from './process-tree.mjs';
import { mkdirStateDirectory } from './state-folders.mjs';

export const KINDS = ['fast', 'full', 'risk-base'];
const LOCK_POLL_MS = 250;

// ---- git -----------------------------------------------------------------------------------------------------------

export function git(cwd, args, { allowFail = false, env } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new WfError(`git failed to start in ${cwd}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new WfError(`git ${args.join(' ')} failed (exit ${r.status}) in ${cwd}:\n${(r.stderr || r.stdout).trim()}`);
  return allowFail ? { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() } : r.stdout.trim();
}

// The tree the files in `dir` make right now: tracked and untracked files git does not ignore, committed or not. The
// implementer tests before committing, so HEAD's tree is not the tree that was tested; after the commit they are equal.
export function workingTree(dir) {
  const index = path.join(os.tmpdir(), `wf-index-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const head = git(dir, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'], { allowFail: true });
    if (head.status === 0) git(dir, ['read-tree', 'HEAD'], { env });
    git(dir, ['add', '-A', '.'], { env });
    return git(dir, ['write-tree'], { env });
  } finally {
    fs.rmSync(index, { force: true });
  }
}

export const mkdirs = (dir) => {
  mkdirStateDirectory(dir, { recursive: true });
  return dir;
};

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// ---- the machine-wide counted lock -----------------------------------------------------------------------------------

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

const held = new Set();
let exitHook = false;
function releaseAllSync() {
  for (const file of held) fs.rmSync(file, { force: true });
  held.clear();
}

// One of `count` slots of the lock `name`, shared by every project on this machine (they share the user folder). A slot
// whose holder process is gone is taken over. Waits as long as the slots are held: the waiting is reported, not capped.
export async function acquireLock(spec, owner, { env = process.env, onWait } = {}) {
  if (!spec) return null;
  const name = String(spec.name ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw new WfError(`lock name \`${name}\` must be letters, digits, dot, dash or underscore`);
  const count = Number(spec.count ?? 1);
  if (!Number.isInteger(count) || count < 1) throw new WfError(`lock \`${name}\` count must be a whole number of at least 1, got ${spec.count}`);
  const dir = path.join(userDir(env), 'locks', name);
  fs.mkdirSync(dir, { recursive: true });
  if (!exitHook) {
    exitHook = true;
    process.on('exit', releaseAllSync);
  }
  const startedAt = Date.now();
  let told = false;
  for (;;) {
    for (let i = 0; i < count; i++) {
      const file = path.join(dir, `slot-${i}.json`);
      try {
        const fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), ...owner }));
        fs.closeSync(fd);
        held.add(file);
        return { name, count, slot: i, file, waitedMs: Date.now() - startedAt };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let holder = null;
        try {
          holder = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          // Being written right now, or removed: look again on the next pass.
          continue;
        }
        if (holder.host === os.hostname() && !alive(holder.pid)) {
          // Rename first: only one waiter takes a dead holder's slot over.
          const moved = `${file}.stale-${process.pid}`;
          try {
            fs.renameSync(file, moved);
            fs.rmSync(moved, { force: true });
          } catch {}
          i -= 1;
        }
      }
    }
    if (!told && onWait) {
      told = true;
      onWait(lockHolders(spec, { env }));
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}

export function releaseLock(lock) {
  if (!lock) return;
  fs.rmSync(lock.file, { force: true });
  held.delete(lock.file);
}

// Who holds the lock now (for messages and doctor).
export function lockHolders(spec, { env = process.env } = {}) {
  const dir = path.join(userDir(env), 'locks', String(spec.name));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^slot-\d+\.json$/.test(f)).map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// ---- provisioning a scratch worktree (risk-base, landing) -------------------------------------------------------------

function cloneTree(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tries = process.platform === 'darwin' ? [['-c', '-R'], ['-R']] : [['--reflink=auto', '-R'], ['-R']];
  for (const flags of tries) if (spawnSync('cp', [...flags, src, dest]).status === 0) return;
  throw new WfError(`could not copy ${src} to ${dest}`);
}

const fileHash = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);

// Make `dir` runnable like `from` (a provisioned checkout of the same repo): clone the dependency folders, copy the
// ignored files, and run the install when a fingerprint file differs (the cloned dependencies would not match).
export function provisionFrom(from, dir, provision, env) {
  const p = { clone: [], copyIgnored: [], fingerprint: [], install: null, ...(provision ?? {}) };
  const drift = p.fingerprint.some((rel) => fileHash(path.join(from, rel)) !== fileHash(path.join(dir, rel)));
  if (!drift) for (const rel of p.clone) if (fs.existsSync(path.join(from, rel)) && !fs.existsSync(path.join(dir, rel))) cloneTree(path.join(from, rel), path.join(dir, rel));
  for (const rel of p.copyIgnored) {
    const src = path.join(from, rel);
    if (fs.existsSync(src) && !fs.existsSync(path.join(dir, rel))) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.copyFileSync(src, path.join(dir, rel));
    }
  }
  if (p.install && (drift || p.clone.some((rel) => !fs.existsSync(path.join(dir, rel))))) {
    const r = spawnSync('sh', ['-c', p.install], { cwd: dir, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new WfError(`install \`${p.install}\` failed (exit ${r.status}) in ${dir}:\n${(r.stderr || r.stdout).trim().slice(-2000)}`);
  }
}

// ---- running one spec -----------------------------------------------------------------------------------------------

export function repoSpec(adapter, repo) {
  const spec = adapter.repos.find((r) => r.name === repo);
  if (!spec) throw new WfError(`no repo \`${repo}\` in the adapter; its repos are: ${adapter.repos.map((r) => r.name).join(', ')}`);
  return spec;
}

export function testSpec(adapter, repo, kind) {
  const spec = repoSpec(adapter, repo).tests?.[kind === 'risk-base' ? 'fast' : kind];
  if (!spec || (!spec.run && !spec.module)) throw new WfError(`repo \`${repo}\` has no \`${kind === 'risk-base' ? 'fast' : kind}\` tests in the adapter (repos[].tests.${kind === 'risk-base' ? 'fast' : kind})`);
  return spec;
}

// Run one spec in `cwd`, writing its output to `log`. A module spec is `{ repo, path }`, loaded from the repo's fetched
// base (baseModule), never from the tree it judges. Returns { pass, exitCode, ms }. Never throws for a failing test;
// throws WfError when the spec cannot start.
export async function execute({ spec, cwd, log, env, ctx, root, adapter }) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const t0 = Date.now();
  if (spec.module) {
    const file = baseModule(root, adapter, spec.module, 'test module');
    let pass = false;
    let text = '';
    try {
      const mod = await import(pathToFileURL(file).href);
      if (typeof mod.default !== 'function') throw new WfError(`test module ${spec.module.repo}/${spec.module.path} has no default export function`);
      const r = await mod.default({ ...ctx, cwd, env });
      pass = r?.pass === true;
      text = String(r?.log ?? '');
    } catch (e) {
      if (e instanceof WfError) throw e;
      text = `the test module threw: ${e?.stack ?? e}`;
    }
    fs.writeFileSync(log, text);
    return { pass, exitCode: null, ms: Date.now() - t0 };
  }
  const fd = fs.openSync(log, 'w');
  const child = spawn('sh', ['-c', spec.run], { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  // Whatever ends wf ends the run's whole tree too, and frees the lock (the exit hook).
  const stop = (signal) => {
    endProcessTree(child.pid, { graceMs: 2000, killMs: 2000 }).finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new WfError(`could not start \`${spec.run}\`: ${e.message}`)));
    child.on('close', (code) => resolve(code));
  }).finally(() => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  });
  return { pass: exitCode === 0, exitCode, ms: Date.now() - t0 };
}

// ---- runTests -------------------------------------------------------------------------------------------------------

// The worktree of `repo` in `attempt` (from its ledger, else the standard place).
export async function attemptRepoDir(root, attempt, repo) {
  let state = null;
  try {
    state = await attemptState(root, attempt);
  } catch (e) {
    if (e?.code === 'WF_NOT_BUILT') throw e;
    throw new WfError(`no attempt \`${attempt}\`: ${e.message}`);
  }
  const dir = state?.repos?.[repo]?.worktree ?? worktreeDir(root, attempt, repo);
  if (!fs.existsSync(dir)) throw new WfError(`attempt ${attempt} has no worktree for \`${repo}\` (${dir})`);
  return { dir, state };
}

// The attempt's changed test files (`kinds.tests`) in `repo`.
async function changedTests(root, attempt, repo) {
  const { files } = await changedFiles(root, attempt);
  return files.filter((f) => f.repo === repo && f.kind === 'tests');
}

// Prepare the merge-base worktree with the attempt's changed tests applied. Returns its folder and a cleanup.
async function riskBaseTree(root, attempt, adapter, repo, dir) {
  const spec = repoSpec(adapter, repo);
  const tests = await changedTests(root, attempt, repo);
  if (!tests.length) throw new WfError(`attempt ${attempt} changes no test file in \`${repo}\` (its \`kinds.tests\`): add a test that fails without the change`);
  // The attempt's own recorded base (`wf start --base`), read as the merge facts read it (base.mjs), so the run's
  // recorded merge-base is the one they compare.
  const r = (await attemptState(root, attempt))?.repos?.[repo];
  const upstream = baseRef(dir, specOf(adapter, repo, r), r?.baseSha ?? null);
  const mb = upstream ? git(dir, ['merge-base', 'HEAD', upstream], { allowFail: true }) : { status: 1, err: 'no base ref' };
  if (mb.status !== 0) throw new WfError(`no merge-base between ${attempt}'s \`${repo}\` and ${upstream ?? 'its base'}: ${mb.err}`);
  const scratch = path.join(mkdirs(path.join(attemptDir(root, attempt), 'tests')), `risk-base-${repo}-${stamp()}`);
  git(dir, ['worktree', 'add', '--detach', '--quiet', scratch, mb.out]);
  const cleanup = () => {
    git(dir, ['worktree', 'remove', '--force', scratch], { allowFail: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  };
  try {
    for (const f of tests) {
      const to = path.join(scratch, f.path);
      if (f.status === 'D') fs.rmSync(to, { force: true });
      else {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(dir, f.path), to);
      }
    }
    provisionFrom(dir, scratch, spec.provision, projectEnv(null));
  } catch (e) {
    cleanup();
    throw e;
  }
  return { scratch, cleanup, mergeBase: mb.out, tests: tests.map((f) => f.path) };
}

export const testEnv = (root, attempt, repo, kind) => projectEnv(null, { WF_ROOT: root, WF_ATTEMPT: attempt ?? '', WF_REPO: repo, WF_TEST_KIND: kind });

// Run one repo's tests for an attempt and append `test.run`. kind: fast | full | risk-base.
export async function runTests(root, attempt, repo, kind, { cwd, source = 'attempt', onWait } = {}) {
  if (!KINDS.includes(kind)) throw new WfError(`unknown test kind \`${kind}\`: use fast, full or risk-base`);
  if (!['attempt', 'landing', 'ci'].includes(source)) throw new WfError(`unknown test source \`${source}\``);
  const adapter = await loadAdapter(root);
  const spec = testSpec(adapter, repo, kind);
  const own = cwd ? { dir: cwd } : await attemptRepoDir(root, attempt, repo);
  let runDir = own.dir;
  let scratch = null;
  if (kind === 'risk-base') {
    scratch = await riskBaseTree(root, attempt, adapter, repo, own.dir);
    runDir = scratch.scratch;
  }
  try {
    const tree = workingTree(own.dir);
    const log = path.join(mkdirs(path.join(attemptDir(root, attempt), 'tests')), `${repo}-${kind}-${stamp()}.log`);
    const env = testEnv(root, attempt, repo, kind);
    const lock = await acquireLock(spec.lock, { root, attempt, repo, kind }, { onWait });
    let result;
    try {
      result = await execute({ spec, cwd: runDir, log, env, ctx: { repo, kind, attempt }, root, adapter });
    } finally {
      releaseLock(lock);
    }
    const after = workingTree(own.dir);
    if (after !== tree) {
      const moved = git(own.dir, ['diff', '--name-only', tree, after], { allowFail: true }).out;
      throw new WfError(`the files of \`${repo}\` changed while its ${kind} tests ran, so the result belongs to no tree; nothing was recorded. Changed: ${moved.split('\n').filter(Boolean).slice(0, 20).join(', ')}`, { hint: 'Ignore files the tests write (.gitignore) or wait for edits to settle, then run the tests again.' });
    }
    const data = { repo, kind, tree, pass: result.pass, exitCode: result.exitCode, ms: result.ms, source, log, ...(scratch ? { mergeBase: scratch.mergeBase } : {}), ...(lock ? { lock: { name: lock.name, count: lock.count, waitedMs: lock.waitedMs } } : {}) };
    await append(root, attempt, 'test.run', data, null);
    return { pass: result.pass, tree, ms: result.ms, exitCode: result.exitCode, log };
  } finally {
    scratch?.cleanup();
  }
}

// The file to import for a project module (`{ repo, path }`: a test runner, the screens routes module), as the repo's
// fetched base holds it (engine/base-module.mjs: the shared loader).
export const baseModule = (root, adapter, ref, what = 'module') => baseModuleFile(root, adapter, ref, { what });

// ---- the command ----------------------------------------------------------------------------------------------------

// The attempt and repo a folder belongs to: `<root>/.wf-worktrees/<attempt>/<repo>/...`.
export function placeOf(root, cwd) {
  const rel = path.relative(path.join(root, '.wf-worktrees'), path.resolve(cwd));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { attempt: null, repo: null };
  const [attempt, repo] = rel.split(path.sep);
  return { attempt: attempt || null, repo: repo || null };
}

const flag = (args, name) => {
  const v = args.flags?.[name];
  if (Array.isArray(v)) throw new WfError(`--${name} is given more than once`);
  if (v === true) throw new WfError(`--${name} needs a value`);
  return v ?? null;
};

export function attemptOf(ctx, args) {
  const attempt = flag(args, 'attempt') ?? placeOf(ctx.root, ctx.cwd).attempt;
  if (!attempt) throw new WfError('which attempt? Run this inside an attempt worktree or pass --attempt <id>');
  return attempt;
}

// wf test fast|full|risk-base [--repo r] [--attempt a]
export async function cmdTest(ctx, args) {
  if (!ctx.root) throw new WfError('no project here: wf test runs inside a project with an adapter');
  const kind = args._?.[0];
  if (!KINDS.includes(kind)) throw new WfError('usage: wf test fast|full|risk-base [--repo <repo>] [--attempt <id>]');
  const attempt = attemptOf(ctx, args);
  const adapter = await loadAdapter(ctx.root);
  const named = flag(args, 'repo') ?? placeOf(ctx.root, ctx.cwd).repo;
  const state = await attemptState(ctx.root, attempt);
  const testKey = kind === 'risk-base' ? 'fast' : kind;
  const repos = named ? [named] : adapter.repos.filter((r) => state?.repos?.[r.name] && r.tests?.[testKey]).map((r) => r.name);
  if (!repos.length) throw new WfError(`no repo of attempt ${attempt} has \`${testKey}\` tests`);
  const lines = [];
  const results = [];
  let ok = true;
  for (const repo of repos) {
    const r = await runTests(ctx.root, attempt, repo, kind, { onWait: (holders) => process.stderr.write(`waiting for the test lock (held by ${holders.map((h) => `${h.attempt ?? '?'} ${h.repo ?? ''} ${h.kind ?? ''}`.trim()).join('; ') || 'another run'})\n`) });
    // A risk-base run proves something only when it fails.
    const good = kind === 'risk-base' ? !r.pass : r.pass;
    ok &&= good;
    results.push({ repo, kind, ...r });
    const min = (r.ms / 60000).toFixed(1);
    if (kind === 'risk-base') lines.push(r.pass ? `${repo}: the changed tests PASS on the merge-base, so they do not prove the change (${min} min). Log: ${r.log}` : `${repo}: the changed tests fail on the merge-base, as they must (${min} min).`);
    else lines.push(`${repo}: ${kind} ${r.pass ? 'passed' : `FAILED (exit ${r.exitCode ?? 'n/a'})`} on tree ${r.tree.slice(0, 12)} in ${min} min. Log: ${r.log}`);
  }
  return { text: lines.join('\n'), data: { attempt, results }, exitCode: ok ? 0 : 1 };
}

export const implements08 = { runTests, cmdTest };
