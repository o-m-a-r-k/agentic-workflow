import { mkdirStateDirectory } from './state-folders.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const YAML = require('./vendor/yaml/dist/index.js');

// The released version, read from package.json (kept in sync with both plugin manifests). It was a constant that
// stayed at 0.1.2 through four releases, so the ledger recorded a version nothing could be checked against.
export const ENGINE_VERSION = require('../package.json').version;

// Exit codes: 1 usage/config error, 2 invalid override, 75 refusal (state does not allow the action).
export class WfError extends Error {
  constructor(message, { code = 1, hint } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}
// Every refusal carries a stable id so it can be counted (engine/refusals.mjs, `wf refusals`): principle 13 asks for a
// measured false-positive rate per check, and refusals left no record before 0.7.0. An explicit id names the check;
// otherwise the call site (file:line) does, which is stable within a release.
export const refuse = (message, hint, { id = null } = {}) => {
  const error = new WfError(message, { code: 75, hint });
  error.refusalId = id ?? callSiteId();
  return error;
};
function callSiteId() {
  const frames = String(new Error().stack ?? '').split('\n').slice(1).map((l) => l.trim());
  const caller = frames.find((l) => !/\b(callSiteId|refuse)\b/.test(l) && /\.m?js:\d+/.test(l)) ?? '';
  const m = /([^\s()/\\]+\.m?js):(\d+):\d+\)?$/.exec(caller);
  return m ? `${m[1]}:${m[2]}` : 'unknown';
}

export function canonical(value) {
  // As JSON writes it: an undefined array element is stored as null, so it must hash as null, or the entry no longer
  // verifies once read back (a component without an id put `undefined` in `impact.touched` and broke the chain).
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const hashFile = (file) => sha256(fs.readFileSync(file));

export const now = () => new Date().toISOString();

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new WfError(`file not found: ${file}`);
    throw new WfError(`invalid JSON in ${file}: ${error.message}`);
  }
}

// Writes exactly this file: a link or a file with a second name is refused, and the data lands by rename, so a reader
// never sees half of it. `exclusive` creates the file and refuses one that exists.
export function writeNoFollow(file, data, { exclusive = false, mode = 0o644 } = {}) {
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  const bytes = typeof data === 'string' ? data : Buffer.from(data);
  const put = (target) => {
    let fd;
    try {
      fd = fs.openSync(target, O_WRONLY | O_NOFOLLOW | O_CREAT | O_EXCL, mode);
    } catch (error) {
      if (error.code === 'ELOOP') throw new WfError(`${file} is a symlink; not written through`, { code: 75 });
      throw error;
    }
    try {
      fs.writeSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
  };
  if (exclusive) return put(file);
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (st && (!st.isFile() || st.nlink > 1)) throw new WfError(`${file} is ${st.isSymbolicLink() ? 'a symlink' : st.isFile() ? 'a hard link' : 'not a regular file'}; not written through`, { code: 75 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.wf-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  put(tmp);
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function writeJson(file, value) {
  mkdirStateDirectory(path.dirname(file), { recursive: true });
  writeNoFollow(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Named failure (0.5.0 adversarial review): engine git calls inherited the environment and the repo's settings, so
// `git replace <committed adapter blob> <weaker blob>` (or a grafts file) changed what "the adapter committed at base"
// and every tree the engine reads contain, with no commit and nothing in the diff. Every git call the engine makes
// ignores replace refs and grafts; `gitObjectsProblem` refuses a repo that has either, so the change is not hidden.
export const gitEnv = (env = process.env) => ({ ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: os.devNull });
const plainChecked = new Map();
export function gitObjectsProblem(dir) {
  const key = path.resolve(dir);
  if (plainChecked.has(key)) return plainChecked.get(key);
  let problem = null;
  const refs = spawnSync('git', ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/replace/'], { cwd: dir, env: gitEnv(), encoding: 'utf8' });
  if (refs.status !== 0) problem = `git cannot list the refs of ${dir}: ${String(refs.stderr).trim()}`;
  else if (refs.stdout.trim()) problem = `${dir} has git replace refs (${refs.stdout.trim()}, refs/replace/*): they change what a commit contains without a commit; remove them (\`git replace -d\`) before running wf`;
  else {
    const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, env: gitEnv(), encoding: 'utf8' });
    const grafts = common.status === 0 ? path.join(path.resolve(dir, common.stdout.trim()), 'info', 'grafts') : null;
    if (!grafts) problem = `git cannot read the repository at ${dir}`;
    else if (fs.existsSync(grafts)) problem = `${dir} has a grafts file (${grafts}, info/grafts): it changes a commit's history without a commit; remove it before running wf`;
  }
  plainChecked.set(key, problem);
  return problem;
}
export function assertPlainGit(dir) {
  const problem = gitObjectsProblem(dir);
  if (problem) throw refuse(problem);
}

// `sensitive` keeps arguments and output out of error messages (used for anything carrying a secret).
export function run(cmd, args, { cwd, env, allowFail = false, input, sensitive = false } = {}) {
  const base = env ?? process.env;
  const result = spawnSync(cmd, args, { cwd, env: cmd === 'git' ? gitEnv(base) : base, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  // Named failure: a missing working directory made spawn report ENOENT for the command ("git failed to start"), which sent
  // people looking for git. The folder is the problem; say so.
  // 0.7.35 (D90): a folder under `.wf-worktrees/` is an attempt's worktree, and the error carries it, so a read command can tell a
  // worktree removed under it from any other failure; any other folder (a repo's own checkout) is named for what it is.
  if (result.error?.code === 'ENOENT' && cwd && !fs.existsSync(cwd)) {
    if (path.resolve(cwd).split(path.sep).includes('.wf-worktrees')) throw Object.assign(new WfError(`worktree missing: ${cwd} (${cmd} was not run there)`), { worktreeMissing: [path.resolve(cwd)] });
    throw new WfError(`repo folder missing: ${cwd} (${cmd} was not run there)`);
  }
  if (result.error) throw new WfError(`${cmd} failed to start: ${result.error.message}`);
  if (result.status !== 0 && !allowFail) {
    if (sensitive) throw new WfError(`${cmd} failed (exit ${result.status})`);
    throw new WfError(`${cmd} ${args.join(' ')} failed (exit ${result.status}) in ${cwd ?? process.cwd()}:\n${(result.stderr || result.stdout).trim()}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export const git = (cwd, args, opts = {}) => run('git', args, { cwd, ...opts }).stdout.trim();

// Glob matching: `**` any depth (`**/` zero or more folders), `*` within a segment, `?` one char, `{a,b}` alternatives.
//
// Named failure (0.5.0 adversarial review): globs compiled to a regular expression. An unclosed `{` made the compiler
// loop for ever (`indexOf` returned -1 and the index went back to 0), and stacked `**` (`**a**a…b`) backtracked
// exponentially in the engine's own process, so one impact query hung `wf plan` and the reviewer handoff. A glob is now
// matched by a state-set simulation (each character advances a set of positions in the glob: time is the glob's length
// times the path's, never more), an unclosed `{` is a literal, and brace alternatives are expanded up front, refused
// past `GLOB_MAX_ALTERNATIVES`.
export const GLOB_MAX_ALTERNATIVES = 256;
function expandBraces(glob) {
  let out = [''];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const end = c === '{' ? glob.indexOf('}', i + 1) : -1;
    if (end < 0) {
      out = out.map((p) => p + c);
      continue;
    }
    const alts = glob.slice(i + 1, end).split(',');
    out = out.flatMap((p) => alts.map((a) => p + a));
    if (out.length > GLOB_MAX_ALTERNATIVES) throw new WfError(`glob \`${glob.slice(0, 200)}\` expands to more than ${GLOB_MAX_ALTERNATIVES} alternatives`);
    i = end;
  }
  return out;
}
// Tokens: a literal character, `?`, `*` (within a segment), `**` (anything) and `**/` (empty, or anything ending in `/`).
function tokenize(glob) {
  const t = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      t.push({ k: slash ? 'dirs' : 'all' });
      i += slash ? 2 : 1;
    } else if (c === '*') t.push({ k: 'star' });
    else if (c === '?') t.push({ k: 'one' });
    else t.push({ k: 'lit', c });
  }
  return t;
}
function simulate(t, s) {
  const n = t.length;
  // States 0..n: at token i. State n+1+i: inside the `**/` at i (consumed something, owes a `/` before moving on).
  const close = (set) => {
    const stack = [...set];
    while (stack.length) {
      const i = stack.pop();
      if (i < n && ['star', 'all', 'dirs'].includes(t[i].k) && !set.has(i + 1)) {
        set.add(i + 1);
        stack.push(i + 1);
      }
    }
    return set;
  };
  let cur = close(new Set([0]));
  for (const ch of s) {
    const next = new Set();
    for (const st of cur) {
      if (st > n) {
        const i = st - n - 1;
        next.add(st);
        if (ch === '/') next.add(i + 1);
        continue;
      }
      if (st === n) continue;
      const tok = t[st];
      if (tok.k === 'lit') {
        if (tok.c === ch) next.add(st + 1);
      } else if (tok.k === 'one') {
        if (ch !== '/') next.add(st + 1);
      } else if (tok.k === 'star') {
        if (ch !== '/') next.add(st);
      } else if (tok.k === 'all') next.add(st);
      else if (tok.k === 'dirs') {
        next.add(n + 1 + st);
        if (ch === '/') next.add(st + 1);
      }
    }
    if (!next.size) return false;
    cur = close(next);
  }
  return cur.has(n);
}
const globCache = new Map();
// A matcher with `test(path)`, the shape the callers used when this returned a RegExp.
export function globToRegExp(glob) {
  if (globCache.has(glob)) return globCache.get(glob);
  const alternatives = expandBraces(String(glob)).map(tokenize);
  const compiled = { source: String(glob), test: (s) => alternatives.some((t) => simulate(t, String(s))) };
  globCache.set(glob, compiled);
  return compiled;
}
export const matchesAny = (file, globs = []) => globs.some((g) => globToRegExp(g).test(file));

// `--opt=value` and `--opt value` give the same key; a repeated option is reported (`repeated`) so a caller can refuse
// it instead of validating one occurrence and using another.
export function parseArgs(argv) {
  const positional = [];
  const options = {};
  const repeated = new Set();
  const set = (k, v) => {
    if (Object.prototype.hasOwnProperty.call(options, k)) repeated.add(k);
    options[k] = v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) set(a.slice(2, eq), a.slice(eq + 1));
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) set(a.slice(2), argv[++i]);
      else set(a.slice(2), true);
    } else positional.push(a);
  }
  return { positional, options, repeated: [...repeated] };
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Ids end up in paths and branch names.
export function assertSafeId(value, what = 'id') {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(String(value)) || String(value).includes('..')) throw new WfError(`invalid ${what} \`${value}\`: use letters, digits, dot, dash and underscore`);
  return String(value);
}

// Exclusive file lock: O_EXCL create, stale when the holder pid is gone. Synchronous wait with a deadline.
export function withFileLock(file, fn, { timeoutMs = 10000 } = {}) {
  mkdirStateDirectory(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = 0;
      let age = 0;
      try {
        holder = Number(fs.readFileSync(file, 'utf8') || 0);
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      // Appends take milliseconds: a dead holder, or any lock older than 30s, is stale.
      if ((holder && !isPidAlive(holder)) || (!holder && age > 5000) || age > 30000) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new WfError(`timed out waiting for lock ${file} (held by pid ${holder})`);
      Atomics.wait(sleeper, 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}
