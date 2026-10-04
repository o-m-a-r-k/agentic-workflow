import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const YAML = require('./vendor/yaml/dist/index.js');

export const ENGINE_VERSION = '0.1.0';
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
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Write-once: refuses to overwrite different content.
export function writeImmutable(file, content) {
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== content) throw new WfError(`immutable evidence already exists with different content: ${file}`);
    return file;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o444 });
  return file;
}

// `sensitive` keeps arguments and output out of error messages (used for anything carrying a secret).
export function run(cmd, args, { cwd, env, allowFail = false, input, sensitive = false } = {}) {
  const result = spawnSync(cmd, args, { cwd, env: env ?? process.env, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new WfError(`${cmd} failed to start: ${result.error.message}`);
  if (result.status !== 0 && !allowFail) {
    if (sensitive) throw new WfError(`${cmd} failed (exit ${result.status})`);
    throw new WfError(`${cmd} ${args.join(' ')} failed (exit ${result.status}) in ${cwd ?? process.cwd()}:\n${(result.stderr || result.stdout).trim()}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export const git = (cwd, args, opts = {}) => run('git', args, { cwd, ...opts }).stdout.trim();

// Glob matching: `**` any depth, `*` within a segment, `?` one char, `{a,b}` alternatives.
const globCache = new Map();
export function globToRegExp(glob) {
  if (globCache.has(glob)) return globCache.get(glob);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  const compiled = new RegExp(`^${re}$`);
  globCache.set(glob, compiled);
  return compiled;
}
export const matchesAny = (file, globs = []) => globs.some((g) => globToRegExp(g).test(file));

export function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) options[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) options[a.slice(2)] = argv[++i];
      else options[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, options };
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
