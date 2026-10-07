import crypto from 'node:crypto';
import { prepareWrite, writeNoFollow } from './evidence.mjs';
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

// `x.y.z` as numbers, missing parts 0; null when it is not a version.
export function parseVersion(v) {
  const m = String(v ?? '').trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// The adapter's `engine:` pin: `N.x` (same major) or `>=x.y.z` (at least that release). Returns why the installed
// engine does not satisfy it, or null. The pin was only checked by `wf doctor`, major only, so a project that needed a
// newer engine's behaviour ran tickets on an older one without a word.
export const ENGINE_PIN = /^(?:\d+\.x|>=\s*\d+(?:\.\d+){0,2})$/;
export function enginePinProblem(pin, installed = ENGINE_VERSION) {
  if (pin === null || pin === undefined) return null;
  const p = String(pin).trim();
  if (/^\d+\.x$/.test(p)) return p.split('.')[0] === String(parseVersion(installed)[0]) ? null : `the project pins engine ${p}; installed is ${installed}`;
  const min = p.match(/^>=\s*(.+)$/)?.[1];
  if (min && parseVersion(min)) return compareVersions(installed, min) >= 0 ? null : `the project needs engine ${p}; installed is ${installed}`;
  return `the engine pin \`${p}\` is not \`N.x\` or \`>=x.y.z\``;
}
export function assertEngine(cfg, installed = ENGINE_VERSION) {
  const problem = enginePinProblem(cfg?.engine, installed);
  if (problem) throw refuse(problem, 'upgrade the plugin (`claude plugin update agentic-workflow@agentic-workflow`, or `git pull` in a clone and `node bin/wf install`), or change `engine:` in .workflow/project.yaml');
}
export const SCHEMA_VERSION = 1;

// Exit codes: 1 usage/config error, 2 invalid override, 75 refusal (state does not allow the action).
export class WfError extends Error {
  constructor(message, { code = 1, hint } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}
export const refuse = (message, hint) => new WfError(message, { code: 75, hint });

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
export const hashValue = (value) => sha256(typeof value === 'string' ? value : canonical(value));
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

export function writeJson(file, value) {
  prepareWrite(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeNoFollow(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Write-once: refuses to overwrite different content.
export function writeImmutable(file, content) {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (st && !st.isFile()) throw new WfError(`${file} is ${st.isSymbolicLink() ? 'a symlink' : 'not a regular file'}; nothing is read or written through it`, { code: 75 });
  if (st) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let same;
    try {
      same = fs.readFileSync(fd, 'utf8') === content;
    } finally {
      fs.closeSync(fd);
    }
    if (!same) throw new WfError(`immutable evidence already exists with different content: ${file}`);
    return file;
  }
  prepareWrite(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeNoFollow(file, content, { mode: 0o444, exclusive: true });
  return file;
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
// Why a glob cannot be used (it expands into too many alternatives), or null.
export function globProblem(glob) {
  try {
    expandBraces(String(glob));
    return null;
  } catch (error) {
    return error.message;
  }
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

export function sessionIdentity(env = process.env) {
  for (const [name, runtime] of [
    ['CLAUDE_CODE_SESSION_ID', 'claude'],
    ['CODEX_THREAD_ID', 'codex'],
    ['GROK_SESSION_ID', 'grok'],
  ]) {
    if (env[name]) return { runtime, session: env[name] };
  }
  return null;
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

// Single-quote a value for sh.
export const shellQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

// Ids end up in paths and branch names.
export function assertSafeId(value, what = 'id') {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(String(value)) || String(value).includes('..')) throw new WfError(`invalid ${what} \`${value}\`: use letters, digits, dot, dash and underscore`);
  return String(value);
}

// Exclusive file lock: O_EXCL create, stale when the holder pid is gone. Synchronous wait with a deadline.
export function withFileLock(file, fn, { timeoutMs = 10000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
